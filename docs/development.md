# Development

How Wicket is built and checked. The commands and the code layout are also in [CONTRIBUTING.md](../CONTRIBUTING.md).

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the commands and how the code is laid out.

```bash
npm run check          # lint, format, types, and tests with coverage gates
npm run test:ui        # every dashboard page in headless Chrome
```

- **199 tests**, run on Node 22 and 24. Coverage is 99.7% of lines, 93.0% of branches and 100% of functions, and CI fails below 95%, 85% and 95%.
- **Policy engine:** every detector, Luhn filtering, normalization tricks, first-match rules, wildcards, nested arguments, fail-closed cases, a regular expression that would never finish, tool calls rebuilt from streamed fragments.
- **Anthropic adapter:** every translation in both directions, tool use, errors, and streaming fed one byte at a time and in odd splits.
- **Stores and migrations:** hashing, persistence across a reopened file, a version 1 database brought forward, month boundaries, budget alerts once per month, every cache invalidated on every write.
- **Audit:** an edited event, a removed event, removal of the newest events, a forged head, a wrong key, a legacy database.
- **Roles and teams:** every role against every kind of route, scope on lists, counts, charts and approvals, a scoped user unable to widen the view, disabled and rotated keys.
- **Edge cases:** bad bodies and models, oversized requests, upstream errors, bad JSON from an upstream, timeouts, a caller who disconnects, concurrency and approval caps, guessing, bypass attempts, secrets kept out of the audit trail.
- **Process:** the real program refusing weak tokens, binding to loopback, writing structured logs without secrets, and stopping cleanly on SIGTERM.
- **Browser:** each page drawn in headless Chrome with no script errors, a team viewer's menu, and an agent named like an HTML tag that is shown as text and never runs.
- **Contract:** the OpenAPI file is checked against the server, including each route's minimum role.
- **CI:** lint, format, types and coverage on two Node versions, a build that is started and probed, the browser test, a container that must become healthy and run as a non-root user, a dependency audit (no runtime dependencies, nothing high or critical in tooling) and CodeQL. Dependabot keeps npm, Actions and Docker current.
