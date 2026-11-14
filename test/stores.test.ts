import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createHash, createHmac } from "node:crypto";
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
import { TeamStore, isTeamSlug } from "../src/gateway/teams.js";
import { AdminKeyStore, ROLE_LEVEL } from "../src/gateway/adminkeys.js";
import { UpstreamStore, validateUpstreamUrl } from "../src/gateway/upstreams.js";

const KEY = "test-signing-key";

describe("AgentStore", () => {
  it("creates agents, authenticates by key and never stores the key", () => {
    const db = openDb();
    const store = new AgentStore(db);
    const { agent, key } = store.create({
      name: "bot",
      team: "support",
      monthlyBudgetUsd: 5,
      allowedModels: ["demo-small"],
    });
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
    const audit = new AuditLog(openDb(), KEY);
    audit.append("agent.created", "admin", { id: "a1" });
    audit.append("policy.updated", "admin");
    audit.append("request.denied", "agent_1", { tool: "delete_all" });
    assert.deepEqual(audit.verify(), { ok: true, checked: 3 });
    const events = audit.recent(10);
    assert.equal(events[0]!.prevHash, events[1]!.hash);
  });

  it("detects an edited event", () => {
    const db = openDb();
    const audit = new AuditLog(db, KEY);
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
    const audit = new AuditLog(db, KEY);
    audit.append("a", "x");
    audit.append("b", "x");
    audit.append("c", "x");
    db.prepare("DELETE FROM audit WHERE seq = 2").run();
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
  });

  it("verifies an empty log", () => {
    assert.deepEqual(new AuditLog(openDb(), KEY).verify(), { ok: true, checked: 0 });
  });

  describe("anchor kept outside the database", () => {
    const digest = (parts: unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");

    /** What someone who holds the database file and the signing key can do: rewrite an event, and everything after it. */
    function rewriteAndResign(db: ReturnType<typeof openDb>, key: string, seq: number, data: unknown) {
      const rows = db.prepare("SELECT * FROM audit WHERE seq >= ? ORDER BY seq").all(seq) as any[];
      let prev =
        (db.prepare("SELECT hash FROM audit WHERE seq = ?").get(seq - 1) as { hash: string } | undefined)?.hash ??
        "0".repeat(64);
      for (const row of rows) {
        const json = row.seq === seq ? JSON.stringify(data) : row.data;
        const hash = digest([prev, row.at, row.type, row.actor, json]);
        db.prepare("UPDATE audit SET data = ?, prev_hash = ?, hash = ? WHERE seq = ?").run(json, prev, hash, row.seq);
        prev = hash;
      }
      const last = db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as {
        seq: number;
        hash: string;
      };
      const mac = createHmac("sha256", key).update(`${last.seq}:${last.hash}`).digest("hex");
      db.prepare("UPDATE audit_head SET seq = ?, hash = ?, mac = ? WHERE id = 1").run(last.seq, last.hash, mac);
    }

    it("reports the newest event, or nothing for an empty log", () => {
      const audit = new AuditLog(openDb(), KEY);
      assert.equal(audit.head(), undefined);
      audit.append("a", "x");
      const second = audit.append("b", "x");
      assert.deepEqual(audit.head(), { seq: 2, hash: second.hash, at: second.at });
    });

    it("confirms an anchor that is still part of the log, also after the log has grown", () => {
      const audit = new AuditLog(openDb(), KEY);
      audit.append("a", "x");
      audit.append("b", "x");
      const anchor = audit.head()!;
      assert.deepEqual(audit.verify(anchor), { ok: true, checked: 2, anchored: true });
      audit.append("c", "x");
      assert.deepEqual(audit.verify({ seq: anchor.seq, hash: anchor.hash }), { ok: true, checked: 3, anchored: true });
    });

    it("catches a rewrite that the chain and the signed head cannot, because they were redone too", () => {
      const db = openDb();
      const audit = new AuditLog(db, KEY);
      audit.append("policy.updated", "owner:ann", { rules: 3 });
      audit.append("request.denied", "agent_1", { tool: "delete_all" });
      const anchor = audit.head()!;
      audit.append("agent.created", "admin", { id: "a2" });

      rewriteAndResign(db, KEY, 2, { tool: "nothing to see" });
      assert.deepEqual(audit.verify(), { ok: true, checked: 3 }, "without an anchor the rewrite is not noticed");
      const result = audit.verify(anchor);
      assert.equal(result.ok, false);
      assert.equal(result.brokenAt, 2);
      assert.match(result.reason!, /not the one that was anchored/);
    });

    it("catches a log that has been cut back past the anchor, and a chain that is broken anyway", () => {
      const db = openDb();
      const audit = new AuditLog(db, KEY);
      audit.append("a", "x");
      audit.append("b", "x");
      const anchor = audit.head()!;
      audit.append("c", "x");
      rewriteAndResign(db, KEY, 1, { cut: true });
      db.prepare("DELETE FROM audit WHERE seq > 1").run();
      rewriteAndResign(db, KEY, 1, { cut: true });
      const cut = audit.verify(anchor);
      assert.equal(cut.ok, false);
      assert.match(cut.reason!, /shorter than the anchor/);

      db.prepare("UPDATE audit SET data = '{}' WHERE seq = 1").run();
      assert.equal(audit.verify(anchor).ok, false, "a broken chain fails first");
      assert.equal(audit.verify(anchor).anchored, undefined);
    });
  });
});

describe("ApprovalQueue", () => {
  const decisions = [
    {
      call: { name: "refund", args: { amount: 500 }, argsValid: true },
      action: "require_approval" as const,
      reason: "large refund",
      ruleIndex: 0,
    },
    {
      call: { name: "lookup", args: {}, argsValid: true },
      action: "allow" as const,
      reason: "default action",
      ruleIndex: null,
    },
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
  const base = {
    agentId: "a",
    model: "m",
    stream: false,
    status: 200,
    latencyMs: 5,
    promptTokens: 10,
    completionTokens: 20,
  };

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
    assert.throws(
      () => parsePolicy({ tools: [{ tool: "x", action: "deny", when: [{ arg: "a", op: "matches", value: "(" }] }] }),
      PolicyError,
    );
    assert.throws(() => parsePolicy({ defaultToolAction: "maybe" }), PolicyError);
  });
});

