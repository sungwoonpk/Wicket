import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Agent } from "./agents.js";
import { bearer, clientIp, collect, HttpError, parseJsonObject, readBody, sendJson } from "./http.js";
import { keyExpired } from "./keylife.js";
import { costUsd } from "./pricing.js";
import { meterText, resolveUsage, StreamMeter, type Usage } from "./usage.js";
import type { Outcome } from "./requests.js";
import type { Services } from "./services.js";
import type { Target } from "./upstreams.js";
import {
  callUpstream,
  UnsupportedContentError,
  UpstreamConfigError,
  UpstreamTimeoutError,
  UpstreamUnreachableError,
} from "../providers/index.js";
import { redactMessages, redactText } from "../policy/redact.js";
import { SseSplitter } from "../policy/sse.js";
import { redactSse, StreamRedactor } from "../policy/streamredact.js";
import { decideToolCall, overallAction, toolCallsFromCompletion, toolCallsFromSse } from "../policy/tools.js";
import type { Finding, ToolCall, ToolDecision } from "../policy/types.js";

export { extractUsage } from "./usage.js";

const MAX_BUFFERED_BYTES = 10_000_000;
const MODEL_NAME = /^[\w.:/@+-]{1,200}$/;
const BUDGET_ALERTS: { percent: number; type: string }[] = [
  { percent: 80, type: "budget.warning" },
  { percent: 100, type: "budget.exhausted" },
];

/** Authenticates an agent key. Repeated failures from one address are slowed down. */
export function authenticateAgent(svc: Services, req: IncomingMessage): Agent {
  const key = bearer(req);
  const agent = key ? svc.agents.authenticate(key) : undefined;
  if (!agent) {
    const wait = svc.authFailures.take(`agent:${clientIp(req)}`, 20);
    if (wait > 0)
      throw new HttpError(429, "too many failed attempts, try again later", "rate_limit_error", {
        "retry-after": String(wait),
      });
    throw new HttpError(401, "invalid or missing API key", "authentication_error");
  }
  if (keyExpired(agent.keyExpiresAt)) {
    // The key is the right one, so this is not guessing, but a retry loop should not run unchecked either.
    svc.log({ event: "auth.key_expired", agentId: agent.id, expiredAt: agent.keyExpiresAt });
    const wait = svc.authFailures.take(`agent:${clientIp(req)}`, 20);
    throw new HttpError(
      wait > 0 ? 429 : 401,
      wait > 0 ? "too many failed attempts, try again later" : "this API key has expired, ask an admin to rotate it",
      wait > 0 ? "rate_limit_error" : "authentication_error",
      wait > 0 ? { "retry-after": String(wait) } : {},
    );
  }
  if (agent.disabled) throw new HttpError(403, "this agent is disabled", "permission_error");
  return agent;
}

function validateChatBody(body: Record<string, any>): { model: string; stream: boolean } {
  if (typeof body.model !== "string" || !MODEL_NAME.test(body.model))
    throw new HttpError(400, "model must be a string of 1 to 200 safe characters");
  if (!Array.isArray(body.messages) || body.messages.length === 0)
    throw new HttpError(400, "messages must be a non-empty list");
  for (const m of body.messages) {
    if (m === null || typeof m !== "object" || typeof m.role !== "string")
      throw new HttpError(400, "every message needs a role");
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean")
    throw new HttpError(400, "stream must be true or false");
  return { model: body.model, stream: body.stream === true };
}

function argsDigest(args: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(args)).digest("hex").slice(0, 16);
}

/** What the audit trail and error bodies say about a decision. Argument values stay out: only a digest is kept. */
function describeDecisions(decisions: ToolDecision[]) {
  return decisions.map((d) => ({
    name: d.call.name,
    action: d.action,
    reason: d.reason,
    argsSha256: argsDigest(d.call.args),
  }));
}

function publicDecisions(decisions: ToolDecision[]) {
  return decisions.map((d) => ({ name: d.call.name, action: d.action, reason: d.reason }));
}

function redactCompletion(body: any, detectors: Parameters<typeof redactText>[1]): { findings: Finding[] } {
  const merged = new Map<string, number>();
  const note = (findings: Finding[]) =>
    findings.forEach((f) => merged.set(f.type, (merged.get(f.type) ?? 0) + f.count));
  for (const choice of body?.choices ?? []) {
    const message = choice?.message;
    if (!message) continue;
    if (typeof message.content === "string") {
      const r = redactText(message.content, detectors);
      message.content = r.text;
      note(r.findings);
    }
  }
  return { findings: [...merged].map(([type, count]) => ({ type: type as Finding["type"], count })) };
}

