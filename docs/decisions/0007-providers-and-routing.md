# 0007. Providers are registered, routed by model name, and translated at the edge

Status: accepted. Builds on [0001](0001-upstream-abstraction.md).

## Context

A company uses more than one model provider, and agents should not need to know which one serves a model, or hold
the provider's key.

## Decision

- An owner registers **providers**: a name, a kind (`openai` or `anthropic`), a base URL, the **name of the environment
  variable** that holds the key, and a list of model patterns with `*` as a wildcard.
- A request is routed to the **first enabled provider whose pattern matches the model**, ignoring case. If none matches,
  it goes to the default upstream from `WICKET_UPSTREAM_URL`.
- The gateway **adds the provider key itself**. Agents never see it. It is never stored, logged, or returned, and a
  provider authentication failure is passed through without echoing it. A missing variable gives the agent a generic
  `502`, while the reason goes to the audit trail.
- Wicket speaks the OpenAI format to agents. The **Anthropic adapter** translates in both directions: system messages,
  tools and tool choice, tool calls and results, usage, errors and server-sent events. Policy and budgets run on the
  translated OpenAI form, so they behave the same for every provider.
- **Provider addresses are checked.** They must be http or https with no credentials, and cloud metadata addresses
  are refused. Local and private addresses are allowed, because a local model server is a normal upstream.
- Requests have a timeout (`504`), stop when the caller disconnects, and buffered replies are capped at 10 MB.

## Costs

- **The adapter is tested against a mock built from the public API description, not against the real service.** It has
  not been run with a real key. Differences in the real API would show up as failures there first.
- Text only. An image in a message to an Anthropic provider is refused with a `400`.
- Provider features that have no OpenAI equivalent are unreachable.
- Routing and policy caches assume a single gateway process owns the database.

## Alternatives considered

- **One adapter per process, behind a generic proxy.** More isolation, more moving parts.
- **Store provider keys in the database, encrypted.** Convenient, but it turns the database into a secrets store and
  adds key management. Environment variables, or a secret manager that fills them, keep that out of scope.
