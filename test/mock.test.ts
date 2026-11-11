import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMockUpstream } from "../src/mock/server.js";

describe("mock upstream", () => {
  let server: Server;
  let base: string;

  before(async () => {
    server = createMockUpstream();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  const post = (body: unknown) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("returns a deterministic completion with usage", async () => {
    const res = await post({ model: "m", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.object, "chat.completion");
    assert.equal(json.choices[0].message.content, "mock reply to: hello");
    assert.equal(json.usage.total_tokens, json.usage.prompt_tokens + json.usage.completion_tokens);
  });

  it("streams server-sent events ending with [DONE]", async () => {
    const res = await post({ messages: [{ role: "user", content: "hi there" }], stream: true });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    const content = text
      .split("\n\n")
      .filter((e) => e.startsWith("data: {"))
      .map((e) => JSON.parse(e.slice(6)))
      .map((c) => c.choices[0].delta.content ?? "")
      .join("");
    assert.equal(content, "mock reply to: hi there");
  });

  it("answers with a tool call when the prompt asks for one", async () => {
    const res = await post({ messages: [{ role: "user", content: 'do it [[tool:refund {"amount":500}]]' }] });
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].finish_reason, "tool_calls");
    const call = json.choices[0].message.tool_calls[0];
    assert.equal(call.function.name, "refund");
    assert.deepEqual(JSON.parse(call.function.arguments), { amount: 500 });
  });

  it("streams a tool call in fragments that rebuild to the same arguments", async () => {
    const res = await post({ messages: [{ role: "user", content: 'x [[tool:refund {"amount":500}]]' }], stream: true });
    const events = (await res.text())
      .split("\n\n")
      .filter((e) => e.startsWith("data: {"))
      .map((e) => JSON.parse(e.slice(6)));
    const fragments = events.flatMap((e) => e.choices[0].delta.tool_calls ?? []);
    assert.equal(fragments.length, 2);
    assert.equal(fragments.map((f: any) => f.function.arguments).join(""), '{"amount":500}');
  });

  it("rejects a request without messages", async () => {
    const res = await post({ model: "m" });
    assert.equal(res.status, 400);
  });

  it("rejects invalid JSON", async () => {
    const res = await fetch(`${base}/v1/chat/completions`, { method: "POST", body: "{nope" });
    assert.equal(res.status, 400);
  });

  it("returns 404 for unknown routes", async () => {
    const res = await fetch(`${base}/nope`);
    assert.equal(res.status, 404);
  });
});
