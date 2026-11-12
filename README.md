# Wicket

[![CI](https://github.com/sungwoonpk/Wicket/actions/workflows/ci.yml/badge.svg)](https://github.com/sungwoonpk/Wicket/actions/workflows/ci.yml)
[![CodeQL](https://github.com/sungwoonpk/Wicket/actions/workflows/codeql.yml/badge.svg)](https://github.com/sungwoonpk/Wicket/actions/workflows/codeql.yml)

A gateway between AI agents and model providers. Every agent gets its own key, budget and limits. Sensitive data is masked before it leaves, risky tool calls are blocked or held for a person, and every decision goes into a tamper-evident audit trail.

Written in TypeScript with no runtime dependencies. One SQLite file.

![Wicket demo](docs/images/demo.gif)

## Why

Agents act through tools, and most teams have no control point in front of them.

| What goes wrong                                            | What Wicket does                                                            |
| ---------------------------------------------------------- | --------------------------------------------------------------------------- |
| One shared API key, no idea which agent did what           | A key per agent, every request logged against it                            |
| Customer data ends up in a prompt                          | Emails, SSNs, cards, phones and API keys are masked, or the call is blocked |
| An agent calls `delete_customer` or issues a $2,400 refund | Rules deny the call, or hold it until a person approves                     |
| A loop burns the month's budget overnight                  | Budget, rate limit, concurrency cap and model allow list per agent          |
| Every team wants different rules                           | A policy per team, with the organization policy as the default              |
| "What did the agent do?" has no trustworthy answer         | A hash-chained, signed audit trail that is verified on demand               |

## Features

- **Drop-in proxy.** OpenAI-compatible `POST /v1/chat/completions`, streamed or not. Change the base URL and the key.
- **Per-agent limits.** Models, monthly budget, requests per minute, requests in flight. Every refusal says why.
- **Sensitive data.** Mask or block, per team, with text normalized first so tricks do not hide anything.
- **Tool-call rules.** `allow`, `deny` or `require_approval`, on the tool name and its arguments. If a call cannot be judged, it fails closed.
- **Approval queue.** A held call is released only after a person approves it.
- **Teams and roles.** Four roles, and a user can be limited to one team.
- **Providers.** OpenAI-compatible servers and the Anthropic Messages API, routed by model name.
- **Audit trail and dashboard.** Chained and signed, with a web dashboard in light and dark.

## Run it

Needs Node 22.13 or newer. No accounts, no keys, no network, no cost.

```bash
git clone https://github.com/sungwoonpk/Wicket.git
cd Wicket
npm install
npm run demo     # three teams, four agents and a day of traffic, then open the link it prints
```

Or with Docker, then open <http://localhost:8080/dashboard>:

```bash
export WICKET_ADMIN_TOKEN=$(openssl rand -hex 24)
export WICKET_AUDIT_KEY=$(openssl rand -hex 24)
docker compose up --build
```

Running it yourself and every setting are in [docs/setup.md](docs/setup.md).

<table>
  <tr>
    <td><img src="docs/images/overview.png" alt="Overview" width="420"></td>
    <td><img src="docs/images/approvals.png" alt="Approval queue with held tool calls" width="420"></td>
  </tr>
</table>

## Using it

| To do this                        | Do this                                              |
| --------------------------------- | ---------------------------------------------------- |
| Create an agent and get its key   | `POST /admin/agents`                                 |
| Send a request through an agent   | `POST /v1/chat/completions` with the agent's key     |
| Set what tools may do             | `PUT /admin/policy`, or `?team=finance` for one team |
| Try a call against a policy first | `POST /admin/policy/simulate`                        |
| Approve a held tool call          | Dashboard, or `POST /admin/approvals/{id}/approve`   |
| Check the audit trail is intact   | `GET /admin/audit/verify`                            |

Every route is in [docs/openapi.yaml](docs/openapi.yaml). The policy format is in [docs/policy.md](docs/policy.md).

## Checks

```bash
npm run check          # lint, format, types, tests with coverage gates
npm run test:ui        # every dashboard page in headless Chrome
```

CI runs the same on Node 22 and 24, plus CodeQL, a dependency audit, and a container that must become healthy.

## Docs

|                                                                            |                                                                |
| -------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [Setup](docs/setup.md)                                                     | Running it, every setting, the price file                      |
| [Policy](docs/policy.md)                                                   | Rules, redaction, approvals, and failing closed                |
| [Teams and roles](docs/teams-and-roles.md), [Providers](docs/providers.md) | Who can do what, and how models are routed                     |
| [API](docs/api.md), [Dashboard](docs/dashboard.md)                         | The routes and the admin page                                  |
| [Features](docs/features.md)                                               | What it does, in detail                                        |
| [Architecture](docs/architecture.md)                                       | How a request flows, and the code layout                       |
| [Decisions](docs/decisions/README.md)                                      | Why it is built this way, and what each choice costs           |
| [Performance](docs/performance.md)                                         | Numbers, and what they mean                                    |
| [Limits and roadmap](docs/limits.md)                                       | What it does not do, and what is next                          |
| [Development](docs/development.md)                                         | Tests and how they are organised                               |
| [Threat model](docs/threat-model.md), [Security](SECURITY.md)              | What is protected and what is not, and how to report a problem |

## Status

It has had no independent security review and runs as one process. The Anthropic adapter has only been tested against a mock, never a real key. The limits are listed plainly in [docs/limits.md](docs/limits.md).
