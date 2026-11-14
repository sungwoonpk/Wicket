import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  /** True when a given anchor was checked and the log still contains it. */
  anchored?: boolean;
}

/** The newest event, as far as someone needs to remember it elsewhere: its number, its hash and when it was written. */
export interface AuditAnchor {
  seq: number;
  hash: string;
  at: string;
}

const GENESIS = "0".repeat(64);

function digest(prevHash: string, at: string, type: string, actor: string, data: string): string {
  return createHash("sha256")
    .update(JSON.stringify([prevHash, at, type, actor, data]))
    .digest("hex");
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
 * deleting a past event breaks every hash after it. A signed head records the newest event, so
 * deleting the newest events is caught too: without the signing key nobody can forge a head.
 */
export class AuditLog {
  /**
   * @param signingKey secret used to sign the head. Keep it outside the database, such as an
   * environment variable. Anyone who has both the database and this key can rewrite the log.
   */
  constructor(
    private readonly db: DatabaseSync,
    private readonly signingKey: string,
  ) {
    this.adoptLegacyHead();
  }

  private mac(seq: number, hash: string): string {
    return createHmac("sha256", this.signingKey).update(`${seq}:${hash}`).digest("hex");
  }

  /** A database from before signed heads has events and no head. Trust it once and sign its newest event. */
  private adoptLegacyHead(): void {
    const head = this.db.prepare("SELECT seq FROM audit_head WHERE id = 1").get();
    if (head) return;
    const last = this.db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
      { seq: number; hash: string } | undefined;
    if (last) {
      this.db
        .prepare("INSERT INTO audit_head (id, seq, hash, mac) VALUES (1, ?, ?, ?)")
        .run(last.seq, last.hash, this.mac(last.seq, last.hash));
    }
  }

  append(type: string, actor: string, data: unknown = {}): AuditEvent {
    const at = new Date().toISOString();
    const json = JSON.stringify(data);
    // Read, insert and head update share one transaction so concurrent writers cannot fork the chain.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const last = this.db.prepare("SELECT hash FROM audit ORDER BY seq DESC LIMIT 1").get() as
        { hash: string } | undefined;
      const prevHash = last?.hash ?? GENESIS;
      const hash = digest(prevHash, at, type, actor, json);
      const result = this.db
        .prepare("INSERT INTO audit (at, type, actor, data, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)")
        .run(at, type, actor, json, prevHash, hash);
      const seq = Number(result.lastInsertRowid);
      this.db
        .prepare(
          "INSERT INTO audit_head (id, seq, hash, mac) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET seq = excluded.seq, hash = excluded.hash, mac = excluded.mac",
        )
        .run(seq, hash, this.mac(seq, hash));
      this.db.exec("COMMIT");
      return { seq, at, type, actor, data, prevHash, hash };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  recent(limit = 100): AuditEvent[] {
    return this.db.prepare("SELECT * FROM audit ORDER BY seq DESC LIMIT ?").all(limit).map(fromRow);
  }

  /** The newest event, or undefined for an empty log. Copy it somewhere the gateway cannot write, see `verify`. */
  head(): AuditAnchor | undefined {
    const row = this.db.prepare("SELECT seq, hash, at FROM audit ORDER BY seq DESC LIMIT 1").get() as
      AuditAnchor | undefined;
    return row ? { seq: row.seq, hash: row.hash, at: row.at } : undefined;
  }

  /**
   * Checks the chain and the signed head. Someone who holds both the database and the signing key can rewrite the
   * log and sign it again, and nothing inside the database can show that. An anchor can: the newest event as it
   * was some time ago, kept elsewhere. The chain commits every event to the ones before it, so if the event at that
   * number still has that hash, nothing before it was changed.
   */
  verify(anchor?: { seq: number; hash: string }): VerifyResult {
    const result = this.verifyChain();
    if (!result.ok || !anchor) return result;
    const last = this.head();
    if (!last || last.seq < anchor.seq) {
      return {
        ok: false,
        checked: result.checked,
        brokenAt: last ? last.seq + 1 : 1,
        reason: `the log is shorter than the anchor: it ends at #${last?.seq ?? 0} and the anchor is #${anchor.seq} (newest events were removed)`,
      };
    }
    const row = this.db.prepare("SELECT hash FROM audit WHERE seq = ?").get(anchor.seq) as { hash: string } | undefined;
    if (!row || row.hash !== anchor.hash) {
      return {
        ok: false,
        checked: result.checked,
        brokenAt: anchor.seq,
        reason: `event #${anchor.seq} is not the one that was anchored (the log was rewritten)`,
      };
    }
    return { ...result, anchored: true };
  }

  private verifyChain(): VerifyResult {
    let prev = GENESIS;
    let checked = 0;
    let lastSeq = 0;
    let lastHash = GENESIS;
    for (const row of this.db.prepare("SELECT * FROM audit ORDER BY seq").all() as any[]) {
      if (row.prev_hash !== prev) {
        return {
          ok: false,
          checked,
          brokenAt: row.seq,
          reason: "previous hash does not match (event removed or reordered)",
        };
      }
      if (digest(row.prev_hash, row.at, row.type, row.actor, row.data) !== row.hash) {
        return { ok: false, checked, brokenAt: row.seq, reason: "event contents do not match its hash (event edited)" };
      }
      prev = row.hash;
      lastSeq = row.seq;
      lastHash = row.hash;
      checked++;
    }

    const head = this.db.prepare("SELECT seq, hash, mac FROM audit_head WHERE id = 1").get() as
      { seq: number; hash: string; mac: string } | undefined;
    if (!head) {
      return checked === 0 ? { ok: true, checked } : { ok: false, checked, reason: "the signed head is missing" };
    }
    const expected = Buffer.from(this.mac(head.seq, head.hash));
    const actual = Buffer.from(head.mac);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      return { ok: false, checked, reason: "the signed head does not verify (wrong key, or the head was edited)" };
    }
    if (head.seq !== lastSeq || head.hash !== lastHash) {
      return {
        ok: false,
        checked,
        brokenAt: lastSeq + 1,
        reason: `the log ends at #${lastSeq} but the signed head says #${head.seq} (newest events were removed)`,
      };
    }
    return { ok: true, checked };
  }
}
