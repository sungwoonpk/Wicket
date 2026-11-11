# 0003. Held tool calls return 202 and are released by polling

Status: accepted

## Context

Some tool calls should run only after a person agrees. The agent is waiting on an HTTP
response, and a human may take minutes. Holding the connection open for that long is fragile.

## Decision

- When a rule says `require_approval`, the gateway stores the upstream response verbatim and
  answers `202 Accepted` with `{ object: "wicket.approval_required", approval_id, status, tool_calls, poll_url }`.
- The agent polls `GET /v1/approvals/:id` with its own key. While pending it gets `202`. After
  approval it gets `200` and the **original** response, byte for byte. After a denial it gets
  `403 policy_violation`.
- An approval can be decided once. Deciding it again returns `409`. An agent can only see its
  own approvals, others get `404`.
- Approve and deny are admin actions and are written to the audit trail with the tool calls
  that were decided.

## Costs

- Agents need a small branch for the `202` case. A plain OpenAI client would see a response
  without `choices`. This is deliberate: it must not look like a normal completion.
- The stored response is released as is. If the policy changes while a call is pending, the
  decision made at the time of the request stands.

## Alternatives considered

- **Hold the connection until a human decides.** Simple for agents, but connections time out
  and proxies cut them, and it ties up server resources.
- **Webhooks to the agent on decision.** Needs the agent to run a server. Polling works from
  anywhere. A webhook option can be added later.
- **Return a normal completion with a "pending" message.** Agents would treat it as the
  model's answer. A distinct object type avoids that.
