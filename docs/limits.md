# Limits and roadmap

An honest list of what this version does not do:

- **No TLS.** Run it behind a proxy that terminates TLS. Keys travel in headers.
- **One process owns the database.** Rate limits, in-flight counts and the policy, routing and spend caches live in that process. Several gateways on one file are not supported. Fixing this means a shared store.
- **Streamed replies are not scanned** for personal data. Detection is pattern based and will miss names, addresses and free-form text.
- **The Anthropic adapter has only met a mock.** Text and tools only.
- **A team policy replaces the organization policy,** it does not merge with it.
- **Keys are bearer secrets.** No single sign-on, no multi-factor sign-in, no expiry.
- **The audit key and the database must be kept apart.** Someone who has both can rewrite and re-sign the log. There is no external anchor yet.
- **Prompt injection is limited, not detected.** Wicket constrains what an injected agent can do. It does not recognize an injection.
- **`node:sqlite` is experimental** in Node 22 and may change.
- **Demo grade.** It has had no independent security review, and the Docker image has been built by CI, not by hand on the author's machine.

## Roadmap

1. Single sign-on (OIDC) and key expiry
2. Postgres and shared limits, to run several instances
3. Anchor the audit head outside the database
4. Scan streamed replies, and webhooks for new approvals
5. Run the Anthropic adapter against the real service
6. Replay recorded traffic against a changed policy before shipping it
