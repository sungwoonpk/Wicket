/**
 * Starts the mock upstream and the gateway, loads a policy and a few agents, and plays a short
 * scenario so the dashboard has something to show. Everything runs locally and on made-up data.
 *
 *   npm run demo            plays the scenario, then keeps the gateway running
 *   npm run demo -- --once  plays the scenario and exits
 *
 * The demo uses inflated prices so that spend is visible next to the budgets. Real prices are
 * a few orders of magnitude smaller.
 */
import { createMockUpstream } from "../src/mock/server.js";
import { createGatewayApp } from "../src/gateway/server.js";

const ADMIN = "demo-admin-token";
const MOCK_PORT = Number(process.env.MOCK_PORT ?? 4010);
const PORT = Number(process.env.PORT ?? 8080);
const base = `http://localhost:${PORT}`;
const once = process.argv.includes("--once");

const say = (text: string) => console.log(text);

async function admin(path: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
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
  prices: {
    "demo-small": { inputPerM: 150, outputPerM: 600 },
    "demo-large": { inputPerM: 3000, outputPerM: 15000 },
    "*": { inputPerM: 1000, outputPerM: 3000 },
  },
});
await new Promise<void>((resolve) => app.server.listen(PORT, resolve));

say("Wicket demo");
say(`  gateway   ${base}`);
say(`  upstream  http://localhost:${MOCK_PORT} (mock, no network, no cost)\n`);

await admin("/admin/policy", "PUT", {
  redaction: { mode: "redact", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
  defaultToolAction: "allow",
  tools: [
    { tool: "delete_*", action: "deny", reason: "destructive tools are never allowed" },
    { tool: "refund", action: "require_approval", when: [{ arg: "amount", op: "gt", value: 100 }], reason: "refunds over $100 need a human" },
    { tool: "http_request", action: "deny", when: [{ arg: "url", op: "matches", value: "^https?://(?!(api\\.)?acme\\.com)" }], reason: "outbound requests are limited to acme.com" },
  ],
});
say("policy loaded: redact PII, deny delete_*, approve refunds over $100, block outbound requests to other hosts\n");

const support = (await admin("/admin/agents", "POST", { name: "support-bot", team: "support", allowedModels: ["demo-small"], monthlyBudgetUsd: 1.5, ratePerMinute: 60 })).key;
const research = (await admin("/admin/agents", "POST", { name: "research-agent", team: "data", allowedModels: ["demo-small", "demo-large"], monthlyBudgetUsd: 10 })).key;
const billing = (await admin("/admin/agents", "POST", { name: "billing-agent", team: "finance", allowedModels: ["demo-small"], monthlyBudgetUsd: 0.5, ratePerMinute: 4 })).key;
const intern = (await admin("/admin/agents", "POST", { name: "intern-bot", team: "support", monthlyBudgetUsd: 1 })).key;
const internId = (await admin("/admin/agents", "GET")).agents.find((a: any) => a.name === "intern-bot").id;
await admin(`/admin/agents/${internId}`, "PATCH", { disabled: true });
say("4 agents created (one disabled)\n");

say("scenario");
const filler = "Summarize the account history and the most recent tickets for this customer in detail. ".repeat(10);
for (let i = 0; i < 6; i++) show("normal question", "support-bot", await chat(support, `${filler} Ticket ${i + 1}.`));
show("message with email and SSN", "support-bot", await chat(support, "Customer ann@example.com, SSN 123-45-6789, asks about her invoice."));
show("message with a card number", "support-bot", await chat(support, "Paid with 4242 4242 4242 4242 on Monday."));
show("asks for the larger model", "support-bot", await chat(support, "Use the big one.", { model: "demo-large" }));
show("long research prompt", "research-agent", await chat(research, filler, { model: "demo-large" }));
show("long research prompt", "research-agent", await chat(research, filler, { model: "demo-large" }));
show("delete_customer tool call", "support-bot", await chat(support, '[[tool:delete_customer {"id":42}]]'));
show("http_request to an outside host", "support-bot", await chat(support, '[[tool:http_request {"url":"https://files.rival.net/upload"}]]'));
show("http_request to acme.com", "support-bot", await chat(support, '[[tool:http_request {"url":"https://api.acme.com/orders"}]]'));
show("refund of $40", "billing-agent", await chat(billing, '[[tool:refund {"amount":40}]]'));
show("refund of $850", "billing-agent", await chat(billing, '[[tool:refund {"amount":850}]]'));
show("refund of $2,400", "billing-agent", await chat(billing, '[[tool:refund {"amount":2400}]]'));
show("streamed refund of $300", "billing-agent", await chat(billing, '[[tool:refund {"amount":300}]]', { stream: true, tools: [{ type: "function", function: { name: "refund" } }] }));
show("fifth call in a minute", "billing-agent", await chat(billing, "one more"));
show("disabled agent", "intern-bot", await chat(intern, "hello"));

const pending = (await admin("/admin/approvals?status=pending", "GET")).approvals;
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
  say(`dashboard: ${base}/dashboard#token=${ADMIN}`);
  say("press Ctrl+C to stop");
}
