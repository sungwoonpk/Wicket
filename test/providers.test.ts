import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { harness, type Harness } from "./helpers.js";

describe("routing to an Anthropic upstream", () => {
  let h: Harness;
  let key: string;
  let upstreamId: number;

  before(async () => {
    h = await harness();
    const created = await h.admin("/admin/upstreams", "POST", {
      name: "anthropic",
      kind: "anthropic",
      baseUrl: h.mockUrl,
      apiKeyEnv: "ANTHROPIC_API_KEY",
      models: ["claude-*"],
    });
    upstreamId = created.json.upstream.id;
    key = await h.newAgent();
  });
  after(() => h.close());

  const claude = (content: string, extra: Record<string, unknown> = {}) => h.chat(key, content, { model: "claude-test", ...extra });

  it("sends a matching model to the Anthropic API and answers in OpenAI format", async () => {
    const res = await claude("hello");
    assert.equal(res.status, 200);
    const body = (await res.json()) as any;
    assert.equal(body.id, "msg_mock", "it came from the Anthropic route of the mock");
    assert.equal(body.object, "chat.completion");
    assert.equal(body.choices[0].message.content, "mock reply to: hello");
    assert.equal(body.choices[0].finish_reason, "stop");
    assert.ok(body.usage.prompt_tokens > 0 && body.usage.completion_tokens > 0);
  });

  it("sends other models to the default upstream", async () => {
    const body = (await (await h.chat(key, "hello", { model: "demo-small" })).json()) as any;
    assert.equal(body.id, "chatcmpl-mock");
  });

  it("injects the provider key itself and never shows it to the agent", async () => {
    const res = await claude("hello");
    const text = await res.text();
    assert.equal(res.status, 200, "the mock rejects any request without the right x-api-key");
    assert.ok(!text.includes("test-anthropic-key"));
    assert.ok(![...res.headers.values()].some((v) => v.includes("test-anthropic-key")));
  });

  it("converts system messages, tools and results on the way out", async () => {
    const res = await claude("go", {
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "refund it" },
        { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "refund", arguments: '{"amount":5}' } }] },
        { role: "tool", tool_call_id: "c1", content: "done" },
        { role: "user", content: "thanks" },
      ],
      tools: [{ type: "function", function: { name: "refund", parameters: { type: "object" } } }],
      max_tokens: 20,
    });
    assert.equal(res.status, 200);
  });

  it("streams a text reply as OpenAI chunks with usage and [DONE]", async () => {
    const res = await claude("stream this please", { stream: true });
    assert.equal(res.headers.get("content-type"), "text/event-stream");
    const text = await res.text();
    const chunks = text.split("\n\n").filter((e) => e.startsWith("data: {")).map((e) => JSON.parse(e.slice(6)));
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "mock reply to: stream this please");
    assert.ok(chunks.at(-1).usage.completion_tokens > 0);
    assert.ok(text.endsWith("data: [DONE]\n\n"));
    const logged = (await h.admin("/admin/requests?limit=1")).json.requests[0];
    assert.equal(logged.stream, true);
    assert.ok(logged.completionTokens > 0, "usage is read from the translated stream");
  });

  it("returns a tool call from Anthropic in OpenAI form", async () => {
    const body = (await (await claude('[[tool:lookup {"id":7}]]')).json()) as any;
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), { id: 7 });
  });

  it("applies tool policy to Anthropic tool calls, streamed or not", async () => {
    await h.admin("/admin/policy", "PUT", {
      tools: [
        { tool: "delete_*", action: "deny", reason: "destructive" },
        { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] },
      ],
    });
    const tools = [{ type: "function", function: { name: "refund" } }];
    assert.equal((await claude("[[tool:delete_user {}]]")).status, 403);
    assert.equal((await claude('[[tool:refund {"amount":20}]]')).status, 200);

    const held = await claude('[[tool:refund {"amount":500}]]', { stream: true, tools });
    assert.equal(held.status, 202, "a streamed Anthropic call is held too");
    const id = ((await held.json()) as any).approval_id;
    assert.equal((await h.admin(`/admin/approvals/${id}/approve`, "POST")).status, 200);
    const released = await fetch(`${h.base}/v1/approvals/${id}`, { headers: { authorization: `Bearer ${key}` } });
    assert.equal(released.status, 200);
    const text = await released.text();
    assert.ok(text.includes('"name":"refund"') && text.endsWith("data: [DONE]\n\n"), "released as translated OpenAI chunks");
    await h.admin("/admin/policy", "PUT", {});
  });

  it("refuses image content that the adapter cannot translate", async () => {
    const res = await claude("x", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://x/y.png" } }] }] });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as any).error.message, /only text content/);
  });

  it("converts an Anthropic error into the OpenAI error shape and keeps the status", async () => {
    const res = await claude("[[status:529]]");
    assert.equal(res.status, 529);
    assert.deepEqual(await res.json(), { error: { message: "mock error 529", type: "mock_error" } }, "no Anthropic envelope is left");
  });

  it("passes a provider authentication failure through without leaking the key", async () => {
    const wrong = await harness({ gateway: { env: { ANTHROPIC_API_KEY: "the-wrong-key" } } });
    try {
      await wrong.admin("/admin/upstreams", "POST", { name: "a", kind: "anthropic", baseUrl: wrong.mockUrl, apiKeyEnv: "ANTHROPIC_API_KEY", models: ["claude-*"] });
      const agent = await wrong.newAgent();
      const res = await wrong.chat(agent, "hi", { model: "claude-test" });
      assert.equal(res.status, 401);
      const text = await res.text();
      assert.match(text, /authentication_error/);
      assert.ok(!text.includes("the-wrong-key"));
    } finally {
      wrong.close();
    }
  });

  it("stops routing to a disabled upstream", async () => {
    await h.admin(`/admin/upstreams/${upstreamId}`, "PATCH", { enabled: false });
    assert.equal(((await (await claude("hello")).json()) as any).id, "chatcmpl-mock");
    await h.admin(`/admin/upstreams/${upstreamId}`, "PATCH", { enabled: true });
    assert.equal(((await (await claude("hello")).json()) as any).id, "msg_mock");
  });

  it("matches model patterns without regard to case and uses the first match", async () => {
    await h.admin("/admin/upstreams", "POST", { name: "second", kind: "openai", baseUrl: h.mockUrl, models: ["CLAUDE-*"] });
    assert.equal(((await (await claude("hello")).json()) as any).id, "msg_mock", "the earlier upstream wins");
  });
});