/** Serves `POST /v1/chat/completions`. */
export async function handleChat(svc: Services, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const agent = authenticateAgent(svc, req);

  const running = svc.inFlight.get(agent.id) ?? 0;
  if (agent.maxConcurrent !== null && running >= agent.maxConcurrent) {
    svc.requests.add({
      agentId: agent.id,
      model: "",
      stream: false,
      status: 429,
      latencyMs: 0,
      promptTokens: null,
      completionTokens: null,
      costUsd: 0,
      outcome: "rate_limited",
    });
    throw new HttpError(
      429,
      `this agent may have at most ${agent.maxConcurrent} requests in flight`,
      "rate_limit_error",
      { "retry-after": "1" },
    );
  }
  svc.inFlight.set(agent.id, running + 1);
  try {
    await runChat(svc, agent, req, res);
  } finally {
    const left = (svc.inFlight.get(agent.id) ?? 1) - 1;
    if (left <= 0) svc.inFlight.delete(agent.id);
    else svc.inFlight.set(agent.id, left);
  }
}

async function runChat(svc: Services, agent: Agent, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readBody(req);
  let body = parseJsonObject(raw);
  const { model, stream } = validateChatBody(body);
  const started = performance.now();
  const requestId = String(res.getHeader("x-request-id") ?? "");
  const target: Target = svc.upstreams.resolve(model, svc.options.upstreamUrl);

  const checkBudget = () => {
    const budget = agent.monthlyBudgetUsd;
    if (budget === null || budget <= 0) return;
    const spent = svc.requests.spendThisMonth(agent.id);
    for (const { percent, type } of BUDGET_ALERTS) {
      if (spent >= (budget * percent) / 100 && svc.requests.claimBudgetAlert(agent.id, percent)) {
        svc.audit.append(type, "system", {
          agentId: agent.id,
          name: agent.name,
          spentUsd: spent,
          budgetUsd: budget,
          percent,
        });
        svc.log({ event: type, agentId: agent.id, spentUsd: spent, budgetUsd: budget });
      }
    }
  };

  const record = (outcome: Outcome, status: number, usage: Usage = {}, estimated = false) => {
    const latencyMs = Math.round(performance.now() - started);
    const cost = costUsd(svc.prices, model, usage.promptTokens, usage.completionTokens);
    svc.requests.add({
      agentId: agent.id,
      model,
      stream,
      status,
      outcome,
      latencyMs,
      promptTokens: usage.promptTokens ?? null,
      completionTokens: usage.completionTokens ?? null,
      costUsd: cost,
    });
    svc.log({
      event: "request",
      requestId,
      agentId: agent.id,
      agent: agent.name,
      team: agent.team,
      model,
      upstream: target.name,
      stream,
      status,
      outcome,
      latencyMs,
      costUsd: cost,
      ...(estimated ? { usageEstimated: true } : {}),
    });
    if (cost > 0) checkBudget();
  };

  const refuse = (
    outcome: Outcome,
    status: number,
    message: string,
    type: string,
    auditType: string,
    data: object = {},
    headers: Record<string, string> = {},
  ): never => {
    record(outcome, status);
    svc.audit.append(auditType, agent.id, { model, reason: message, ...data });
    throw new HttpError(status, message, type, headers);
  };

  if (agent.ratePerMinute) {
    const wait = svc.limiter.take(agent.id, agent.ratePerMinute);
    if (wait > 0) {
      record("rate_limited", 429);
      throw new HttpError(429, `rate limit of ${agent.ratePerMinute} requests per minute reached`, "rate_limit_error", {
        "retry-after": String(wait),
      });
    }
  }

  if (agent.allowedModels && !agent.allowedModels.includes(model)) {
    refuse(
      "model_denied",
      403,
      `model "${model}" is not allowed for this agent`,
      "permission_error",
      "request.denied",
      { rule: "allowed_models" },
    );
  }

  if (agent.monthlyBudgetUsd !== null) {
    const spent = svc.requests.spendThisMonth(agent.id);
    if (spent >= agent.monthlyBudgetUsd) {
      refuse("budget_exceeded", 429, "monthly budget exhausted", "budget_exceeded", "request.denied", {
        rule: "monthly_budget",
        spentUsd: spent,
        budgetUsd: agent.monthlyBudgetUsd,
      });
    }
  }

  const policy = svc.policies.effective(agent.team);
  const wantsUsage = body.stream_options?.include_usage === true;
  let redacted = false;
  if (policy.redaction.mode !== "off") {
    const result = redactMessages(body.messages, policy.redaction.detectors);
    if (result.findings.length > 0) {
      if (policy.redaction.mode === "block") {
        refuse(
          "blocked_pii",
          400,
          "request blocked: it contains sensitive data",
          "policy_violation",
          "request.blocked",
          { findings: result.findings },
        );
      }
      body = { ...body, messages: result.messages };
      redacted = true;
      svc.audit.append("request.redacted", agent.id, { model, findings: result.findings });
    }
  }

  // Stop the upstream call when the caller goes away or the upstream takes too long.
  const controller = new AbortController();
  const onClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on("close", onClose);
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(svc.options.upstreamTimeoutMs)]);

  const failUpstream = (err: unknown): never => {
    if (err instanceof UpstreamTimeoutError || (err as Error)?.name === "TimeoutError") {
      record("upstream_error", 504);
      throw new HttpError(504, "the upstream did not answer in time", "upstream_error");
    }
    if (err instanceof UpstreamConfigError) {
      svc.audit.append("upstream.misconfigured", "system", { upstream: target.name, detail: err.message });
      svc.log({ event: "upstream.misconfigured", upstream: target.name, detail: err.message });
      record("upstream_error", 502);
      throw new HttpError(502, "the upstream is not configured correctly", "upstream_error");
    }
    if (err instanceof UnsupportedContentError) {
      record("upstream_error", 400);
      throw new HttpError(400, err.message);
    }
    if ((err as Error)?.name === "AbortError") {
      record("cancelled", 499);
      throw new HttpError(499, "the client closed the request", "cancelled");
    }
    if (err instanceof HttpError) {
      record("upstream_error", err.status);
      throw err;
    }
    record("upstream_error", 502);
    throw new HttpError(
      502,
      err instanceof UpstreamUnreachableError ? err.message : "upstream unreachable",
      "upstream_error",
    );
  };

  try {
    const governsTools = policy.tools.length > 0 || policy.defaultToolAction !== "allow";
    // `functions` is the older name for `tools`, and models answer it with `function_call`.
    const declaresTools =
      (Array.isArray(body.tools) && body.tools.length > 0) ||
      (Array.isArray(body.functions) && body.functions.length > 0);

    let upstream;
    try {
      upstream = await callUpstream(target, body, svc.env, signal);
    } catch (err) {
      return failUpstream(err);
    }

    // The caller asked for a stream, but an upstream may answer with a plain completion or an error body. What came
    // is what gets read, judged and masked, whatever was asked for.
    const sse = stream && /text\/event-stream/i.test(upstream.contentType);
    // A stream has to be held back to judge its tool calls, so only do it when it can matter.
    const buffered = !sse || (governsTools && declaresTools);

    const okOutcome: Outcome = redacted ? "redacted" : "ok";
    const outcomeFor = (status: number): Outcome => (status >= 400 ? "upstream_error" : okOutcome);

    if (!buffered) {
      res.writeHead(upstream.status, { "content-type": upstream.contentType });
      const splitter = new SseSplitter();
      const meter = new StreamMeter();
      const decoder = new TextDecoder();
      // A reply that is streamed straight through is masked as it goes, holding back only what could still turn out
      // to be the start of something sensitive.
      const masker = policy.redaction.mode !== "off" ? new StreamRedactor(policy.redaction.detectors) : undefined;
      const pass = (events: string[]) => {
        for (const event of events) {
          if (meter.observe(event, wantsUsage)) res.write(masker ? masker.push(event) : event);
        }
      };
      // An error status carries no usage and is not charged. Anything else is, estimated if the upstream said nothing.
      const settle = (outcome: Outcome) => {
        const charged =
          upstream.status < 400
            ? resolveUsage(meter.usage, body, meter.chars)
            : { usage: {} as Usage, estimated: false };
        const findings = masker?.findings() ?? [];
        if (findings.length > 0) {
          svc.audit.append("response.redacted", agent.id, { model, findings, streamed: true });
          if (outcome === "ok") outcome = "redacted";
        }
        record(outcome, upstream.status, charged.usage, charged.estimated);
      };
      try {
        for await (const chunk of upstream.chunks) {
          pass(splitter.push(typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true })));
        }
        pass(splitter.flush());
        const rest = masker?.flush();
        if (rest) res.write(rest);
        res.end();
        settle(outcomeFor(upstream.status));
      } catch (err) {
        // Headers are already sent, so the stream can only be cut short.
        res.end();
        settle((err as Error)?.name === "AbortError" ? "cancelled" : "upstream_error");
      }
      return;
    }

    let text: string;
    try {
      text = await collect(upstream.chunks, MAX_BUFFERED_BYTES);
    } catch (err) {
      return failUpstream(err);
    }
    const metered = meterText(text, sse);
    const { usage, estimated } =
      upstream.status < 400
        ? resolveUsage(metered.usage, body, metered.chars)
        : { usage: metered.usage, estimated: false };

    let parsed: any;
    if (upstream.status === 200 && !sse) {
      try {
        parsed = JSON.parse(text);
      } catch {
        record("upstream_error", 502);
        throw new HttpError(502, "the upstream returned a response that is not valid JSON", "upstream_error");
      }
    }

    // Mask the reply before anything is decided about it, so every way out, including a reply that is held and
    // released later, carries the masked text and nothing raw is kept in the approval queue.
    let outText = text;
    let responseFindings: Finding[] = [];
    if (parsed && policy.redaction.mode !== "off") {
      const { findings } = redactCompletion(parsed, policy.redaction.detectors);
      if (findings.length > 0) {
        outText = JSON.stringify(parsed);
        responseFindings = findings;
      }
    }
    if (sse && upstream.status === 200 && policy.redaction.mode !== "off") {
      const masked = redactSse(text, policy.redaction.detectors);
      if (masked.findings.length > 0) {
        outText = masked.text;
        responseFindings = masked.findings;
      }
    }
    const noteMasking = () => {
      if (responseFindings.length > 0)
        svc.audit.append("response.redacted", agent.id, { model, findings: responseFindings });
    };

    if (upstream.status === 200 && governsTools) {
      let calls: ToolCall[];
      try {
        calls = sse ? toolCallsFromSse(text) : toolCallsFromCompletion(parsed);
      } catch {
        // A reply whose tool calls cannot be read cannot be judged, so it is not passed on.
        record("upstream_error", 502, usage, estimated);
        svc.audit.append("tool.unjudgeable", agent.id, { model, upstream: target.name });
        throw new HttpError(
          502,
          "the upstream reply could not be read, so its tool calls could not be judged",
          "upstream_error",
        );
      }
      const decisions = calls.map((call) => decideToolCall(policy, call));
      const action = overallAction(decisions);

      if (action === "deny") {
        record("denied_tool", 403, usage, estimated);
        svc.audit.append("tool.denied", agent.id, { model, decisions: describeDecisions(decisions) });
        const denied = decisions.find((d) => d.action === "deny")!;
        throw new HttpError(
          403,
          `tool call "${denied.call.name}" was denied by policy: ${denied.reason}`,
          "policy_violation",
          {},
          { tool_calls: publicDecisions(decisions) },
        );
      }

      if (action === "require_approval") {
        if (svc.approvals.pendingForAgent(agent.id) >= svc.options.maxPendingApprovalsPerAgent) {
          record("rate_limited", 429, usage, estimated);
          throw new HttpError(429, "this agent has too many tool calls waiting for approval", "rate_limit_error", {
            "retry-after": "30",
          });
        }
        const approval = svc.approvals.hold(agent.id, decisions, { body: outText, contentType: upstream.contentType });
        record("pending_approval", 202, usage, estimated);
        noteMasking();
        svc.audit.append("approval.requested", agent.id, {
          approvalId: approval.id,
          decisions: describeDecisions(decisions.filter((d) => d.action === "require_approval")),
        });
        // Names and reasons only. The arguments can hold anything, so they stay in the queue for the reviewer.
        svc.webhook?.notify("approval.requested", {
          approvalId: approval.id,
          agentId: agent.id,
          agentName: agent.name,
          team: agent.team,
          toolCalls: approval.toolCalls.map((c) => ({ name: c.name, reason: c.reason })),
        });
        sendJson(res, 202, {
          object: "wicket.approval_required",
          approval_id: approval.id,
          status: "pending",
          tool_calls: approval.toolCalls.map((c) => ({ name: c.name, reason: c.reason })),
          poll_url: `/v1/approvals/${approval.id}`,
        });
        return;
      }
    }

    let outcome = outcomeFor(upstream.status);
    if (responseFindings.length > 0) {
      outcome = "redacted";
      noteMasking();
    }

    res.writeHead(upstream.status, { "content-type": upstream.contentType });
    res.end(outText);
    record(outcome, upstream.status, usage, estimated);
  } finally {
    res.off("close", onClose);
  }
}

/** Serves `GET /v1/approvals/:id` for the agent that is waiting on a held tool call. */
export function handleAgentApproval(svc: Services, req: IncomingMessage, res: ServerResponse, id: string): void {
  const agent = authenticateAgent(svc, req);
  const approval = svc.approvals.get(id);
  if (!approval || approval.agentId !== agent.id) throw new HttpError(404, "approval not found");
  if (approval.status === "pending") {
    sendJson(res, 202, { object: "wicket.approval_required", approval_id: id, status: "pending" });
  } else if (approval.status === "denied") {
    throw new HttpError(403, "a human reviewer denied this tool call", "policy_violation");
  } else {
    const stored = svc.approvals.response(id)!;
    res.writeHead(200, { "content-type": stored.contentType });
    res.end(stored.body);
  }
}
