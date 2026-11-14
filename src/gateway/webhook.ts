import { createHmac, randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { validateUpstreamUrl } from "./upstreams.js";

export interface WebhookOptions {
  url: string;
  /** Signs each delivery, so the receiver can tell it came from this gateway. */
  secret?: string;
  /** How long to wait for the receiver to answer. Default 5000. */
  timeoutMs?: number;
  /** Pauses before each retry, which also sets how many retries there are. Default 1 s, 5 s, 15 s. */
  retryDelaysMs?: number[];
}

/**
 * Applies the rules a provider address must meet (http or https, no credentials, no cloud metadata address) and
 * returns the URL exactly as given, since a receiver may care about a trailing slash.
 */
export function validateWebhookUrl(value: unknown): string {
  try {
    validateUpstreamUrl(value);
  } catch (err) {
    throw new Error((err as Error).message.replace(/^baseUrl/, "the webhook URL"));
  }
  return value as string;
}

const DEFAULT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000];

/** The signature a receiver should expect: HMAC-SHA256 of `<timestamp>.<body>`, as hex, with the secret as key. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

type Attempt = { ok: true } | { ok: false; retry: boolean; reason: string };

/**
 * Tells another system that something happened, such as a tool call waiting for a person.
 *
 * Delivery runs in the background and never holds up the request that caused it. A receiver that is down, slow or
 * answers with a server error is tried again a few times. One that answers with a client error, or a redirect, is
 * not: the answer will not change, and following a redirect would let a receiver send the gateway somewhere else.
 * A restart drops deliveries still in progress.
 */
export class Webhook {
  private readonly running = new Set<Promise<void>>();

  constructor(
    private readonly options: WebhookOptions,
    private readonly log: (record: Record<string, unknown>) => void,
  ) {}

  /** Starts a delivery and returns at once. It never throws. */
  notify(type: string, data: Record<string, unknown>): void {
    const task: Promise<void> = this.deliver(type, data)
      .catch(() => {})
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }

  /** Resolves once every delivery that has started is finished, delivered or given up. */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  private async deliver(type: string, data: Record<string, unknown>): Promise<void> {
    const id = `evt_${randomBytes(8).toString("hex")}`;
    const body = JSON.stringify({ id, type, at: new Date().toISOString(), data });
    const delays = this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      const result = await this.send(type, id, body);
      if (result.ok) {
        this.log({ event: "webhook.delivered", type, id, attempts: attempt + 1 });
        return;
      }
      if (!result.retry || attempt >= delays.length) {
        this.log({ event: "webhook.failed", type, id, attempts: attempt + 1, reason: result.reason });
        return;
      }
      await sleep(delays[attempt]!);
    }
  }

  private async send(type: string, id: string, body: string): Promise<Attempt> {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "user-agent": "wicket-webhook",
      "x-wicket-event": type,
      "x-wicket-delivery": id,
      "x-wicket-timestamp": timestamp,
    };
    if (this.options.secret)
      headers["x-wicket-signature"] = `sha256=${signWebhook(this.options.secret, timestamp, body)}`;
    try {
      const res = await fetch(this.options.url, {
        method: "POST",
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 5_000),
      });
      await res.arrayBuffer().catch(() => {});
      if (res.ok) return { ok: true };
      const retry = res.status >= 500 || res.status === 408 || res.status === 429;
      return { ok: false, retry, reason: `the receiver answered ${res.status}` };
    } catch (err) {
      const timedOut = (err as Error)?.name === "TimeoutError";
      return {
        ok: false,
        retry: true,
        reason: timedOut ? "the receiver did not answer in time" : "the receiver is unreachable",
      };
    }
  }
}
