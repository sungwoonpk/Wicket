import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fromAnthropicError,
  fromAnthropicResponse,
  StreamTranslator,
  toAnthropicRequest,
  UnsupportedContentError,
} from "../src/providers/anthropic.js";

describe("toAnthropicRequest", () => {
  it("moves system messages out and merges adjacent turns of the same role", () => {
    const out = toAnthropicRequest({
      model: "claude-test",
      messages: [
        { role: "system", content: "Be brief." },
        { role: "system", content: "Be kind." },
        { role: "user", content: "Hi" },
        { role: "user", content: "Are you there?" },
        { role: "assistant", content: "Yes." },
      ],
    });
    assert.equal(out.system, "Be brief.\n\nBe kind.");
    assert.equal(out.max_tokens, 1024, "max_tokens is required by the API and defaults to 1024");
    assert.deepEqual(out.messages, [
      { role: "user", content: [{ type: "text", text: "Hi" }, { type: "text", text: "Are you there?" }] },
      { role: "assistant", content: [{ type: "text", text: "Yes." }] },
    ]);
  });

  it("honors max_tokens, max_completion_tokens, stop and sampling settings", () => {
    const a = toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], max_tokens: 50, stop: "END", temperature: 0.2, top_p: 0.9 });
    assert.equal(a.max_tokens, 50);
    assert.deepEqual(a.stop_sequences, ["END"]);
    assert.equal(a.temperature, 0.2);
    assert.equal(a.top_p, 0.9);
    assert.equal(toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], max_completion_tokens: 77 }).max_tokens, 77);
    assert.deepEqual(toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], stop: ["a", "b"] }).stop_sequences, ["a", "b"]);
  });

  it("converts tools and every tool_choice form", () => {
    const tools = [{ type: "function", function: { name: "refund", description: "Refund an order", parameters: { type: "object", properties: { amount: { type: "number" } } } } }];
    const base = { model: "m", messages: [{ role: "user", content: "x" }], tools };
    const out = toAnthropicRequest({ ...base, tool_choice: "auto" });
    assert.deepEqual(out.tools, [{ name: "refund", description: "Refund an order", input_schema: { type: "object", properties: { amount: { type: "number" } } } }]);
    assert.deepEqual(out.tool_choice, { type: "auto" });
    assert.deepEqual(toAnthropicRequest({ ...base, tool_choice: "required" }).tool_choice, { type: "any" });
    assert.deepEqual(toAnthropicRequest({ ...base, tool_choice: "none" }).tool_choice, { type: "none" });
    assert.deepEqual(toAnthropicRequest({ ...base, tool_choice: { type: "function", function: { name: "refund" } } }).tool_choice, { type: "tool", name: "refund" });
    assert.equal(toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }] }).tools, undefined);
  });

  it("gives a tool without a schema an empty object schema", () => {
    const out = toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], tools: [{ type: "function", function: { name: "ping" } }] });
    assert.deepEqual(out.tools[0].input_schema, { type: "object", properties: {} });
  });

  it("converts a tool-calling turn and its result", () => {
    const out = toAnthropicRequest({
      model: "m",
      messages: [
        { role: "user", content: "refund it" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "refund", arguments: '{"amount":5}' } }] },
        { role: "tool", tool_call_id: "call_1", content: "done" },
        { role: "tool", tool_call_id: "call_2", content: "also done" },
      ],
    });
    assert.deepEqual(out.messages[1], { role: "assistant", content: [{ type: "tool_use", id: "call_1", name: "refund", input: { amount: 5 } }] });
    assert.deepEqual(out.messages[2], {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }, { type: "tool_result", tool_use_id: "call_2", content: "also done" }],
    });
  });

  it("treats unparseable tool arguments as an empty object instead of failing", () => {
    const out = toAnthropicRequest({
      model: "m",
      messages: [{ role: "assistant", tool_calls: [{ id: "c", function: { name: "x", arguments: "{oops" } }] }],
    });
    assert.deepEqual(out.messages[0].content[0].input, {});
  });

  it("accepts text parts and refuses images", () => {
    const ok = toAnthropicRequest({ model: "m", messages: [{ role: "user", content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }] });
    assert.equal(ok.messages[0].content[0].text, "ab");
    assert.throws(
      () => toAnthropicRequest({ model: "m", messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }),
      UnsupportedContentError,
    );
  });

  it("only asks for streaming when the request did", () => {
    assert.equal(toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }] }).stream, undefined);
    assert.equal(toAnthropicRequest({ model: "m", messages: [{ role: "user", content: "x" }], stream: true }).stream, true);
  });
});

