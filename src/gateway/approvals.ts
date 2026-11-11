import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ToolDecision } from "../policy/types.js";

export type ApprovalStatus = "pending" | "approved" | "denied";

export interface Approval {
  id: string;
  at: string;
  agentId: string;
  status: ApprovalStatus;
  toolCalls: { name: string; args: Record<string, unknown>; reason: string }[];
  decidedAt: string | null;
  decidedBy: string | null;
}

export interface StoredResponse {
  body: string;
  contentType: string;
}

function fromRow(row: any): Approval {
  return {
    id: row.id,
    at: row.at,
    agentId: row.agent_id,
    status: row.status,
    toolCalls: JSON.parse(row.tool_calls),
    decidedAt: row.decided_at ?? null,
    decidedBy: row.decided_by ?? null,
  };
}

/**
 * Holds upstream responses whose tool calls need a human decision. The original response is kept
 * verbatim and is released to the agent only after approval.
 */
export class ApprovalQueue {
  constructor(private readonly db: DatabaseSync) {}

  hold(agentId: string, decisions: ToolDecision[], response: StoredResponse): Approval {
    const id = `apr_${randomBytes(8).toString("hex")}`;
    const calls = decisions
      .filter((d) => d.action === "require_approval")
      .map((d) => ({ name: d.call.name, args: d.call.args, reason: d.reason }));
    this.db
      .prepare(
        `INSERT INTO approvals (id, at, agent_id, status, tool_calls, response, content_type)
         VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
      )
      .run(id, new Date().toISOString(), agentId, JSON.stringify(calls), response.body, response.contentType);
    return this.get(id)!;
  }

  get(id: string): Approval | undefined {
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list(status?: ApprovalStatus, limit = 100): Approval[] {
    const rows = status
      ? this.db.prepare("SELECT * FROM approvals WHERE status = ? ORDER BY at DESC LIMIT ?").all(status, limit)
      : this.db.prepare("SELECT * FROM approvals ORDER BY at DESC LIMIT ?").all(limit);
    return rows.map(fromRow);
  }

  pendingCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'").get() as { n: number }).n;
  }

  /** Only a pending approval can be decided, and only once. Returns undefined otherwise. */
  decide(id: string, status: "approved" | "denied", decidedBy: string): Approval | undefined {
    const result = this.db
      .prepare("UPDATE approvals SET status = ?, decided_at = ?, decided_by = ? WHERE id = ? AND status = 'pending'")
      .run(status, new Date().toISOString(), decidedBy, id);
    return result.changes === 1 ? this.get(id) : undefined;
  }

  response(id: string): StoredResponse | undefined {
    const row = this.db.prepare("SELECT response, content_type FROM approvals WHERE id = ?").get(id) as
      | { response: string; content_type: string }
      | undefined;
    return row ? { body: row.response, contentType: row.content_type } : undefined;
  }
}
