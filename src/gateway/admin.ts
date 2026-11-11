import type { IncomingMessage, ServerResponse } from "node:http";
import { type Actor, BOOTSTRAP_ACTOR, ROLE_LEVEL, ROLES, type Role } from "./adminkeys.js";
import type { AgentChanges } from "./agents.js";
import { clampLimit, clientIp, HttpError, bearer, parseJsonObject, readBody, safeEqual, sendJson } from "./http.js";
import { renderMetrics } from "./metrics.js";
import { PolicyError, parsePolicy } from "./policystore.js";
import type { Services } from "./services.js";
import { isTeamSlug } from "./teams.js";
import { UPSTREAM_KINDS, validateUpstreamUrl, type UpstreamKind } from "./upstreams.js";
import { redactText } from "../policy/redact.js";
import { decideToolCall, parseToolArguments } from "../policy/tools.js";
import type { Policy } from "../policy/types.js";

type Body = Record<string, any>;

interface Ctx {
  svc: Services;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  actor: Actor;
  params: string[];
  body(): Promise<Body>;
}

interface Route {
  method: string;
  pattern: RegExp;
  /** The lowest role allowed to call this route. */
  role: Role;
  handler(ctx: Ctx): Promise<void> | void;
}

const label = (actor: Actor) => `${actor.role}:${actor.name}`;
const json = (ctx: Ctx, status: number, body: unknown) => sendJson(ctx.res, status, body);

function authenticateAdmin(svc: Services, req: IncomingMessage): Actor {
  const token = bearer(req);
  if (token) {
    if (safeEqual(token, svc.options.adminToken)) return BOOTSTRAP_ACTOR;
    const key = svc.adminKeys.authenticate(token);
    if (key) return { id: key.id, name: key.name, role: key.role, team: key.team };
  }
  const wait = svc.authFailures.take(`admin:${clientIp(req)}`, 10);
  if (wait > 0)
    throw new HttpError(429, "too many failed attempts, try again later", "rate_limit_error", {
      "retry-after": String(wait),
    });
  throw new HttpError(401, "invalid admin token", "authentication_error");
}

/** The team a list should be limited to: the actor's own team, or the `?team=` filter for someone with access to all. */
function scopeTeam(ctx: Ctx): string | null {
  if (ctx.actor.team !== null) return ctx.actor.team;
  const asked = ctx.url.searchParams.get("team");
  return asked && isTeamSlug(asked) ? asked : null;
}

function requireTeamAccess(actor: Actor, team: string): void {
  if (actor.team !== null && actor.team !== team)
    throw new HttpError(403, "this is outside your team", "permission_error");
}

function requireAllTeams(actor: Actor): void {
  if (actor.team !== null) throw new HttpError(403, "this needs access to all teams", "permission_error");
}

function optionalNumber(value: unknown, field: string, { min = 0, integer = false } = {}): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || (integer && !Number.isInteger(value))) {
    throw new HttpError(400, `${field} must be ${integer ? "an integer" : "a number"} of at least ${min}, or null`);
  }
  return value;
}

function requireName(value: unknown, field = "name"): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 100)
    throw new HttpError(400, `${field} must be a non-empty string of at most 100 characters`);
  return value.trim();
}

/** Validates the settings an admin can set on an agent. Unknown fields are ignored. */
function parseAgentSettings(body: Body): AgentChanges {
  const out: AgentChanges = {};
  if (body.name !== undefined) out.name = requireName(body.name);
  if (body.team !== undefined) {
    if (!isTeamSlug(body.team))
      throw new HttpError(400, "team must be lowercase letters, digits and dashes, up to 40 characters");
    out.team = body.team;
  }
  if (body.disabled !== undefined) {
    if (typeof body.disabled !== "boolean") throw new HttpError(400, "disabled must be a boolean");
    out.disabled = body.disabled;
  }
  if (body.allowedModels !== undefined) {
    const list = body.allowedModels;
    if (
      list !== null &&
      (!Array.isArray(list) ||
        list.length > 100 ||
        list.some((m: unknown) => typeof m !== "string" || m === "" || m.length > 200))
    ) {
      throw new HttpError(400, "allowedModels must be a list of model names, or null");
    }
    out.allowedModels = list;
  }
  const budget = optionalNumber(body.monthlyBudgetUsd, "monthlyBudgetUsd");
  if (budget !== undefined) out.monthlyBudgetUsd = budget;
  const rate = optionalNumber(body.ratePerMinute, "ratePerMinute", { min: 1, integer: true });
  if (rate !== undefined) out.ratePerMinute = rate;
  const concurrent = optionalNumber(body.maxConcurrent, "maxConcurrent", { min: 1, integer: true });
  if (concurrent !== undefined) out.maxConcurrent = concurrent;
  return out;
}

