import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { harness, type Harness } from "./helpers.js";

describe("roles and team scope", () => {
  let h: Harness;
  let owner: string;
  let viewer: string;
  let approver: string;
  let admin: string;
  let supportAdmin: string;
  let supportViewer: string;
  let supportApprover: string;
  let supportKey: string;
  let financeKey: string;
  let supportAgentId: string;
  let financeAgentId: string;

  before(async () => {
    h = await harness();
    await h.admin("/admin/teams", "POST", { id: "support", name: "Support" });
    await h.admin("/admin/teams", "POST", { id: "finance", name: "Finance" });
    owner = await h.newUser("owner");
    viewer = await h.newUser("viewer");
    approver = await h.newUser("approver");
    admin = await h.newUser("admin");
    supportAdmin = await h.newUser("admin", "support");
    supportViewer = await h.newUser("viewer", "support");
    supportApprover = await h.newUser("approver", "support");

    supportKey = await h.newAgent({ team: "support" });
    financeKey = await h.newAgent({ team: "finance" });
    const agents = (await h.admin("/admin/agents")).json.agents;
    supportAgentId = agents.find((a: any) => a.team === "support").id;
    financeAgentId = agents.find((a: any) => a.team === "finance").id;
    await h.chat(supportKey, "hello from support");
    await h.chat(financeKey, "hello from finance");
  });
  after(() => h.close());

  it("reports who is calling", async () => {
    assert.deepEqual((await h.admin("/admin/me")).json.actor, {
      id: "bootstrap",
      name: "bootstrap",
      role: "owner",
      team: null,
    });
    const me = (await h.admin("/admin/me", "GET", undefined, supportAdmin)).json.actor;
    assert.equal(me.role, "admin");
    assert.equal(me.team, "support");
  });

  it("lets a viewer read but not change anything", async () => {
    assert.equal((await h.admin("/admin/agents", "GET", undefined, viewer)).status, 200);
    assert.equal((await h.admin("/admin/summary", "GET", undefined, viewer)).status, 200);
    assert.equal((await h.admin("/admin/agents", "POST", { name: "x" }, viewer)).status, 403);
    assert.equal((await h.admin(`/admin/agents/${supportAgentId}`, "PATCH", { disabled: true }, viewer)).status, 403);
    assert.equal((await h.admin("/admin/policy", "PUT", {}, viewer)).status, 403);
    assert.equal((await h.admin("/admin/users", "GET", undefined, viewer)).status, 403);
  });

  it("lets an approver decide approvals but not manage agents", async () => {
    await h.admin("/admin/policy", "PUT", { tools: [{ tool: "refund", action: "require_approval" }] });
    const held = (await (await h.chat(supportKey, '[[tool:refund {"amount":500}]]')).json()) as any;
    assert.equal((await h.admin("/admin/agents", "POST", { name: "x" }, approver)).status, 403);
    assert.equal(
      (await h.admin(`/admin/approvals/${held.approval_id}/approve`, "POST", undefined, viewer)).status,
      403,
    );
    assert.equal(
      (await h.admin(`/admin/approvals/${held.approval_id}/approve`, "POST", undefined, approver)).status,
      200,
    );
    await h.admin("/admin/policy", "PUT", {});
  });

  it("lets an admin manage agents and team policy but not the organization", async () => {
    assert.equal(
      (await h.admin("/admin/agents", "POST", { name: "made-by-admin", team: "finance" }, admin)).status,
      201,
    );
    assert.equal(
      (await h.admin("/admin/policy", "PUT", {}, admin)).status,
      403,
      "only an owner changes the organization policy",
    );
    assert.equal((await h.admin("/admin/policy?team=finance", "PUT", { tools: [] }, admin)).status, 200);
    assert.equal((await h.admin("/admin/users", "POST", { name: "x", role: "viewer" }, admin)).status, 403);
    assert.equal((await h.admin("/admin/upstreams", "POST", {}, admin)).status, 403);
  });

  it("limits a team-scoped admin to its own team", async () => {
    assert.equal(
      (await h.admin("/admin/agents", "POST", { name: "mine" }, supportAdmin)).json.agent.team,
      "support",
      "defaults to its own team",
    );
    assert.equal(
      (await h.admin("/admin/agents", "POST", { name: "theirs", team: "finance" }, supportAdmin)).status,
      403,
    );
    assert.equal(
      (await h.admin(`/admin/agents/${financeAgentId}`, "PATCH", { disabled: true }, supportAdmin)).status,
      403,
    );
    assert.equal(
      (await h.admin(`/admin/agents/${financeAgentId}/rotate-key`, "POST", undefined, supportAdmin)).status,
      403,
    );
    assert.equal(
      (await h.admin(`/admin/agents/${supportAgentId}`, "PATCH", { team: "finance" }, supportAdmin)).status,
      403,
      "cannot move an agent out of the team",
    );
    assert.equal((await h.admin("/admin/policy?team=finance", "PUT", {}, supportAdmin)).status, 403);
    assert.equal((await h.admin("/admin/policy?team=support", "PUT", {}, supportAdmin)).status, 200);
    assert.equal((await h.admin("/admin/policy", "PUT", {}, supportAdmin)).status, 403);
  });

  it("shows a team-scoped user only that team's data", async () => {
    const agents = (await h.admin("/admin/agents", "GET", undefined, supportViewer)).json.agents;
    assert.ok(agents.length >= 1 && agents.every((a: any) => a.team === "support"));
    const requests = (await h.admin("/admin/requests", "GET", undefined, supportViewer)).json.requests;
    assert.ok(requests.length >= 1 && requests.every((r: any) => r.agentId !== financeAgentId));
    const all = (await h.admin("/admin/summary")).json.summary.requests;
    const scoped = (await h.admin("/admin/summary", "GET", undefined, supportViewer)).json.summary.requests;
    assert.ok(scoped < all);
    const teams = (await h.admin("/admin/teams", "GET", undefined, supportViewer)).json.teams;
    assert.deepEqual(
      teams.map((t: any) => t.id),
      ["support"],
    );
    const series = (await h.admin("/admin/timeseries?hours=2", "GET", undefined, supportViewer)).json.buckets;
    assert.equal(
      series.reduce((n: number, b: any) => n + b.total, 0),
      scoped,
    );
    assert.ok(!(await h.admin("/metrics", "GET", undefined, supportViewer)).json.includes("wicket_agents 0"));
  });

  it("lets an owner filter by team and ignores a team filter from a scoped user", async () => {
    const financeOnly = (await h.admin("/admin/agents?team=finance")).json.agents;
    assert.ok(financeOnly.length >= 1 && financeOnly.every((a: any) => a.team === "finance"));
    const stillSupport = (await h.admin("/admin/agents?team=finance", "GET", undefined, supportViewer)).json.agents;
    assert.ok(
      stillSupport.every((a: any) => a.team === "support"),
      "a scoped user cannot widen its view",
    );
  });

  it("keeps the audit trail away from team-scoped users", async () => {
    assert.equal((await h.admin("/admin/audit", "GET", undefined, supportViewer)).status, 403);
    assert.equal((await h.admin("/admin/audit/verify", "GET", undefined, supportAdmin)).status, 403);
    assert.equal((await h.admin("/admin/audit", "GET", undefined, viewer)).status, 200);
  });

  it("keeps approvals inside their team", async () => {
    // Earlier tests gave finance and support policies of their own. Remove them so the organization rule applies.
    await h.admin("/admin/policy?team=finance", "DELETE");
    await h.admin("/admin/policy?team=support", "DELETE");
    await h.admin("/admin/policy", "PUT", { tools: [{ tool: "refund", action: "require_approval" }] });
    const held = (await (await h.chat(financeKey, '[[tool:refund {"amount":900}]]')).json()) as any;
    assert.ok(held.approval_id, "the call must be held for this test to mean anything");
    const pending = (await h.admin("/admin/approvals?status=pending", "GET", undefined, supportViewer)).json.approvals;
    assert.ok(!pending.some((a: any) => a.id === held.approval_id), "support cannot see finance's approval");
    assert.equal(
      (await h.admin(`/admin/approvals/${held.approval_id}/approve`, "POST", undefined, supportApprover)).status,
      403,
    );
    assert.equal((await h.admin(`/admin/approvals/${held.approval_id}/deny`, "POST", undefined, owner)).status, 200);
    await h.admin("/admin/policy", "PUT", {});
  });

  it("rejects a disabled admin user", async () => {
    const created = await h.admin("/admin/users", "POST", { name: "temp", role: "viewer" });
    assert.equal((await h.admin("/admin/me", "GET", undefined, created.json.key)).status, 200);
    assert.equal((await h.admin(`/admin/users/${created.json.user.id}`, "PATCH", { disabled: true })).status, 200);
    assert.equal((await h.admin("/admin/me", "GET", undefined, created.json.key)).status, 401);
    assert.equal((await h.admin(`/admin/users/${created.json.user.id}`, "PATCH", { disabled: false })).status, 200);
    assert.equal((await h.admin("/admin/me", "GET", undefined, created.json.key)).status, 200);
  });

  it("validates users and teams", async () => {
    assert.equal((await h.admin("/admin/users", "POST", { name: "x", role: "superuser" })).status, 400);
    assert.equal((await h.admin("/admin/users", "POST", { name: "x", role: "viewer", team: "nope" })).status, 404);
    assert.equal((await h.admin("/admin/users", "POST", { name: "x", role: "viewer", team: "Bad Team" })).status, 400);
    assert.equal((await h.admin("/admin/teams", "POST", { id: "Bad Id" })).status, 400);
    assert.equal((await h.admin("/admin/teams", "POST", { id: "support" })).status, 409);
    assert.equal(
      (await h.admin("/admin/teams/support", "PATCH", { name: "Customer Support" })).json.team.name,
      "Customer Support",
    );
    assert.equal((await h.admin("/admin/teams/ghost", "PATCH", { name: "x" })).status, 404);
  });

  it("never shows admin key material", async () => {
    const users = JSON.stringify((await h.admin("/admin/users")).json);
    for (const key of [owner, viewer, approver, admin]) assert.ok(!users.includes(key));
    assert.ok(!users.includes("key_hash") && !users.includes("keyHash"));
  });

  it("rotates an agent key and kills the old one at once", async () => {
    const old = await h.newAgent();
    const id = (await h.admin("/admin/agents")).json.agents.at(-1).id;
    assert.equal((await h.chat(old, "before")).status, 200);
    const rotated = await h.admin(`/admin/agents/${id}/rotate-key`, "POST");
    assert.equal(rotated.status, 200);
    assert.equal((await h.chat(old, "after")).status, 401);
    assert.equal((await h.chat(rotated.json.key, "after")).status, 200);
    assert.equal((await h.admin("/admin/agents/agent_missing/rotate-key", "POST")).status, 404);
  });

  it("does not show a scoped user another team's policy, through the simulator or the policy list", async () => {
    await h.admin("/admin/policy?team=finance", "PUT", {
      tools: [{ tool: "wire_*", action: "deny", reason: "finance-only rule" }],
    });
    try {
      const probe = { toolCall: { name: "wire_funds", args: {} } };
      const other = await h.admin("/admin/policy/simulate", "POST", { team: "finance", ...probe }, supportViewer);
      assert.equal(other.status, 403, "another team's policy is not readable through a simulation");
      assert.ok(!JSON.stringify(other.json).includes("finance-only"));

      const own = await h.admin("/admin/policy/simulate", "POST", { team: "support", ...probe }, supportViewer);
      assert.equal(own.status, 200, "its own team is fine");
      assert.equal(own.json.tool.action, "allow");

      const owner = await h.admin("/admin/policy/simulate", "POST", { team: "finance", ...probe });
      assert.equal(owner.json.tool.action, "deny", "someone with access to every team still can");

      const plain = await h.admin("/admin/policy/simulate", "POST", probe, supportViewer);
      assert.equal(plain.json.tool.action, "allow", "with no team a scoped user simulates their own team");

      const list = (await h.admin("/admin/policy", "GET", undefined, supportViewer)).json;
      assert.ok(!list.teamsWithPolicy.includes("finance"), "other teams are not listed");
      assert.ok((await h.admin("/admin/policy")).json.teamsWithPolicy.includes("finance"), "an owner sees them");
    } finally {
      await h.admin("/admin/policy?team=finance", "DELETE");
    }
  });

  it("records who did what in the audit trail", async () => {
    const events = (await h.admin("/admin/audit?limit=300")).json.events;
    assert.ok(events.some((e: any) => e.type === "agent.created" && e.actor === "admin:admin-4"));
    assert.ok(events.some((e: any) => e.type === "user.created" && e.actor === "owner:bootstrap"));
    assert.ok(events.some((e: any) => e.type === "agent.key_rotated"));
    assert.ok(events.some((e: any) => e.type === "approval.approved" && e.actor === "approver:approver-3"));
  });
});

