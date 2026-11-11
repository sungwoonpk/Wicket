import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createGateway, extractUsage } from "../src/gateway/server.js";
import { ADMIN, harness, listen, type Harness } from "./helpers.js";

describe("proxy basics", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("reports health", async () => {
    assert.deepEqual(await (await fetch(`${h.base}/healthz`)).json(), { status: "ok" });
  });

  it("rejects missing, unknown and disabled agent keys", async () => {
    assert.equal((await h.chat(undefined, "hi")).status, 401);
    assert.equal((await h.chat("wk_unknown", "hi")).status, 401);
    const key = await h.newAgent();
    const id = (await h.admin("/admin/agents")).json.agents.at(-1).id;
    await h.admin(`/admin/agents/${id}`, "PATCH", { disabled: true });
    assert.equal((await h.chat(key, "hi")).status, 403);
    await h.admin(`/admin/agents/${id}`, "PATCH", { disabled: false });
    assert.equal((await h.chat(key, "hi")).status, 200);
  });

  it("proxies a completion and a stream", async () => {
    const key = await h.newAgent();
    const json = (await (await h.chat(key, "hello")).json()) as any;
    assert.equal(json.choices[0].message.content, "mock reply to: hello");
    const streamed = await h.chat(key, "stream me", { stream: true });
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
    assert.ok((await streamed.text()).endsWith("data: [DONE]\n\n"));
  });

  it("passes upstream errors through", async () => {
    const key = await h.newAgent();
    const res = await fetch(`${h.base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: "m" }),
    });
    assert.equal(res.status, 400);
  });

  it("logs requests with tokens and cost, for streams too", async () => {
    const key = await h.newAgent();
    await h.chat(key, "one");
    await h.chat(key, "two", { stream: true });
    const { json } = await h.admin("/admin/requests?limit=2");
    const [streamed, plain] = json.requests;
    assert.equal(plain.outcome, "ok");
    assert.ok(plain.promptTokens > 0 && plain.costUsd > 0);
    assert.equal(streamed.stream, true);
    assert.ok(streamed.completionTokens > 0);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const dead = createGateway({ upstreamUrl: "http://127.0.0.1:1", adminToken: ADMIN });
    try {
      const base = await listen(dead);
      const created = await fetch(`${base}/admin/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "a" }),
      });
      const key = ((await created.json()) as any).key;
      const res = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(res.status, 502);
    } finally {
      dead.close();
    }
  });
});

