import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createMockUpstream } from "../src/mock/server.js";
import { signWebhook } from "../src/gateway/webhook.js";

const MAIN = "src/gateway/main.ts";
const STRONG = "0123456789abcdef0123456789";

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

interface Finished {
  code: number | null;
  stdout: string;
  stderr: string;
}

function launch(env: Record<string, string>): { child: ChildProcess; done: Promise<Finished>; output: () => string } {
  const child = spawn(process.execPath, ["--import", "tsx", MAIN], {
    env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1", WICKET_DB: ":memory:", ...env },
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (d) => (stdout += d));
  child.stderr!.on("data", (d) => (stderr += d));
  const done = new Promise<Finished>((resolve) => child.on("close", (code) => resolve({ code, stdout, stderr })));
  return { child, done, output: () => stdout + stderr };
}

async function waitUntil(check: () => boolean | Promise<boolean>, ms = 15_000): Promise<void> {
  const until = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await sleep(50);
  }
}

describe("start-up checks", () => {
  it("refuses to start without an admin token", async () => {
    const { done } = launch({});
    const r = await done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /WICKET_ADMIN_TOKEN is required/);
  });

  it("refuses a short admin token", async () => {
    const { done } = launch({ WICKET_ADMIN_TOKEN: "short" });
    const r = await done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /too short/);
  });

  it("refuses a bad port and a bad timeout", async () => {
    assert.match((await launch({ WICKET_ADMIN_TOKEN: STRONG, PORT: "99999" }).done).stderr, /PORT must be/);
    assert.match(
      (await launch({ WICKET_ADMIN_TOKEN: STRONG, WICKET_UPSTREAM_TIMEOUT_MS: "soon" }).done).stderr,
      /TIMEOUT_MS/,
    );
  });

  it("refuses an approval webhook address that is not allowed", async () => {
    for (const url of ["ftp://hooks.example.com", "http://169.254.169.254/latest", "not a url"]) {
      const r = await launch({ WICKET_ADMIN_TOKEN: STRONG, WICKET_APPROVAL_WEBHOOK_URL: url }).done;
      assert.equal(r.code, 1, url);
      assert.match(r.stderr, /WICKET_APPROVAL_WEBHOOK_URL/);
    }
  });

  it("refuses a price file that could price requests at zero", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wicket-"));
    try {
      const file = join(dir, "prices.json");
      writeFileSync(file, JSON.stringify({ "some-model": { inputPerM: 1 } }));
      const r = await launch({ WICKET_ADMIN_TOKEN: STRONG, WICKET_PRICES_FILE: file }).done;
      assert.equal(r.code, 1);
      assert.match(r.stderr, /WICKET_PRICES_FILE/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("running process", () => {
  it("listens on loopback by default, logs structured records, and stops cleanly on SIGTERM", async () => {
    const port = await freePort();
    const { child, done, output } = launch({
      WICKET_ADMIN_TOKEN: STRONG,
      PORT: String(port),
      WICKET_AUDIT_KEY: "separate-signing-key-0123456789",
    });
    try {
      await waitUntil(() => output().includes("listening"));
      assert.match(output(), new RegExp(`http://127\\.0\\.0\\.1:${port}`), "bound to loopback, not to every interface");
      assert.ok(!output().includes("WICKET_AUDIT_KEY is not set"), "no warning when a separate audit key is given");

      const base = `http://127.0.0.1:${port}`;
      assert.equal((await fetch(`${base}/readyz`)).status, 200);
      const created = await fetch(`${base}/admin/agents`, {
        method: "POST",
        headers: { authorization: `Bearer ${STRONG}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "proc-test" }),
      });
      const { key } = (await created.json()) as { key: string };
      await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content: "hi" }] }),
      }); // the upstream is not running, so this is a 502, which is still logged
      await waitUntil(() => output().includes('"event":"request"'));
      const line = output()
        .split("\n")
        .find((l) => l.includes('"event":"request"'))!;
      const record = JSON.parse(line);
      assert.equal(record.agent, "proc-test");
      assert.equal(record.status, 502);
      assert.ok(!line.includes(key) && !line.includes(STRONG), "no secret in a log line");

      child.kill("SIGTERM");
      const finished = await Promise.race([done, sleep(8000).then(() => "timeout" as const)]);
      assert.notEqual(finished, "timeout", "it must exit on SIGTERM");
      assert.equal((finished as Finished).code, 0);
      assert.match((finished as Finished).stdout, /shutting down/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("warns when the audit key is derived from the admin token", async () => {
    const port = await freePort();
    const { child, output } = launch({ WICKET_ADMIN_TOKEN: STRONG, PORT: String(port) });
    try {
      await waitUntil(() => output().includes("listening"));
      assert.match(output(), /WICKET_AUDIT_KEY is not set/);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("sends a signed message to the approval webhook from the environment, and warns when it is unsigned", async () => {
    const mock = createMockUpstream();
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
    const upstream = `http://127.0.0.1:${(mock.address() as { port: number }).port}`;
    const hits: { headers: Record<string, unknown>; body: string }[] = [];
    const hook = createHttpServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        hits.push({ headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
        res.end("ok");
      });
    });
    await new Promise<void>((resolve) => hook.listen(0, "127.0.0.1", () => resolve()));
    const hookUrl = `http://127.0.0.1:${(hook.address() as { port: number }).port}/approvals`;

    const trigger = async (port: number) => {
      const base = `http://127.0.0.1:${port}`;
      const admin = { authorization: `Bearer ${STRONG}`, "content-type": "application/json" };
      await fetch(`${base}/admin/policy`, {
        method: "PUT",
        headers: admin,
        body: JSON.stringify({ tools: [{ tool: "refund", action: "require_approval" }] }),
      });
      const { key } = (await (
        await fetch(`${base}/admin/agents`, { method: "POST", headers: admin, body: JSON.stringify({ name: "w" }) })
      ).json()) as { key: string };
      return fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "demo-small",
          messages: [{ role: "user", content: '[[tool:refund {"amount":9}]]' }],
        }),
      });
    };

    const unsigned = await freePort();
    const first = launch({
      WICKET_ADMIN_TOKEN: STRONG,
      PORT: String(unsigned),
      WICKET_UPSTREAM_URL: upstream,
      WICKET_APPROVAL_WEBHOOK_URL: hookUrl,
    });
    const signedPort = await freePort();
    const second = launch({
      WICKET_ADMIN_TOKEN: STRONG,
      PORT: String(signedPort),
      WICKET_UPSTREAM_URL: upstream,
      WICKET_APPROVAL_WEBHOOK_URL: hookUrl,
      WICKET_WEBHOOK_SECRET: "process-test-secret",
      WICKET_AUDIT_KEY: "separate-signing-key-0123456789",
    });
    try {
      await waitUntil(() => first.output().includes("listening") && second.output().includes("listening"));
      assert.match(first.output(), /WICKET_WEBHOOK_SECRET is not set/);
      assert.ok(!second.output().includes("WICKET_WEBHOOK_SECRET is not set"));

      assert.equal((await trigger(signedPort)).status, 202);
      await waitUntil(() => hits.length === 1);
      const got = hits[0]!;
      const stamp = String(got.headers["x-wicket-timestamp"]);
      assert.equal(got.headers["x-wicket-signature"], `sha256=${signWebhook("process-test-secret", stamp, got.body)}`);
      assert.equal(JSON.parse(got.body).type, "approval.requested");

      assert.equal((await trigger(unsigned)).status, 202);
      await waitUntil(() => hits.length === 2);
      assert.equal(hits[1]!.headers["x-wicket-signature"], undefined);
    } finally {
      first.child.kill("SIGKILL");
      second.child.kill("SIGKILL");
      hook.closeAllConnections();
      hook.close();
      mock.closeAllConnections();
      mock.close();
    }
  });

  it("can be silenced", async () => {
    const port = await freePort();
    const { child, output } = launch({ WICKET_ADMIN_TOKEN: STRONG, PORT: String(port), WICKET_LOG: "off" });
    try {
      await waitUntil(() => output().includes("listening"));
      await fetch(`http://127.0.0.1:${port}/readyz`);
      assert.ok(!output().includes('"event"'));
    } finally {
      child.kill("SIGKILL");
    }
  });
});
