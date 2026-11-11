# 0001. The gateway talks to an upstream through the OpenAI-compatible wire format

Status: accepted

## Context

Wicket sits between AI agents and LLM providers. Development, CI and load tests must not
depend on paid APIs, and results must be deterministic. Demos should still be able to show
real model output.

## Decision

The gateway speaks one upstream protocol: the OpenAI-compatible `POST /v1/chat/completions`
(JSON and server-sent-event streaming). The upstream is a base URL in configuration, so the
same gateway runs against three backends without code changes:

1. **Mock upstream** (`src/mock`): a small deterministic server in this repo. It returns token
   usage, can stream, and can inject latency, errors and tool calls. Used for tests, CI and
   load tests.
2. **Ollama** (or any local OpenAI-compatible server): real model output for demos, no cost.
3. **A real provider** through an OpenAI-compatible endpoint, enabled by setting the base URL
   and a key.

Provider-specific formats (for example the Anthropic Messages API) are added later as
adapters that translate to and from this wire format. They are not part of the MVP.

## Costs

- Provider features that do not map to the OpenAI format are not reachable until an adapter exists.
- The mock must stay faithful to the real format. It is checked by the same tests that run
  against the gateway, so drift shows up as a failing test.

## Alternatives considered

- **Call real APIs in tests.** Costs money, is flaky and non-deterministic. Rejected.
- **Record and replay real traffic.** Good for realism, but adds fixtures to maintain and
  cannot produce the dangerous tool-call scenarios the policy engine needs. May be added later.
