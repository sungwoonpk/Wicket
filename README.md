# Wicket

A policy-enforcing gateway for AI agents. It sits between agents and LLM providers and gives
each agent an identity, an API key, an audit trail and (planned) cost limits and tool-call policies.

Status: early. The proxy MVP works. Policies, budgets and a dashboard are not built yet.

## What works today

- OpenAI-compatible `POST /v1/chat/completions` proxy, including streaming (SSE).
- Per-agent API keys (`wk_...`). Only a SHA-256 hash is kept, and a key is shown once, at creation.
- Admin API protected by a bearer token: create keys, list agents, read the request log.
- Request log with agent, model, status, latency and token usage (also for streamed responses).
- A deterministic mock upstream, so everything runs without a paid API.

Keys and logs are in memory and are lost on restart. Persistence is planned.

## Run it locally

Requires Node 22 or newer.

```sh
npm install

# terminal 1: mock upstream on :4010
npm run dev:mock

# terminal 2: gateway on :8080
WICKET_ADMIN_TOKEN=change-me npm run dev
```

Create an agent key and make a call:

```sh
curl -s localhost:8080/admin/keys \
  -H "authorization: Bearer change-me" -H "content-type: application/json" \
  -d '{"name":"support-bot"}'

curl -s localhost:8080/v1/chat/completions \
  -H "authorization: Bearer <key from above>" -H "content-type: application/json" \
  -d '{"model":"demo","messages":[{"role":"user","content":"hello"}]}'

curl -s localhost:8080/admin/logs -H "authorization: Bearer change-me"
```

### Configuration

| Variable | Default | Meaning |
|---|---|---|
| `WICKET_ADMIN_TOKEN` | required | Bearer token for `/admin` routes |
| `WICKET_UPSTREAM_URL` | `http://localhost:4010` | OpenAI-compatible upstream (mock, Ollama, or a provider) |
| `PORT` | `8080` | Gateway port |
| `MOCK_PORT`, `MOCK_LATENCY_MS` | `4010`, `0` | Mock upstream port and added latency |

## Tests

```sh
npm run typecheck
npm test
```

## Design decisions

- [0001. The gateway talks to an upstream through the OpenAI-compatible wire format](docs/decisions/0001-upstream-abstraction.md)

## Roadmap

1. Proxy MVP (done)
2. Multi-tenancy, RBAC, cost aggregation and budget limits
3. Tool-call policy engine and approval queue
4. Trace collection, dashboard, audit log export
5. Load tests and published latency overhead numbers
6. Evaluation replay
