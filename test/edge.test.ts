import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ADMIN, harness, type Harness } from "./helpers.js";

async function waitFor<T>(fn: () => Promise<T | undefined | false>, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > until) throw new Error("condition not met in time");
    await sleep(25);
  }
}

describe("request validation", () => {
  let h: Harness;
  let key: string;
  before(async () => {
    h = await harness();
    key = await h.newAgent();
  });
  after(() => h.close());

  const post = (body: string, headers: Record<string, string> = {}) =>
    fetch(`${h.base}/v1/chat/completions`, { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...headers }, body });
  const errorOf = async (res: Response) => ((await res.json()) as any).error;

  it("refuses bodies that are not JSON objects", async () => {
    for (const body of ["{nope", "[]", '"text"', "null", "42"]) {
      const res = await post(body);
      assert.equal(res.status, 400, body);
      assert.equal((await errorOf(res)).type, "invalid_request_error");
    }
  });

  it("refuses a bad model, messages or stream flag", async () => {
    const ok = [{ role: "user", content: "hi" }];
    for (const body of [
      {},
      { model: 5, messages: ok },
      { model: "", messages: ok },
      { model: "a b", messages: ok },
      { model: "x".repeat(201), messages: ok },
      { model: "m" },
      { model: "m", messages: [] },
      { model: "m", messages: "hello" },
      { model: "m", messages: [null] },
      { model: "m", messages: [{ content: "no role" }] },
      { model: "m", messages: ok, stream: "yes" },
    ]) {
      assert.equal((await post(JSON.stringify(body))).status, 400, JSON.stringify(body).slice(0, 60));
    }
  });

  it("refuses an oversized body before reading it all", async () => {
    const big = JSON.stringify({ model: "m", messages: [{ role: "user", content: "x".repeat(1_100_000) }] });
    assert.equal((await post(big)).status, 413);
  });

  it("gives every response a request id and keeps a safe one from the caller", async () => {
    const mine = await post(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }), { "x-request-id": "trace-123" });
    assert.equal(mine.headers.get("x-request-id"), "trace-123");
    const unsafe = await post("{}", { "x-request-id": "bad id\twith spaces" });
    assert.match(unsafe.headers.get("x-request-id")!, /^[0-9a-f-]{36}$/, "an unsafe id is replaced");
    const body = (await unsafe.json()) as any;
    assert.equal(body.error.request_id, unsafe.headers.get("x-request-id"), "errors carry the id too");
  });

  it("sets security headers and refuses the wrong method", async () => {
    const res = await fetch(`${h.base}/healthz`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal(res.headers.get("referrer-policy"), "no-referrer");
    const wrong = await fetch(`${h.base}/v1/chat/completions`);
    assert.equal(wrong.status, 405);
    assert.equal(wrong.headers.get("allow"), "POST");
    assert.equal((await h.admin("/admin/me", "DELETE")).status, 405);
    assert.equal((await fetch(`${h.base}/nothing-here`)).status, 404);
  });

  it("reports readiness", async () => {
    assert.deepEqual(await (await fetch(`${h.base}/readyz`)).json(), { status: "ready" });
  });

  it("never echoes a key, token or provider secret in an error", async () => {
    const res = await fetch(`${h.base}/v1/chat/completions`, { method: "POST", headers: { authorization: "Bearer wk_secretvalue123", "content-type": "application/json" }, body: "{}" });
    assert.equal(res.status, 401);
    assert.ok(!(await res.text()).includes("secretvalue123"));
  });
});

