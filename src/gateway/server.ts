import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { AgentStore, type Agent, type AgentChanges, type NewAgent } from "./agents.js";
import { ApprovalQueue } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { openDb } from "./db.js";
import { renderMetrics } from "./metrics.js";
import { costUsd, DEFAULT_PRICES, type PriceTable } from "./pricing.js";
import { PolicyError, PolicyStore } from "./policystore.js";
import { RateLimiter } from "./ratelimit.js";
import { RequestStore, type Outcome } from "./requests.js";
import { redactMessages } from "../policy/redact.js";
import { decideToolCall, overallAction, toolCallsFromCompletion, toolCallsFromSse } from "../policy/tools.js";
import type { ToolCall, ToolDecision } from "../policy/types.js";

export interface GatewayOptions {
  /** Base URL of the OpenAI-compatible upstream, for example http://localhost:4010. */
  upstreamUrl: string;
  /** Bearer token that protects the /admin routes. */
  adminToken: string;
  /** SQLite file. Defaults to an in-memory database that is lost on exit. */
  dbPath?: string;
  prices?: PriceTable;
}

export interface GatewayApp {
  server: Server;
  db: DatabaseSync;
  agents: AgentStore;
  audit: AuditLog;
  approvals: ApprovalQueue;
  requests: RequestStore;
  policies: PolicyStore;
}

const MAX_BODY_BYTES = 1_000_000;
const ADMIN = "admin";
const DASHBOARD_HTML = readFileSync(new URL("./dashboard.html", import.meta.url), "utf8");

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
    readonly headers: Record<string, string> = {},
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw: Buffer): any {
  try {
    return raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

function optionalNumber(value: unknown, field: string, { min = 0, integer = false } = {}): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new HttpError(400, `${field} must be ${integer ? "an integer" : "a number"} of at least ${min}, or null`);
  }
  return value;
}

/** Validates the settings an admin can set on an agent. Unknown fields are ignored. */
function parseAgentSettings(body: any): AgentChanges {
  const out: AgentChanges = {};
  if (body.name !== undefined) {
    if (typeof body.name !== "string" || body.name.trim() === "") throw new HttpError(400, "name must be a non-empty string");
    out.name = body.name.trim();
  }
  if (body.team !== undefined) {
    if (typeof body.team !== "string" || body.team.trim() === "") throw new HttpError(400, "team must be a non-empty string");
    out.team = body.team.trim();
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") throw new HttpError(400, "disabled must be a boolean");
    out.disabled = body.disabled;
  }
  if (body.allowedModels !== undefined) {
    if (body.allowedModels !== null && (!Array.isArray(body.allowedModels) || body.allowedModels.some((m: unknown) => typeof m !== "string"))) {
      throw new HttpError(400, "allowedModels must be a list of strings, or null");
    }
    out.allowedModels = body.allowedModels;
  }
  const budget = optionalNumber(body.monthlyBudgetUsd, "monthlyBudgetUsd");
  if (budget !== undefined) out.monthlyBudgetUsd = budget;
  const rate = optionalNumber(body.ratePerMinute, "ratePerMinute", { min: 1, integer: true });
  if (rate !== undefined) out.ratePerMinute = rate;
  return out;
}

/** Reads token usage from a JSON response, or from the last usage-bearing SSE event. */
export function extractUsage(
  text: string,
  stream: boolean,
): { promptTokens?: number; completionTokens?: number } {
  try {
    let usage: any;
    if (stream) {
      const events = text.split("\n\n").filter((e) => e.startsWith("data: {"));
      for (const event of events) {
        const parsed = JSON.parse(event.slice(6));
        if (parsed.usage) usage = parsed.usage;
      }
    } else {
      usage = JSON.parse(text).usage;
    }
    if (!usage) return {};
    return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  } catch {
    return {};
  }
}

function describeDecisions(decisions: ToolDecision[]) {
  return decisions.map((d) => ({ name: d.call.name, action: d.action, reason: d.reason }));
}

