import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface Agent {
  id: string;
  name: string;
  team: string;
  createdAt: string;
  disabled: boolean;
  allowedModels: string[] | null;
  monthlyBudgetUsd: number | null;
  ratePerMinute: number | null;
  /** Most requests this agent may have in flight at once, or null for no limit. */
  maxConcurrent: number | null;
}

export interface NewAgent {
  name: string;
  team?: string;
  allowedModels?: string[] | null;
  monthlyBudgetUsd?: number | null;
  ratePerMinute?: number | null;
  maxConcurrent?: number | null;
}

export type AgentChanges = Partial<Omit<NewAgent, "name">> & { disabled?: boolean; name?: string };

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function fromRow(row: any): Agent {
  return {
    id: row.id,
    name: row.name,
    team: row.team,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
    allowedModels: row.allowed_models ? JSON.parse(row.allowed_models) : null,
    monthlyBudgetUsd: row.monthly_budget_usd ?? null,
    ratePerMinute: row.rate_per_minute ?? null,
    maxConcurrent: row.max_concurrent ?? null,
  };
}

/**
 * Agent registry backed by SQLite. Only a SHA-256 hash of each key is stored, so a key is shown
 * once at creation and cannot be read back.
 */
export class AgentStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: NewAgent): { agent: Agent; key: string } {
    const key = `wk_${randomBytes(24).toString("base64url")}`;
    const id = `agent_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        `INSERT INTO agents (id, name, team, key_hash, created_at, allowed_models, monthly_budget_usd, rate_per_minute, max_concurrent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.name,
        input.team ?? "default",
        hash(key),
        new Date().toISOString(),
        input.allowedModels ? JSON.stringify(input.allowedModels) : null,
        input.monthlyBudgetUsd ?? null,
        input.ratePerMinute ?? null,
        input.maxConcurrent ?? null,
      );
    return { agent: this.get(id)!, key };
  }

  authenticate(key: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE key_hash = ?").get(hash(key));
    return row ? fromRow(row) : undefined;
  }

  get(id: string): Agent | undefined {
    const row = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list(team: string | null = null): Agent[] {
    return this.db
      .prepare("SELECT * FROM agents WHERE (? IS NULL OR team = ?) ORDER BY created_at, id")
      .all(team, team)
      .map(fromRow);
  }

  update(id: string, changes: AgentChanges): Agent | undefined {
    const current = this.get(id);
    if (!current) return undefined;
    const next = { ...current, ...changes };
    this.db
      .prepare(
        `UPDATE agents SET name = ?, team = ?, disabled = ?, allowed_models = ?, monthly_budget_usd = ?, rate_per_minute = ?, max_concurrent = ?
         WHERE id = ?`,
      )
      .run(
        next.name,
        next.team,
        next.disabled ? 1 : 0,
        next.allowedModels ? JSON.stringify(next.allowedModels) : null,
        next.monthlyBudgetUsd,
        next.ratePerMinute,
        next.maxConcurrent,
        id,
      );
    return this.get(id);
  }

  /** Replaces the agent's key. The old key stops working at once. Returns the new key, shown once. */
  rotateKey(id: string): { agent: Agent; key: string } | undefined {
    if (!this.get(id)) return undefined;
    const key = `wk_${randomBytes(24).toString("base64url")}`;
    this.db.prepare("UPDATE agents SET key_hash = ? WHERE id = ?").run(hash(key), id);
    return { agent: this.get(id)!, key };
  }
}
