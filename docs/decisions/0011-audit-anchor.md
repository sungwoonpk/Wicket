# 0011. The audit trail can be checked against an anchor kept elsewhere

Status: accepted. Follows [0006](0006-signed-audit-head.md), which named this as the next step.

## Context

The chain and the signed head catch edits and removals. They cannot catch someone who holds both the database and the
signing key: that person can rewrite an event, recompute every hash after it and sign the new head. Nothing inside the
database can show it, because everything inside the database was rewritten.

## Decision

- `GET /admin/audit/head` returns the newest event: its number, its hash and its time.
- The operator copies that somewhere the gateway and the database host cannot write, on a schedule. A cron job that
  appends it to a bucket with object lock, or to a repository, is enough.
- `GET /admin/audit/verify?seq=N&hash=H` checks the chain and the signed head as before, and also that event `N` still
  has hash `H`. The chain commits every event to the ones before it, so a match shows that nothing up to `N` changed.
  A rewrite that was re-chained and re-signed, and a log cut back past the anchor, both fail.

## Costs

- **The gateway does not store the anchor.** A copy kept on the same host is no better than none. The protection is
  only as good as where the operator puts it.
- Events written after the newest anchor are covered by the chain and the head only, until the next anchor is taken.
- It proves that history up to a point was not changed. It does not say who wrote an event.

## Alternatives considered

- **Push each head to an external log from the gateway.** Stronger, and needs outbound access, credentials and a
  place to push to. This record is the part that works without any of that, and a push can be built on it.
- **Keep the anchor in the same database.** Defeated by the same attacker.