export function createGatewayApp(options: GatewayOptions): GatewayApp {
  const db = openDb(options.dbPath);
  const agents = new AgentStore(db);
  const audit = new AuditLog(db);
  const approvals = new ApprovalQueue(db);
  const requests = new RequestStore(db);
  const policies = new PolicyStore(db);
  const limiter = new RateLimiter();
  const prices = options.prices ?? DEFAULT_PRICES;
  const upstream = options.upstreamUrl.replace(/\/+$/, "");

  function requireAdmin(req: IncomingMessage): void {
    const token = bearer(req);
    if (!token || !safeEqual(token, options.adminToken)) throw new HttpError(401, "invalid admin token", "authentication_error");
  }

  function authenticateAgent(req: IncomingMessage): Agent {
    const key = bearer(req);
    const agent = key ? agents.authenticate(key) : undefined;
    if (!agent) throw new HttpError(401, "invalid or missing API key", "authentication_error");
    if (agent.disabled) throw new HttpError(403, "this agent is disabled", "permission_error");
    return agent;
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const agent = authenticateAgent(req);
    const raw = await readBody(req);
    let body = parseJson(raw);
    const model = String(body.model ?? "");
    const stream = body.stream === true;
    const started = performance.now();

    const record = (
      outcome: Outcome,
      status: number,
      usage: { promptTokens?: number; completionTokens?: number } = {},
    ) => {
      requests.add({
        agentId: agent.id, model, stream, status, outcome,
        latencyMs: Math.round(performance.now() - started),
        promptTokens: usage.promptTokens ?? null,
        completionTokens: usage.completionTokens ?? null,
        costUsd: costUsd(prices, model, usage.promptTokens, usage.completionTokens),
      });
    };
    const refuse = (outcome: Outcome, status: number, message: string, type: string, auditType: string, data: object = {}, headers: Record<string, string> = {}): never => {
      record(outcome, status);
      audit.append(auditType, agent.id, { model, reason: message, ...data });
      throw new HttpError(status, message, type, headers);
    };

    if (agent.ratePerMinute) {
      const wait = limiter.take(agent.id, agent.ratePerMinute);
      if (wait > 0) {
        record("rate_limited", 429);
        throw new HttpError(429, `rate limit of ${agent.ratePerMinute} requests per minute reached`, "rate_limit_error", { "retry-after": String(wait) });
      }
    }

    if (agent.allowedModels && !agent.allowedModels.includes(model)) {
      refuse("model_denied", 403, `model "${model}" is not allowed for this agent`, "permission_error", "request.denied", { rule: "allowed_models" });
    }

    if (agent.monthlyBudgetUsd !== null) {
      const spent = requests.spendThisMonth(agent.id);
      if (spent >= agent.monthlyBudgetUsd) {
        refuse("budget_exceeded", 429, "monthly budget exhausted", "budget_exceeded", "request.denied", { rule: "monthly_budget", spentUsd: spent, budgetUsd: agent.monthlyBudgetUsd });
      }
    }

    const policy = policies.get();
    let redacted = false;
    if (policy.redaction.mode !== "off" && Array.isArray(body.messages)) {
      const result = redactMessages(body.messages, policy.redaction.detectors);
      if (result.findings.length > 0) {
        if (policy.redaction.mode === "block") {
          refuse("blocked_pii", 400, "request blocked: it contains sensitive data", "policy_violation", "request.blocked", { findings: result.findings });
        }
        body = { ...body, messages: result.messages };
        redacted = true;
        audit.append("request.redacted", agent.id, { model, findings: result.findings });
      }
    }

    const governsTools = policy.tools.length > 0 || policy.defaultToolAction !== "allow";
    const declaresTools = Array.isArray(body.tools) && body.tools.length > 0;
    // A streamed response has to be held back to judge its tool calls, so only do it when it can matter.
    const buffered = !stream || (governsTools && declaresTools);

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${upstream}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch {
      record("upstream_error", 502);
      throw new HttpError(502, "upstream unreachable", "upstream_error");
    }

    const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
    const okOutcome: Outcome = redacted ? "redacted" : "ok";
    const outcomeFor = (status: number): Outcome => (status >= 400 ? "upstream_error" : okOutcome);

    if (!buffered) {
      res.writeHead(upstreamRes.status, { "content-type": contentType });
      let captured = "";
      if (upstreamRes.body) {
        const decoder = new TextDecoder();
        for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
          captured += decoder.decode(chunk, { stream: true });
          res.write(chunk);
        }
      }
      res.end();
      record(outcomeFor(upstreamRes.status), upstreamRes.status, extractUsage(captured, true));
      return;
    }

    const text = await upstreamRes.text();
    const usage = extractUsage(text, stream);

    if (upstreamRes.status === 200 && governsTools) {
      let calls: ToolCall[];
      try {
        calls = stream ? toolCallsFromSse(text) : toolCallsFromCompletion(JSON.parse(text));
      } catch {
        calls = [];
      }
      const decisions = calls.map((call) => decideToolCall(policy, call));
      const action = overallAction(decisions);

      if (action === "deny") {
        record("denied_tool", 403, usage);
        audit.append("tool.denied", agent.id, { model, decisions: describeDecisions(decisions) });
        const denied = decisions.find((d) => d.action === "deny")!;
        throw new HttpError(403, `tool call "${denied.call.name}" was denied by policy: ${denied.reason}`, "policy_violation", {}, { tool_calls: describeDecisions(decisions) });
      }

      if (action === "require_approval") {
        const approval = approvals.hold(agent.id, decisions, { body: text, contentType });
        record("pending_approval", 202, usage);
        audit.append("approval.requested", agent.id, { approvalId: approval.id, toolCalls: approval.toolCalls });
        sendJson(res, 202, {
          object: "wicket.approval_required",
          approval_id: approval.id,
          status: "pending",
          tool_calls: approval.toolCalls,
          poll_url: `/v1/approvals/${approval.id}`,
        });
        return;
      }
    }

    res.writeHead(upstreamRes.status, { "content-type": contentType });
    res.end(text);
    record(outcomeFor(upstreamRes.status), upstreamRes.status, usage);
  }

  function agentApproval(req: IncomingMessage, res: ServerResponse, id: string): void {
    const agent = authenticateAgent(req);
    const approval = approvals.get(id);
    if (!approval || approval.agentId !== agent.id) throw new HttpError(404, "approval not found");
    if (approval.status === "pending") {
      sendJson(res, 202, { object: "wicket.approval_required", approval_id: id, status: "pending" });
    } else if (approval.status === "denied") {
      throw new HttpError(403, "a human reviewer denied this tool call", "policy_violation");
    } else {
      const stored = approvals.response(id)!;
      res.writeHead(200, { "content-type": stored.contentType });
      res.end(stored.body);
    }
  }

  async function admin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = req.method;
    if (!path.startsWith("/admin/") && path !== "/metrics") return false;
    requireAdmin(req);

    if (method === "POST" && path === "/admin/agents") {
      const body = parseJson(await readBody(req));
      if (typeof body.name !== "string" || body.name.trim() === "") throw new HttpError(400, "name is required");
      const settings = parseAgentSettings(body);
      const input: NewAgent = { name: body.name.trim(), team: settings.team, allowedModels: settings.allowedModels, monthlyBudgetUsd: settings.monthlyBudgetUsd, ratePerMinute: settings.ratePerMinute };
      const { agent, key } = agents.create(input);
      audit.append("agent.created", ADMIN, { agentId: agent.id, name: agent.name, team: agent.team });
      sendJson(res, 201, { agent, key });
      return true;
    }

    if (method === "GET" && path === "/admin/agents") {
      const list = agents.list().map((a) => ({ ...a, spentThisMonthUsd: requests.spendThisMonth(a.id) }));
      sendJson(res, 200, { agents: list });
      return true;
    }

    const agentMatch = /^\/admin\/agents\/([\w-]+)$/.exec(path);
    if (method === "PATCH" && agentMatch) {
      const changes = parseAgentSettings(parseJson(await readBody(req)));
      const updated = agents.update(agentMatch[1]!, changes);
      if (!updated) throw new HttpError(404, "agent not found");
      audit.append("agent.updated", ADMIN, { agentId: updated.id, changes });
      sendJson(res, 200, { agent: updated });
      return true;
    }

    if (path === "/admin/policy") {
      if (method === "GET") {
        sendJson(res, 200, { policy: policies.get() });
        return true;
      }
      if (method === "PUT") {
        try {
          const policy = policies.set(parseJson(await readBody(req)));
          audit.append("policy.updated", ADMIN, { policy });
          sendJson(res, 200, { policy });
        } catch (err) {
          if (err instanceof PolicyError) throw new HttpError(400, err.message);
          throw err;
        }
        return true;
      }
    }

    if (method === "GET" && path === "/admin/requests") {
      sendJson(res, 200, { requests: requests.recent(clampLimit(url)) });
      return true;
    }

    if (method === "GET" && path === "/admin/summary") {
      sendJson(res, 200, { summary: requests.summary(), pendingApprovals: approvals.pendingCount(), agents: agents.list().length });
      return true;
    }

    if (method === "GET" && path === "/admin/approvals") {
      const status = url.searchParams.get("status");
      if (status && !["pending", "approved", "denied"].includes(status)) throw new HttpError(400, "status must be pending, approved or denied");
      sendJson(res, 200, { approvals: approvals.list(status as "pending" | "approved" | "denied" | undefined ?? undefined, clampLimit(url)) });
      return true;
    }

    const decision = /^\/admin\/approvals\/([\w-]+)\/(approve|deny)$/.exec(path);
    if (method === "POST" && decision) {
      const approved = decision[2] === "approve";
      const result = approvals.decide(decision[1]!, approved ? "approved" : "denied", ADMIN);
      if (!result) {
        throw new HttpError(approvals.get(decision[1]!) ? 409 : 404, approvals.get(decision[1]!) ? "approval was already decided" : "approval not found");
      }
      audit.append(approved ? "approval.approved" : "approval.denied", ADMIN, { approvalId: result.id, agentId: result.agentId, toolCalls: result.toolCalls });
      sendJson(res, 200, { approval: result });
      return true;
    }

    if (method === "GET" && path === "/admin/audit") {
      sendJson(res, 200, { events: audit.recent(clampLimit(url)) });
      return true;
    }

    if (method === "GET" && path === "/admin/audit/verify") {
      sendJson(res, 200, audit.verify());
      return true;
    }

    if (method === "GET" && path === "/metrics") {
      const text = renderMetrics(requests.summary(), approvals.pendingCount(), agents.list().length);
      res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      res.end(text);
      return true;
    }

    return false;
  }

  function clampLimit(url: URL): number {
    return Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
  }

  function dashboard(res: ServerResponse): void {
    const nonce = randomBytes(16).toString("base64");
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    res.end(DASHBOARD_HTML.replaceAll("__NONCE__", nonce));
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { status: "ok" });
      } else if (req.method === "GET" && url.pathname === "/dashboard") {
        dashboard(res);
      } else if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await chatCompletions(req, res);
      } else if (req.method === "GET" && /^\/v1\/approvals\/[\w-]+$/.test(url.pathname)) {
        agentApproval(req, res, url.pathname.split("/").pop()!);
      } else if (!(await admin(req, res, url))) {
        throw new HttpError(404, "not found");
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { message: err.message, type: err.type, ...err.extra } }, err.headers);
      } else {
        sendJson(res, 500, { error: { message: "internal error", type: "server_error" } });
      }
    }
  });
  server.on("close", () => db.close());

  return { server, db, agents, audit, approvals, requests, policies };
}

export function createGateway(options: GatewayOptions): Server {
  return createGatewayApp(options).server;
}
