# Setup

Running Wicket and the settings it takes.

## Try the demo

Needs Node 22.13 or newer, the first release where the built-in `node:sqlite` works without a flag. No accounts, no keys, no network, no cost.

```bash
git clone https://github.com/sungwoonpk/Wicket.git
cd Wicket
npm install
npm run demo
```

The demo starts a mock upstream and the gateway, then sets up three teams, three users, a stricter policy for finance, an Anthropic provider (served by the mock), four agents and a day of earlier traffic. It plays a scenario: normal questions, a message with an email and SSN, a reply that carries personal data, a denied `delete_customer`, a blocked outside request, refunds and a transfer that wait for approval, a card number that finance blocks, a rate limit, a disabled agent. Then it keeps running. Open the dashboard link it prints.

The demo uses inflated prices so spend is visible next to the budgets. Node prints a warning that `node:sqlite` is experimental, which is expected.

### With Docker

```bash
export WICKET_ADMIN_TOKEN=$(openssl rand -hex 24)
export WICKET_AUDIT_KEY=$(openssl rand -hex 24)
docker compose up --build
```

Open <http://localhost:8080/dashboard> and sign in with `WICKET_ADMIN_TOKEN`. The compose file starts the gateway and a mock upstream and keeps the database in a volume. The image runs as an unprivileged user and has a health check. CI builds it and waits for it to become healthy on every change.

### Run it yourself

```bash
export WICKET_ADMIN_TOKEN=$(openssl rand -hex 24)
npm run dev:mock        # mock upstream on :4010
npm run dev             # gateway on 127.0.0.1:8080
```

Create an agent and call through it:

```bash
curl -s localhost:8080/admin/agents \
  -H "authorization: Bearer $WICKET_ADMIN_TOKEN" -H "content-type: application/json" \
  -d '{"name":"support-bot","team":"support","allowedModels":["demo-small"],"monthlyBudgetUsd":5,"ratePerMinute":60}'

curl -s localhost:8080/v1/chat/completions \
  -H "authorization: Bearer <key from above>" -H "content-type: application/json" \
  -d '{"model":"demo-small","messages":[{"role":"user","content":"hello"}]}'
```

### Configuration

| Variable                       | Default                 | Meaning                                                                                  |
| ------------------------------ | ----------------------- | ---------------------------------------------------------------------------------------- |
| `WICKET_ADMIN_TOKEN`           | required                | Owner token, at least 16 characters. Always accepted, so you can recover from a lost key |
| `WICKET_AUDIT_KEY`             | derived from the token  | Signs the audit head. Set a separate secret in production                                |
| `WICKET_UPSTREAM_URL`          | `http://localhost:4010` | OpenAI-compatible upstream for models no provider matches                                |
| `WICKET_DB`                    | `wicket.db`             | SQLite file. `:memory:` for a throwaway database                                         |
| `WICKET_PRICES_FILE`           | built-in demo prices    | JSON price table, see below                                                              |
| `WICKET_UPSTREAM_TIMEOUT_MS`   | `120000`                | How long to wait for an upstream before answering 504                                    |
| `WICKET_APPROVAL_WEBHOOK_URL`  | none                    | Where to post a message when a tool call is held, see below                              |
| `WICKET_WEBHOOK_SECRET`        | none                    | Signs those messages. Set it whenever the webhook is on                                  |
| `WICKET_LOG`                   | on                      | `off` silences the JSON log                                                              |
| `HOST`, `PORT`                 | `127.0.0.1`, `8080`     | Where to listen. Use `0.0.0.0` only behind a proxy                                       |
| `MOCK_PORT`, `MOCK_LATENCY_MS` | `4010`, `0`             | The mock upstream's port and added latency                                               |

A price file maps a model to dollars per million tokens. `*` is the fallback. A malformed file stops the gateway at start-up instead of pricing requests at zero:

```json
{
  "claude-sonnet": { "inputPerM": 3, "outputPerM": 15 },
  "*": { "inputPerM": 1, "outputPerM": 3 }
}
```

### Key lifetime

An agent or admin key can be given a lifetime in days (1 to 3650). Without one it never expires.

```bash
curl -s localhost:8080/admin/agents -H "authorization: Bearer $WICKET_ADMIN_TOKEN" \
  -H "content-type: application/json" -d '{"name":"nightly-job","keyTtlDays":90}'
```

The response shows `keyExpiresAt`. An expired key is refused with a message that says to rotate it. `POST /admin/agents/:id/rotate-key` issues a new key with the same lifetime counted from now, or with another one if you send `{"keyTtlDays": 30}`, or `null` for none. The environment token never expires.

### Approval webhook

Set `WICKET_APPROVAL_WEBHOOK_URL` and the gateway posts a message when a tool call is held for approval. It contains the approval id, the agent and its team, and the tool names with the reason each was held. It does not contain the arguments.

```json
{
  "id": "evt_9f2c4a1b7d3e5f60",
  "type": "approval.requested",
  "at": "2026-11-13T09:30:00.000Z",
  "data": {
    "approvalId": "apr_...",
    "agentId": "agent_...",
    "agentName": "billing-agent",
    "team": "finance",
    "toolCalls": [{ "name": "refund", "reason": "refunds over $100 need a human" }]
  }
}
```

With `WICKET_WEBHOOK_SECRET` set, each delivery has `x-wicket-timestamp` and `x-wicket-signature: sha256=<hex>`, where the hex is HMAC-SHA-256 of `<timestamp>.<body>` keyed with the secret. Check it, and reject a timestamp that is old:

```js
const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
const ok = timingSafeEqual(Buffer.from(`sha256=${expected}`), Buffer.from(signatureHeader));
```

Delivery is in the background. A receiver that is down or failing is tried again after 1 s, 5 s and 15 s with the same `x-wicket-delivery` id, so keep it idempotent. A 4xx answer is not retried and a redirect is not followed. The result is logged as `webhook.delivered` or `webhook.failed`. A restart drops deliveries in progress, so treat the queue as the source of truth.

### Anchoring the audit trail

`GET /admin/audit/verify` shows that the chain and the signed head agree. Someone who holds both the database and `WICKET_AUDIT_KEY` could still rewrite the log and sign it again. To catch that, copy the newest event somewhere the gateway cannot write, on a schedule:

```bash
curl -s localhost:8080/admin/audit/head -H "authorization: Bearer $WICKET_ADMIN_TOKEN" >> audit-anchors.jsonl
# {"head":{"seq":412,"hash":"3b1f...","at":"2026-11-13T09:30:00.000Z"}}
```

Later, check the log against any anchor you saved:

```bash
curl -s "localhost:8080/admin/audit/verify?seq=412&hash=3b1f..." -H "authorization: Bearer $WICKET_ADMIN_TOKEN"
# {"ok":true,"checked":530,"anchored":true}
```

A copy kept on the same host is worth little. Use a bucket with object lock, a separate account, or a repository.
