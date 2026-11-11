import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createMockUpstream } from "../src/mock/server.js";
import { createGateway, extractUsage } from "../src/gateway/server.js";

const ADMIN = "test-admin-token";

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

describe("gateway", () => {
  let mock: Server;
  let gateway: Server;
  let base: string;
  let agentKey: string;

  const admin = { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" };
  const chat = (key: string | undefined, body: unknown) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify(body),
    });

  before(async () => {
    mock = createMockUpstream();
    const upstreamUrl = await listen(mock);
    gateway = createGateway({ upstreamUrl, adminToken: ADMIN });
    base = await listen(gateway);

    const res = await fetch(`${base}/admin/keys`, { method: "POST", headers: admin, body: JSON.stringify({ name: "support-bot" }) });
    agentKey = ((await res.json()) as any).key;
  });

  after(() => {
    mock.close();
    gateway.close();
  });

  it("reports health", async () => {
    const res = await fetch(`${base}/healthz`);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("issues keys only to the admin", async () => {
    const res = await fetch(`${base}/admin/keys`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "x" }) });
    assert.equal(res.status, 401);
    const bad = await fetch(`${base}/admin/keys`, { method: "POST", headers: admin, body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
  });

  it("never lists key material", async () => {
    const res = await fetch(`${base}/admin/agents`, { headers: admin });
    const text = await res.text();
    assert.ok(text.includes("support-bot"));
    assert.ok(!text.includes(agentKey));
  });

  it("rejects missing and unknown agent keys", async () => {
    assert.equal((await chat(undefined, { messages: [{ role: "user", content: "hi" }] })).status, 401);
    assert.equal((await chat("wk_unknown", { messages: [{ role: "user", content: "hi" }] })).status, 401);
  });

  it("proxies a completion to the upstream", async () => {
    const res = await chat(agentKey, { model: "m", messages: [{ role: "user", content: "hello" }] });
    assert.equal(res.status, 200);
    const json = (await res.json()) as any;
    assert.equal(json.choices[0].message.content, "mock reply to: hello");
  });

  it("proxies a streamed completion", async () => {
    const res = await chat(agentKey, { messages: [{ role: "user", content: "stream me" }], stream: true });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    assert.ok(text.endsWith("data: [DONE]\n\n"));
  });

  it("passes upstream errors through", async () => {
    const res = await chat(agentKey, { model: "m" });
    assert.equal(res.status, 400);
  });

  it("logs each request with agent, status and token usage", async () => {
    const res = await fetch(`${base}/admin/logs?limit=10`, { headers: admin });
    const { logs } = (await res.json()) as any;
    const ok = logs.find((l: any) => l.status === 200 && !l.stream);
    assert.equal(ok.agentName, "support-bot");
    assert.ok(ok.promptTokens > 0 && ok.completionTokens > 0);
    const streamed = logs.find((l: any) => l.stream && l.status === 200);
    assert.ok(streamed.completionTokens > 0);
  });

  it("returns 502 when the upstream is unreachable", async () => {
    const dead = createGateway({ upstreamUrl: "http://127.0.0.1:1", adminToken: ADMIN });
    const url = await listen(dead);
    const keyRes = await fetch(`${url}/admin/keys`, { method: "POST", headers: admin, body: JSON.stringify({ name: "a" }) });
    const key = ((await keyRes.json()) as any).key;
    const res = await fetch(`${url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(res.status, 502);
    dead.close();
  });
});

describe("extractUsage", () => {
  it("reads usage from a JSON body", () => {
    assert.deepEqual(extractUsage('{"usage":{"prompt_tokens":3,"completion_tokens":5}}', false), { promptTokens: 3, completionTokens: 5 });
  });

  it("reads usage from the last SSE event that has it", () => {
    const sse = 'data: {"choices":[]}\n\ndata: {"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n';
    assert.deepEqual(extractUsage(sse, true), { promptTokens: 1, completionTokens: 2 });
  });

  it("returns nothing for unparseable text", () => {
    assert.deepEqual(extractUsage("not json", false), {});
  });
});
