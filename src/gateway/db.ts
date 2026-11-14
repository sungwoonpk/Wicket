import { DatabaseSync, type StatementSync } from "node:sqlite";

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
  `
  ALTER TABLE agents ADD COLUMN max_concurrent INTEGER;
  CREATE INDEX requests_at ON requests(at);
  CREATE TABLE teams (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  INSERT OR IGNORE INTO teams (id, name, created_at) VALUES ('default', 'default', datetime('now'));
  INSERT OR IGNORE INTO teams (id, name, created_at) SELECT DISTINCT team, team, datetime('now') FROM agents;
  CREATE TABLE team_policies (
    team TEXT PRIMARY KEY REFERENCES teams(id),
    doc TEXT NOT NULL
  );
  CREATE TABLE admin_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    team TEXT REFERENCES teams(id),
    key_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE upstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    base_url TEXT NOT NULL,
    api_key_env TEXT,
    models TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );
  CREATE TABLE budget_alerts (
    agent_id TEXT NOT NULL,
    month TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (agent_id, month, threshold)
  );
  CREATE TABLE audit_head (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    seq INTEGER NOT NULL,
    hash TEXT NOT NULL,
    mac TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE agents ADD COLUMN key_ttl_days INTEGER;
  ALTER TABLE agents ADD COLUMN key_expires_at TEXT;
  ALTER TABLE admin_keys ADD COLUMN expires_at TEXT;
  `,
];

/** Opens the database and applies any migrations that have not run yet. */
export function openDb(path = ":memory:"): DatabaseSync {
  const db = new DatabaseSync(path);
  // NORMAL is safe with WAL: a power cut can lose the last few commits but cannot corrupt the file.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON;");
  reusePreparedStatements(db);
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

/**
 * Compiling a statement costs more than running it, and the same few statements run on every request.
 * This keeps each one after its first use. Statements are safe to reuse because the database is
 * driven synchronously, so two never run at once.
 */
function reusePreparedStatements(db: DatabaseSync): void {
  const cache = new Map<string, StatementSync>();
  const prepare = db.prepare.bind(db);
  (db as { prepare: (sql: string) => StatementSync }).prepare = (sql: string) => {
    let statement = cache.get(sql);
    if (!statement) {
      statement = prepare(sql);
      cache.set(sql, statement);
    }
    return statement;
  };
}
