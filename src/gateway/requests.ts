import type { DatabaseSync } from "node:sqlite";

export type Outcome =
  | "ok"
  | "redacted"
  | "blocked_pii"
  | "denied_tool"
  | "pending_approval"
  | "budget_exceeded"
  | "rate_limited"
  | "model_denied"
  | "upstream_error"
  | "cancelled";

export interface RequestRecord {
  id: number;
  at: string;
  agentId: string;
  agentName?: string;
  model: string;
  stream: boolean;
  status: number;
  latencyMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  costUsd: number;
  outcome: Outcome;
}

export type NewRequestRecord = Omit<RequestRecord, "id" | "at" | "agentName">;

export interface TimeBucket {
  bucket: string;
  total: number;
  spendUsd: number;
  byOutcome: Record<string, number>;
}

export interface Summary {
  requests: number;
  spendUsd: number;
  blocked: number;
  redacted: number;
  tokens: number;
  byOutcome: Record<string, number>;
}

function fromRow(row: any): RequestRecord {
  return {
    id: row.id,
    at: row.at,
    agentId: row.agent_id,
    agentName: row.agent_name ?? undefined,
    model: row.model,
    stream: row.stream === 1,
    status: row.status,
    latencyMs: row.latency_ms,
    promptTokens: row.prompt_tokens ?? null,
    completionTokens: row.completion_tokens ?? null,
    costUsd: row.cost_usd,
    outcome: row.outcome,
  };
}

/** First instant of the current UTC month, as an ISO string. */
export function monthStart(now = new Date()): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

const BLOCKING: Outcome[] = ["blocked_pii", "denied_tool", "budget_exceeded", "rate_limited", "model_denied"];

export class RequestStore {
  constructor(private readonly db: DatabaseSync) {}

  add(record: NewRequestRecord, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO requests (at, agent_id, model, stream, status, latency_ms, prompt_tokens, completion_tokens, cost_usd, outcome)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        now.toISOString(),
        record.agentId,
        record.model,
        record.stream ? 1 : 0,
        record.status,
        record.latencyMs,
        record.promptTokens,
        record.completionTokens,
        record.costUsd,
        record.outcome,
      );
  }

  recent(limit = 100, team: string | null = null, filter: { outcome?: string; agentId?: string } = {}): RequestRecord[] {
    return this.db
      .prepare(
        `SELECT r.*, a.name AS agent_name FROM requests r LEFT JOIN agents a ON a.id = r.agent_id
         WHERE (? IS NULL OR a.team = ?) AND (? IS NULL OR r.outcome = ?) AND (? IS NULL OR r.agent_id = ?)
         ORDER BY r.at DESC, r.id DESC LIMIT ?`,
      )
      .all(team, team, filter.outcome ?? null, filter.outcome ?? null, filter.agentId ?? null, filter.agentId ?? null, limit)
      .map(fromRow);
  }

  /** Spend of one agent since the start of the current UTC month. */
  spendThisMonth(agentId: string, now = new Date()): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE agent_id = ? AND at >= ?")
      .get(agentId, monthStart(now)) as { total: number };
    return row.total;
  }

  summary(team: string | null = null): Summary {
    const rows = this.db
      .prepare(
        `SELECT r.outcome AS outcome, COUNT(*) AS n, COALESCE(SUM(r.cost_usd), 0) AS spend,
                COALESCE(SUM(COALESCE(r.prompt_tokens, 0) + COALESCE(r.completion_tokens, 0)), 0) AS tokens
         FROM requests r LEFT JOIN agents a ON a.id = r.agent_id
         WHERE (? IS NULL OR a.team = ?) GROUP BY r.outcome`,
      )
      .all(team, team) as { outcome: Outcome; n: number; spend: number; tokens: number }[];
    const summary: Summary = { requests: 0, spendUsd: 0, blocked: 0, redacted: 0, tokens: 0, byOutcome: {} };
    for (const r of rows) {
      summary.requests += r.n;
      summary.spendUsd += r.spend;
      summary.tokens += r.tokens;
      summary.byOutcome[r.outcome] = r.n;
      if (BLOCKING.includes(r.outcome)) summary.blocked += r.n;
      if (r.outcome === "redacted") summary.redacted += r.n;
    }
    return summary;
  }

  /** Requests and spend per hour for the last `hours` hours, oldest first, with empty hours included. */
  timeseries(hours: number, team: string | null = null, now = new Date()): TimeBucket[] {
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), now.getUTCHours()));
    const start = new Date(end.getTime() - (hours - 1) * 3_600_000);
    const rows = this.db
      .prepare(
        `SELECT strftime('%Y-%m-%dT%H:00:00.000Z', r.at) AS bucket, r.outcome AS outcome, COUNT(*) AS n, COALESCE(SUM(r.cost_usd), 0) AS spend
         FROM requests r LEFT JOIN agents a ON a.id = r.agent_id
         WHERE r.at >= ? AND (? IS NULL OR a.team = ?) GROUP BY bucket, r.outcome`,
      )
      .all(start.toISOString(), team, team) as { bucket: string; outcome: string; n: number; spend: number }[];
    const buckets = new Map<string, TimeBucket>();
    for (let i = 0; i < hours; i++) {
      const at = new Date(start.getTime() + i * 3_600_000).toISOString();
      buckets.set(at, { bucket: at, total: 0, spendUsd: 0, byOutcome: {} });
    }
    for (const r of rows) {
      const b = buckets.get(r.bucket);
      if (!b) continue;
      b.total += r.n;
      b.spendUsd += r.spend;
      b.byOutcome[r.outcome] = r.n;
    }
    return [...buckets.values()];
  }

  /**
   * Records that a budget threshold (a percent, such as 80 or 100) was crossed this month.
   * Returns true only the first time, so each alert fires once per agent per month.
   */
  claimBudgetAlert(agentId: string, threshold: number, now = new Date()): boolean {
    const month = monthStart(now).slice(0, 7);
    const result = this.db
      .prepare("INSERT OR IGNORE INTO budget_alerts (agent_id, month, threshold, at) VALUES (?, ?, ?, ?)")
      .run(agentId, month, threshold, now.toISOString());
    return result.changes === 1;
  }
}