describe("upstream failures", () => {
  let h: Harness;
  let key: string;
  before(async () => {
    h = await harness({ gateway: { upstreamTimeoutMs: 250 } });
    key = await h.newAgent();
  });
  after(() => h.close());

  const lastRequest = async () => (await h.admin("/admin/requests?limit=1")).json.requests[0];

  it("passes an upstream error status through and logs it", async () => {
    const res = await h.chat(key, "[[status:500]]");
    assert.equal(res.status, 500);
    assert.equal(((await res.json()) as any).error.message, "mock error 500");
    assert.equal((await lastRequest()).outcome, "upstream_error");
  });

  it("passes a rate-limit response through", async () => {
    assert.equal((await h.chat(key, "[[status:429]]")).status, 429);
  });

  it("answers 502 when a successful upstream reply is not JSON", async () => {
    const res = await h.chat(key, "[[badjson]]");
    assert.equal(res.status, 502);
    assert.match(((await res.json()) as any).error.message, /not valid JSON/);
  });

  it("answers 504 when the upstream is too slow", async () => {
    const res = await h.chat(key, "[[slow:1500]]");
    assert.equal(res.status, 504);
    assert.equal((await lastRequest()).outcome, "upstream_error");
  });

  it("stops waiting for the upstream when the caller disconnects", async () => {
    const gone = await harness({ gateway: { upstreamTimeoutMs: 10_000 } });
    try {
      const agent = await gone.newAgent();
      const controller = new AbortController();
      const pending = fetch(`${gone.base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${agent}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content: "[[slow:5000]]" }] }),
        signal: controller.signal,
      }).catch(() => undefined);
      await sleep(150);
      controller.abort();
      await pending;
      const record = await waitFor(async () => {
        const r = (await gone.admin("/admin/requests?limit=1")).json.requests[0];
        return r?.outcome === "cancelled" ? r : undefined;
      });
      assert.equal(record.outcome, "cancelled");
    } finally {
      gone.close();
    }
  });
});

describe("abuse limits", () => {
  it("limits how many requests one agent may have in flight", async () => {
    const h = await harness();
    try {
      const key = await h.newAgent({ maxConcurrent: 1 });
      const slow = h.chat(key, "[[slow:400]]");
      await sleep(100);
      const second = await h.chat(key, "quick");
      assert.equal(second.status, 429);
      assert.equal(second.headers.get("retry-after"), "1");
      assert.equal((await slow).status, 200);
      assert.equal((await h.chat(key, "after")).status, 200, "the slot is released");
    } finally {
      h.close();
    }
  });

  it("caps how many approvals one agent can leave waiting", async () => {
    const h = await harness({ gateway: { maxPendingApprovalsPerAgent: 2 } });
    try {
      await h.admin("/admin/policy", "PUT", { tools: [{ tool: "refund", action: "require_approval" }] });
      const key = await h.newAgent();
      assert.equal((await h.chat(key, '[[tool:refund {"amount":1}]]')).status, 202);
      assert.equal((await h.chat(key, '[[tool:refund {"amount":2}]]')).status, 202);
      const third = await h.chat(key, '[[tool:refund {"amount":3}]]');
      assert.equal(third.status, 429);
      assert.equal(h.app.approvals.pendingCount(), 2, "the third call was not queued");
      const other = await h.newAgent();
      assert.equal((await h.chat(other, '[[tool:refund {"amount":4}]]')).status, 202, "another agent is not affected");
    } finally {
      h.close();
    }
  });

  it("slows down repeated wrong admin tokens, and still accepts the right one", async () => {
    const h = await harness();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 14; i++) statuses.push((await h.admin("/admin/me", "GET", undefined, `wrong-${i}`)).status);
      assert.equal(statuses[0], 401);
      assert.ok(statuses.includes(429), "guessing is cut off");
      const blocked = await h.admin("/admin/me", "GET", undefined, "wrong-again");
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.headers.get("retry-after")) > 0);
      assert.equal((await h.admin("/admin/me")).status, 200, "a valid token is never throttled");
    } finally {
      h.close();
    }
  });

  it("slows down repeated wrong agent keys", async () => {
    const h = await harness();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await h.chat(`wk_guess${i}`, "hi")).status);
      assert.ok(statuses.includes(429));
      const good = await h.newAgent();
      assert.equal((await h.chat(good, "hi")).status, 200);
    } finally {
      h.close();
    }
  });
});

describe("policy bypass attempts", () => {
  let h: Harness;
  let key: string;
  before(async () => {
    h = await harness();
    await h.admin("/admin/policy", "PUT", {
      redaction: { mode: "redact", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
      defaultToolAction: "allow",
      tools: [
        { tool: "delete_*", action: "deny", reason: "destructive" },
        { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }], reason: "large refund" },
        { tool: "fetch", action: "deny", when: [{ arg: "url", op: "matches", value: "^(a+)+$" }], reason: "bad url" },
      ],
    });
    key = await h.newAgent();
  });
  after(() => h.close());

  it("catches a tool name that only differs in case", async () => {
    assert.equal((await h.chat(key, "[[tool:DELETE_Everything {}]]")).status, 403);
  });

  it("holds a refund whose amount is missing, text or malformed", async () => {
    assert.equal((await h.chat(key, "[[tool:refund {}]]")).status, 202, "missing amount");
    assert.equal((await h.chat(key, '[[tool:refund {"amount":"a lot"}]]')).status, 202, "text amount");
    assert.equal((await h.chat(key, "[[tool:refund {broken]]")).status, 202, "broken JSON");
    assert.equal((await h.chat(key, '[[tool:refund {"amount":50}]]')).status, 200, "a small refund still goes through");
  });

  it("masks PII hidden with invisible characters or fullwidth digits", async () => {
    const zeroWidth = (await (await h.chat(key, "mail ann@exa​mple.com now")).json()) as any;
    assert.equal(zeroWidth.choices[0].message.content, "mock reply to: mail [REDACTED:EMAIL] now");
    const fullwidth = (await (await h.chat(key, "ssn １２３-４５-６７８９")).json()) as any;
    assert.equal(fullwidth.choices[0].message.content, "mock reply to: ssn [REDACTED:SSN]");
  });

  it("masks PII in the model's reply, not only in the prompt", async () => {
    const res = await h.chat(key, "[[leak]]");
    const body = (await res.json()) as any;
    assert.equal(body.choices[0].message.content, "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
    const events = (await h.admin("/admin/audit?limit=20")).json.events;
    assert.ok(events.some((e: any) => e.type === "response.redacted"));
  });

  it("keeps a catastrophic regular expression from freezing the gateway", async () => {
    const started = Date.now();
    const res = await h.chat(key, `[[tool:fetch {"url":"${"a".repeat(60)}!"}]]`);
    assert.ok(Date.now() - started < 2000, "the pattern was cut off by its time limit");
    assert.equal(res.status, 403, "an unjudgeable condition meets a deny rule");
  });

  it("keeps argument values out of the audit trail", async () => {
    const held = await h.chat(key, '[[tool:refund {"amount":500,"note":"card-on-file-77-private"}]]');
    assert.equal(held.status, 202);
    const trail = JSON.stringify((await h.admin("/admin/audit?limit=300")).json);
    assert.ok(!trail.includes("card-on-file-77-private"), "values never reach the audit trail");
    assert.match(trail, /argsSha256/, "a digest records what was decided");
    const heldBody = JSON.stringify(await held.json());
    assert.ok(!heldBody.includes("card-on-file-77-private"), "the agent's own 202 does not echo the arguments");
    const queue = JSON.stringify((await h.admin("/admin/approvals?status=pending")).json);
    assert.ok(queue.includes("card-on-file-77-private"), "the reviewer still sees them");
  });
});

describe("budgets", () => {
  it("raises each budget alert once per month", async () => {
    const h = await harness();
    try {
      const key = await h.newAgent({ monthlyBudgetUsd: 0.0000001 });
      assert.equal((await h.chat(key, "first")).status, 200);
      assert.equal((await h.chat(key, "second")).status, 429);
      assert.equal((await h.chat(key, "third")).status, 429);
      const events = (await h.admin("/admin/audit?limit=100")).json.events;
      assert.equal(events.filter((e: any) => e.type === "budget.warning").length, 1);
      assert.equal(events.filter((e: any) => e.type === "budget.exhausted").length, 1);
    } finally {
      h.close();
    }
  });

  it("treats a budget of zero as no spending allowed", async () => {
    const h = await harness();
    try {
      const key = await h.newAgent({ monthlyBudgetUsd: 0 });
      assert.equal((await h.chat(key, "hi")).status, 429);
    } finally {
      h.close();
    }
  });
});

describe("policy simulator and charts", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    await h.admin("/admin/policy", "PUT", { tools: [{ tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] }] });
  });
  after(() => h.close());

  it("judges a tool call against the saved policy without running it", async () => {
    const r = await h.admin("/admin/policy/simulate", "POST", { toolCall: { name: "refund", args: { amount: 500 } } });
    assert.equal(r.json.tool.action, "require_approval");
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { toolCall: { name: "refund", args: '{"amount":5}' } })).json.tool.action, "allow");
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { toolCall: { name: "refund", args: "{bad" } })).json.tool.argumentsValid, false);
  });

  it("judges against an unsaved draft policy", async () => {
    const draft = { tools: [{ tool: "refund", action: "deny" }] };
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { policy: draft, toolCall: { name: "refund", args: {} } })).json.tool.action, "deny");
    assert.equal((await h.admin("/admin/policy")).json.policy.tools[0].action, "require_approval", "the saved policy is untouched");
  });

  it("previews redaction and says whether a request would be blocked", async () => {
    const draft = { redaction: { mode: "block", detectors: ["email"] } };
    const r = await h.admin("/admin/policy/simulate", "POST", { policy: draft, text: "write to ann@example.com" });
    assert.equal(r.json.redaction.text, "write to [REDACTED:EMAIL]");
    assert.equal(r.json.redaction.wouldBlock, true);
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { text: "ann@example.com" })).json.redaction.wouldBlock, false, "the saved policy has redaction off");
  });

  it("rejects bad simulator input", async () => {
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { policy: { defaultToolAction: "maybe" } })).status, 400);
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { toolCall: { args: {} } })).status, 400);
    assert.equal((await h.admin("/admin/policy/simulate", "POST", { text: "x".repeat(20_001) })).status, 400);
  });

  it("returns a bucket for every hour, with this hour's traffic in the last one", async () => {
    const key = await h.newAgent();
    await h.chat(key, "count me");
    const { json } = await h.admin("/admin/timeseries?hours=6");
    assert.equal(json.buckets.length, 6);
    assert.ok(json.buckets.at(-1).total >= 1);
    assert.ok(json.buckets.at(-1).spendUsd > 0);
    assert.equal((await h.admin("/admin/timeseries?hours=100000")).json.hours, 168, "the range is capped");
    assert.equal((await h.admin("/admin/timeseries?hours=abc")).json.hours, 24);
  });

  it("filters requests by outcome and agent", async () => {
    const key = await h.newAgent();
    const id = (await h.admin("/admin/agents")).json.agents.at(-1).id;
    await h.chat(key, "ok one");
    await h.chat(key, "x", { model: "demo-small", stream: "nope" });
    const mine = (await h.admin(`/admin/requests?agent=${id}`)).json.requests;
    assert.ok(mine.length >= 1 && mine.every((r: any) => r.agentId === id));
    assert.equal((await h.admin("/admin/requests?outcome=ok")).json.requests.every((r: any) => r.outcome === "ok"), true);
    assert.equal((await h.admin("/admin/requests?outcome=bad%20value")).status, 400);
  });
});

describe("audit integrity through the API", () => {
  it("notices when the newest events are removed", async () => {
    const h = await harness();
    try {
      const key = await h.newAgent({ allowedModels: ["demo-small"] });
      await h.chat(key, "x", { model: "demo-large" });
      await h.chat(key, "y", { model: "demo-large" });
      assert.equal((await h.admin("/admin/audit/verify")).json.ok, true);
      const last = (h.app.db.prepare("SELECT MAX(seq) AS s FROM audit").get() as { s: number }).s;
      h.app.db.prepare("DELETE FROM audit WHERE seq = ?").run(last);
      const result = (await h.admin("/admin/audit/verify")).json;
      assert.equal(result.ok, false);
      assert.match(result.reason, /newest events were removed/);
    } finally {
      h.close();
    }
  });

  it("notices a forged head", async () => {
    const h = await harness();
    try {
      await h.newAgent();
      h.app.db.prepare("UPDATE audit_head SET mac = 'forged'").run();
      const result = (await h.admin("/admin/audit/verify")).json;
      assert.equal(result.ok, false);
      assert.match(result.reason, /signed head does not verify/);
    } finally {
      h.close();
    }
  });
});

describe("upstream configuration", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
  });
  after(() => h.close());

  const create = (body: Record<string, unknown>) => h.admin("/admin/upstreams", "POST", { name: "u", kind: "anthropic", baseUrl: "https://api.example.com", models: ["claude-*"], ...body });

  it("refuses unsafe or malformed upstream definitions", async () => {
    assert.equal((await create({ baseUrl: "http://169.254.169.254/latest" })).status, 400, "cloud metadata address");
    assert.equal((await create({ baseUrl: "http://169.254.10.20" })).status, 400, "link-local range");
    assert.equal((await create({ baseUrl: "http://metadata.google.internal" })).status, 400);
    assert.equal((await create({ baseUrl: "ftp://example.com" })).status, 400);
    assert.equal((await create({ baseUrl: "https://user:pass@example.com" })).status, 400, "credentials in the URL");
    assert.equal((await create({ baseUrl: "not a url" })).status, 400);
    assert.equal((await create({ kind: "gemini" })).status, 400);
    assert.equal((await create({ apiKeyEnv: "lower-case; rm -rf" })).status, 400);
    assert.equal((await create({ models: [] })).status, 400);
    assert.equal((await create({ name: "bad name!" })).status, 400);
  });

  it("allows a local upstream, since local model servers are normal", async () => {
    const r = await create({ name: "ollama", kind: "openai", baseUrl: "http://localhost:11434/", models: ["llama*"] });
    assert.equal(r.status, 201);
    assert.equal(r.json.upstream.baseUrl, "http://localhost:11434", "trailing slash removed");
    assert.equal((await create({ name: "ollama", kind: "openai", baseUrl: "http://localhost:11434", models: ["x"] })).status, 409);
  });

  it("answers with a generic error when the provider key is not set, and says why in the audit trail", async () => {
    await create({ name: "no-key", kind: "anthropic", baseUrl: h.mockUrl, apiKeyEnv: "SOME_UNSET_KEY", models: ["needs-key-*"] });
    const agent = await h.newAgent();
    const res = await h.chat(agent, "hi", { model: "needs-key-1" });
    assert.equal(res.status, 502);
    const text = JSON.stringify(await res.json());
    assert.ok(!text.includes("SOME_UNSET_KEY"), "the agent is not told which variable is missing");
    const events = (await h.admin("/admin/audit?limit=20")).json.events;
    const event = events.find((e: any) => e.type === "upstream.misconfigured");
    assert.match(JSON.stringify(event.data), /SOME_UNSET_KEY/);
  });

  it("can disable, re-enable and delete an upstream", async () => {
    const list = (await h.admin("/admin/upstreams")).json;
    const id = list.upstreams.find((u: any) => u.name === "ollama").id;
    assert.equal((await h.admin(`/admin/upstreams/${id}`, "PATCH", { enabled: false })).json.upstream.enabled, false);
    assert.equal((await h.admin(`/admin/upstreams/${id}`, "PATCH", { enabled: "no" })).status, 400);
    assert.equal((await h.admin(`/admin/upstreams/${id}`, "DELETE")).status, 200);
    assert.equal((await h.admin(`/admin/upstreams/${id}`, "DELETE")).status, 404);
    assert.equal((await h.admin("/admin/upstreams/99999", "PATCH", { enabled: true })).status, 404);
  });
});

describe("admin token handling", () => {
  it("accepts the bootstrap token even when the database has no admin users", async () => {
    const h = await harness();
    try {
      assert.equal((await h.admin("/admin/users")).json.users.length, 0);
      assert.equal((await h.admin("/admin/me", "GET", undefined, ADMIN)).status, 200);
    } finally {
      h.close();
    }
  });
});