describe("fromAnthropicResponse", () => {
  it("converts text and usage", () => {
    const out = fromAnthropicResponse(
      { id: "msg_1", model: "claude-test", content: [{ type: "text", text: "Hello" }, { type: "text", text: " there" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 4 } },
      "claude-test",
    );
    assert.equal(out.object, "chat.completion");
    assert.equal(out.choices[0].message.content, "Hello there");
    assert.equal(out.choices[0].finish_reason, "stop");
    assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it("converts tool use into tool_calls with JSON string arguments", () => {
    const out = fromAnthropicResponse(
      { content: [{ type: "tool_use", id: "toolu_1", name: "refund", input: { amount: 500 } }], stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 } },
      "m",
    );
    const choice = out.choices[0];
    assert.equal(choice.finish_reason, "tool_calls");
    assert.equal(choice.message.content, null);
    assert.deepEqual(choice.message.tool_calls, [{ id: "toolu_1", type: "function", function: { name: "refund", arguments: '{"amount":500}' } }]);
  });

  it("maps stop reasons and tolerates missing fields", () => {
    assert.equal(fromAnthropicResponse({ content: [], stop_reason: "max_tokens" }, "m").choices[0].finish_reason, "length");
    assert.equal(fromAnthropicResponse({ content: [], stop_reason: "something_new" }, "m").choices[0].finish_reason, "stop");
    const bare = fromAnthropicResponse({}, "fallback-model");
    assert.equal(bare.model, "fallback-model");
    assert.deepEqual(bare.usage, { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
  });

  it("keeps text next to tool calls", () => {
    const out = fromAnthropicResponse({ content: [{ type: "text", text: "Checking." }, { type: "tool_use", id: "t", name: "x", input: {} }], stop_reason: "tool_use" }, "m");
    assert.equal(out.choices[0].message.content, "Checking.");
    assert.equal(out.choices[0].message.tool_calls.length, 1);
  });
});

describe("fromAnthropicError", () => {
  it("keeps the message and type in the OpenAI shape", () => {
    assert.deepEqual(fromAnthropicError({ type: "error", error: { type: "overloaded_error", message: "busy" } }), { error: { message: "busy", type: "overloaded_error" } });
    assert.deepEqual(fromAnthropicError({}), { error: { message: "upstream error", type: "upstream_error" } });
  });
});

function sse(event: string, data: object): string {
  return `event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`;
}

function parseChunks(text: string): any[] {
  return text
    .split("\n\n")
    .filter((e) => e.startsWith("data: {"))
    .map((e) => JSON.parse(e.slice(6)));
}

const TEXT_STREAM =
  sse("message_start", { message: { id: "msg_1", model: "claude-test", usage: { input_tokens: 12 } } }) +
  sse("ping", {}) +
  sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hello" } }) +
  sse("content_block_delta", { index: 0, delta: { type: "text_delta", text: " world" } }) +
  sse("content_block_stop", { index: 0 }) +
  sse("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 7 } }) +
  sse("message_stop", {});

describe("StreamTranslator", () => {
  it("turns a text stream into OpenAI chunks ending in usage and [DONE]", () => {
    const t = new StreamTranslator("claude-test");
    const out = t.push(TEXT_STREAM) + t.end();
    const chunks = parseChunks(out);
    assert.equal(chunks[0].choices[0].delta.role, "assistant");
    assert.equal(chunks.map((c) => c.choices[0].delta.content ?? "").join(""), "Hello world");
    const last = chunks.at(-1);
    assert.equal(last.choices[0].finish_reason, "stop");
    assert.deepEqual(last.usage, { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 });
    assert.ok(out.endsWith("data: [DONE]\n\n"));
    assert.equal((out.match(/\[DONE\]/g) ?? []).length, 1, "[DONE] is sent exactly once");
  });

  it("gives the same result however the bytes are split", () => {
    const whole = new StreamTranslator("claude-test");
    const expected = whole.push(TEXT_STREAM) + whole.end();
    const pieces = new StreamTranslator("claude-test");
    let out = "";
    for (let i = 0; i < TEXT_STREAM.length; i += 7) out += pieces.push(TEXT_STREAM.slice(i, i + 7));
    out += pieces.end();
    assert.deepEqual(parseChunks(out).map((c) => c.choices[0].delta), parseChunks(expected).map((c) => c.choices[0].delta));
  });

  it("turns tool use into tool_call deltas that rebuild to the arguments", () => {
    const stream =
      sse("message_start", { message: { id: "msg_2", usage: { input_tokens: 3 } } }) +
      sse("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_1", name: "refund", input: {} } }) +
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: '{"amo' } }) +
      sse("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: 'unt":500}' } }) +
      sse("content_block_stop", { index: 0 }) +
      sse("message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } }) +
      sse("message_stop", {});
    const chunks = parseChunks(new StreamTranslator("m").push(stream));
    const fragments = chunks.flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    assert.equal(fragments[0].id, "toolu_1");
    assert.equal(fragments[0].function.name, "refund");
    assert.equal(fragments.map((f: any) => f.function.arguments).join(""), '{"amount":500}');
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
  });

  it("numbers several tool calls separately", () => {
    const stream =
      sse("message_start", { message: { id: "m" } }) +
      sse("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) +
      sse("content_block_start", { index: 1, content_block: { type: "tool_use", id: "a", name: "one", input: {} } }) +
      sse("content_block_start", { index: 2, content_block: { type: "tool_use", id: "b", name: "two", input: {} } }) +
      sse("content_block_delta", { index: 2, delta: { type: "input_json_delta", partial_json: "{}" } }) +
      sse("message_stop", {});
    const fragments = parseChunks(new StreamTranslator("m").push(stream)).flatMap((c) => c.choices[0].delta.tool_calls ?? []);
    assert.deepEqual(fragments.filter((f: any) => f.id).map((f: any) => [f.index, f.function.name]), [[0, "one"], [1, "two"]]);
    assert.equal(fragments.find((f: any) => f.function.arguments === "{}").index, 1);
  });

  it("passes an upstream error event through and stops", () => {
    const t = new StreamTranslator("m");
    const out = t.push(sse("message_start", { message: { id: "m" } }) + sse("error", { error: { type: "overloaded_error", message: "busy" } }));
    assert.ok(out.includes('"overloaded_error"'));
    assert.ok(out.endsWith("data: [DONE]\n\n"));
    assert.equal(t.end(), "", "nothing more is sent after an error");
  });

  it("closes the stream if the upstream ends without a final event", () => {
    const t = new StreamTranslator("m");
    t.push(sse("message_start", { message: { id: "m" } }));
    assert.ok(t.end().endsWith("data: [DONE]\n\n"));
  });

  it("skips malformed events instead of ending the stream", () => {
    const t = new StreamTranslator("m");
    const out = t.push("event: x\ndata: {not json\n\n") + t.push(TEXT_STREAM);
    assert.ok(parseChunks(out).length > 0);
  });
});
