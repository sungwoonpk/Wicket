import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { describe, it } from "node:test";
import { signWebhook, validateWebhookUrl, Webhook } from "../src/gateway/webhook.js";
import { harness, listen, type Harness } from "./helpers.js";

interface Received {
  headers: IncomingMessage["headers"];
  body: string;
  json: any;
}

/** A receiver that records what it is sent and answers with the statuses it is told to, then 200. */
async function receiver(statuses: number[] = [], extra: Record<string, string> = {}) {
  const received: Received[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ headers: req.headers, body, json: JSON.parse(body) });
      const status = statuses.shift() ?? 200;
      res.writeHead(status, extra);
      res.end("ok");
    });
  });
  const url = await listen(server);
  return {
    url,
    received,
    close: () => {
      server.closeAllConnections();
      server.close();
    },
  };
}

const POLICY = { tools: [{ tool: "refund", action: "require_approval" }] };
const FAST = [5, 5, 5];

async function withGateway<T>(
  options: { url: string; secret?: string; retryDelaysMs?: number[] },
  run: (h: Harness, logs: Record<string, unknown>[]) => Promise<T>,
): Promise<T> {
  const logs: Record<string, unknown>[] = [];
  const h = await harness({
    gateway: { logger: (r) => logs.push(r), approvalWebhook: { retryDelaysMs: FAST, ...options } },
  });
  try {
    await h.admin("/admin/policy", "PUT", POLICY);
    return await run(h, logs);
  } finally {
    await h.app.webhook?.idle();
    h.close();
  }
}