describe("signed audit head", () => {
  it("detects removal of the newest events, which a plain hash chain cannot", () => {
    const db = openDb();
    const audit = new AuditLog(db, KEY);
    audit.append("a", "x");
    audit.append("b", "x");
    audit.append("c", "x");
    db.prepare("DELETE FROM audit WHERE seq = 3").run();
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.equal(result.brokenAt, 3);
    assert.match(result.reason!, /newest events were removed/);
  });

  it("detects removal of every event", () => {
    const db = openDb();
    const audit = new AuditLog(db, KEY);
    audit.append("a", "x");
    db.prepare("DELETE FROM audit").run();
    assert.equal(audit.verify().ok, false);
  });

  it("cannot be forged by someone who lacks the signing key", () => {
    const db = openDb();
    const audit = new AuditLog(db, KEY);
    audit.append("a", "x");
    audit.append("b", "x");
    db.prepare("DELETE FROM audit WHERE seq = 2").run();
    const last = db.prepare("SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1").get() as {
      seq: number;
      hash: string;
    };
    db.prepare("UPDATE audit_head SET seq = ?, hash = ?, mac = 'guess'").run(last.seq, last.hash);
    const result = audit.verify();
    assert.equal(result.ok, false);
    assert.match(result.reason!, /signed head does not verify/);
  });

  it("does not verify under a different key", () => {
    const db = openDb();
    new AuditLog(db, KEY).append("a", "x");
    assert.equal(new AuditLog(db, "another-key").verify().ok, false);
  });

  it("adopts a database from before signed heads and signs its newest event", () => {
    const db = openDb();
    const first = new AuditLog(db, KEY);
    first.append("a", "x");
    first.append("b", "x");
    db.prepare("DELETE FROM audit_head").run();
    const reopened = new AuditLog(db, KEY);
    assert.equal(reopened.verify().ok, true);
    reopened.append("c", "x");
    assert.deepEqual(reopened.verify(), { ok: true, checked: 3 });
  });

  it("reports a missing head when events exist but nothing was adopted", () => {
    const db = openDb();
    const audit = new AuditLog(db, KEY);
    audit.append("a", "x");
    db.prepare("DELETE FROM audit_head").run();
    assert.equal(audit.verify().ok, false);
  });
});