describe("admin API", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("requires the admin token everywhere", async () => {
    for (const path of ["/admin/agents", "/admin/policy", "/admin/summary", "/admin/audit", "/metrics"]) {
      const res = await fetch(`${h.base}${path}`);
      assert.equal(res.status, 401, path);
    }
    const wrong = await fetch(`${h.base}/admin/agents`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401);
  });

  it("validates agent settings", async () => {
    assert.equal((await h.admin("/admin/agents", "POST", {})).status, 400);
    assert.equal((await h.admin("/admin/agents", "POST", { name: "x", monthlyBudgetUsd: -1 })).status, 400);
    assert.equal((await h.admin("/admin/agents", "POST", { name: "x", ratePerMinute: 1.5 })).status, 400);
    assert.equal((await h.admin("/admin/agents", "POST", { name: "x", allowedModels: "gpt" })).status, 400);
    assert.equal((await h.admin("/admin/agents/agent_missing", "PATCH", { disabled: true })).status, 404);
  });

  it("never lists key material and reports monthly spend", async () => {
    const key = await h.newAgent({ team: "support", monthlyBudgetUsd: 10 });
    await h.chat(key, "spend something");
    const { json } = await h.admin("/admin/agents");
    assert.ok(!JSON.stringify(json).includes(key));
    const agent = json.agents.at(-1);
    assert.equal(agent.team, "support");
    assert.ok(agent.spentThisMonthUsd > 0);
  });

  it("validates and stores the policy", async () => {
    assert.equal((await h.admin("/admin/policy", "PUT", { tools: [{ tool: "x", action: "explode" }] })).status, 400);
    const ok = await h.admin("/admin/policy", "PUT", {
      redaction: { mode: "redact" },
      tools: [{ tool: "x", action: "deny" }],
    });
    assert.equal(ok.status, 200);
    assert.equal((await h.admin("/admin/policy")).json.policy.redaction.mode, "redact");
  });

  it("serves metrics in Prometheus format", async () => {
    const { json } = await h.admin("/metrics");
    assert.match(json, /# TYPE wicket_requests_total counter/);
    assert.match(json, /wicket_agents \d+/);
  });

  it("serves the dashboard under a strict content security policy", async () => {
    const page = await fetch(`${h.base}/dashboard`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type")!, /text\/html/);
    const csp = page.headers.get("content-security-policy")!;
    for (const directive of [
      "default-src 'none'",
      "script-src 'self'",
      "style-src 'self'",
      "frame-ancestors 'none'",
      "connect-src 'self'",
    ]) {
      assert.ok(csp.includes(directive), `missing ${directive}`);
    }
    assert.ok(!csp.includes("unsafe-inline") && !csp.includes("unsafe-eval"));
    assert.equal(page.headers.get("x-frame-options"), "DENY");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match((await fetch(`${h.base}/dashboard/app.js`)).headers.get("content-type")!, /javascript/);
    assert.match((await fetch(`${h.base}/dashboard/app.css`)).headers.get("content-type")!, /css/);
    assert.equal((await fetch(`${h.base}/dashboard/secret.js`)).status, 404, "only the three known files are served");
  });
});

describe("access controls", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  it("denies models that are not on the agent's allow list", async () => {
    const key = await h.newAgent({ allowedModels: ["demo-small"] });
    assert.equal((await h.chat(key, "hi", { model: "demo-small" })).status, 200);
    const res = await h.chat(key, "hi", { model: "demo-large" });
    assert.equal(res.status, 403);
    assert.equal(((await res.json()) as any).error.type, "permission_error");
  });

  it("stops an agent once its monthly budget is spent", async () => {
    const key = await h.newAgent({ monthlyBudgetUsd: 0.0000001 });
    assert.equal((await h.chat(key, "first")).status, 200);
    const res = await h.chat(key, "second");
    assert.equal(res.status, 429);
    assert.equal(((await res.json()) as any).error.type, "budget_exceeded");
  });

  it("rate limits an agent and says when to retry", async () => {
    const key = await h.newAgent({ ratePerMinute: 2 });
    assert.equal((await h.chat(key, "1")).status, 200);
    assert.equal((await h.chat(key, "2")).status, 200);
    const res = await h.chat(key, "3");
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
  });
});

