/**
 * Loads every dashboard page in headless Chrome and checks what was drawn.
 *
 *   npm run test:ui
 *   CHROME_BIN=/path/to/chrome npm run test:ui
 *
 * It needs a Chrome or Chromium install. It starts its own gateway on a random port with made-up data.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { promisify } from "node:util";
import { createMockUpstream } from "../src/mock/server.js";
import { createGatewayApp } from "../src/gateway/server.js";

const run = promisify(execFile);
const ADMIN = "ui-smoke-admin-token";

function findChrome(): string {
  const candidates = [
    process.env.CHROME_BIN,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((c) => c && existsSync(c));
  if (!found) {
    console.error("No Chrome or Chromium found. Set CHROME_BIN to its path.");
    process.exit(2);
  }
  return found;
}

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
  );

const mock = createMockUpstream();
const mockPort = await listen(mock);
const app = createGatewayApp({ upstreamUrl: `http://127.0.0.1:${mockPort}`, adminToken: ADMIN });
const port = await listen(app.server);
const base = `http://127.0.0.1:${port}`;
const chrome = findChrome();

async function api(path: string, method = "GET", body?: unknown): Promise<any> {
  const res = await fetch(base + path, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

// Some data to draw
await api("/admin/teams", "POST", { id: "support" });
await api("/admin/teams", "POST", { id: "finance" });
await api("/admin/policy", "PUT", { tools: [{ tool: "refund", action: "require_approval" }] });
const support = (await api("/admin/agents", "POST", { name: "support-bot", team: "support", monthlyBudgetUsd: 5 })).key;
const finance = (await api("/admin/agents", "POST", { name: "billing-agent", team: "finance" })).key;
const hostile = (
  await api("/admin/agents", "POST", {
    name: "<img src=x onerror=document.documentElement.setAttribute('data-pwned','1')>",
    team: "support",
  })
).key;
const call = (key: string, content: string) =>
  fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "demo-small", messages: [{ role: "user", content }] }),
  });
await call(support, "hello");
await call(finance, '[[tool:refund {"amount":500}]]');
await call(hostile, "hello");
const viewer = (await api("/admin/users", "POST", { name: "Vee", role: "viewer", team: "support" })).key;

async function dom(hash: string): Promise<string> {
  const { stdout } = await run(
    chrome,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--virtual-time-budget=9000",
      "--dump-dom",
      `${base}/dashboard#${hash}`,
    ],
    { maxBuffer: 20_000_000, timeout: 60_000 },
  );
  return stdout;
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : "  " + detail}`);
  if (!ok) failures++;
}
const noErrors = (html: string) => !/data-js-errors/.test(html);

try {
  const login = await dom("/overview");
  check("signed-out page shows the sign-in form", login.includes("Sign in with the admin token") && noErrors(login));

  const bad = await dom("/overview&token=not-a-real-token");
  check("a wrong token is refused with a message", bad.includes("was not accepted") && noErrors(bad));

  const pages: [string, string[]][] = [
    ["overview", ["Traffic, last 24 hours", "Spend this month", "Recent requests"]],
    ["approvals", ["Waiting (1)", "refund"]],
    ["agents", ["support-bot", "billing-agent", "New agent"]],
    ["policy", ["Sensitive data", "Tool calls", "Try it"]],
    ["requests", ["Every outcome", "Allowed"]],
    ["audit", ["Chain intact", "agent.created"]],
    ["settings", ["New user", "Vee"]],
  ];
  for (const [route, expected] of pages) {
    const html = await dom(`/${route}&token=${ADMIN}`);
    const missing = expected.filter((text) => !html.includes(text));
    check(
      `${route} page draws`,
      missing.length === 0 && noErrors(html),
      `missing: ${missing.join(", ")}${noErrors(html) ? "" : ", and the page raised a script error"}`,
    );
  }

  const dark = await dom(`/overview&token=${ADMIN}&theme=dark`);
  check("theme can be set to dark", /data-theme="dark"/.test(dark));

  const hostileHtml = await dom(`/agents&token=${ADMIN}`);
  // The name itself contains "data-pwned", so look for the attribute on <html>, which only appears if the handler ran.
  const ran = /<html[^>]*data-pwned/.test(hostileHtml);
  check(
    "an agent named like an HTML tag is shown as text and never runs",
    !ran && hostileHtml.includes("&lt;img src=x onerror="),
    ran ? "the injected handler ran" : "the name was not shown as text",
  );

  const scoped = await dom(`/overview&token=${viewer}`);
  check(
    "a team viewer sees its own team's agents only",
    scoped.includes("support-bot") && !scoped.includes("billing-agent") && noErrors(scoped),
  );
  check(
    "a team viewer has no audit or settings menu",
    !scoped.includes("Audit trail") && !scoped.includes(">Settings<"),
  );
  const forced = await dom(`/audit&token=${viewer}`);
  check(
    "a team viewer who opens the audit address lands on the overview",
    forced.includes("Traffic, last 24 hours") && noErrors(forced),
  );
} finally {
  app.server.closeAllConnections();
  app.server.close();
  mock.closeAllConnections();
  mock.close();
}

console.log(failures === 0 ? "\nall UI checks passed" : `\n${failures} UI check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