describe("TeamStore", () => {
  it("creates teams once, lists them and renames them", () => {
    const teams = new TeamStore(openDb());
    assert.deepEqual(
      teams.list().map((t) => t.id),
      ["default"],
    );
    teams.ensure("support", "Support");
    teams.ensure("support", "ignored");
    assert.equal(teams.get("support")?.name, "Support");
    assert.equal(teams.rename("support", "Customer Support")?.name, "Customer Support");
    assert.equal(teams.get("ghost"), undefined);
    assert.equal(teams.list().length, 2);
  });

  it("accepts only lowercase slugs", () => {
    for (const ok of ["a", "support", "team-1", "0day"]) assert.ok(isTeamSlug(ok), ok);
    for (const bad of ["", "Support", "-lead", "has space", "x".repeat(41), "a_b", 5, null, undefined, "a/b"])
      assert.ok(!isTeamSlug(bad), String(bad));
  });
});

describe("AdminKeyStore", () => {
  it("hashes keys, authenticates enabled ones and orders roles", () => {
    const db = openDb();
    new TeamStore(db).ensure("support");
    const store = new AdminKeyStore(db);
    const { adminKey, key } = store.create({ name: "lee", role: "approver", team: "support" });
    assert.ok(key.startsWith("wa_"));
    assert.equal(store.authenticate(key)?.id, adminKey.id);
    assert.equal(store.authenticate("wa_nope"), undefined);
    assert.ok(!JSON.stringify(db.prepare("SELECT * FROM admin_keys").all()).includes(key));
    store.setDisabled(adminKey.id, true);
    assert.equal(store.authenticate(key), undefined);
    assert.equal(store.setDisabled("admin_missing", true), undefined);
    assert.ok(
      ROLE_LEVEL.viewer < ROLE_LEVEL.approver &&
        ROLE_LEVEL.approver < ROLE_LEVEL.admin &&
        ROLE_LEVEL.admin < ROLE_LEVEL.owner,
    );
  });
});

describe("UpstreamStore", () => {
  const store = () => new UpstreamStore(openDb());

  it("falls back when no upstream matches and honors order, case and disabled state", () => {
    const s = store();
    assert.deepEqual(s.resolve("gpt-x", "http://fallback"), {
      name: "default",
      kind: "openai",
      baseUrl: "http://fallback",
      apiKeyEnv: null,
    });
    const a = s.create({
      name: "a",
      kind: "anthropic",
      baseUrl: "https://a.example/",
      apiKeyEnv: "A_KEY",
      models: ["claude-*"],
    });
    s.create({ name: "b", kind: "openai", baseUrl: "https://b.example", models: ["claude-opus*", "gpt-*"] });
    assert.equal(s.resolve("claude-opus-1", "x").name, "a", "first match wins");
    assert.equal(s.resolve("CLAUDE-OPUS-1", "x").name, "a", "case does not matter");
    assert.equal(s.resolve("gpt-4", "x").name, "b");
    assert.equal(s.resolve("claude-opus-1", "x").baseUrl, "https://a.example", "trailing slash removed");
    s.setEnabled(a.id, false);
    assert.equal(s.resolve("claude-opus-1", "x").name, "b");
    assert.equal(s.delete(a.id), true);
    assert.equal(s.delete(a.id), false);
  });

  it("treats a model pattern as a whole-name match", () => {
    const s = store();
    s.create({ name: "a", kind: "openai", baseUrl: "https://a.example", models: ["gpt-4"] });
    assert.equal(s.resolve("gpt-4o", "x").name, "default");
    assert.equal(s.resolve("my-gpt-4", "x").name, "default");
  });

  it("does not let a pattern be used as a regular expression", () => {
    const s = store();
    s.create({ name: "a", kind: "openai", baseUrl: "https://a.example", models: ["a.c", "(x+)+"] });
    assert.equal(s.resolve("abc", "x").name, "default", "the dot is a literal dot");
    assert.equal(s.resolve("a.c", "x").name, "a");
  });
});

