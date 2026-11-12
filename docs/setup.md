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
