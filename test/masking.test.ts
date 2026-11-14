import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { harness, type Harness } from "./helpers.js";

const MASK_AND_HOLD = {
  redaction: { mode: "redact", detectors: ["email", "ssn"] },
  tools: [{ tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] }],
};

describe("a reply is masked on every way out", () => {
  let h: Harness;
  let key: string;
  before(async () => {
    h = await harness();
    key = await h.newAgent();
    assert.equal((await h.admin("/admin/policy", "PUT", MASK_AND_HOLD)).status, 200);
  });
  after(() => h.close());

  const poll = (id: string) => fetch(`${h.base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${key}` } });

  it("masks a reply that was held for approval, both in storage and when it is released", async () => {
    const held = await h.chat(key, '[[tool:refund {"amount":500}]][[leak]]');
    assert.equal(held.status, 202);
    const id = ((await held.json()) as any).approval_id;

    const stored = h.app.approvals.response(id)!.body;
    assert.ok(!stored.includes("ann@example.com") && !stored.includes("123-45-6789"), "nothing raw is kept");

    assert.equal((await h.admin(`/admin/approvals/${id}/approve`, "POST")).status, 200);
    const released = await poll(id);
    assert.equal(released.status, 200);
    const body = (await released.json()) as any;
    assert.equal(body.choices[0].message.content, "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
    assert.equal(body.choices[0].message.tool_calls[0].function.name, "refund", "the call itself is untouched");
  });

  it("records that the held reply was masked", async () => {
    const events = (await h.admin("/admin/audit?limit=30")).json.events;
    assert.ok(events.some((e: any) => e.type === "response.redacted"));
  });

  it("releases a reply with nothing to mask exactly as it came", async () => {
    const held = await h.chat(key, '[[tool:refund {"amount":500}]]');
    const id = ((await held.json()) as any).approval_id;
    await h.admin(`/admin/approvals/${id}/approve`, "POST");
    const body = (await (await poll(id)).json()) as any;
    assert.equal(body.choices[0].message.content, null);
  });
});
