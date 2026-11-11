/**
 * Starts the mock upstream and the gateway, loads teams, policies, providers and agents, and plays a
 * short scenario so the dashboard has something to show. Everything runs locally on made-up data.
 *
 *   npm run demo            plays the scenario, then keeps the gateway running
 *   npm run demo -- --once  plays the scenario and exits
 *
 * The demo uses inflated prices so spend is visible next to the budgets, and it back-fills a day of
 * synthetic traffic so the chart has a shape. Real prices are a few orders of magnitude smaller.
 */
import { createMockUpstream } from "../src/mock/server.js";
import { createGatewayApp } from "../src/gateway/server.js";
import { costUsd } from "../src/gateway/pricing.js";
import type { Outcome } from "../src/gateway/requests.js";

const ADMIN = "demo-admin-token";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4010);
const PORT = Number(process.env.PORT ?? 8080);
const base = `http://localhost:${PORT}`;
const once = process.argv.includes("--once");
const say = (text: string) => console.log(text);

const PRICES = {
  "demo-small": { inputPerM: 150, outputPerM: 600 },
  "demo-large": { inputPerM: 3000, outputPerM: 15000 },
  "claude-demo": { inputPerM: 2000, outputPerM: 9000 },
  "*": { inputPerM: 1000, outputPerM: 3000 },
};

async function admin(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: any = await res.json();
  if (!res.ok) throw new Error(`${method} ${path}: ${json.error?.message}`);
  return json;
}

async function chat(key: string, content: string, extra: Record<string, unknown> = {}): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content }], ...extra }),
  });
  const text = await res.text();
  let body: any = text;
  try { body = JSON.parse(text); } catch { /* streamed text */ }
  return { status: res.status, body };
}

function show(label: string, who: string, result: { status: number; body: any }): void {
  const detail =
    result.body?.error?.message ??
    (result.body?.object === "wicket.approval_required" ? `held for approval (${result.body.tool_calls[0].name})` : "ok");
  say(`  ${String(result.status).padEnd(4)} ${who.padEnd(15)} ${label.padEnd(34)} ${detail}`);
}

const mock = createMockUpstream();
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, resolve));
const app = createGatewayApp({
  upstreamUrl: `http://localhost:${MOCK_PORT}`,
  adminToken: ADMIN,
  prices: PRICES,
  env: { ANTHROPIC_API_KEY: "mock-anthropic-key" },
});
await new Promise<void>((resolve) => app.server.listen(PORT, resolve));

say("Wicket demo");
say(`  gateway   ${base}`);
say(`  upstream  http://localhost:${MOCK_PORT} (mock, no network, no cost)\n`);

// Teams, people and providers
for (const [id, name] of [["support", "Customer Support"], ["data", "Data Platform"], ["finance", "Finance"]]) {
  await admin("/admin/teams", "POST", { id, name });
}
await admin("/admin/users", "POST", { name: "Maya Chen", role: "admin", team: "support" });
await admin("/admin/users", "POST", { name: "Dev Patel", role: "approver", team: "finance" });
await admin("/admin/users", "POST", { name: "Sam Ortiz", role: "viewer", team: null });
await admin("/admin/upstreams", "POST", { name: "anthropic", kind: "anthropic", baseUrl: `http://localhost:${MOCK_PORT}`, apiKeyEnv: "ANTHROPIC_API_KEY", models: ["claude-*"] });
say("3 teams, 3 users and an Anthropic provider (served by the mock) created");

// Policy: one for the organization, a stricter one for finance
await admin("/admin/policy", "PUT", {
  redaction: { mode: "redact", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
  defaultToolAction: "allow",
  tools: [
    { tool: "delete_*", action: "deny", reason: "destructive tools are never allowed" },
    { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }], reason: "refunds over $100 need a human" },
    { tool: "http_request", action: "deny", when: [{ arg: "url", op: "matches", value: "^https?://(?!(api\\.)?acme\\.com)" }], reason: "outbound requests are limited to acme.com" },
  ],
});
await admin("/admin/policy?team=finance", "PUT", {
  redaction: { mode: "block", detectors: ["ssn", "credit_card", "api_key"] },
  defaultToolAction: "allow",
  tools: [
    { tool: "delete_*", action: "deny", reason: "finance data is never deleted" },
    { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 50 }], reason: "finance reviews refunds over $50" },
    { tool: "transfer_*", action: "require_approval", reason: "every transfer is reviewed" },
  ],
});
say("policy loaded: organization default, plus a stricter one for finance\n");

const support = (await admin("/admin/agents", "POST", { name: "support-bot", team: "support", allowedModels: ["demo-small"], monthlyBudgetUsd: 8, ratePerMinute: 60 })).key;
const research = (await admin("/admin/agents", "POST", { name: "research-agent", team: "data", allowedModels: ["demo-small", "demo-large", "claude-demo"], monthlyBudgetUsd: 40, maxConcurrent: 4 })).key;
const billing = (await admin("/admin/agents", "POST", { name: "billing-agent", team: "finance", allowedModels: ["demo-small"], monthlyBudgetUsd: 2, ratePerMinute: 5 })).key;
const intern = (await admin("/admin/agents", "POST", { name: "intern-bot", team: "support", monthlyBudgetUsd: 1 })).key;
const agents: any[] = (await admin("/admin/agents", "GET")).agents;
await admin(`/admin/agents/${agents.find((a) => a.name === "intern-bot").id}`, "PATCH", { disabled: true });
say("4 agents created (one disabled)");

