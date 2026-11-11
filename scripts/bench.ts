/**
 * Measures the latency Wicket adds in front of the upstream.
 *
 *   npm run bench
 *   BENCH_REQUESTS=20000 BENCH_CONCURRENCY=64 npm run bench
 *
 * The mock upstream, the gateway and this client run as separate processes on one machine, so the
 * numbers describe gateway overhead on a local loopback, not production latency. The mock answers
 * instantly, which makes the gateway's own cost the dominant term.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { cpus, platform, arch } from "node:os";

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 5000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const WARMUP = 300;
const MOCK_PORT = 4300;
const GATEWAY_PORT = 8300;
const ADMIN = "bench-admin-token";

const children: ChildProcess[] = [];

function start(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn("node_modules/.bin/tsx", [script], {
    env: { ...process.env, NODE_NO_WARNINGS: "1", ...env },
    stdio: "ignore",
  });
  children.push(child);
  return child;
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url, { method: "POST", body: "{}" });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`${url} did not come up`);
}

interface Result {
  name: string;
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

async function run(name: string, url: string, headers: Record<string, string>, body: string): Promise<Result> {
  const latencies: number[] = [];
  let errors = 0;
  let sent = 0;
  const total = WARMUP + REQUESTS;
  const started = { at: 0 };

  async function worker(): Promise<void> {
    while (sent < total) {
      const n = sent++;
      if (n === WARMUP) started.at = performance.now();
      const t0 = performance.now();
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        });
        await res.arrayBuffer();
        if (res.status !== 200) errors++;
      } catch {
        errors++;
      }
      if (n >= WARMUP) latencies.push(performance.now() - t0);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - started.at) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    name,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: REQUESTS / elapsed,
    errors,
  };
}

async function main(): Promise<void> {
  start("src/mock/main.ts", { MOCK_PORT: String(MOCK_PORT) });
  start("src/gateway/main.ts", {
    PORT: String(GATEWAY_PORT),
    WICKET_ADMIN_TOKEN: ADMIN,
    WICKET_UPSTREAM_URL: `http://127.0.0.1:${MOCK_PORT}`,
    WICKET_DB: ":memory:",
  });
  await waitFor(`http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`);
  await waitFor(`http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`);

  const admin = (path: string, method: string, body: unknown) =>
    fetch(`http://127.0.0.1:${GATEWAY_PORT}${path}`, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json() as Promise<any>);

  const { key } = await admin("/admin/agents", "POST", { name: "bench", monthlyBudgetUsd: 1_000_000 });
  const body = JSON.stringify({
    model: "demo-small",
    messages: [{ role: "user", content: "Summarize the open tickets for this customer. Contact: ann@example.com" }],
  });
  const gatewayUrl = `http://127.0.0.1:${GATEWAY_PORT}/v1/chat/completions`;
  const auth = { authorization: `Bearer ${key}` };

  const results: Result[] = [];
  results.push(await run("direct to upstream", `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`, {}, body));
  results.push(await run("gateway, no policy", gatewayUrl, auth, body));

  await admin("/admin/policy", "PUT", {
    redaction: { mode: "redact", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
    defaultToolAction: "allow",
    tools: [
      { tool: "delete_*", action: "deny" },
      { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] },
    ],
  });
  results.push(await run("gateway, redaction + tool rules", gatewayUrl, auth, body));

  const base = results[0]!;
  const fmt = (n: number) => n.toFixed(2).padStart(7);
  console.log(
    `\n${REQUESTS} requests per scenario, concurrency ${CONCURRENCY}, ${cpus()[0]?.model} (${cpus().length} cores), ${platform()}/${arch()}, node ${process.version}\n`,
  );
  console.log("scenario                          p50 ms   p95 ms   p99 ms   req/s   errors");
  for (const r of results) {
    console.log(
      `${r.name.padEnd(32)} ${fmt(r.p50)}  ${fmt(r.p95)}  ${fmt(r.p99)}  ${r.rps.toFixed(0).padStart(6)}  ${String(r.errors).padStart(6)}`,
    );
  }
  console.log("\noverhead versus direct (added latency)");
  console.log("scenario                          p50 ms   p95 ms   p99 ms");
  for (const r of results.slice(1)) {
    console.log(`${r.name.padEnd(32)} ${fmt(r.p50 - base.p50)}  ${fmt(r.p95 - base.p95)}  ${fmt(r.p99 - base.p99)}`);
  }
}

try {
  await main();
} finally {
  for (const c of children) c.kill();
}
