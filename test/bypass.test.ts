import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import { toolCallsFromCompletion, toolCallsFromSse } from "../src/policy/tools.js";
import { harness, listen, type Harness } from "./helpers.js";

const DENY_DELETE = {
  tools: [{ tool: "delete_*", action: "deny", reason: "no deletes" }],
  defaultToolAction: "allow",
};

const TOOLS = [{ type: "function", function: { name: "delete_row", parameters: { type: "object", properties: {} } } }];
const FUNCTIONS = [{ name: "delete_row", parameters: { type: "object", properties: {} } }];

describe("tool rules cannot be dodged by the way a call is written", () => {
  let h: Harness;
  let key: string;
  before(async () => {
    h = await harness();
    key = await h.newAgent();
    assert.equal((await h.admin("/admin/policy", "PUT", DENY_DELETE)).status, 200);
  });
  after(() => h.close());

  const call = '[[tool:delete_row {"id":1}]]';

  it("judges the older `functions` and `function_call` shape, streamed or not", async () => {
    const plain = await h.chat(key, call, { functions: FUNCTIONS });
    assert.equal(plain.status, 403, "not streamed");
    const streamed = await h.chat(key, call, { functions: FUNCTIONS, stream: true });
    assert.equal(streamed.status, 403, "streamed");
    assert.match(((await streamed.json()) as any).error.message, /no deletes/);
  });

  it("judges a stream framed with CRLF line ends or without a space after `data:`", async () => {
    for (const framing of ["[[crlf]]", "[[bare]]", "[[crlf]][[bare]]"]) {
      const res = await h.chat(key, call + framing, { tools: TOOLS, stream: true });
      assert.equal(res.status, 403, framing);
      const legacy = await h.chat(key, call + framing, { functions: FUNCTIONS, stream: true });
      assert.equal(legacy.status, 403, `${framing} with functions`);
    }
  });

  it("still lets a harmless streamed call through, in every framing", async () => {
    for (const framing of ["", "[[crlf]]", "[[bare]]"]) {
      const res = await h.chat(key, `[[tool:read_row {"id":1}]]${framing}`, { tools: TOOLS, stream: true });
      assert.equal(res.status, 200, framing);
      assert.match(await res.text(), /read_row/);
    }
  });

  it("holds an older-shape call for approval as well", async () => {
    await h.admin("/admin/policy", "PUT", {
      tools: [{ tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] }],
    });
    try {
      const res = await h.chat(key, '[[tool:refund {"amount":500}]]', { functions: [{ name: "refund" }] });
      assert.equal(res.status, 202);
    } finally {
      await h.admin("/admin/policy", "PUT", DENY_DELETE);
    }
  });
});

describe("a reply that cannot be read is refused, not waved through", () => {
  let broken: Server;
  let h: Harness;
  let key: string;
  let body = "";
  before(async () => {
    broken = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(body);
    });
    h = await harness({ gateway: { upstreamUrl: await listen(broken) } });
    key = await h.newAgent();
    await h.admin("/admin/policy", "PUT", DENY_DELETE);
  });
  after(() => {
    h.close();
    broken.closeAllConnections();
    broken.close();
  });

  it("answers 502 when the tool calls cannot be read and the policy governs tools", async () => {
    for (const odd of ['{"choices": 5}', '{"choices": {"a": 1}}']) {
      body = odd;
      const res = await h.chat(key, "hello", { tools: TOOLS });
      assert.equal(res.status, 502, odd);
      assert.equal(((await res.json()) as any).error.type, "upstream_error");
    }
    const events = (await h.admin("/admin/audit?limit=10")).json.events;
    assert.ok(events.some((e: any) => e.type === "tool.unjudgeable"));
  });

  it("passes a reply with nothing to judge", async () => {
    body = '{"choices": [{"message": {"role": "assistant", "content": "fine"}}]}';
    assert.equal((await h.chat(key, "hello", { tools: TOOLS })).status, 200);
    body = '{"id": "no choices at all"}';
    assert.equal((await h.chat(key, "hello", { tools: TOOLS })).status, 200);
  });
});

describe("an upstream that ignores `stream` and answers with plain JSON", () => {
  let upstream: Server;
  let h: Harness;
  let key: string;
  let reply: unknown;
  before(async () => {
    upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply));
    });
    h = await harness({ gateway: { upstreamUrl: await listen(upstream) } });
    key = await h.newAgent();
    await h.admin("/admin/policy", "PUT", {
      redaction: { mode: "redact", detectors: ["email"] },
      tools: [{ tool: "delete_*", action: "deny", reason: "no deletes" }],
    });
  });
  after(() => {
    h.close();
    upstream.closeAllConnections();
    upstream.close();
  });

  const completion = (message: object) => ({
    id: "x",
    object: "chat.completion",
    choices: [{ index: 0, message: { role: "assistant", content: null, ...message }, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 4 },
  });

  it("still judges its tool calls", async () => {
    reply = completion({
      tool_calls: [{ id: "c1", type: "function", function: { name: "delete_row", arguments: "{}" } }],
    });
    const res = await h.chat(key, "go", { stream: true, tools: TOOLS });
    assert.equal(res.status, 403);
  });

  it("still masks its text", async () => {
    reply = completion({ content: "write to ann@example.com" });
    for (const extra of [{ stream: true }, { stream: true, tools: TOOLS }]) {
      const res = await h.chat(key, "go", extra);
      assert.equal(res.status, 200);
      assert.equal(((await res.json()) as any).choices[0].message.content, "write to [REDACTED:EMAIL]");
    }
  });

  it("passes an error answer through as it came", async () => {
    reply = { error: { message: "no such model", type: "invalid_request_error" } };
    const res = await h.chat(key, "go", { stream: true });
    assert.equal(res.status, 200, "this stub answers 200 with an error body, and it is not rewritten");
    assert.equal(((await res.json()) as any).error.message, "no such model");
  });
});

describe("reading tool calls", () => {
  it("reads the older function_call shape from a completion and from a stream", () => {
    const completion = {
      choices: [{ message: { function_call: { name: "delete_row", arguments: '{"id":1}' } } }],
    };
    assert.deepEqual(toolCallsFromCompletion(completion), [
      { id: undefined, name: "delete_row", args: { id: 1 }, argsValid: true },
    ]);
    const sse =
      'data: {"choices":[{"index":0,"delta":{"function_call":{"name":"delete_","arguments":"{\\"id\\""}}}]}\r\n\r\n' +
      'data:{"choices":[{"index":0,"delta":{"function_call":{"name":"row","arguments":":1}"}}}]}\r\n\r\n' +
      "data: [DONE]\r\n\r\n";
    assert.deepEqual(toolCallsFromSse(sse), [{ id: undefined, name: "delete_row", args: { id: 1 }, argsValid: true }]);
  });

  it("keeps a tool call and a legacy call in one reply apart", () => {
    const completion = {
      choices: [
        {
          message: {
            tool_calls: [{ id: "c1", function: { name: "a", arguments: "{}" } }],
            function_call: { name: "b", arguments: "{}" },
          },
        },
      ],
    };
    assert.deepEqual(
      toolCallsFromCompletion(completion).map((c) => c.name),
      ["a", "b"],
    );
  });
});
