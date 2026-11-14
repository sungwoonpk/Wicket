# 0012. Keys can expire, and rotation keeps the lifetime

Status: accepted.

## Context

Agent keys and admin keys were bearer secrets with no end. A leaked key worked until someone noticed and rotated it.

## Decision

- A key can be given a **lifetime in days**, 1 to 3650, when it is created. Leaving it out means no expiry, as before.
- The agent stores both the **lifetime** and the **date it runs out**. Rotating a key issues a new one with the same
  lifetime counted from now, so the usual way to deal with an expired key is one call, and the new key works at once.
  `rotate-key` can name a different lifetime, or `null` for none.
- Changing an agent's lifetime counts from now. Any other change leaves the expiry alone.
- An **expired agent key** gets 401 with a message that says to rotate it, a log line `auth.key_expired`, and counts
  towards the failed-attempt limit, so a retry loop is slowed down.
- An **expired admin key** is refused like an unknown one. The environment token never expires, so a locked-out
  instance can still be recovered. An expired admin key is replaced by creating a user again.
- The dashboard shows when a key runs out, warns in the last seven days and flags one that has.

## Costs

- There is **no default lifetime**. Keys last forever unless someone asks otherwise. A default would break existing
  deployments quietly on the day it arrived.
- Expiry is checked when a key is used. Nothing is sent when a key is about to expire. The dashboard shows it, and the
  agent list in the API carries `keyExpiresAt` for a script to check.
- Admin users have no rotate call. A new user is the replacement.

## Alternatives considered

- **Store only the date.** Then rotating an expired key hands back a key that is already expired.
- **Expire keys by revoking them in a job.** Needs a scheduler. Checking on use needs nothing and cannot be late.
