# 0006. The audit head is signed, so removing the newest events is detected

Status: accepted. Closes the main gap named in [0004](0004-hash-chained-audit-log.md).

## Context

A hash chain catches an edited or removed event in the middle, because the next event no longer points at it. It cannot
catch removal of the **newest** events: what is left is still a valid, shorter chain.

## Decision

Next to the chain the database keeps one row, the **head**: the sequence number and hash of the newest event, plus an
HMAC-SHA-256 of both under a **signing key that is not in the database**. The head is updated in the same transaction
as the event it describes.

`verify` walks the chain and then checks the head:

- the head's signature must verify, otherwise it was forged or the key is wrong
- the head must name the newest event that exists, otherwise newer events were removed

The key comes from `WICKET_AUDIT_KEY`. If it is not set, one is derived from the admin token and a warning is printed.
A database from before heads existed is adopted once: its newest event is signed on first start.

## Costs

- **Key custody matters.** Someone who has the database _and_ the key can rewrite the log and re-sign it. Keep the key
  in a secret store, not next to the database file.
- It proves integrity, not who wrote an event. Authorship would need per-writer signatures.
- Adopting a legacy database trusts it once. Anything removed before that first start is not noticed.
- Only the latest head is kept, so it detects removal but cannot say how much was removed.

## Alternatives considered

- **Publish each head to an external append-only log or a transparency log.** The strongest answer, and a good future
  addition. It needs infrastructure this project does not assume.
- **Sign every event with a key.** Proves authorship but needs key management per writer, and still needs the head to
  notice deletions.