describe("team policy", () => {
  let h: Harness;
  before(async () => {
    h = await harness();
    await h.admin("/admin/teams", "POST", { id: "finance" });
    await h.admin("/admin/teams", "POST", { id: "support" });
  });
  after(() => h.close());

  it("lets a team override the organization policy and fall back when it is removed", async () => {
    await h.admin("/admin/policy", "PUT", { tools: [] });
    await h.admin("/admin/policy?team=finance", "PUT", {
      tools: [{ tool: "delete_*", action: "deny", reason: "finance never deletes" }],
    });
    const finance = await h.newAgent({ team: "finance" });
    const support = await h.newAgent({ team: "support" });

    const blocked = await h.chat(finance, "[[tool:delete_row {}]]");
    assert.equal(blocked.status, 403);
    assert.match(((await blocked.json()) as any).error.message, /finance never deletes/);
    assert.equal(
      (await h.chat(support, "[[tool:delete_row {}]]")).status,
      200,
      "other teams follow the organization policy",
    );

    assert.equal((await h.admin("/admin/policy?team=finance", "DELETE")).status, 200);
    assert.equal((await h.chat(finance, "[[tool:delete_row {}]]")).status, 200);
    assert.equal((await h.admin("/admin/policy?team=finance", "DELETE")).status, 404);
  });

  it("reports whether a team has its own policy", async () => {
    let r = (await h.admin("/admin/policy?team=support")).json;
    assert.equal(r.policy, null);
    assert.equal(r.inherited, true);
    await h.admin("/admin/policy?team=support", "PUT", { redaction: { mode: "block", detectors: ["email"] } });
    r = (await h.admin("/admin/policy?team=support")).json;
    assert.equal(r.inherited, false);
    assert.equal(r.policy.redaction.mode, "block");
    assert.equal((await h.admin("/admin/policy")).json.teamsWithPolicy.includes("support"), true);
    assert.equal((await h.admin("/admin/teams")).json.teams.find((t: any) => t.id === "support").hasOwnPolicy, true);
    assert.equal((await h.admin("/admin/policy?team=ghost")).status, 404);
    assert.equal((await h.admin("/admin/policy?team=ghost", "PUT", {})).status, 404);
    assert.equal((await h.admin("/admin/policy", "DELETE")).status, 400);
  });

  it("applies a team's redaction mode to that team only", async () => {
    await h.admin("/admin/policy", "PUT", { redaction: { mode: "off" } });
    const support = await h.newAgent({ team: "support" });
    const finance = await h.newAgent({ team: "finance" });
    assert.equal((await h.chat(support, "mail ann@example.com")).status, 400, "support blocks");
    assert.equal(
      (await h.chat(finance, "mail ann@example.com")).status,
      200,
      "finance follows the organization, which is off",
    );
  });
});
