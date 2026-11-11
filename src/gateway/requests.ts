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
  | "upstream_error";

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

  recent(limit = 100): RequestRecord[] {
    return this.db
      .prepare(
        `SELECT r.*, a.name AS agent_name FROM requests r LEFT JOIN agents a ON a.id = r.agent_id
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(limit)
      .map(fromRow);
  }

  /** Spend of one agent since the start of the current UTC month. */
  spendThisMonth(agentId: string, now = new Date()): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM requests WHERE agent_id = ? AND at >= ?")
      .get(agentId, monthStart(now)) as { total: number };
    return row.total;
  }

  summary(): Summary {
    const rows = this.db
      .prepare(
        `SELECT outcome, COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS spend,
                COALESCE(SUM(COALESCE(prompt_tokens, 0) + COALESCE(completion_tokens, 0)), 0) AS tokens
         FROM requests GROUP BY outcome`,
      )
      .all() as { outcome: Outcome; n: number; spend: number; tokens: number }[];
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
}
