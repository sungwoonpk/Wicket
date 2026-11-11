import type { DatabaseSync } from "node:sqlite";

export interface Team {
  id: string;
  name: string;
  createdAt: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isTeamSlug(value: unknown): value is string {
  return typeof value === "string" && SLUG.test(value);
}

function fromRow(row: any): Team {
  return { id: row.id, name: row.name, createdAt: row.created_at };
}

/** Teams are the unit of tenancy: agents belong to one, admins can be limited to one, policy can be set per team. */
export class TeamStore {
  constructor(private readonly db: DatabaseSync) {}

  /** Creates the team if it does not exist yet. Returns it either way. */
  ensure(id: string, name = id): Team {
    this.db
      .prepare("INSERT OR IGNORE INTO teams (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, new Date().toISOString());
    return this.get(id)!;
  }

  get(id: string): Team | undefined {
    const row = this.db.prepare("SELECT * FROM teams WHERE id = ?").get(id);
    return row ? fromRow(row) : undefined;
  }

  list(): Team[] {
    return this.db.prepare("SELECT * FROM teams ORDER BY id").all().map(fromRow);
  }

  rename(id: string, name: string): Team | undefined {
    this.db.prepare("UPDATE teams SET name = ? WHERE id = ?").run(name, id);
    return this.get(id);
  }
}
