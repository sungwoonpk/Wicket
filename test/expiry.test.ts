import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { expiryFrom, keyExpired } from "../src/gateway/keylife.js";
import { harness } from "./helpers.js";

const DAY = 86_400_000;

describe("key lifetime", () => {
  it("counts a lifetime in days from the moment of issue", () => {
    const from = new Date("2026-03-01T00:00:00.000Z");
    assert.equal(expiryFrom(30, from), "2026-03-31T00:00:00.000Z");
    assert.equal(expiryFrom(null, from), null);
    assert.equal(expiryFrom(undefined, from), null);
  });

  it("treats a key as expired from the moment it runs out, and never when it has no end", () => {
    const at = "2026-03-31T00:00:00.000Z";
    assert.equal(keyExpired(at, new Date("2026-03-30T23:59:59.999Z")), false);
    assert.equal(keyExpired(at, new Date(at)), true);
    assert.equal(keyExpired(at, new Date("2027-01-01")), true);
    assert.equal(keyExpired(null, new Date("2100-01-01")), false);
  });
});

describe("agent key expiry", () => {
  const expire = (h: Awaited<ReturnType<typeof harness>>, id: string) =>
    h.app.db
      .prepare("UPDATE agents SET key_expires_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 1000).toISOString(), id);

  it("gives a key an end date, shows it, and records it", async () => {
    const h = await harness();
    try {
      const created = await h.admin("/admin/agents", "POST", { name: "short-lived", keyTtlDays: 30 });
      assert.equal(created.status, 201);
      const { agent, key } = created.json;
      assert.equal(agent.keyTtlDays, 30);
      const left = Date.parse(agent.keyExpiresAt) - Date.now();
      assert.ok(Math.abs(left - 30 * DAY) < 60_000, `about thirty days from now, got ${left / DAY}`);
      assert.equal((await h.chat(key, "still fine")).status, 200);

      const forever = await h.admin("/admin/agents", "POST", { name: "forever" });
      assert.equal(forever.json.agent.keyExpiresAt, null);
      assert.equal(forever.json.agent.keyTtlDays, null);

      const listed = (await h.admin("/admin/agents")).json.agents.find((a: any) => a.id === agent.id);
      assert.equal(listed.keyExpiresAt, agent.keyExpiresAt);
      const audit = (await h.admin("/admin/audit?limit=10")).json.events.find((e: any) => e.type === "agent.created");
      assert.ok(audit.data.keyExpiresAt === null || typeof audit.data.keyExpiresAt === "string");
    } finally {
      h.close();
    }
  });

  it("refuses an expired key with a message that says so, and logs it", async () => {
    const logs: Record<string, unknown>[] = [];
    const h = await harness({ gateway: { logger: (r) => logs.push(r) } });
    try {
      const { agent, key } = (await h.admin("/admin/agents", "POST", { name: "lapsing", keyTtlDays: 1 })).json;
      expire(h, agent.id);
      const res = await h.chat(key, "too late");
      assert.equal(res.status, 401);
      const error = ((await res.json()) as any).error;
      assert.equal(error.type, "authentication_error");
      assert.match(error.message, /expired.*rotate/);
      assert.ok(logs.some((r) => r.event === "auth.key_expired" && r.agentId === agent.id));
      const poll = await fetch(`${h.base}/v1/approvals/apr_x`, { headers: { authorization: `Bearer ${key}` } });
      assert.equal(poll.status, 401, "the approval poll refuses it too");
    } finally {
      h.close();
    }
  });

  it("slows down a loop that keeps sending an expired key", async () => {
    const h = await harness();
    try {
      const { agent, key } = (await h.admin("/admin/agents", "POST", { name: "looping", keyTtlDays: 1 })).json;
      expire(h, agent.id);
      let throttled = false;
      for (let i = 0; i < 40 && !throttled; i++) throttled = (await h.chat(key, "again")).status === 429;
      assert.ok(throttled, "repeated failures are rate limited like any other");
    } finally {
      h.close();
    }
  });

  it("gives a rotated key the same lifetime again, counted from now", async () => {
    const h = await harness();
    try {
      const { agent, key } = (await h.admin("/admin/agents", "POST", { name: "rotating", keyTtlDays: 7 })).json;
      expire(h, agent.id);
      assert.equal((await h.chat(key, "x")).status, 401);

      const rotated = (await h.admin(`/admin/agents/${agent.id}/rotate-key`, "POST")).json;
      assert.equal(rotated.agent.keyTtlDays, 7);
      const left = Date.parse(rotated.agent.keyExpiresAt) - Date.now();
      assert.ok(Math.abs(left - 7 * DAY) < 60_000);
      assert.equal((await h.chat(rotated.key, "back")).status, 200, "the new key works");
      assert.equal((await h.chat(key, "old")).status, 401, "the old one does not");

      const longer = (await h.admin(`/admin/agents/${agent.id}/rotate-key`, "POST", { keyTtlDays: 90 })).json;
      assert.equal(longer.agent.keyTtlDays, 90);
      const never = (await h.admin(`/admin/agents/${agent.id}/rotate-key`, "POST", { keyTtlDays: null })).json;
      assert.equal(never.agent.keyExpiresAt, null);
      assert.equal(never.agent.keyTtlDays, null);
      assert.equal((await h.admin(`/admin/agents/${agent.id}/rotate-key`, "POST", { keyTtlDays: 0 })).status, 400);

      const audit = (await h.admin("/admin/audit?limit=20")).json.events.filter(
        (e: any) => e.type === "agent.key_rotated",
      );
      assert.equal(audit.length, 3);
      assert.equal(audit[0].data.keyExpiresAt, null, "the newest rotation cleared the expiry");
      assert.equal(typeof audit[2].data.keyExpiresAt, "string", "the oldest gave it a new date");
    } finally {
      h.close();
    }
  });

  it("can change or clear the lifetime on an existing agent, and keeps it when it is not mentioned", async () => {
    const h = await harness();
    try {
      const { agent } = (await h.admin("/admin/agents", "POST", { name: "tuning", keyTtlDays: 10 })).json;
      const before = agent.keyExpiresAt;
      const renamed = (await h.admin(`/admin/agents/${agent.id}`, "PATCH", { name: "tuned" })).json.agent;
      assert.equal(renamed.keyExpiresAt, before, "an unrelated change leaves the expiry alone");
      assert.equal(renamed.keyTtlDays, 10);

      const longer = (await h.admin(`/admin/agents/${agent.id}`, "PATCH", { keyTtlDays: 365 })).json.agent;
      assert.equal(longer.keyTtlDays, 365);
      assert.ok(Date.parse(longer.keyExpiresAt) > Date.parse(before));

      const cleared = (await h.admin(`/admin/agents/${agent.id}`, "PATCH", { keyTtlDays: null })).json.agent;
      assert.equal(cleared.keyExpiresAt, null);
    } finally {
      h.close();
    }
  });

  it("refuses a lifetime that makes no sense", async () => {
    const h = await harness();
    try {
      for (const keyTtlDays of [0, -1, 1.5, 3651, "30", true]) {
        const res = await h.admin("/admin/agents", "POST", { name: "bad", keyTtlDays });
        assert.equal(res.status, 400, JSON.stringify(keyTtlDays));
        assert.match(res.json.error.message, /keyTtlDays/);
      }
    } finally {
      h.close();
    }
  });
});

describe("admin key expiry", () => {
  it("lets an admin key lapse, while the environment token never does", async () => {
    const h = await harness();
    try {
      const made = await h.admin("/admin/users", "POST", { name: "temp-viewer", role: "viewer", keyTtlDays: 1 });
      assert.equal(made.status, 201);
      assert.ok(Math.abs(Date.parse(made.json.user.expiresAt) - Date.now() - DAY) < 60_000);
      const key = made.json.key;
      assert.equal((await h.admin("/admin/me", "GET", undefined, key)).status, 200);

      h.app.db
        .prepare("UPDATE admin_keys SET expires_at = ? WHERE id = ?")
        .run(new Date(Date.now() - 1000).toISOString(), made.json.user.id);
      const lapsed = await h.admin("/admin/me", "GET", undefined, key);
      assert.equal(lapsed.status, 401);
      assert.match(lapsed.json.error.message, /expired/);
      assert.equal((await h.admin("/admin/me")).status, 200, "the environment token still works");

      const listed = (await h.admin("/admin/users")).json.users.find((u: any) => u.id === made.json.user.id);
      assert.equal(typeof listed.expiresAt, "string");
      assert.ok(!JSON.stringify(listed).includes(key));

      const plain = await h.admin("/admin/users", "POST", { name: "keeper", role: "viewer" });
      assert.equal(plain.json.user.expiresAt, null);
      assert.equal((await h.admin("/admin/users", "POST", { name: "x", role: "viewer", keyTtlDays: 0 })).status, 400);
    } finally {
      h.close();
    }
  });
});
