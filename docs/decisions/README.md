# Design decisions

Each record says what was decided, why, and what it costs. Newest last.

| #    | Decision                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------- |
| 0001 | [The gateway talks to an upstream through the OpenAI-compatible wire format](0001-upstream-abstraction.md)  |
| 0002 | [Tool calls are judged on the model's response, by ordered rules](0002-tool-call-policy.md)                 |
| 0003 | [Held tool calls return 202 and are released by polling](0003-approval-queue.md)                            |
| 0004 | [The audit trail is a hash chain](0004-hash-chained-audit-log.md)                                           |
| 0005 | [Teams are the unit of tenancy, and admins have a role and an optional team](0005-teams-roles-and-scope.md) |
| 0006 | [The audit head is signed, so removing the newest events is detected](0006-signed-audit-head.md)            |
| 0007 | [Providers are registered, routed by model name, and translated at the edge](0007-providers-and-routing.md) |
| 0008 | [Policy fails closed when it cannot judge a call](0008-fail-closed-policy.md)                               |
| 0009 | [Streamed replies are masked by holding text back](0009-mask-streamed-replies.md)                           |
| 0010 | [Every request is charged](0010-charge-every-request.md)                                                    |
| 0011 | [The audit trail can be checked against an anchor kept elsewhere](0011-audit-anchor.md)                     |
| 0012 | [Keys can expire, and rotation keeps the lifetime](0012-key-lifetime.md)                                    |
| 0013 | [A held tool call is announced by a signed webhook](0013-approval-webhook.md)                               |
