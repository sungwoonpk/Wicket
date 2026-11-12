# Policy

How tool calls and sensitive data are controlled, and what happens when a rule cannot decide.

```json
{
  "redaction": { "mode": "redact", "detectors": ["email", "ssn", "credit_card", "phone", "api_key"] },
  "defaultToolAction": "allow",
  "tools": [
    { "tool": "delete_*", "action": "deny", "reason": "destructive tools are never allowed" },
    {
      "tool": "refund",
      "action": "require_approval",
      "when": [{ "arg": "amount", "op": "gt", "value": 100 }],
      "reason": "refunds over $100 need a human"
    },
    {
      "tool": "http_request",
      "action": "deny",
      "when": [{ "arg": "url", "op": "matches", "value": "^https?://(?!(api\\.)?acme\\.com)" }],
      "reason": "outbound requests are limited to acme.com"
    }
  ]
}
```

Load it with `PUT /admin/policy`, or `PUT /admin/policy?team=finance` for one team. Rules run in order and the first match wins. Tool names match without regard to case, and `*` is a wildcard. Conditions read the tool's JSON arguments by dot path (`customer.id`). With several tool calls in one response, the strictest result applies.

**Fails closed.** A condition that cannot be judged counts as _holding_ for rules that deny or hold for approval, and as _failing_ for rules that allow. A refund with a missing amount, an amount written as text or broken JSON therefore meets the strict rule and never the permissive one. Regular expressions run with a 20 ms limit, so a pattern that never finishes cannot freeze the gateway. See [ADR 0008](decisions/0008-fail-closed-policy.md).

When a call needs approval the agent gets `202` and a `poll_url`:

```json
{
  "object": "wicket.approval_required",
  "approval_id": "apr_...",
  "status": "pending",
  "tool_calls": [{ "name": "refund", "reason": "refunds over $100 need a human" }],
  "poll_url": "/v1/approvals/apr_..."
}
```

Polling returns `202` while pending, then the original response (`200`) once approved, or `403` if denied. The reviewer sees the arguments. The agent's `202` and the audit trail do not contain them: the trail keeps a digest.
