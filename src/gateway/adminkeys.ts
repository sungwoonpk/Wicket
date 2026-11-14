import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { expiryFrom } from "./keylife.js";

export type Role = "viewer" | "approver" | "admin" | "owner";
export const ROLES: Role[] = ["viewer", "approver", "admin", "owner"];

/** Higher means more power. Each role includes everything below it. */
export const ROLE_LEVEL: Record<Role, number> = { viewer: 1, approver: 2, admin: 3, owner: 4 };

export interface Actor {
  id: string;
  name: string;
  role: Role;
  /** The one team this actor may act on, or null for every team. */
  team: string | null;
}

export interface AdminKey extends Actor {
  createdAt: string;
  disabled: boolean;
  /** When the key stops working, or null for one that never expires. */
  expiresAt: string | null;
}

/** The environment token. It always works and is always an owner, so a locked-out instance can recover. */
export const BOOTSTRAP_ACTOR: Actor = { id: "bootstrap", name: "bootstrap", role: "owner", team: null };

function hash(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

function fromRow(row: any): AdminKey {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    team: row.team ?? null,
    createdAt: row.created_at,
    disabled: row.disabled === 1,
    expiresAt: row.expires_at ?? null,
  };
}

export class AdminKeyStore {
  constructor(private readonly db: DatabaseSync) {}

  create(input: { name: string; role: Role; team: string | null; keyTtlDays?: number | null }): {
    adminKey: AdminKey;
    key: string;
  } {
    const key = `wa_${randomBytes(24).toString("base64url")}`;
    const id = `admin_${randomBytes(6).toString("hex")}`;
    this.db
      .prepare(
        "INSERT INTO admin_keys (id, name, role, team, key_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.name, input.role, input.team, hash(key), new Date().toISOString(), expiryFrom(input.keyTtlDays));
    return { adminKey: this.get(id)!, key };
  }

  authenticate(key: string): AdminKey | undefined {
    const row = this.db.prepare("SELECT * FROM admin_keys WHERE key_hash = ?").get(hash(key));
    const found = row ? fromRow(row) : undefined;
    return found && !found.disabled ? found : undefined;
  }

  get(id: string): AdminKey | undefined {
    const row = this.db.prepare("SELECT * FROM admin_keys WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list(): AdminKey[] {
    return this.db.prepare("SELECT * FROM admin_keys ORDER BY created_at, id").all().map(fromRow);
  }

  setDisabled(id: string, disabled: boolean): AdminKey | undefined {
    this.db.prepare("UPDATE admin_keys SET disabled = ? WHERE id = ?").run(disabled ? 1 : 0, id);
    return this.get(id);
  }
}
