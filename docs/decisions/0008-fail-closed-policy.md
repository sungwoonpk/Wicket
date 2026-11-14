# 0008. Policy fails closed when it cannot judge a call

Status: accepted. Replaces the rule in [0002](0002-tool-call-policy.md) that malformed arguments fall through.
Amended: streamed replies are now scanned ([0009](0009-mask-streamed-replies.md)), and the reply is read strictly, see below.

## Context

A policy is only as good as the cases it cannot be talked out of. An agent that is being manipulated can send a tool
call that is awkward on purpose: an amount that is text, a missing field, broken JSON, a different capital letter in the
tool name, or an address written with invisible characters.

## Decision

- Tool names are matched **without regard to case**, so `Delete_Customer` meets `delete_*`.
- A condition has three outcomes: holds, fails, or **cannot be judged**. It cannot be judged when the argument is
  missing, is not a number where one is needed, the JSON is broken, or a pattern timed out.
- A rule that **denies or asks for approval** treats a condition it cannot judge as holding. A rule that **allows**
  treats it as failing. So awkward input meets the strict rule and never the permissive one.
- Regular expressions from a policy run in a separate context with a **20 ms limit** and see at most 2,048 characters.
  A pattern that backtracks forever cannot freeze the gateway, and a timeout counts as "cannot be judged".
- Argument paths cannot reach inherited properties (`__proto__`, `constructor`).
- Before PII detection, text is **normalized**: look-alike forms are folded (fullwidth digits) and invisible characters
  are removed. The masked text is the normalized text.
- Model replies are masked as well as prompts, whenever redaction is on, streamed or not ([0009](0009-mask-streamed-replies.md)).
  A reply is masked before anything is decided about it, so a reply held for approval is stored and released masked.
- The reply is **read strictly**. Tool calls are taken from `tool_calls` and from the older `function_call`, a request
  that declares `functions` is treated like one that declares `tools`, and event streams are read as the specification
  says (CRLF, `data:` with no space). What the upstream actually sent decides how it is read, so a plain completion
  sent in answer to a streaming request is judged and masked like any other. A reply whose tool calls cannot be read is refused with 502 and a
  `tool.unjudgeable` audit event, never passed on as if it had none.
- The audit trail records the **tool name, reason and a digest of the arguments**, never the argument values, so a
  refund note or an address does not end up in a log that is kept for a long time. The reviewer still sees the values.

## Costs

- A legitimate call with a missing or oddly formatted argument may be held for approval. That is the intended trade.
- Normalizing changes the text that is sent on, in the direction of safety.
- Pattern-based detection finds common formats and will miss free-form personal data. This is stated in the README.
- The regex time limit bounds a runaway pattern. It is not a security sandbox for running untrusted code, and it is
  not used for that. Only regular expressions run in it.

## Alternatives considered

- **Reject every call with unparseable arguments.** Simple, but it ignores the rule that matched the tool name.
- **Treat unknown as failing everywhere.** Lets a call with a missing amount through a "hold refunds over 100" rule.
- **A safe regular expression engine.** Better in principle, a heavy dependency for a limit that is already enforced.
