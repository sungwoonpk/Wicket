import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { redactText } from "../src/policy/redact.js";
import { sseJson } from "../src/policy/sse.js";
import { redactSse, safeCut, StreamRedactor } from "../src/policy/streamredact.js";
import type { Finding } from "../src/policy/types.js";
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

  const TOOLS = [{ type: "function", function: { name: "refund", parameters: { type: "object", properties: {} } } }];
  const textOf = (wire: string) =>
    sseJson(wire)
      .flatMap((c) => c.choices.map((ch: any) => ch.delta?.content ?? ""))
      .join("");

  it("masks a reply that is streamed straight through", async () => {
    const res = await h.chat(key, "[[leak]]", { stream: true });
    assert.equal(res.status, 200);
    const wire = await res.text();
    assert.equal(textOf(wire), "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
    assert.ok(!wire.includes("ann@example.com") && !wire.includes("123-45-6789"), "nothing raw on the wire");
    assert.ok(wire.trimEnd().endsWith("data: [DONE]"));
    const last = (await h.admin("/admin/requests?limit=1")).json.requests[0];
    assert.equal(last.outcome, "redacted");
    assert.ok(last.completionTokens > 0, "usage is still read from the original stream");
    const events = (await h.admin("/admin/audit?limit=5")).json.events;
    assert.ok(events.some((e: any) => e.type === "response.redacted" && e.data.streamed === true));
  });

  it("masks a streamed reply that is held back to judge its tool calls", async () => {
    const res = await h.chat(key, "[[leak]]", { stream: true, tools: TOOLS });
    assert.equal(res.status, 200);
    assert.equal(textOf(await res.text()), "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
  });

  it("masks a streamed reply that was held for approval, in storage and on release", async () => {
    const held = await h.chat(key, '[[tool:refund {"amount":500}]][[leak]]', { stream: true, tools: TOOLS });
    assert.equal(held.status, 202);
    const id = ((await held.json()) as any).approval_id;
    const stored = h.app.approvals.response(id)!.body;
    assert.ok(!stored.includes("ann@example.com") && !stored.includes("123-45-6789"));
    await h.admin(`/admin/approvals/${id}/approve`, "POST");
    const released = await poll(id);
    assert.equal(released.headers.get("content-type"), "text/event-stream");
    const wire = await released.text();
    assert.equal(textOf(wire), "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
    assert.ok(wire.includes("refund"), "the tool call is still in the stream");
  });

  it("masks a stream that uses CRLF framing as well", async () => {
    const wire = await (await h.chat(key, "[[leak]][[crlf]][[bare]]", { stream: true })).text();
    assert.equal(textOf(wire), "You can reach [REDACTED:EMAIL] or [REDACTED:SSN]");
  });

  it("leaves a stream alone when masking is off", async () => {
    await h.admin("/admin/policy", "PUT", { redaction: { mode: "off" } });
    try {
      const wire = await (await h.chat(key, "[[leak]]", { stream: true })).text();
      assert.equal(textOf(wire), "You can reach ann@example.com or 123-45-6789");
    } finally {
      await h.admin("/admin/policy", "PUT", MASK_AND_HOLD);
    }
  });

  it("releases a reply with nothing to mask exactly as it came", async () => {
    const held = await h.chat(key, '[[tool:refund {"amount":500}]]');
    const id = ((await held.json()) as any).approval_id;
    await h.admin(`/admin/approvals/${id}/approve`, "POST");
    const body = (await (await poll(id)).json()) as any;
    assert.equal(body.choices[0].message.content, null);
  });
});

describe("masking a stream that arrives in pieces", () => {
  const DETECTORS = ["email", "ssn", "credit_card", "phone", "api_key"] as const;
  const all = [...DETECTORS];

  const chunk = (content: string, finish: string | null = null) =>
    `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { content }, finish_reason: finish }] })}\n\n`;

  /** Streams `text` in pieces of `size` characters through the redactor and returns the text that came out. */
  function through(text: string, size: number, detectors = all): { text: string; findings: Finding[] } {
    const redactor = new StreamRedactor(detectors);
    let wire = "";
    for (let i = 0; i < text.length; i += size) wire += redactor.push(chunk(text.slice(i, i + size)));
    wire += redactor.push(chunk("", "stop"));
    wire += redactor.push("data: [DONE]\n\n");
    return { text: joined(wire), findings: redactor.findings() };
  }

  function joined(wire: string): string {
    return sseJson(wire)
      .flatMap((c) => c.choices.map((ch: any) => ch.delta?.content ?? ""))
      .join("");
  }

  const SAMPLES = [
    "Write to ann@example.com about the invoice, or call (555) 123-4567 today.",
    "Her SSN is 123-45-6789 and her card is 4111 1111 1111 1111, thanks.",
    "Same card with dashes 4111-1111-1111-1111 and plain 4111111111111111 end.",
    "The key sk-abcdefghijklmnop1234 and AKIAABCDEFGHIJKLMNOP are secret; phone +1 555 123 4567.",
    "mail ann@exa​mple.com now, ssn １２３-４５-６７８９ too",
    "Nothing sensitive here, only words and 42 numbers like 2026 and 3.14.",
    "ends right on the secret ann@example.com",
    "ann@example.com starts with it and 123-45-6789",
  ];

  it("gives the same answer however the reply is cut into pieces", () => {
    for (const text of SAMPLES) {
      const expected = redactText(text, all);
      for (let size = 1; size <= 9; size++) {
        const got = through(text, size);
        const want = expected.findings.length > 0 ? expected.text : text;
        assert.equal(got.text, want, `size ${size}: ${text}`);
        assert.deepEqual(
          Object.fromEntries(got.findings.map((f) => [f.type, f.count])),
          Object.fromEntries(expected.findings.map((f) => [f.type, f.count])),
          `findings, size ${size}: ${text}`,
        );
      }
    }
  });

  it("never lets a secret reach the wire, not even in part", () => {
    const text = "card 4111 1111 1111 1111 and mail ann@example.com and 123-45-6789 done";
    for (let size = 1; size <= 7; size++) {
      const redactor = new StreamRedactor(all);
      let wire = "";
      for (let i = 0; i < text.length; i += size) wire += redactor.push(chunk(text.slice(i, i + size)));
      wire += redactor.push(chunk("", "stop")) + redactor.push("data: [DONE]\n\n");
      for (const secret of ["4111", "ann@", "example.com", "123-45", "6789"]) {
        assert.ok(!wire.includes(secret), `"${secret}" leaked at size ${size}`);
      }
    }
  });

  it("sends text on while the reply is still going, and does not wait for the end", () => {
    const redactor = new StreamRedactor(all);
    const words = "one two three four five six seven eight nine ten".split(" ");
    let early = "";
    words.forEach((word, i) => (early += joined(redactor.push(chunk(i === 0 ? word : ` ${word}`)))));
    assert.ok(early.startsWith("one two three four five six seven eight nine"), early);
  });

  it("leaves text without anything to mask exactly as it was, including characters that normalize", () => {
    for (const text of ["㈜한국 … ½ café ﬁne — 안녕하세요 반갑습니다", "plain words only"]) {
      for (const size of [1, 3, 8]) assert.equal(through(text, size).text, text, `${size}: ${text}`);
    }
  });

  it("keeps a Korean reply moving instead of holding it back", () => {
    const redactor = new StreamRedactor(all);
    let early = "";
    for (const piece of ["안녕하세요", " 저는", " 도우미", " 입니다", " 무엇을", " 도와", " 드릴까요"])
      early += joined(redactor.push(chunk(piece)));
    assert.ok(early.length > 10, `sent ${JSON.stringify(early)} early`);
  });

  it("releases what is held when the stream ends without a closing event", () => {
    const redactor = new StreamRedactor(all);
    let wire = redactor.push(chunk("mail ann@exam")) + redactor.push(chunk("ple.com"));
    wire += redactor.flush();
    assert.equal(joined(wire), "mail [REDACTED:EMAIL]");
  });

  it("handles several choices at once, each on its own", () => {
    const redactor = new StreamRedactor(all);
    const two = (a: string, b: string, finish: string | null = null) =>
      `data: ${JSON.stringify({
        id: "c",
        object: "chat.completion.chunk",
        created: 1,
        model: "m",
        choices: [
          { index: 0, delta: { content: a }, finish_reason: finish },
          { index: 1, delta: { content: b }, finish_reason: finish },
        ],
      })}\n\n`;
    let wire = "";
    wire += redactor.push(two("ann@exam", "123-45-"));
    wire += redactor.push(two("ple.com ok", "6789 ok", "stop"));
    const byChoice = ["", ""];
    for (const c of sseJson(wire)) for (const ch of c.choices) byChoice[ch.index] += ch.delta?.content ?? "";
    assert.deepEqual(byChoice, ["[REDACTED:EMAIL] ok", "[REDACTED:SSN] ok"]);
  });

  it("carries the held text in a closing event that has no text of its own", () => {
    const redactor = new StreamRedactor(all);
    let wire = redactor.push(chunk("ssn 123-45-6789"));
    wire += redactor.push(
      `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    assert.equal(joined(wire), "ssn [REDACTED:SSN]");
  });

  it("passes events it does not understand through untouched", () => {
    const redactor = new StreamRedactor(all);
    for (const event of [
      ": comment\n\n",
      "data: not json\n\n",
      "data: 5\n\n",
      'data: {"choices":"x"}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":1}}\n\n',
      "event: ping\n\n",
    ])
      assert.equal(redactor.push(event), event);
  });

  it("cuts a very long word eventually instead of holding it for good", () => {
    const redactor = new StreamRedactor(all);
    let sent = "";
    for (let i = 0; i < 100; i++) sent += joined(redactor.push(chunk("x".repeat(100))));
    assert.ok(sent.length > 5000, `only ${sent.length} sent`);
  });

  it("masks a stream read in full, and returns it untouched when there was nothing to mask", () => {
    const wire = chunk("mail ann@example.com ") + chunk("now", "stop") + "data: [DONE]\n\n";
    const masked = redactSse(wire, all);
    assert.equal(joined(masked.text), "mail [REDACTED:EMAIL] now");
    assert.deepEqual(masked.findings, [{ type: "email", count: 1 }]);
    const clean = chunk("nothing here", "stop") + "data: [DONE]\r\n\r\n";
    assert.deepEqual(redactSse(clean, all), { text: clean, findings: [] });
  });

  it("only looks for the detectors that are on", () => {
    assert.equal(through("ann@example.com 123-45-6789", 4, ["ssn"]).text, "ann@example.com [REDACTED:SSN]");
  });

  it("chooses cut points that cannot split a match", () => {
    assert.equal(safeCut("hello"), 0, "inside a word");
    assert.equal(safeCut("hello wor"), "hello ".length, "after a space, in front of letters");
    assert.equal(safeCut("pay 4111 1111"), "pay".length, "never inside a run of digits and spaces");
    assert.equal(safeCut("pay 4111 1111 now"), "pay 4111 1111 ".length, "after a number that is over");
    assert.equal(safeCut("a😀 "), "a😀".length, "right after a surrogate pair, never inside it");
    assert.equal(safeCut("x😀y"), 0, "no space, no cut");
    assert.equal(safeCut(""), 0);
  });
});