describe("policy enforcement", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    await h.admin("/admin/policy", "PUT", {
      redaction: { mode: "redact", detectors: ["email", "ssn"] },
      defaultToolAction: "allow",
      tools: [
        { tool: "delete_*", action: "deny", reason: "destructive" },
        {
          tool: "refund",
          action: "require_approval",
          when: [{ arg: "amount", op: "gt", value: 100 }],
          reason: "large refund",
        },
      ],
    });
  });
  after(() => h.close());

  it("redacts sensitive data before it reaches the upstream", async () => {
    const key = await h.newAgent();
    const json = (await (await h.chat(key, "contact ann@example.com ssn 123-45-6789")).json()) as any;
    assert.equal(json.choices[0].message.content, "mock reply to: contact [REDACTED:EMAIL] ssn [REDACTED:SSN]");
    const last = (await h.admin("/admin/requests?limit=1")).json.requests[0];
    assert.equal(last.outcome, "redacted");
  });

  it("blocks instead of redacting when the mode is block", async () => {
    await h.admin("/admin/policy", "PUT", { redaction: { mode: "block", detectors: ["email"] } });
    const key = await h.newAgent();
    const res = await h.chat(key, "mail ann@example.com");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as any).error.type, "policy_violation");
    await h.admin("/admin/policy", "PUT", {
      redaction: { mode: "redact", detectors: ["email", "ssn"] },
      tools: [
        { tool: "delete_*", action: "deny", reason: "destructive" },
        {
          tool: "refund",
          action: "require_approval",
          when: [{ arg: "amount", op: "gt", value: 100 }],
          reason: "large refund",
        },
      ],
    });
  });

  it("denies a destructive tool call and does not return it", async () => {
    const key = await h.newAgent();
    const res = await h.chat(key, '[[tool:delete_customer {"id":7}]]');
    assert.equal(res.status, 403);
    const body = (await res.json()) as any;
    assert.equal(body.error.type, "policy_violation");
    assert.match(body.error.message, /delete_customer/);
    assert.ok(!JSON.stringify(body).includes("arguments"), "the denied call's arguments must not be echoed back");
    assert.equal((await h.admin("/admin/requests?limit=1")).json.requests[0].outcome, "denied_tool");
  });

  it("lets an allowed tool call through, streamed or not", async () => {
    const key = await h.newAgent();
    const tools = [{ type: "function", function: { name: "refund" } }];
    const plain = (await (await h.chat(key, '[[tool:refund {"amount":20}]]')).json()) as any;
    assert.equal(plain.choices[0].message.tool_calls[0].function.name, "refund");
    const streamed = await h.chat(key, '[[tool:refund {"amount":20}]]', { stream: true, tools });
    assert.equal(streamed.status, 200);
    assert.equal(streamed.headers.get("content-type"), "text/event-stream");
    assert.ok((await streamed.text()).includes("[DONE]"));
  });

  it("holds a risky tool call until a human approves it", async () => {
    const key = await h.newAgent();
    const held = await h.chat(key, '[[tool:refund {"amount":500}]]');
    assert.equal(held.status, 202);
    const heldBody = (await held.json()) as any;
    assert.equal(heldBody.object, "wicket.approval_required");
    assert.equal(heldBody.tool_calls[0].name, "refund");
    const id = heldBody.approval_id;
    const poll = () => fetch(`${h.base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${key}` } });

    assert.equal((await poll()).status, 202);
    const queue = (await h.admin("/admin/approvals?status=pending")).json.approvals;
    assert.ok(queue.some((a: any) => a.id === id));

    assert.equal((await h.admin(`/admin/approvals/${id}/approve`, "POST")).status, 200);
    assert.equal((await h.admin(`/admin/approvals/${id}/deny`, "POST")).status, 409);
    const released = await poll();
    assert.equal(released.status, 200);
    const completion = (await released.json()) as any;
    assert.equal(completion.choices[0].message.tool_calls[0].function.name, "refund");
  });

  it("keeps a denied approval blocked and hides approvals from other agents", async () => {
    const key = await h.newAgent();
    const other = await h.newAgent();
    const id = ((await (await h.chat(key, '[[tool:refund {"amount":900}]]')).json()) as any).approval_id as string;
    await h.admin(`/admin/approvals/${id}/deny`, "POST");
    const denied = await fetch(`${h.base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(denied.status, 403);
    const stolen = await fetch(`${h.base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${other}` } });
    assert.equal(stolen.status, 404);
    assert.equal((await h.admin("/admin/approvals/apr_missing/approve", "POST")).status, 404);
  });

  it("holds a streamed risky tool call too", async () => {
    const key = await h.newAgent();
    const tools = [{ type: "function", function: { name: "refund" } }];
    const res = await h.chat(key, '[[tool:refund {"amount":500}]]', { stream: true, tools });
    assert.equal(res.status, 202);
  });

  it("writes every decision to a verifiable audit trail", async () => {
    const { json: verify } = await h.admin("/admin/audit/verify");
    assert.equal(verify.ok, true);
    assert.ok(verify.checked > 5);
    const types = new Set((await h.admin("/admin/audit?limit=200")).json.events.map((e: any) => e.type));
    for (const t of [
      "agent.created",
      "policy.updated",
      "request.redacted",
      "tool.denied",
      "approval.requested",
      "approval.approved",
      "approval.denied",
    ]) {
      assert.ok(types.has(t), `missing ${t}`);
    }
  });

  it("detects tampering with the audit trail", async () => {
    h.app.db.prepare("UPDATE audit SET actor = 'someone-else' WHERE seq = 2").run();
    const { json } = await h.admin("/admin/audit/verify");
    assert.equal(json.ok, false);
    assert.equal(json.brokenAt, 2);
  });
});

describe("extractUsage", () => {
  it("reads usage from a JSON body", () => {
    assert.deepEqual(extractUsage('{"usage":{"prompt_tokens":3,"completion_tokens":5}}', false), {
      promptTokens: 3,
      completionTokens: 5,
    });
  });

  it("reads usage from the last SSE event that has it", () => {
    const sse = 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    assert.deepEqual(extractUsage(sse, true), { promptTokens: 1, completionTokens: 2 });
  });

  it("returns nothing for unparseable text", () => {
    assert.deepEqual(extractUsage("not json", false), {});
  });
});
