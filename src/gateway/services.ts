import { createHmac } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AdminKeyStore } from "./adminkeys.js";
import { AgentStore } from "./agents.js";
import { ApprovalQueue } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { openDb } from "./db.js";
import { PolicyStore } from "./policystore.js";
import { DEFAULT_PRICES, type PriceTable } from "./pricing.js";
import { RateLimiter } from "./ratelimit.js";
import { RequestStore } from "./requests.js";
import { TeamStore } from "./teams.js";
import { UpstreamStore } from "./upstreams.js";

export interface GatewayOptions {
  /** Base URL of the OpenAI-compatible upstream used when no registered upstream matches a model. */
  upstreamUrl: string;
  /** Owner token. Always accepted, so a locked-out instance can be recovered. */
  adminToken: string;
  /** SQLite file. Defaults to an in-memory database that is lost on exit. */
  dbPath?: string;
  prices?: PriceTable;
  /** Environment used to look up provider keys. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Secret that signs the audit head. Defaults to a key derived from the admin token. */
  auditKey?: string;
  /** How long to wait for an upstream before answering 504. Default 120000. */
  upstreamTimeoutMs?: number;
  /** Most approvals one agent may have waiting. Default 100. */
  maxPendingApprovalsPerAgent?: number;
  /** Receives one structured record per request and per notable event. */
  logger?: (record: Record<string, unknown>) => void;
}

/** Everything a request handler needs, built once at start-up. */
export interface Services {
  options: Required<Pick<GatewayOptions, "upstreamUrl" | "adminToken" | "upstreamTimeoutMs" | "maxPendingApprovalsPerAgent">>;
  env: NodeJS.ProcessEnv;
  db: DatabaseSync;
  agents: AgentStore;
  teams: TeamStore;
  adminKeys: AdminKeyStore;
  audit: AuditLog;
  approvals: ApprovalQueue;
  requests: RequestStore;
  policies: PolicyStore;
  upstreams: UpstreamStore;
  prices: PriceTable;
  limiter: RateLimiter;
  /** Counts failed sign-ins per address, to slow down guessing. */
  authFailures: RateLimiter;
  /** Requests currently being handled, per agent. */
  inFlight: Map<string, number>;
  log: (record: Record<string, unknown>) => void;
}

export function createServices(options: GatewayOptions): Services {
  const db = openDb(options.dbPath);
  const auditKey = options.auditKey ?? createHmac("sha256", options.adminToken).update("wicket audit head").digest("hex");
  return {
    options: {
      upstreamUrl: options.upstreamUrl.replace(/\/+$/, ""),
      adminToken: options.adminToken,
      upstreamTimeoutMs: options.upstreamTimeoutMs ?? 120_000,
      maxPendingApprovalsPerAgent: options.maxPendingApprovalsPerAgent ?? 100,
    },
    env: options.env ?? process.env,
    db,
    agents: new AgentStore(db),
    teams: new TeamStore(db),
    adminKeys: new AdminKeyStore(db),
    audit: new AuditLog(db, auditKey),
    approvals: new ApprovalQueue(db),
    requests: new RequestStore(db),
    policies: new PolicyStore(db),
    upstreams: new UpstreamStore(db),
    prices: options.prices ?? DEFAULT_PRICES,
    limiter: new RateLimiter(),
    authFailures: new RateLimiter(),
    inFlight: new Map(),
    log: options.logger ?? (() => {}),
  };
}
