# 0013. A held tool call is announced by a signed webhook

Status: accepted. Adds the option [0003](0003-approval-queue.md) left for later, for reviewers rather than agents.

## Context

A held call waited until someone happened to open the dashboard. Reviewers need to be told, in a chat tool or a
pager, and Wicket should not need to know which.

## Decision

- Set `WICKET_APPROVAL_WEBHOOK_URL` and the gateway posts a JSON message when a call is held: the approval id, the
  agent, its team, and the tool names with the reason each was held.
- The message **carries no tool arguments.** They can hold anything. The reviewer reads them in the queue.
- With `WICKET_WEBHOOK_SECRET` each delivery has `x-wicket-signature: sha256=` and an HMAC-SHA-256 of
  `<timestamp>.<body>`, with the timestamp in `x-wicket-timestamp`, so the receiver can check the sender and reject a
  replay. Without a secret the gateway warns at start-up.
- Delivery is **in the background** and never delays the agent's answer. A receiver that is unreachable, slow, rate
  limiting or failing is tried again after 1 s, 5 s and 15 s with the same delivery id. A client error is not
  retried, and a **redirect is not followed**, so a receiver cannot send the gateway somewhere else.
- The address follows the rules for a provider address: http or https, no credentials, no cloud metadata address.

## Costs

- **Best effort.** Deliveries are in memory. A restart drops those in progress, and a receiver that stays down for
  more than the retries misses the message. The queue and the dashboard remain the source of truth.
- Only new approvals are announced. Decisions and budget alerts are not.
- One address for the whole gateway, not one per team.

## Alternatives considered

- **A durable outbox in the database.** Right for delivery that must not be lost, and more machinery than a first
  version needs. It is on the roadmap.
- **Talk to a chat tool directly.** Ties the gateway to one vendor. A webhook reaches any of them through a small
  adapter.
