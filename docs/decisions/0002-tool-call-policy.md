# 0002. Tool calls are judged on the model's response, by ordered rules

Status: accepted. The rule for malformed arguments is replaced by [0008](0008-fail-closed-policy.md).

## Context

The risky thing an agent does is not the text it sends, it is the tool it asks to run: a refund,
a delete, an outbound request. A gateway in front of the model sees every tool call before the
agent acts on it.

## Decision

- Policy is a document with ordered rules. Each rule names a tool (with `*` wildcards), an action
  (`allow`, `deny`, `require_approval`) and optional conditions on the parsed arguments
  (`equals`, `contains`, `matches`, `gt`, `lt`). The first matching rule wins, and a default
  action covers everything else.
- The gateway reads tool calls from the upstream **response**, for plain and streamed replies.
  With several calls in one response, the strictest outcome applies: any `deny` blocks the whole
  response, otherwise any `require_approval` holds the whole response.
- A denied response is not returned. The error names the tool and the rule's reason, and does
  not echo the arguments.
- Arguments that cannot be judged (broken JSON, missing or non-numeric values) fail **closed**: they meet deny and
  approval rules and never an allow rule. See [0008](0008-fail-closed-policy.md).
- Streamed responses are held back and replayed only when the request declares tools and the
  policy has tool rules. Other streams pass through chunk by chunk, so streaming stays fast
  where it cannot matter.
- Policy is validated on write (unknown actions, bad regular expressions and detector names are
  rejected) and kept in SQLite, so a restart does not lose it.

## Costs

- A streamed response with tools loses incremental delivery, because the gateway has to see the
  whole call to judge it.
- Tokens are billed by the provider before the gateway blocks a call. Blocked responses are
  still charged to the agent's spend so budgets match the provider's bill.
- Policy is global in this version. Per-team policies are a later change.

## Alternatives considered

- **Judge tool calls in the request** (the tool results the agent sends back). Too late: the
  agent has already run the tool.
- **Rewrite the response to drop the call.** Produces a reply the model never wrote and hides
  the block from the agent. A clear error is easier to handle and to audit.
- **A general policy language such as OPA or Rego.** More power than this needs and a heavy
  dependency. The rule shape here is small enough to validate and explain.
