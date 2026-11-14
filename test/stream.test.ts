import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { StreamMeter, estimateTokens, resolveUsage } from "../src/gateway/usage.js";
import { withStreamUsage } from "../src/providers/index.js";
import { SseSplitter, sseData, sseDataOf, sseJson } from "../src/policy/sse.js";
import { harness, type Harness } from "./helpers.js";

describe("streamed requests are charged", () => {
  let h: Harness;
  const logs: Record<string, unknown>[] = [];
  before(async () => {
    h = await harness({ gateway: { logger: (record) => logs.push(record) } });
  });
  after(() => h.close());

  const spent = async (): Promise<number> => (await h.admin("/admin/agents")).json.agents[0].spentThisMonthUsd;

  it("charges a stream whose caller did not ask for usage, and does not send that caller the usage chunk", async () => {
    const key = await h.newAgent();
    const res = await h.chat(key, "count me please", { stream: true });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.ok((await spent()) > 0, "the budget sees the stream");
    const chunks = sseJson(text);
    assert.ok(chunks.length > 0);
    assert.ok(
      chunks.every((c) => !("usage" in c) || c.usage === null),
      "no usage chunk reaches a caller that did not ask for one",
    );
    assert.ok(text.trimEnd().endsWith("data: [DONE]"));
  });

  it("asks the upstream for usage, so the charge is its own number and not a guess", async () => {
    const key = await h.newAgent();
    logs.length = 0;
    await (await h.chat(key, "real usage", { stream: true })).text();
    const row = logs.find((r) => r.event === "request" && r.stream === true);
    assert.ok(row, "the request was logged");
    assert.equal(row.usageEstimated, undefined, "usage came from the upstream");
    assert.ok((row.costUsd as number) > 0);
  });

  it("still sends the usage chunk to a caller that asked for it", async () => {
    const key = await h.newAgent();
    const res = await h.chat(key, "count me too", { stream: true, stream_options: { include_usage: true } });
    const chunks = sseJson(await res.text());
    const last = chunks.at(-1);
    assert.deepEqual(last.choices, []);
    assert.ok(last.usage.completion_tokens > 0);
  });

  it("keeps the other stream options the caller set", () => {
    assert.deepEqual(withStreamUsage({ stream: true }).stream_options, { include_usage: true });
    assert.deepEqual(withStreamUsage({ stream_options: { include_usage: false, extra: 1 } }).stream_options, {
      include_usage: true,
      extra: 1,
    });
    assert.deepEqual(withStreamUsage({ stream_options: "junk" }).stream_options, { include_usage: true });
  });

  it("stops a streaming agent at its budget", async () => {
    const key = await h.newAgent({ monthlyBudgetUsd: 0.0000001 });
    assert.equal((await (await h.chat(key, "first", { stream: true })).text()).length > 0, true);
    const second = await h.chat(key, "second", { stream: true });
    assert.equal(second.status, 429, "the first stream used the budget up");
  });

  it("charges an estimate when an upstream reports no usage at all", async () => {
    const quiet = await harness({ mock: { omitUsage: true }, gateway: { logger: (record) => logs.push(record) } });
    try {
      logs.length = 0;
      const key = await quiet.newAgent();
      await (await quiet.chat(key, "a reply with no usage reported")).text();
      await (await quiet.chat(key, "and a streamed one", { stream: true })).text();
      const rows = (await quiet.admin("/admin/requests?limit=2")).json.requests;
      for (const r of rows) assert.ok(r.promptTokens > 0 && r.costUsd > 0, `estimated: ${JSON.stringify(r)}`);
      assert.equal(logs.filter((r) => r.event === "request" && r.usageEstimated === true).length, 2, "both say so");
    } finally {
      quiet.close();
    }
  });
});