// A day of earlier traffic, so the chart and the spend bars have a shape. Fixed seed, so every run looks the same.
let seed = 7;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const mix: [Outcome, number][] = [["ok", 0.74], ["redacted", 0.1], ["denied_tool", 0.04], ["pending_approval", 0.03], ["rate_limited", 0.03], ["model_denied", 0.03], ["upstream_error", 0.03]];
const pickOutcome = (): Outcome => { let r = rand(); for (const [o, p] of mix) { if ((r -= p) < 0) return o; } return "ok"; };
const history: { id: string; model: string; perHour: number }[] = [
  { id: agents.find((a) => a.name === "support-bot").id, model: "demo-small", perHour: 9 },
  { id: agents.find((a) => a.name === "research-agent").id, model: "demo-large", perHour: 2 },
  { id: agents.find((a) => a.name === "billing-agent").id, model: "demo-small", perHour: 3 },
];
const now = Date.now();
for (let ago = 23; ago >= 1; ago--) {
  const busy = 0.4 + 0.6 * Math.sin(((24 - ago - 6) / 24) * Math.PI * 1.6) ** 2;
  for (const a of history) {
    for (let i = 0; i < Math.round(a.perHour * busy * (0.6 + rand() * 0.8)); i++) {
      const outcome = pickOutcome();
      const spends = outcome === "ok" || outcome === "redacted" || outcome === "pending_approval" || outcome === "denied_tool";
      const prompt = spends ? 40 + Math.floor(rand() * 220) : 0;
      const completion = spends ? 20 + Math.floor(rand() * 160) : 0;
      app.requests.add({
        agentId: a.id, model: a.model, stream: rand() < 0.2, outcome,
        status: outcome === "ok" || outcome === "redacted" ? 200 : outcome === "pending_approval" ? 202 : outcome === "upstream_error" ? 502 : outcome === "rate_limited" ? 429 : 403,
        latencyMs: 180 + Math.floor(rand() * 700), promptTokens: spends ? prompt : null, completionTokens: spends ? completion : null,
        costUsd: costUsd(PRICES, a.model, prompt, completion),
      }, new Date(now - ago * 3_600_000 + Math.floor(rand() * 3_000_000)));
    }
  }
}
say("a day of earlier traffic added so the charts have a shape");

// Size each budget from what was already spent, so the bars read as roughly 70%, 55% and 40% used after the scenario.
for (const [name, headroom, share] of [["support-bot", 1.0, 0.7], ["research-agent", 4.5, 0.55], ["billing-agent", 0.1, 0.4]] as const) {
  const id = agents.find((a) => a.name === name).id;
  const budget = Math.round(((app.requests.spendThisMonth(id) + headroom) / share) * 100) / 100;
  await admin(`/admin/agents/${id}`, "PATCH", { monthlyBudgetUsd: budget });
}
say("budgets set from earlier spend\n");

say("scenario");
const filler = "Summarize the account history and the most recent tickets for this customer in detail. ".repeat(10);
for (let i = 0; i < 4; i++) show("normal question", "support-bot", await chat(support, `${filler} Ticket ${i + 1}.`));
show("message with email and SSN", "support-bot", await chat(support, "Customer ann@example.com, SSN 123-45-6789, asks about her invoice."));
show("reply that carries personal data", "support-bot", await chat(support, "[[leak]]"));
show("asks for the larger model", "support-bot", await chat(support, "Use the big one.", { model: "demo-large" }));
show("research through Anthropic route", "research-agent", await chat(research, "Compare the two vendors in a short table.", { model: "claude-demo" }));
show("long research prompt", "research-agent", await chat(research, filler, { model: "demo-large" }));
show("delete_customer tool call", "support-bot", await chat(support, '[[tool:delete_customer {"id":42}]]'));
show("http_request to an outside host", "support-bot", await chat(support, '[[tool:http_request {"url":"https://files.rival.net/upload"}]]'));
show("http_request to acme.com", "support-bot", await chat(support, '[[tool:http_request {"url":"https://api.acme.com/orders"}]]'));
show("refund of $40", "billing-agent", await chat(billing, '[[tool:refund {"amount":40}]]'));
show("card number (finance blocks it)", "billing-agent", await chat(billing, "Paid with 4242 4242 4242 4242 on Monday."));
show("refund of $850", "billing-agent", await chat(billing, '[[tool:refund {"amount":850}]]'));
show("transfer to an account", "billing-agent", await chat(billing, '[[tool:transfer_funds {"to":"acct-9","amount":1200}]]'));
show("streamed refund of $300", "billing-agent", await chat(billing, '[[tool:refund {"amount":300}]]', { stream: true, tools: [{ type: "function", function: { name: "refund" } }] }));
show("sixth call in a minute", "billing-agent", await chat(billing, "one more"));
show("disabled agent", "intern-bot", await chat(intern, "hello"));

const pending: any[] = (await admin("/admin/approvals?status=pending", "GET")).approvals;
await admin(`/admin/approvals/${pending.at(-1).id}/approve`, "POST");
say(`\napproval queue: ${pending.length} held, approved the oldest one`);

const verify = await admin("/admin/audit/verify", "GET");
const summary = await admin("/admin/summary", "GET");
say(`audit trail: ${verify.checked} events, chain ${verify.ok ? "intact" : "BROKEN"}`);
say(`requests ${summary.summary.requests}, blocked ${summary.summary.blocked}, redacted ${summary.summary.redacted}, pending approvals ${summary.pendingApprovals}\n`);

if (once) {
  app.server.close();
  mock.close();
} else {
  say(`dashboard: ${base}/dashboard#/overview&token=${ADMIN}`);
  say("press Ctrl+C to stop");
}