describe("validateUpstreamUrl", () => {
  it("accepts ordinary and local addresses and strips trailing slashes", () => {
    assert.equal(validateUpstreamUrl("https://api.anthropic.com/"), "https://api.anthropic.com");
    assert.equal(validateUpstreamUrl("http://localhost:11434"), "http://localhost:11434");
    assert.equal(validateUpstreamUrl("http://10.0.0.5:8000/v1"), "http://10.0.0.5:8000/v1");
  });

  it("refuses metadata services, other schemes, credentials and junk", () => {
    for (const bad of [
      "http://169.254.169.254",
      "http://169.254.0.1/x",
      "http://metadata.google.internal",
      "http://[fd00:ec2::254]/",
      "ftp://x.example",
      "file:///etc/passwd",
      "https://a:b@x.example",
      "x",
      "",
      5,
      null,
    ]) {
      assert.throws(() => validateUpstreamUrl(bad), Error, String(bad));
    }
  });
});

describe("AgentStore extras", () => {
  it("rotates a key so only the new one works, and keeps every setting", () => {
    const store = new AgentStore(openDb());
    const { agent, key } = store.create({ name: "bot", team: "x", monthlyBudgetUsd: 3, maxConcurrent: 2 });
    const rotated = store.rotateKey(agent.id)!;
    assert.equal(store.authenticate(key), undefined);
    assert.equal(store.authenticate(rotated.key)?.id, agent.id);
    assert.equal(rotated.agent.monthlyBudgetUsd, 3);
    assert.equal(rotated.agent.maxConcurrent, 2);
    assert.equal(store.rotateKey("agent_missing"), undefined);
  });

  it("filters the list by team", () => {
    const store = new AgentStore(openDb());
    store.create({ name: "a", team: "one" });
    store.create({ name: "b", team: "two" });
    assert.equal(store.list().length, 2);
    assert.deepEqual(
      store.list("two").map((a) => a.name),
      ["b"],
    );
    assert.deepEqual(store.list("none"), []);
  });
});

describe("RequestStore extras", () => {
  const base = {
    model: "m",
    stream: false,
    status: 200,
    latencyMs: 1,
    promptTokens: 1,
    completionTokens: 1,
    costUsd: 0.5,
  };

  it("scopes summaries, recent requests and filters by team", () => {
    const db = openDb();
    const agents = new AgentStore(db);
    const a = agents.create({ name: "a", team: "one" }).agent;
    const b = agents.create({ name: "b", team: "two" }).agent;
    const store = new RequestStore(db);
    store.add({ ...base, agentId: a.id, outcome: "ok" });
    store.add({ ...base, agentId: a.id, outcome: "denied_tool", status: 403 });
    store.add({ ...base, agentId: b.id, outcome: "ok" });
    assert.equal(store.summary().requests, 3);
    assert.equal(store.summary("one").requests, 2);
    assert.equal(store.summary("two").spendUsd, 0.5);
    assert.equal(store.recent(10, "two").length, 1);
    assert.equal(store.recent(10, null, { outcome: "denied_tool" }).length, 1);
    assert.equal(store.recent(10, null, { agentId: b.id })[0]!.agentName, "b");
  });

  it("builds an hourly series with empty hours filled in", () => {
    const db = openDb();
    const a = new AgentStore(db).create({ name: "a" }).agent;
    const store = new RequestStore(db);
    const now = new Date("2026-11-15T12:30:00Z");
    store.add({ ...base, agentId: a.id, outcome: "ok" }, new Date("2026-11-15T12:10:00Z"));
    store.add({ ...base, agentId: a.id, outcome: "redacted" }, new Date("2026-11-15T12:20:00Z"));
    store.add({ ...base, agentId: a.id, outcome: "ok" }, new Date("2026-11-15T10:05:00Z"));
    store.add({ ...base, agentId: a.id, outcome: "ok" }, new Date("2026-11-14T01:00:00Z"));
    const series = store.timeseries(4, null, now);
    assert.deepEqual(
      series.map((b) => b.bucket),
      ["2026-11-15T09:00:00.000Z", "2026-11-15T10:00:00.000Z", "2026-11-15T11:00:00.000Z", "2026-11-15T12:00:00.000Z"],
    );
    assert.deepEqual(
      series.map((b) => b.total),
      [0, 1, 0, 2],
    );
    assert.deepEqual(series[3]!.byOutcome, { ok: 1, redacted: 1 });
    assert.equal(series[3]!.spendUsd, 1);
  });

  it("lets each budget alert fire once per agent, threshold and month", () => {
    const store = new RequestStore(openDb());
    const nov = new Date("2026-11-15T00:00:00Z");
    assert.equal(store.claimBudgetAlert("a", 80, nov), true);
    assert.equal(store.claimBudgetAlert("a", 80, nov), false);
    assert.equal(store.claimBudgetAlert("a", 100, nov), true);
    assert.equal(store.claimBudgetAlert("b", 80, nov), true);
    assert.equal(store.claimBudgetAlert("a", 80, new Date("2026-12-01T00:00:00Z")), true, "a new month starts again");
  });
});

