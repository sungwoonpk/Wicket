import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { redactMessages, redactText } from "../src/policy/redact.js";
import {
  decideToolCall,
  overallAction,
  toolCallsFromCompletion,
  toolCallsFromSse,
} from "../src/policy/tools.js";
import { DEFAULT_POLICY, type Policy, type ToolCall } from "../src/policy/types.js";

const ALL = DEFAULT_POLICY.redaction.detectors;

describe("redactText", () => {
  it("masks emails and SSNs", () => {
    const r = redactText("mail ann@example.com, ssn 123-45-6789", ALL);
    assert.equal(r.text, "mail [REDACTED:EMAIL], ssn [REDACTED:SSN]");
    assert.deepEqual(r.findings.map((f) => f.type).sort(), ["email", "ssn"]);
  });

  it("masks a Luhn-valid card but leaves other long numbers alone", () => {
    assert.equal(redactText("card 4242 4242 4242 4242 ok", ALL).text, "card [REDACTED:CREDIT_CARD] ok");
    assert.equal(redactText("order 1234 5678 9012 3456", ALL).text, "order 1234 5678 9012 3456");
  });

  it("masks phone numbers and provider-style keys", () => {
    assert.equal(redactText("call (415) 555-0132", ALL).text, "call [REDACTED:PHONE]");
    assert.equal(redactText("key sk-abcdefghijklmnop1234", ALL).text, "key [REDACTED:API_KEY]");
    assert.equal(redactText("aws AKIAABCDEFGHIJKLMNOP", ALL).text, "aws [REDACTED:API_KEY]");
  });

  it("only runs the detectors it is given", () => {
    const r = redactText("ann@example.com 123-45-6789", ["ssn"]);
    assert.equal(r.text, "ann@example.com [REDACTED:SSN]");
  });

  it("counts repeated matches", () => {
    const r = redactText("a@b.co and c@d.co", ["email"]);
    assert.deepEqual(r.findings, [{ type: "email", count: 2 }]);
  });
});

describe("redactMessages", () => {
  it("handles string and part-array content without mutating the input", () => {
    const input = [
      { role: "user", content: "mine is ann@example.com" },
      { role: "user", content: [{ type: "text", text: "ssn 123-45-6789" }, { type: "image_url", image_url: { url: "x" } }] },
    ];
    const copy = structuredClone(input);
    const r = redactMessages(input, ALL);
    assert.deepEqual(input, copy);
    assert.equal(r.messages[0]!.content, "mine is [REDACTED:EMAIL]");
    assert.equal((r.messages[1]!.content as any[])[0].text, "ssn [REDACTED:SSN]");
    assert.equal((r.messages[1]!.content as any[])[1].type, "image_url");
    assert.equal(r.findings.length, 2);
  });
});

const policy: Policy = {
  redaction: { mode: "off", detectors: [] },
  defaultToolAction: "allow",
  tools: [
    { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }], reason: "large refund" },
    { tool: "refund", action: "allow" },
    { tool: "delete_*", action: "deny", reason: "destructive" },
    { tool: "send_email", action: "deny", when: [{ arg: "to", op: "matches", value: "@(?!corp\\.com)" }] },
  ],
};

const call = (name: string, args: Record<string, unknown> = {}, argsValid = true): ToolCall => ({ name, args, argsValid });

describe("tool policy", () => {
  it("uses the first matching rule", () => {
    assert.equal(decideToolCall(policy, call("refund", { amount: 500 })).action, "require_approval");
    assert.equal(decideToolCall(policy, call("refund", { amount: 20 })).action, "allow");
  });

  it("supports wildcards and reasons", () => {
    const d = decideToolCall(policy, call("delete_customer"));
    assert.equal(d.action, "deny");
    assert.equal(d.reason, "destructive");
  });

  it("reads nested arguments and regex conditions", () => {
    assert.equal(decideToolCall(policy, call("send_email", { to: "x@evil.com" })).action, "deny");
    assert.equal(decideToolCall(policy, call("send_email", { to: "x@corp.com" })).action, "allow");
  });

  it("falls back to the default action", () => {
    assert.equal(decideToolCall({ ...policy, defaultToolAction: "deny" }, call("unknown")).action, "deny");
  });

  it("does not let malformed arguments match a conditional rule", () => {
    const d = decideToolCall(policy, call("refund", {}, false));
    assert.equal(d.action, "allow");
    assert.equal(d.ruleIndex, 1);
  });

  it("takes the strictest decision overall", () => {
    const ds = [call("refund", { amount: 20 }), call("refund", { amount: 900 }), call("delete_x")].map((c) =>
      decideToolCall(policy, c),
    );
    assert.equal(overallAction(ds.slice(0, 2)), "require_approval");
    assert.equal(overallAction(ds), "deny");
    assert.equal(overallAction([]), "allow");
  });
});

describe("tool call extraction", () => {
  it("reads calls from a completion body", () => {
    const body = {
      choices: [{ message: { tool_calls: [{ id: "c1", type: "function", function: { name: "refund", arguments: '{"amount":5}' } }] } }],
    };
    assert.deepEqual(toolCallsFromCompletion(body), [{ id: "c1", name: "refund", args: { amount: 5 }, argsValid: true }]);
  });

  it("flags invalid argument JSON", () => {
    const body = { choices: [{ message: { tool_calls: [{ function: { name: "x", arguments: "{oops" } }] } }] };
    assert.equal(toolCallsFromCompletion(body)[0]!.argsValid, false);
  });

  it("rebuilds calls from streamed fragments", () => {
    const ev = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`;
    const sse =
      ev({ tool_calls: [{ index: 0, id: "c1", function: { name: "ref", arguments: '{"amo' } }] }) +
      ev({ tool_calls: [{ index: 0, function: { name: "und", arguments: 'unt":7}' } }] }) +
      "data: [DONE]\n\n";
    assert.deepEqual(toolCallsFromSse(sse), [{ id: "c1", name: "refund", args: { amount: 7 }, argsValid: true }]);
  });
});
