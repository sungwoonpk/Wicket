# Contributing

## Set up

Needs Node 22.13 or newer, because the database is Node's built-in `node:sqlite`.

```sh
npm install
npm run check      # lint, format, types, and tests with coverage gates: run this before every push
```

| Command                 | What it does                                                            |
| ----------------------- | ----------------------------------------------------------------------- |
| `npm test`              | All tests, no coverage                                                  |
| `npm run test:coverage` | Tests with line, function and branch gates                              |
| `npm run test:ui`       | Loads every dashboard page in headless Chrome (needs Chrome, see below) |
| `npm run lint`          | ESLint                                                                  |
| `npm run format`        | Prettier, writes changes                                                |
| `npm run typecheck`     | TypeScript with no output                                               |
| `npm run build`         | Compiles to `dist/`                                                     |
| `npm run demo`          | The scripted scenario, then the dashboard                               |
| `npm run bench`         | Latency overhead, median of several rounds                              |

`npm run test:ui` looks for Chrome in the usual places. Set `CHROME_BIN` if yours is elsewhere.

## No real keys, ever

Nothing in this repository needs a real provider key. Development, tests, CI and the demo all run against the mock
upstream in `src/mock`. Please keep it that way, and never commit a key, token or `.env` file.

## How the code is laid out

- `src/policy` is pure functions with no input or output. Put new rules there so they can be tested without a server.
- `src/gateway` is the server. `chat.ts` is the request pipeline, `admin.ts` is the admin API, the other files are one
  store each. Stores take a database in the constructor, so tests use an in-memory one.
- `src/providers` translates between the OpenAI format and a provider's own.
- `src/mock` is the stand-in upstream. Add a directive there when a test needs the upstream to misbehave.

## Making a change

1. Write the test first when you fix a bug, and watch it fail for the reason you expect.
2. Add a route to `src/gateway/admin.ts` **and** to `docs/openapi.yaml`, with its `x-min-role`. A test fails if they differ.
3. If you change a design decision, write or amend a record in `docs/decisions`. Say what it costs, not only why it is good.
4. Keep the README true. Check each claim you touch against the code.
5. Commit small, with a message that says what changed and why. Everything in the repository is written in English.

## Style

Prettier and ESLint decide formatting and most style questions. Beyond that: prefer a plain function to a class, write a
comment for the reason behind something and not for what it does, and fail closed when a security decision is unclear.