describe("PolicyStore teams", () => {
  it("stores, resolves and removes a team policy", () => {
    const db = openDb();
    new TeamStore(db).ensure("finance");
    const store = new PolicyStore(db);
    store.set({ defaultToolAction: "allow" });
    assert.equal(store.getTeam("finance"), undefined);
    assert.equal(store.effective("finance").defaultToolAction, "allow");
    store.setTeam("finance", { defaultToolAction: "deny" });
    assert.equal(store.effective("finance").defaultToolAction, "deny");
    assert.equal(store.effective("other").defaultToolAction, "allow");
    assert.deepEqual(store.teamsWithPolicy(), ["finance"]);
    assert.equal(store.deleteTeam("finance"), true);
    assert.equal(store.deleteTeam("finance"), false);
    assert.equal(store.effective("finance").defaultToolAction, "allow");
  });
});

describe("migrations", () => {
  it("brings a version 1 database forward and keeps its data", () => {
    const dir = mkdtempSync(join(tmpdir(), "wicket-"));
    try {
      const path = join(dir, "w.db");
      const db = openDb(path);
      db.exec(
        "PRAGMA user_version = 1; DROP TABLE teams; DROP TABLE team_policies; DROP TABLE admin_keys; DROP TABLE upstreams; DROP TABLE budget_alerts; DROP TABLE audit_head; DROP INDEX requests_at;",
      );
      db.exec("ALTER TABLE agents DROP COLUMN key_ttl_days; ALTER TABLE agents DROP COLUMN key_expires_at");
      db.exec("ALTER TABLE agents DROP COLUMN max_concurrent");
      db.prepare(
        "INSERT INTO agents (id, name, team, key_hash, created_at) VALUES ('agent_old', 'old', 'legacy', 'h', '2026-01-01')",
      ).run();
      db.close();
      const upgraded = openDb(path);
      assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
      assert.ok(new TeamStore(upgraded).get("legacy"), "a team is created for each team an existing agent used");
      assert.equal(new AgentStore(upgraded).get("agent_old")?.maxConcurrent, null);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("brings a version 2 database forward, and its keys keep working without an expiry", () => {
    const dir = mkdtempSync(join(tmpdir(), "wicket-"));
    try {
      const path = join(dir, "w.db");
      const db = openDb(path);
      const created = new AgentStore(db).create({ name: "old-key" });
      const admin = new AdminKeyStore(db).create({ name: "old-admin", role: "viewer", team: null });
      db.exec("PRAGMA user_version = 2");
      db.exec("ALTER TABLE agents DROP COLUMN key_ttl_days; ALTER TABLE agents DROP COLUMN key_expires_at");
      db.exec("ALTER TABLE admin_keys DROP COLUMN expires_at");
      db.close();
      const upgraded = openDb(path);
      assert.equal((upgraded.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 3);
      const agent = new AgentStore(upgraded).authenticate(created.key);
      assert.equal(agent?.keyExpiresAt, null);
      assert.equal(agent?.keyTtlDays, null);
      assert.equal(new AdminKeyStore(upgraded).authenticate(admin.key)?.expiresAt, null);
      upgraded.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("parsePriceTable", () => {
  it("accepts a valid table", async () => {
    const { parsePriceTable } = await import("../src/gateway/pricing.js");
    assert.deepEqual(
      parsePriceTable({ "gpt-x": { inputPerM: 2.5, outputPerM: 10 }, "*": { inputPerM: 1, outputPerM: 1 } })["gpt-x"],
      { inputPerM: 2.5, outputPerM: 10 },
    );
  });

  it("refuses anything that could silently price requests at zero", async () => {
    const { parsePriceTable } = await import("../src/gateway/pricing.js");
    for (const bad of [
      null,
      [],
      "x",
      { m: null },
      { m: { inputPerM: 1 } },
      { m: { inputPerM: -1, outputPerM: 1 } },
      { m: { inputPerM: "1", outputPerM: 1 } },
      { m: { inputPerM: NaN, outputPerM: 1 } },
    ]) {
      assert.throws(() => parsePriceTable(bad), Error, JSON.stringify(bad));
    }
  });
});

describe("caches never serve a stale answer", () => {
  it("policy: every write is visible to the next read", () => {
    const db = openDb();
    new TeamStore(db).ensure("finance");
    const store = new PolicyStore(db);
    assert.equal(store.effective("finance").defaultToolAction, "allow");
    assert.equal(store.effective("finance"), store.effective("finance"), "a repeat read is served from the cache");
    store.set({ defaultToolAction: "deny" });
    assert.equal(store.effective("finance").defaultToolAction, "deny", "organization change seen at once");
    store.setTeam("finance", { defaultToolAction: "require_approval" });
    assert.equal(
      store.effective("finance").defaultToolAction,
      "require_approval",
      "team policy created after a read is seen",
    );
    store.setTeam("finance", { defaultToolAction: "allow" });
    assert.equal(store.effective("finance").defaultToolAction, "allow", "team policy replaced");
    store.deleteTeam("finance");
    assert.equal(store.effective("finance").defaultToolAction, "deny", "removing it falls back to the organization");
    assert.equal(store.getTeam("finance"), undefined);
  });

  it("upstreams: create, disable, enable and delete change routing at once", () => {
    const s = new UpstreamStore(openDb());
    assert.equal(s.resolve("claude-1", "http://fallback").name, "default");
    const u = s.create({ name: "a", kind: "anthropic", baseUrl: "https://a.example", models: ["claude-*"] });
    assert.equal(s.resolve("claude-1", "x").name, "a");
    s.setEnabled(u.id, false);
    assert.equal(s.resolve("claude-1", "x").name, "default");
    s.setEnabled(u.id, true);
    assert.equal(s.resolve("claude-1", "x").name, "a");
    s.delete(u.id);
    assert.equal(s.resolve("claude-1", "x").name, "default");
    assert.deepEqual(s.list(), []);
  });

  it("spend: a recorded request moves the cached total, and months stay apart", () => {
    const db = openDb();
    const store = new RequestStore(db);
    const base = {
      agentId: "a",
      model: "m",
      stream: false,
      status: 200,
      latencyMs: 1,
      promptTokens: 1,
      completionTokens: 1,
      outcome: "ok" as const,
    };
    const nov = new Date("2026-11-15T10:00:00Z");
    const dec = new Date("2026-12-02T10:00:00Z");
    store.add({ ...base, costUsd: 1 }, nov);
    assert.equal(store.spendThisMonth("a", nov), 1, "first read sums what is in the table");
    store.add({ ...base, costUsd: 2 }, nov);
    assert.equal(store.spendThisMonth("a", nov), 3, "a later request updates the cached total");
    store.add({ ...base, costUsd: 5 }, dec);
    assert.equal(store.spendThisMonth("a", nov), 3, "another month does not leak in");
    assert.equal(store.spendThisMonth("a", dec), 5);
    // The cache agrees with the database.
    const sql = (db.prepare("SELECT SUM(cost_usd) AS t FROM requests WHERE at < '2026-12-01'").get() as { t: number })
      .t;
    assert.equal(store.spendThisMonth("a", nov), sql);
  });

  it("prepared statements are reused without mixing up results", () => {
    const db = openDb();
    const a = db.prepare("SELECT ? AS v");
    assert.equal(db.prepare("SELECT ? AS v"), a, "the same SQL gives back the same statement");
    assert.equal((a.get(1) as { v: number }).v, 1);
    assert.equal((db.prepare("SELECT ? AS v").get(2) as { v: number }).v, 2);
  });
});
