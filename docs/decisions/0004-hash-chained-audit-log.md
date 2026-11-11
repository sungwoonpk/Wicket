# 0004. The audit trail is a hash chain

Status: accepted. The newest-events gap named below is closed by [0006](0006-signed-audit-head.md).

## Context

An audit log is only useful if people can trust it after something went wrong. A table anyone
with database access can edit quietly is weak evidence.

## Decision

Every audit event stores the hash of the previous event. An event's hash is
`SHA-256([prev_hash, time, type, actor, data])`, with the fields serialized as a JSON array so
that field boundaries cannot be confused. Appending runs in one `BEGIN IMMEDIATE` transaction so
two writers cannot extend the same predecessor.

`GET /admin/audit/verify` walks the chain and reports the first event that fails:

- **edited event:** its stored hash no longer matches its contents
- **removed or reordered event:** the next event's `prev_hash` no longer matches

The dashboard shows the result at all times. What gets logged: agent created or changed, policy
changed, requests denied or blocked, redactions (with counts per type, never the data),
tool-call denials, approval requested, approved and denied.

## Costs

- **Tail truncation** is not detected by the chain alone. It is caught by the signed head, see
  [0006](0006-signed-audit-head.md).
- The chain proves integrity, not authorship. Someone who can rewrite the whole table and
  recompute every hash can forge a log. Anchoring externally fixes this too.
- Writes are serialized, which is fine for one SQLite file and would need rethinking on a
  different store.

## Alternatives considered

- **Plain table with no hashing.** Cheap, but edits leave no trace.
- **Signing each event with a key.** Proves authorship but needs key management, and still does
  not detect deleted events without sequence checks.
- **An external append-only service.** The right production answer, and a good later addition.
  Too heavy as a first step.