const OUTCOME_FILTER = /^[a-z_]{1,30}$/;

const routes: Route[] = [
  {
    method: "GET",
    pattern: /^\/admin\/me$/,
    role: "viewer",
    handler: (c) => json(c, 200, { actor: c.actor }),
  },

  // Teams
  {
    method: "GET",
    pattern: /^\/admin\/teams$/,
    role: "viewer",
    handler: (c) => {
      const teams = c.svc.teams.list().filter((t) => c.actor.team === null || t.id === c.actor.team);
      json(c, 200, { teams: teams.map((t) => ({ ...t, hasOwnPolicy: c.svc.policies.getTeam(t.id) !== undefined })) });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/teams$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const body = await c.body();
      if (!isTeamSlug(body.id))
        throw new HttpError(400, "id must be lowercase letters, digits and dashes, up to 40 characters");
      if (c.svc.teams.get(body.id)) throw new HttpError(409, "a team with this id already exists");
      const team = c.svc.teams.ensure(body.id, body.name === undefined ? body.id : requireName(body.name));
      c.svc.audit.append("team.created", label(c.actor), { teamId: team.id });
      json(c, 201, { team });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/admin\/teams\/([a-z0-9-]+)$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const team = c.svc.teams.rename(c.params[0]!, requireName((await c.body()).name));
      if (!team) throw new HttpError(404, "team not found");
      c.svc.audit.append("team.updated", label(c.actor), { teamId: team.id, name: team.name });
      json(c, 200, { team });
    },
  },

  // Admin users
  {
    method: "GET",
    pattern: /^\/admin\/users$/,
    role: "owner",
    handler: (c) => {
      requireAllTeams(c.actor);
      json(c, 200, { users: c.svc.adminKeys.list() });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/users$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const body = await c.body();
      const name = requireName(body.name);
      if (!ROLES.includes(body.role)) throw new HttpError(400, `role must be one of: ${ROLES.join(", ")}`);
      const team = body.team === undefined || body.team === null ? null : body.team;
      if (team !== null && !isTeamSlug(team)) throw new HttpError(400, "team must be a team id, or null for all teams");
      if (team !== null && !c.svc.teams.get(team)) throw new HttpError(404, "team not found");
      const { adminKey, key } = c.svc.adminKeys.create({ name, role: body.role, team });
      c.svc.audit.append("user.created", label(c.actor), { userId: adminKey.id, name, role: body.role, team });
      json(c, 201, { user: adminKey, key });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/admin\/users\/([\w-]+)$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const body = await c.body();
      if (typeof body.disabled !== "boolean") throw new HttpError(400, "disabled must be a boolean");
      const user = c.svc.adminKeys.setDisabled(c.params[0]!, body.disabled);
      if (!user) throw new HttpError(404, "user not found");
      c.svc.audit.append(body.disabled ? "user.disabled" : "user.enabled", label(c.actor), { userId: user.id });
      json(c, 200, { user });
    },
  },

  // Agents
  {
    method: "GET",
    pattern: /^\/admin\/agents$/,
    role: "viewer",
    handler: (c) => {
      const agents = c.svc.agents
        .list(scopeTeam(c))
        .map((a) => ({ ...a, spentThisMonthUsd: c.svc.requests.spendThisMonth(a.id) }));
      json(c, 200, { agents });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/agents$/,
    role: "admin",
    handler: async (c) => {
      const body = await c.body();
      const name = requireName(body.name);
      const settings = parseAgentSettings(body);
      const team = settings.team ?? c.actor.team ?? "default";
      requireTeamAccess(c.actor, team);
      c.svc.teams.ensure(team);
      const { agent, key } = c.svc.agents.create({
        name,
        team,
        allowedModels: settings.allowedModels,
        monthlyBudgetUsd: settings.monthlyBudgetUsd,
        ratePerMinute: settings.ratePerMinute,
        maxConcurrent: settings.maxConcurrent,
      });
      c.svc.audit.append("agent.created", label(c.actor), { agentId: agent.id, name: agent.name, team: agent.team });
      json(c, 201, { agent, key });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/admin\/agents\/([\w-]+)$/,
    role: "admin",
    handler: async (c) => {
      const current = c.svc.agents.get(c.params[0]!);
      if (!current) throw new HttpError(404, "agent not found");
      requireTeamAccess(c.actor, current.team);
      const changes = parseAgentSettings(await c.body());
      if (changes.team !== undefined) {
        requireTeamAccess(c.actor, changes.team);
        c.svc.teams.ensure(changes.team);
      }
      const updated = c.svc.agents.update(current.id, changes)!;
      c.svc.audit.append("agent.updated", label(c.actor), { agentId: updated.id, changes });
      json(c, 200, { agent: updated });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/agents\/([\w-]+)\/rotate-key$/,
    role: "admin",
    handler: (c) => {
      const current = c.svc.agents.get(c.params[0]!);
      if (!current) throw new HttpError(404, "agent not found");
      requireTeamAccess(c.actor, current.team);
      const rotated = c.svc.agents.rotateKey(current.id)!;
      c.svc.audit.append("agent.key_rotated", label(c.actor), { agentId: current.id });
      json(c, 200, { agent: rotated.agent, key: rotated.key });
    },
  },

  // Policy
  {
    method: "GET",
    pattern: /^\/admin\/policy$/,
    role: "viewer",
    handler: (c) => {
      const team = c.url.searchParams.get("team");
      if (team === null) {
        json(c, 200, { policy: c.svc.policies.get(), teamsWithPolicy: c.svc.policies.teamsWithPolicy() });
        return;
      }
      if (!isTeamSlug(team) || !c.svc.teams.get(team)) throw new HttpError(404, "team not found");
      requireTeamAccess(c.actor, team);
      const own = c.svc.policies.getTeam(team);
      json(c, 200, { policy: own ?? null, inherited: own === undefined, effective: c.svc.policies.effective(team) });
    },
  },
  {
    method: "PUT",
    pattern: /^\/admin\/policy$/,
    role: "admin",
    handler: async (c) => {
      const team = c.url.searchParams.get("team");
      const body = await c.body();
      try {
        if (team === null) {
          if (c.actor.role !== "owner")
            throw new HttpError(403, "only an owner can change the organization policy", "permission_error");
          requireAllTeams(c.actor);
          const policy = c.svc.policies.set(body);
          c.svc.audit.append("policy.updated", label(c.actor), { scope: "organization", policy });
          json(c, 200, { policy });
          return;
        }
        if (!isTeamSlug(team) || !c.svc.teams.get(team)) throw new HttpError(404, "team not found");
        requireTeamAccess(c.actor, team);
        const policy = c.svc.policies.setTeam(team, body);
        c.svc.audit.append("policy.updated", label(c.actor), { scope: `team:${team}`, policy });
        json(c, 200, { policy });
      } catch (err) {
        if (err instanceof PolicyError) throw new HttpError(400, err.message);
        throw err;
      }
    },
  },
  {
    method: "DELETE",
    pattern: /^\/admin\/policy$/,
    role: "admin",
    handler: (c) => {
      const team = c.url.searchParams.get("team");
      if (team === null || !isTeamSlug(team)) throw new HttpError(400, "pass ?team=<id> to remove a team policy");
      requireTeamAccess(c.actor, team);
      if (!c.svc.policies.deleteTeam(team)) throw new HttpError(404, "this team has no policy of its own");
      c.svc.audit.append("policy.removed", label(c.actor), { scope: `team:${team}` });
      json(c, 200, { removed: true });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/policy\/simulate$/,
    role: "viewer",
    handler: async (c) => {
      const body = await c.body();
      let policy: Policy;
      try {
        if (body.policy !== undefined) policy = parsePolicy(body.policy);
        else if (typeof body.team === "string" && isTeamSlug(body.team)) policy = c.svc.policies.effective(body.team);
        else policy = c.svc.policies.get();
      } catch (err) {
        if (err instanceof PolicyError) throw new HttpError(400, err.message);
        throw err;
      }
      const out: Record<string, unknown> = {};
      if (body.toolCall !== undefined) {
        const tc = body.toolCall;
        if (tc === null || typeof tc !== "object" || typeof tc.name !== "string" || tc.name === "")
          throw new HttpError(400, "toolCall.name is required");
        const { args, valid } = parseToolArguments(tc.args);
        const d = decideToolCall(policy, { name: tc.name, args, argsValid: valid });
        out.tool = { action: d.action, reason: d.reason, ruleIndex: d.ruleIndex, argumentsValid: valid };
      }
      if (typeof body.text === "string") {
        if (body.text.length > 20_000) throw new HttpError(400, "text is limited to 20000 characters");
        if (policy.redaction.mode === "off") {
          out.redaction = { mode: "off", text: body.text, findings: [], wouldBlock: false };
        } else {
          const r = redactText(body.text, policy.redaction.detectors);
          out.redaction = {
            mode: policy.redaction.mode,
            text: r.text,
            findings: r.findings,
            wouldBlock: policy.redaction.mode === "block" && r.findings.length > 0,
          };
        }
      }
      json(c, 200, out);
    },
  },

  // Traffic
  {
    method: "GET",
    pattern: /^\/admin\/requests$/,
    role: "viewer",
    handler: (c) => {
      const outcome = c.url.searchParams.get("outcome");
      if (outcome !== null && !OUTCOME_FILTER.test(outcome)) throw new HttpError(400, "invalid outcome filter");
      const agentId = c.url.searchParams.get("agent");
      const requests = c.svc.requests.recent(clampLimit(c.url), scopeTeam(c), {
        outcome: outcome ?? undefined,
        agentId: agentId ?? undefined,
      });
      json(c, 200, { requests });
    },
  },
  {
    method: "GET",
    pattern: /^\/admin\/summary$/,
    role: "viewer",
    handler: (c) => {
      const team = scopeTeam(c);
      json(c, 200, {
        summary: c.svc.requests.summary(team),
        pendingApprovals: c.svc.approvals.pendingCount(team),
        agents: c.svc.agents.list(team).length,
      });
    },
  },
  {
    method: "GET",
    pattern: /^\/admin\/timeseries$/,
    role: "viewer",
    handler: (c) => {
      const asked = Number(c.url.searchParams.get("hours") ?? 24);
      const hours = Math.min(Math.max(Number.isFinite(asked) ? Math.floor(asked) : 24, 1), 168);
      json(c, 200, { hours, buckets: c.svc.requests.timeseries(hours, scopeTeam(c)) });
    },
  },
  {
    method: "GET",
    pattern: /^\/metrics$/,
    role: "viewer",
    handler: (c) => {
      const team = scopeTeam(c);
      const text = renderMetrics(
        c.svc.requests.summary(team),
        c.svc.approvals.pendingCount(team),
        c.svc.agents.list(team).length,
      );
      c.res.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      c.res.end(text);
    },
  },

  // Approvals
  {
    method: "GET",
    pattern: /^\/admin\/approvals$/,
    role: "viewer",
    handler: (c) => {
      const status = c.url.searchParams.get("status");
      if (status !== null && !["pending", "approved", "denied"].includes(status))
        throw new HttpError(400, "status must be pending, approved or denied");
      json(c, 200, {
        approvals: c.svc.approvals.list(
          (status as "pending" | "approved" | "denied" | null) ?? undefined,
          clampLimit(c.url),
          scopeTeam(c),
        ),
      });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/approvals\/([\w-]+)\/(approve|deny)$/,
    role: "approver",
    handler: (c) => {
      const id = c.params[0]!;
      const approve = c.params[1] === "approve";
      const existing = c.svc.approvals.get(id);
      if (!existing) throw new HttpError(404, "approval not found");
      const agent = c.svc.agents.get(existing.agentId);
      if (agent) requireTeamAccess(c.actor, agent.team);
      const result = c.svc.approvals.decide(id, approve ? "approved" : "denied", label(c.actor));
      if (!result) throw new HttpError(409, "approval was already decided");
      c.svc.audit.append(approve ? "approval.approved" : "approval.denied", label(c.actor), {
        approvalId: result.id,
        agentId: result.agentId,
        tools: result.toolCalls.map((t) => ({ name: t.name, reason: t.reason })),
      });
      json(c, 200, { approval: result });
    },
  },

  // Audit
  {
    method: "GET",
    pattern: /^\/admin\/audit$/,
    role: "viewer",
    handler: (c) => {
      requireAllTeams(c.actor);
      json(c, 200, { events: c.svc.audit.recent(clampLimit(c.url)) });
    },
  },
  {
    method: "GET",
    pattern: /^\/admin\/audit\/verify$/,
    role: "viewer",
    handler: (c) => {
      requireAllTeams(c.actor);
      json(c, 200, c.svc.audit.verify());
    },
  },

  // Upstreams
  {
    method: "GET",
    pattern: /^\/admin\/upstreams$/,
    role: "admin",
    handler: (c) => {
      requireAllTeams(c.actor);
      json(c, 200, { upstreams: c.svc.upstreams.list(), fallback: c.svc.options.upstreamUrl });
    },
  },
  {
    method: "POST",
    pattern: /^\/admin\/upstreams$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const body = await c.body();
      const name = requireName(body.name);
      if (!/^[\w.-]{1,60}$/.test(name))
        throw new HttpError(400, "name may use letters, digits, dots, dashes and underscores");
      if (!UPSTREAM_KINDS.includes(body.kind))
        throw new HttpError(400, `kind must be one of: ${UPSTREAM_KINDS.join(", ")}`);
      let baseUrl: string;
      try {
        baseUrl = validateUpstreamUrl(body.baseUrl);
      } catch (err) {
        throw new HttpError(400, (err as Error).message);
      }
      if (body.apiKeyEnv !== undefined && body.apiKeyEnv !== null && !/^[A-Z_][A-Z0-9_]{0,63}$/.test(body.apiKeyEnv)) {
        throw new HttpError(400, "apiKeyEnv must be the name of an environment variable, such as ANTHROPIC_API_KEY");
      }
      const models = body.models;
      if (
        !Array.isArray(models) ||
        models.length === 0 ||
        models.length > 50 ||
        models.some((m: unknown) => typeof m !== "string" || m === "" || m.length > 200)
      ) {
        throw new HttpError(400, "models must be a non-empty list of model name patterns, such as claude-*");
      }
      if (c.svc.upstreams.list().some((u) => u.name === name))
        throw new HttpError(409, "an upstream with this name already exists");
      const upstream = c.svc.upstreams.create({
        name,
        kind: body.kind as UpstreamKind,
        baseUrl,
        apiKeyEnv: body.apiKeyEnv ?? null,
        models,
      });
      c.svc.audit.append("upstream.created", label(c.actor), {
        upstreamId: upstream.id,
        name,
        kind: upstream.kind,
        baseUrl: upstream.baseUrl,
        models,
      });
      json(c, 201, { upstream });
    },
  },
  {
    method: "PATCH",
    pattern: /^\/admin\/upstreams\/(\d+)$/,
    role: "owner",
    handler: async (c) => {
      requireAllTeams(c.actor);
      const body = await c.body();
      if (typeof body.enabled !== "boolean") throw new HttpError(400, "enabled must be a boolean");
      const upstream = c.svc.upstreams.setEnabled(Number(c.params[0]), body.enabled);
      if (!upstream) throw new HttpError(404, "upstream not found");
      c.svc.audit.append(body.enabled ? "upstream.enabled" : "upstream.disabled", label(c.actor), {
        upstreamId: upstream.id,
      });
      json(c, 200, { upstream });
    },
  },
  {
    method: "DELETE",
    pattern: /^\/admin\/upstreams\/(\d+)$/,
    role: "owner",
    handler: (c) => {
      requireAllTeams(c.actor);
      if (!c.svc.upstreams.delete(Number(c.params[0]))) throw new HttpError(404, "upstream not found");
      c.svc.audit.append("upstream.deleted", label(c.actor), { upstreamId: Number(c.params[0]) });
      json(c, 200, { deleted: true });
    },
  },
];

/** How many operations the admin API has. A test compares this with the OpenAPI file so the two cannot drift apart. */
export const ADMIN_OPERATION_COUNT = routes.length;

/**
 * Handles `/admin/*` and `/metrics`. Returns false when the path is not one of them, so the caller can move on.
 * Roles and team limits are checked here, once, before any handler runs.
 */
export async function handleAdmin(
  svc: Services,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith("/admin/") && path !== "/metrics") return false;

  const actor = authenticateAdmin(svc, req);

  let pathMatched = false;
  for (const route of routes) {
    const match = route.pattern.exec(path);
    if (!match) continue;
    pathMatched = true;
    if (route.method !== req.method) continue;
    if (ROLE_LEVEL[actor.role] < ROLE_LEVEL[route.role]) {
      throw new HttpError(403, `this needs the ${route.role} role or higher`, "permission_error");
    }
    let cached: Promise<Body> | undefined;
    const ctx: Ctx = {
      svc,
      req,
      res,
      url,
      actor,
      params: match.slice(1),
      body: () => (cached ??= readBody(req).then(parseJsonObject)),
    };
    await route.handler(ctx);
    return true;
  }
  if (pathMatched) throw new HttpError(405, "method not allowed");
  return false;
}
