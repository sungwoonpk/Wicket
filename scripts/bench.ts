/**
 * Measures the latency Wicket adds in front of the upstream.
 *
 *   npm run bench
 *   BENCH_REQUESTS=20000 BENCH_CONCURRENCY=64 BENCH_ROUNDS=5 npm run bench
 *
 * The mock upstream, the gateway and this client run as separate processes on one machine, so the
 * numbers describe gateway overhead on a local loopback, not production latency. The mock answers
 * instantly, which makes the gateway's own cost the dominant term.
 *
 * To keep one lucky or unlucky run from deciding the result, every scenario is warmed up first, the
 * scenarios then take turns over several rounds, and the report shows the median of the rounds.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { cpus, platform, arch } from "node:os";

const REQUESTS = Number(process.env.BENCH_REQUESTS ?? 3000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 5);
const WARMUP = Number(process.env.BENCH_WARMUP ?? 1500);
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

interface Sample {
  p50: number;
  p95: number;
  p99: number;
  rps: number;
  errors: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

async function run(url: string, headers: Record<string, string>, body: string, count: number): Promise<Sample> {
  const latencies: number[] = [];
  let errors = 0;
  let sent = 0;

  async function worker(): Promise<void> {
    while (sent < count) {
      sent++;
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
      latencies.push(performance.now() - t0);
    }
  }

  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsed = (performance.now() - started) / 1000;
  latencies.sort((a, b) => a - b);
  return {
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    rps: count / elapsed,
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
    WICKET_AUDIT_KEY: "bench-audit-key-0123456789",
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

  const policyOn = {
    redaction: { mode: "redact", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
    defaultToolAction: "allow",
    tools: [
      { tool: "delete_*", action: "deny" },
      { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }] },
    ],
  };
  const policyOff = { redaction: { mode: "off" }, tools: [], defaultToolAction: "allow" };

  const scenarios = [
    {
      name: "direct to upstream",
      url: `http://127.0.0.1:${MOCK_PORT}/v1/chat/completions`,
      headers: {},
      policy: null as object | null,
    },
    { name: "gateway, no policy", url: gatewayUrl, headers: auth, policy: policyOff },
    { name: "gateway, redaction + tool rules", url: gatewayUrl, headers: auth, policy: policyOn },
  ];

  // Warm every path first, so no scenario pays for the engine getting ready.
  for (const s of scenarios) {
    if (s.policy) await admin("/admin/policy", "PUT", s.policy);
    await run(s.url, s.headers, body, WARMUP);
  }

  const samples: Sample[][] = scenarios.map(() => []);
  for (let round = 0; round < ROUNDS; round++) {
    for (const [i, s] of scenarios.entries()) {
      if (s.policy) await admin("/admin/policy", "PUT", s.policy);
      samples[i]!.push(await run(s.url, s.headers, body, REQUESTS));
    }
  }

  const summary = scenarios.map((s, i) => ({
    name: s.name,
    p50: median(samples[i]!.map((x) => x.p50)),
    p95: median(samples[i]!.map((x) => x.p95)),
    p99: median(samples[i]!.map((x) => x.p99)),
    rps: median(samples[i]!.map((x) => x.rps)),
    errors: samples[i]!.reduce((n, x) => n + x.errors, 0),
  }));

  const base = summary[0]!;
  const fmt = (n: number) => n.toFixed(2).padStart(7);
  console.log(
    `\n${REQUESTS} requests per scenario per round, ${ROUNDS} rounds, median reported. Concurrency ${CONCURRENCY}, ${cpus()[0]?.model} (${cpus().length} cores), ${platform()}/${arch()}, node ${process.version}\n`,
  );
  console.log("scenario                          p50 ms   p95 ms   p99 ms   req/s   errors");
  for (const r of summary) {
    console.log(
      `${r.name.padEnd(32)} ${fmt(r.p50)}  ${fmt(r.p95)}  ${fmt(r.p99)}  ${r.rps.toFixed(0).padStart(6)}  ${String(r.errors).padStart(6)}`,
    );
  }
  console.log("\noverhead versus direct (added latency)");
  console.log("scenario                          p50 ms   p95 ms   p99 ms");
  for (const r of summary.slice(1)) {
    console.log(`${r.name.padEnd(32)} ${fmt(r.p50 - base.p50)}  ${fmt(r.p95 - base.p95)}  ${fmt(r.p99 - base.p99)}`);
  }
}

try {
  await main();
} finally {
  for (const c of children) c.kill();
}
