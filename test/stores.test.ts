import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/gateway/db.js";
import { AgentStore } from "../src/gateway/agents.js";
import { AuditLog } from "../src/gateway/audit.js";
import { ApprovalQueue } from "../src/gateway/approvals.js";
import { RequestStore, monthStart } from "../src/gateway/requests.js";
import { costUsd, DEFAULT_PRICES } from "../src/gateway/pricing.js";
import { RateLimiter } from "../src/gateway/ratelimit.js";
import { PolicyError, PolicyStore, parsePolicy } from "../src/gateway/policystore.js";
import { DEFAULT_POLICY } from "../src/policy/types.js";

describe("AgentStore", () => {
  it("creates agents, authenticates by key and never stores the key", () => {
    const db = openDb();
    const store = new AgentStore(db);
    const { agent, key } = store.create({ name: "bot", team: "support", monthlyBudgetUsd: 5, allowedModels: ["demo-small"] });
    assert.equal(store.authenticate(key)?.id, agent.id);
    assert.equal(store.authenticate("wk_nope"), undefined);
    assert.equal(agent.team, "support");
    assert.deepEqual(agent.allowedModels, ["demo-small"]);
    const stored = JSON.stringify(db.prepare("SELECT * FROM agents").all());
    assert.ok(!stored.includes(key));
  });

  it("updates settings and can disable an agent", () => {
    const store = new AgentStore(openDb());
    const { agent } = store.create({ name: "bot" });
    const updated = store.update(agent.id, { disabled: true, monthlyBudgetUsd: 2 });
    assert.equal(updated?.disabled, true);
    assert.equal(updated?.monthlyBudgetUsd, 2);
    assert.equal(updated?.name, "bot");
    assert.equal(store.update("agent_missing", { disabled: true }), undefined);
  });

  it("survives a restart when backed by a file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wicket-"));
    try {
      const path = join(dir, "w.db");
      const first = openDb(path);
      const { key } = new AgentStore(first).create({ name: "persisted" });
      first.close();
      const second = openDb(path);
      assert.equal(new AgentStore(second).authenticate(key)?.name, "persisted");
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("AuditLog", () => {
  it("chains events and verifies a clean log", () => {
    const audit = new AuditLog(openDb());
    audit.append("agent.created", "admin", { id: "a1" });
    audit.append("policy.updated", "admin");
    audit.append("request.denied", "agent_1", { tool: "delete_all" });
    assert.deepEqual(audit.verify(), { ok: true, checked: 3 });
    const events = audit.recent(10);
    assert.equal(events[0]!.prevHash, events[1]!.hash);
  });

  it("detects an edited event", () => {
    const db = openDb();
    const audit = new AuditLog(db);
    audit.append("a", "x");
    audit.append("b", "x", { amount: 1 });
    audit.append("c", "x");
    db.prepare("UPDATE audit SET data = ? WHERE seq = 2").run(JSON.stringify({ amount: 999 }));
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 2);
  });

  it("detects a removed event in the middle", () => {
    const db = openDb();
    const audit = new AuditLog(db);
    audit.append("a", "x");
    audit.append("b", "x");
    audit.append("c", "x");
    db.prepare("DELETE FROM audit WHERE seq = 2").run();
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
  });

  it("verifies an empty log", () => {
    assert.deepEqual(new AuditLog(openDb()).verify(), { ok: true, checked: 0 });
  });
});

describe("ApprovalQueue", () => {
  const decisions = [
    { call: { name: "refund", args: { amount: 500 }, argsValid: true }, action: "require_approval" as const, reason: "large refund", ruleIndex: 0 },
    { call: { name: "lookup", args: {}, argsValid: true }, action: "allow" as const, reason: "default action", ruleIndex: null },
  ];

  it("holds a response and releases it only after a single decision", () => {
    const queue = new ApprovalQueue(openDb());
    const a = queue.hold("agent_1", decisions, { body: '{"x":1}', contentType: "application/json" });
    assert.equal(a.status, "pending");
    assert.equal(a.toolCalls.length, 1);
    assert.equal(queue.pendingCount(), 1);
    assert.equal(queue.decide(a.id, "approved", "admin")?.status, "approved");
    assert.equal(queue.decide(a.id, "denied", "admin"), undefined);
    assert.equal(queue.get(a.id)?.status, "approved");
    assert.equal(queue.response(a.id)?.body, '{"x":1}');
    assert.equal(queue.pendingCount(), 0);
  });

  it("filters by status", () => {
    const queue = new ApprovalQueue(openDb());
    const a = queue.hold("agent_1", decisions, { body: "", contentType: "application/json" });
    queue.hold("agent_1", decisions, { body: "", contentType: "application/json" });
    queue.decide(a.id, "denied", "admin");
    assert.equal(queue.list("pending").length, 1);
    assert.equal(queue.list("denied").length, 1);
    assert.equal(queue.list().length, 2);
  });
});

describe("RequestStore", () => {
  const base = { agentId: "a", model: "m", stream: false, status: 200, latencyMs: 5, promptTokens: 10, completionTokens: 20 };

  it("sums spend for the current month only", () => {
    const store = new RequestStore(openDb());
    const now = new Date("2026-11-15T12:00:00Z");
    store.add({ ...base, costUsd: 0.5, outcome: "ok" }, now);
    store.add({ ...base, costUsd: 0.25, outcome: "ok" }, new Date("2026-11-01T00:00:00Z"));
    store.add({ ...base, costUsd: 9, outcome: "ok" }, new Date("2026-10-31T23:59:59Z"));
    assert.equal(store.spendThisMonth("a", now), 0.75);
    assert.equal(store.spendThisMonth("other", now), 0);
    assert.equal(monthStart(now), "2026-11-01T00:00:00.000Z");
  });

  it("summarizes outcomes", () => {
    const store = new RequestStore(openDb());
    store.add({ ...base, costUsd: 1, outcome: "ok" });
    store.add({ ...base, costUsd: 0, outcome: "denied_tool", status: 403 });
    store.add({ ...base, costUsd: 0, outcome: "rate_limited", status: 429 });
    store.add({ ...base, costUsd: 0.5, outcome: "redacted" });
    const s = store.summary();
    assert.equal(s.requests, 4);
    assert.equal(s.blocked, 2);
    assert.equal(s.redacted, 1);
    assert.equal(s.spendUsd, 1.5);
    assert.equal(s.tokens, 120);
  });
});

describe("costUsd", () => {
  it("prices input and output separately", () => {
    assert.equal(costUsd(DEFAULT_PRICES, "demo-large", 1_000_000, 1_000_000), 18);
  });
  it("uses the fallback price for unknown models and treats missing tokens as zero", () => {
    assert.equal(costUsd(DEFAULT_PRICES, "mystery", 1_000_000, null), 1);
    assert.equal(costUsd({}, "x", 5, 5), 0);
  });
});

describe("RateLimiter", () => {
  it("allows a burst up to the limit, then asks the caller to wait, then refills", () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    for (let i = 0; i < 3; i++) assert.equal(limiter.take("a", 3), 0);
    assert.ok(limiter.take("a", 3) > 0);
    assert.equal(limiter.take("b", 3), 0);
    now += 20_000;
    assert.equal(limiter.take("a", 3), 0);
  });
});

describe("policy store", () => {
  it("returns the default policy until one is set, and persists a valid one", () => {
    const store = new PolicyStore(openDb());
    assert.deepEqual(store.get(), DEFAULT_POLICY);
    store.set({ redaction: { mode: "redact" }, tools: [{ tool: "x", action: "deny" }], defaultToolAction: "allow" });
    assert.equal(store.get().redaction.mode, "redact");
    assert.equal(store.get().tools[0]!.action, "deny");
  });

  it("rejects invalid documents", () => {
    assert.throws(() => parsePolicy(null), PolicyError);
    assert.throws(() => parsePolicy({ redaction: { mode: "sometimes" } }), PolicyError);
    assert.throws(() => parsePolicy({ tools: [{ tool: "x", action: "explode" }] }), PolicyError);
    assert.throws(() => parsePolicy({ tools: [{ tool: "x", action: "deny", when: [{ arg: "a", op: "matches", value: "(" }] }] }), PolicyError);
    assert.throws(() => parsePolicy({ defaultToolAction: "maybe" }), PolicyError);
  });
});
