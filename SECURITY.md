# Security

## Reporting a problem

Please **do not open a public issue** for a security problem. Use GitHub's private reporting instead: on the repository
page, open the **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it and
what you think the impact is.

This is a personal project, so there is no service level. Reports are read and answered on a best-effort basis, and a
confirmed problem is fixed in `main`. Only the latest `main` is supported.

## What to expect from the gateway

[docs/threat-model.md](docs/threat-model.md) lists what Wicket defends against and, just as important, what it does not.
Read the "What is not covered" section before running it anywhere real. The short version:

- It has **no TLS of its own**. Run it behind a proxy that terminates TLS.
- It has **not had an independent security review**.
- Streamed replies are **not scanned** for personal data, and detection is pattern based.

## If you deploy it

- Use a long random `WICKET_ADMIN_TOKEN`, and a **different** random `WICKET_AUDIT_KEY` kept outside the database host.
  `openssl rand -hex 24` is enough. The server refuses an admin token shorter than 16 characters.
- Keep the SQLite file on a volume only the gateway can read. It holds key hashes, policy, request logs and held tool calls.
- Give provider keys to the gateway through environment variables filled from a secret manager. They are never stored.
- Create users with the lowest role that works, limit them to a team where you can, and disable keys that are not used.
- Listen on loopback or a private network, and expose only the proxy. The default bind address is `127.0.0.1`.
- Put rate limiting in front of anything reachable from the internet.
- Run `GET /admin/audit/verify` on a schedule and alert when it reports `ok: false`.
