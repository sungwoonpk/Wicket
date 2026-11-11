import { DatabaseSync } from "node:sqlite";

const MIGRATIONS: string[] = [
  `
  CREATE TABLE agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    team TEXT NOT NULL DEFAULT 'default',
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    allowed_models TEXT,
    monthly_budget_usd REAL,
    rate_per_minute INTEGER
  );
  CREATE TABLE requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    model TEXT NOT NULL,
    stream INTEGER NOT NULL,
    status INTEGER NOT NULL,
    latency_ms INTEGER NOT NULL,
    prompt_tokens INTEGER,
    completion_tokens INTEGER,
    cost_usd REAL NOT NULL DEFAULT 0,
    outcome TEXT NOT NULL
  );
  CREATE INDEX requests_agent_at ON requests(agent_id, at);
  CREATE TABLE audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    actor TEXT NOT NULL,
    data TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    hash TEXT NOT NULL
  );
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    at TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    status TEXT NOT NULL,
    tool_calls TEXT NOT NULL,
    response TEXT NOT NULL,
    content_type TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT
  );
  CREATE TABLE policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    doc TEXT NOT NULL
  );
  `,
];

/** Opens the database and applies any migrations that have not run yet. */
export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  const current = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
  for (let version = current; version < MIGRATIONS.length; version++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}
