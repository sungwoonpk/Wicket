import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

export interface AuditEvent {
  seq: number;
  at: string;
  type: string;
  actor: string;
  data: unknown;
  prevHash: string;
  hash: string;
}

export interface VerifyResult {
  ok: boolean;
  checked: number;
  /** Sequence number of the first event that does not verify. */
  brokenAt?: number;
  reason?: string;
}

const GENESIS = "0".repeat(64);

function digest(prevHash: string, at: string, type: string, actor: string, data: string): string {
  return createHash("sha256").update(JSON.stringify([prevHash, at, type, actor, data])).digest("hex");
}

function fromRow(row: any): AuditEvent {
  return {
    seq: row.seq,
    at: row.at,
    type: row.type,
    actor: row.actor,
    data: JSON.parse(row.data),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

/**
 * Append-only audit trail. Each event stores the hash of the one before it, so editing or
 * deleting a past event breaks every hash after it and `verify` reports where.
 */
export class AuditLog {
  constructor(private readonly db: DatabaseSync) {}

  append(type: string, actor: string, data: unknown = {}): AuditEvent {
    const at = new Date().toISOString();
    const json = JSON.stringify(data);
    // One statement for read and insert keeps the chain consistent without a separate lock.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
        | { hash: string }
        | undefined;
      const prevHash = last?.hash ?? GENESIS;
      const hash = digest(prevHash, at, type, actor, json);
      const result = this.db
        .prepare("INSERT INTO audit (at, type, actor, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(at, type, actor, json, prevHash, hash);
      this.db.exec("COMMIT");
      return { seq: Number(result.lastInsertRowid), at, type, actor, data, prevHash, hash };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recent(limit = 100): AuditEvent[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit).map(fromRow);
  }

  verify(): VerifyResult {
    let prev = GENESIS;
    let checked = 0;
    for (const row of this.db.prepare("SELECT * FROM audit ORDER BY seq").all() as any[]) {
      if (row.prev_hash !== prev) {
        return { ok: false, checked, brokenAt: row.seq, reason: "previous hash does not match (event removed or reordered)" };
      }
      if (digest(row.prev_hash, row.at, row.type, row.actor, row.data) !== row.hash) {
        return { ok: false, checked, brokenAt: row.seq, reason: "event contents do not match its hash (event edited)" };
      }
      prev = row.hash;
      checked++;
    }
    return { ok: true, checked };
  }
}