describe("approval webhook", () => {
  it("sends a signed message when a tool call is held, without the arguments", async () => {
    const hook = await receiver();
    try {
      await withGateway({ url: hook.url, secret: "shhh-secret" }, async (h) => {
        const key = await h.newAgent();
        const held = await h.chat(key, '[[tool:refund {"amount":500,"note":"card-on-file-77-private"}]]');
        assert.equal(held.status, 202);
        await h.app.webhook!.idle();

        assert.equal(hook.received.length, 1);
        const got = hook.received[0]!;
        assert.equal(got.json.type, "approval.requested");
        assert.match(got.json.id, /^evt_[0-9a-f]{16}$/);
        const { data } = got.json;
        assert.equal(data.approvalId, ((await held.json()) as any).approval_id);
        assert.equal(data.team, "default");
        assert.deepEqual(data.toolCalls, [{ name: "refund", reason: "matched rule 1" }]);
        assert.ok(!got.body.includes("card-on-file-77-private"), "argument values are not sent");
        assert.ok(!got.body.includes("500"), "nor the amount");

        assert.equal(got.headers["x-wicket-event"], "approval.requested");
        assert.equal(got.headers["x-wicket-delivery"], got.json.id);
        const stamp = String(got.headers["x-wicket-timestamp"]);
        assert.ok(Math.abs(Number(stamp) - Date.now() / 1000) < 30);
        assert.equal(
          got.headers["x-wicket-signature"],
          `sha256=${signWebhook("shhh-secret", stamp, got.body)}`,
          "the receiver can check who sent it",
        );
        assert.notEqual(
          got.headers["x-wicket-signature"],
          `sha256=${signWebhook("another-secret", stamp, got.body)}`,
          "and a wrong secret does not match",
        );
      });
    } finally {
      hook.close();
    }
  });

  it("sends no signature when no secret is set, and sends nothing when no webhook is set", async () => {
    const hook = await receiver();
    try {
      await withGateway({ url: hook.url }, async (h) => {
        await h.chat(await h.newAgent(), '[[tool:refund {"amount":5}]]');
        await h.app.webhook!.idle();
        assert.equal(hook.received[0]!.headers["x-wicket-signature"], undefined);
      });
    } finally {
      hook.close();
    }
    const plain = await harness();
    try {
      await plain.admin("/admin/policy", "PUT", POLICY);
      assert.equal(plain.app.webhook, undefined);
      assert.equal((await plain.chat(await plain.newAgent(), '[[tool:refund {"amount":5}]]')).status, 202);
    } finally {
      plain.close();
    }
  });

  it("does not send anything for a call that is allowed or denied", async () => {
    const hook = await receiver();
    try {
      await withGateway({ url: hook.url }, async (h) => {
        const key = await h.newAgent();
        await h.admin("/admin/policy", "PUT", { tools: [{ tool: "wipe", action: "deny" }, ...POLICY.tools] });
        assert.equal((await h.chat(key, "[[tool:wipe {}]]")).status, 403);
        assert.equal((await h.chat(key, "[[tool:lookup {}]]")).status, 200);
        await h.app.webhook!.idle();
        assert.equal(hook.received.length, 0);
      });
    } finally {
      hook.close();
    }
  });

  it("tries again when the receiver fails, and says so once it gets through", async () => {
    const hook = await receiver([500, 503]);
    try {
      await withGateway({ url: hook.url }, async (h, logs) => {
        await h.chat(await h.newAgent(), '[[tool:refund {"amount":5}]]');
        await h.app.webhook!.idle();
        assert.equal(hook.received.length, 3, "two failures, then success");
        assert.equal(new Set(hook.received.map((r) => r.json.id)).size, 1, "the same delivery each time");
        const done = logs.find((r) => r.event === "webhook.delivered");
        assert.equal(done?.attempts, 3);
      });
    } finally {
      hook.close();
    }
  });

  it("gives up after the last retry and logs why, without failing the request", async () => {
    const hook = await receiver([500, 500, 500, 500, 500]);
    try {
      await withGateway({ url: hook.url }, async (h, logs) => {
        const started = Date.now();
        const res = await h.chat(await h.newAgent(), '[[tool:refund {"amount":5}]]');
        assert.equal(res.status, 202, "the agent still gets its answer");
        assert.ok(Date.now() - started < 2000, "and does not wait for the webhook");
        await h.app.webhook!.idle();
        assert.equal(hook.received.length, 4, "the first try and three retries");
        const failed = logs.find((r) => r.event === "webhook.failed");
        assert.equal(failed?.attempts, 4);
        assert.match(String(failed?.reason), /answered 500/);
      });
    } finally {
      hook.close();
    }
  });

  it("does not retry an answer that will not change, nor follow a redirect", async () => {
    for (const [status, extra] of [
      [400, {}],
      [404, {}],
      [302, { location: "http://127.0.0.1:1/elsewhere" }],
    ] as [number, Record<string, string>][]) {
      const hook = await receiver([status], extra);
      try {
        await withGateway({ url: hook.url }, async (h, logs) => {
          await h.chat(await h.newAgent(), '[[tool:refund {"amount":5}]]');
          await h.app.webhook!.idle();
          assert.equal(hook.received.length, 1, `${status} is not retried`);
          assert.equal(logs.find((r) => r.event === "webhook.failed")?.attempts, 1);
        });
      } finally {
        hook.close();
      }
    }
  });

  it("retries a rate limit and a timeout answer", async () => {
    const hook = await receiver([429, 408]);
    try {
      await withGateway({ url: hook.url }, async (h) => {
        await h.chat(await h.newAgent(), '[[tool:refund {"amount":5}]]');
        await h.app.webhook!.idle();
        assert.equal(hook.received.length, 3);
      });
    } finally {
      hook.close();
    }
  });

  it("copes with a receiver that is not there, and one that never answers", async () => {
    const logs: Record<string, unknown>[] = [];
    const gone = new Webhook({ url: "http://127.0.0.1:1/hook", retryDelaysMs: [1] }, (r) => logs.push(r));
    gone.notify("approval.requested", {});
    await gone.idle();
    assert.match(String(logs.find((r) => r.event === "webhook.failed")?.reason), /unreachable/);

    const silent = createServer(() => {});
    const url = await listen(silent);
    try {
      const slow = new Webhook({ url, timeoutMs: 50, retryDelaysMs: [] }, (r) => logs.push(r));
      slow.notify("approval.requested", {});
      await slow.idle();
      assert.ok(logs.some((r) => /did not answer in time/.test(String(r.reason))));
    } finally {
      silent.closeAllConnections();
      silent.close();
    }
  });
});

describe("webhook address", () => {
  it("applies the provider address rules and keeps the address as given", () => {
    assert.equal(validateWebhookUrl("https://hooks.example.com/abc/"), "https://hooks.example.com/abc/");
    assert.equal(validateWebhookUrl("http://localhost:9000/x"), "http://localhost:9000/x");
    for (const bad of [
      "ftp://x.example.com",
      "not a url",
      "https://user:pw@x.example.com",
      "http://169.254.169.254/latest",
      5,
    ]) {
      assert.throws(() => validateWebhookUrl(bad), /the webhook URL/, String(bad));
    }
  });
});
