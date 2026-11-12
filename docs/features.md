# Features

What Wicket does, in groups.

**Control**

- **OpenAI-compatible proxy.** `POST /v1/chat/completions`, streamed or not. Point a client at Wicket by changing its base URL and key.
- **Agent identity and limits.** A key per agent, shown once and stored only as a hash. Allowed models, monthly budget in dollars, requests per minute, requests in flight. Each refusal says why.
- **Sensitive data.** Detectors for email, SSN, card (Luhn-checked), phone and API keys. Mask or block, per team. Text is normalized first so fullwidth digits and invisible characters do not hide anything. Replies that are not streamed are masked too.
- **Tool-call policy.** Ordered rules on tool name and arguments: `allow`, `deny` or `require_approval`. Judged on the model's response, plain or streamed. When Wicket cannot judge a call (missing amount, text where a number belongs, broken JSON) it fails **closed**.
- **Approval queue.** A held call is stored and released to the agent only after a person approves it, in the dashboard or the API.

**Organization**

- **Teams, roles and scope.** Roles `viewer`, `approver`, `admin`, `owner`. A user can be limited to one team and then sees and changes only that team.
- **Policy per team.** A team with its own policy follows that. Others follow the organization policy.
- **Providers.** Register OpenAI-compatible servers and the Anthropic Messages API. Models are routed by name pattern. Provider keys stay in environment variables.
- **Budget alerts.** Warnings at 80% and 100% of a monthly budget, once per month, in the audit trail.

**Trust and operations**

- **Audit trail.** Every denial, redaction, policy change, approval decision and admin action, chained by hash and signed at the head, so edits, removals in the middle and removal of the newest events are all detected.
- **Dashboard.** Overview with charts, approvals, agents, a policy editor with a tester, requests, audit, users, teams and providers. Light and dark.
- **Observability.** Structured JSON logs with request ids, Prometheus metrics, `/healthz` and `/readyz`.
- **Persistence.** One SQLite file with numbered migrations. Keys, policy, logs and approvals survive restarts.
- **Careful by default.** Refuses short admin tokens, listens on loopback unless told otherwise, slows down repeated wrong keys, times out slow upstreams, stops the upstream call when the caller disconnects, and shuts down cleanly.