describe("usage helpers", () => {
  it("uses what the upstream reported, and estimates only when it reported nothing", () => {
    const body = { messages: [{ role: "user", content: "x".repeat(400) }] };
    assert.deepEqual(resolveUsage({ promptTokens: 3, completionTokens: 5 }, body, 999), {
      usage: { promptTokens: 3, completionTokens: 5 },
      estimated: false,
    });
    const guess = resolveUsage({}, body, 80);
    assert.equal(guess.estimated, true);
    assert.equal(guess.usage.completionTokens, 20);
    assert.ok(guess.usage.promptTokens! >= 100);
    assert.equal(estimateTokens(0), 0);
  });

  it("ignores usage numbers that are not plain counts", () => {
    const meter = new StreamMeter();
    meter.observe('data: {"choices":[],"usage":{"prompt_tokens":"9","completion_tokens":-4}}\n\n', true);
    assert.deepEqual(meter.usage, { promptTokens: undefined, completionTokens: undefined });
  });

  it("counts reply text, tool names and tool arguments", () => {
    const meter = new StreamMeter();
    meter.observe('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n', true);
    meter.observe(
      'data: {"choices":[{"delta":{"tool_calls":[{"function":{"name":"ab","arguments":"{}"}}]}}]}\n\n',
      true,
    );
    meter.observe('data: {"choices":[{"delta":{"function_call":{"name":"c","arguments":"1"}}}]}\n\n', true);
    meter.observe("data: not json\n\n", true);
    meter.observe("data: [DONE]\n\n", true);
    meter.observe(": a comment\n\n", true);
    assert.equal(meter.chars, 5 + 4 + 2);
  });
});

describe("server-sent events are read as the specification says", () => {
  it("splits on LF, CRLF and CR line ends, and keeps each event exactly as written", () => {
    for (const eol of ["\n", "\r\n", "\r"]) {
      const a = `data: {"n":1}${eol}${eol}`;
      const b = `data:{"n":2}${eol}${eol}`;
      const splitter = new SseSplitter();
      const events = [...splitter.push(a + b), ...splitter.flush()];
      assert.deepEqual(events, [a, b], JSON.stringify(eol));
    }
  });

  it("does not end an event on a lone CR that may be half of a CRLF", () => {
    const splitter = new SseSplitter();
    assert.deepEqual(splitter.push("data: a\r\n\r"), []);
    assert.deepEqual(splitter.push("\ndata: b\r\n\r\n"), ["data: a\r\n\r\n", "data: b\r\n\r\n"]);
  });

  it("waits for the rest of an event, however the text is cut", () => {
    const whole = 'event: message\r\ndata: {"a":1}\r\n\r\ndata: {"a":2}\r\n\r\n';
    for (let cut = 1; cut < whole.length; cut++) {
      const splitter = new SseSplitter();
      const events = [...splitter.push(whole.slice(0, cut)), ...splitter.push(whole.slice(cut)), ...splitter.flush()];
      assert.equal(events.join(""), whole, `cut at ${cut}`);
      assert.deepEqual(events.map(sseData), ['{"a":1}', '{"a":2}'], `cut at ${cut}`);
    }
  });

  it("reads data with or without the space, joins data lines, and skips comments and other fields", () => {
    assert.equal(sseData("data: x\n\n"), "x");
    assert.equal(sseData("data:x\n\n"), "x");
    assert.equal(sseData("data:  two spaces\n\n"), " two spaces");
    assert.equal(sseData('data: {"a":\ndata: 1}\n\n'), '{"a":\n1}');
    assert.equal(sseData(": comment\nevent: ping\n\n"), undefined);
  });

  it("returns an unfinished last event on flush", () => {
    const splitter = new SseSplitter();
    assert.deepEqual(splitter.push("data: a\n\ndata: b"), ["data: a\n\n"]);
    assert.deepEqual(splitter.flush(), ["data: b"]);
    assert.deepEqual(sseDataOf("data: a\n\ndata: b"), ["a", "b"]);
  });

  it("returns only JSON objects from a whole stream", () => {
    assert.deepEqual(sseJson('data: {"a":1}\n\ndata: 5\n\ndata: oops\n\ndata: [DONE]\n\n'), [{ a: 1 }]);
  });
});
