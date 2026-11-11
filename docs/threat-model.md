# Threat model

What Wicket protects, who it protects it from, what it does about each threat, and what it does **not** do. It is
written for someone deciding whether to trust the gateway, so the gaps are listed as plainly as the defenses.

## What is being protected

| Asset                                           | Why it matters                                                     |
| ----------------------------------------------- | ------------------------------------------------------------------ |
| Provider API keys                               | They spend money and can read whatever the account can             |
| Agent keys (`wk_...`) and admin keys (`wa_...`) | They are the identity of every caller                              |
| Prompts and replies                             | They can contain customer and employee personal data               |
| The tool calls an agent makes                   | A refund, a delete or an outbound request has real effects         |
| Policy and budgets                              | They are the rules everything else relies on                       |
| The audit trail                                 | It is the record used to answer "what happened and who allowed it" |

## Who might attack, and from where

1. **A manipulated agent.** Prompt injection makes a well-behaved agent ask for tool calls it should not make, or send
   data it should not. This is the main case the gateway exists for.
2. **A caller with a stolen or guessed key.** An agent key or admin key leaks, or someone tries to guess one.
3. **An insider with a limited role.** A viewer, approver, or an admin of one team tries to do more than their role.
4. **Someone who can read or write the database file.** A backup leaks, or a host is compromised.
5. **A network attacker** between the agent and the gateway, or between the gateway and the provider.
6. **A hostile value that ends up in the dashboard,** such as an agent named like an HTML tag.

## Threats and what is done about them

| Threat                                                | Defense                                                                                                                                                                              | Checked by                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| A manipulated agent calls a destructive tool          | Ordered tool rules judge the model's response. A denied response is never returned                                                                                                   | `gateway`, `edge` tests                    |
| It dodges a rule with an odd call                     | Case-insensitive tool names. Missing, text or broken arguments meet strict rules and never permissive ones (ADR 0008)                                                                | `policy`, `edge` tests                     |
| It dodges a rule with a pattern that never finishes   | Policy regular expressions run with a 20 ms limit, and a timeout counts as "cannot be judged"                                                                                        | `policy`, `edge` tests                     |
| It hides personal data from the scanner               | Text is normalized first (fullwidth digits, invisible characters). Card numbers are checked with the Luhn test to avoid false hits                                                   | `policy`, `edge` tests                     |
| Personal data leaves in a prompt                      | Mask or block before the request is forwarded, per team                                                                                                                              | `gateway`, `tenancy` tests                 |
| Personal data comes back in a reply                   | Replies that are not streamed are masked. **Streamed replies are not scanned**                                                                                                       | `edge` tests                               |
| A looping agent burns the budget                      | Monthly budget, per-minute rate limit, a cap on requests in flight, a cap on approvals left waiting, a model allow list. Budgets are checked before the call                         | `gateway`, `edge` tests                    |
| An agent key is guessed                               | Keys are 192 bits of randomness. Failed attempts from one address are slowed down. Only a SHA-256 hash is stored                                                                     | `edge`, `stores` tests                     |
| An agent key leaks                                    | One call rotates it and the old key stops at once. An agent can be disabled instantly                                                                                                | `tenancy` tests                            |
| An admin tries to exceed their role                   | Roles are checked once in the router, before any handler. Team scope is checked against the target. The OpenAPI file lists every route's role and a test calls each one a step below | `tenancy`, `openapi` tests                 |
| A team reads another team's data or approvals         | Every list, count, chart and approval is filtered by team. A scoped user cannot widen the view                                                                                       | `tenancy` tests                            |
| Someone edits the audit trail                         | Each event contains the hash of the one before it                                                                                                                                    | `stores`, `edge` tests                     |
| Someone deletes the newest audit events               | The head (newest event) is signed with a key kept outside the database                                                                                                               | `stores`, `edge` tests                     |
| A secret ends up in the audit trail                   | Tool argument values are never written to it, only a digest. Keys are never logged                                                                                                   | `edge` tests                               |
| A provider key is exposed                             | It lives in an environment variable. It is never stored, logged or returned, and provider errors are passed on without it                                                            | `providers`, `edge` tests                  |
| An admin points a provider at the host's own metadata | Cloud metadata addresses, other schemes and embedded credentials are refused                                                                                                         | `edge`, `stores` tests                     |
| A hostile name runs script in the dashboard           | Everything is written as text, never as HTML. A content security policy allows only same-origin script and style, and forbids framing                                                | `ui-smoke` (real browser), `gateway` tests |
| A huge or slow request ties up the gateway            | Body limit of 1 MB, header and request timeouts, an upstream timeout, a cap on buffered replies, the upstream call stops when the caller disconnects                                 | `edge` tests                               |
| The gateway is locked out after a key is lost         | The environment token is always accepted as an owner                                                                                                                                 | `edge` tests                               |
| A weak admin token is used                            | The server refuses to start with fewer than 16 characters                                                                                                                            | `main` tests                               |

## What is not covered

These are real gaps. Read them before relying on the gateway.

- **No TLS.** Wicket speaks plain HTTP. Put it behind a reverse proxy or load balancer that terminates TLS, and do not
  expose the port directly. Keys travel in headers, so this matters.
- **Streamed replies are not scanned** for personal data, and a stream is not held back unless tool rules need it.
- **Detection is pattern based.** It catches common formats of email, SSN, card, phone and API keys. It will miss names,
  addresses and anything written in free form.
- **The Anthropic adapter was tested against a mock,** not the real service, and handles text and tools only.
- **Secrets live in environment variables.** Anyone who can read the process environment can read the provider keys and
  the audit signing key. Use a secret manager to fill them.
- **The audit signing key and the database must be kept apart.** Someone with both can rewrite and re-sign the log.
- **One process owns the database.** Rate limits, in-flight counts and the policy, routing and spend caches live in that
  process. Running several gateways on one file, or on copies, is not supported.
- **Keys are bearer secrets.** There is no single sign-on, no multi-factor sign-in and no per-key expiry.
- **Denial of service is limited, not prevented.** A single process can still be overwhelmed by enough traffic. Put rate
  limiting in front of it for anything exposed to the internet.
- **Prompt injection itself is not detected.** Wicket limits what an injected agent can do, it does not recognise an
  injection.
- **This is a demo-grade project built to show the design.** It has not had an independent security review.

## How to report a problem

See [SECURITY.md](../SECURITY.md).
