# Limits and roadmap

An honest list of what this version does not do:

- **No TLS.** Run it behind a proxy that terminates TLS. Keys travel in headers.
- **One process owns the database.** Rate limits, in-flight counts and the policy, routing and spend caches live in that process. Several gateways on one file are not supported. Fixing this means a shared store.
- **Detection is pattern based.** It catches common formats of email, SSN, card, phone and API keys. It will miss names, addresses and free-form text.
- **A streamed reply is masked a little behind.** The last word or number is held until it is clear it is over. Text that stays one unbroken word for more than 4,096 characters is cut anyway, so a secret that long could be split ([ADR 0009](decisions/0009-mask-streamed-replies.md)).
- **Tool arguments are not masked,** in a reply or a stream. They reach the agent as the model wrote them.
- **A stream that declares no tools is not judged.** A streamed request that names neither `tools` nor `functions` is passed straight through, so tool calls the provider makes by itself would not be judged. A reply that is not streamed always is.
- **The Anthropic adapter has only met a mock.** Text and tools only.
- **A team policy replaces the organization policy,** it does not merge with it.
- **Keys are bearer secrets.** No single sign-on, no multi-factor sign-in. A key can be given a lifetime, but none has one unless asked ([ADR 0012](decisions/0012-key-lifetime.md)).
- **The audit key and the database must be kept apart,** and the anchor is only as good as where it is kept. Wicket hands out the head and checks it, but does not store it for you ([ADR 0011](decisions/0011-audit-anchor.md)).
- **A budget can be overshot a little.** It is checked before a request and charged after, so requests running at the same moment can pass it by what they cost. `maxConcurrent` bounds this. When an upstream reports no usage, an estimate is charged, one token for every four characters, which is rough ([ADR 0010](decisions/0010-charge-every-request.md)).
- **The approval webhook is best effort.** Deliveries are in memory, retried three times, and a restart drops those in progress ([ADR 0013](decisions/0013-approval-webhook.md)).
- **Prompt injection is limited, not detected.** Wicket constrains what an injected agent can do. It does not recognize an injection.
- **`node:sqlite` is experimental** in Node 22 and may change.
- **Demo grade.** It has had no independent security review, and the Docker image has been built by CI, not by hand on the author's machine.

## Roadmap

1. Single sign-on (OIDC), and a default key lifetime
2. Postgres and shared limits, to run several instances
3. A durable outbox for webhooks, and more events: decisions and budget alerts
4. Run the Anthropic adapter against the real service
5. Replay recorded traffic against a changed policy before shipping it
