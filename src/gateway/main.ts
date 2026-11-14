import { readFileSync } from "node:fs";
import { createGatewayApp } from "./server.js";
import { parsePriceTable } from "./pricing.js";
import { validateWebhookUrl } from "./webhook.js";

const MIN_TOKEN_LENGTH = 16;

function fail(message: string): never {
  console.error(`wicket: ${message}`);
  process.exit(1);
}

const adminToken = process.env.WICKET_ADMIN_TOKEN;
if (!adminToken) fail("WICKET_ADMIN_TOKEN is required. Generate one with: openssl rand -hex 24");
if (adminToken.length < MIN_TOKEN_LENGTH)
  fail(
    `WICKET_ADMIN_TOKEN is too short. Use at least ${MIN_TOKEN_LENGTH} characters, for example: openssl rand -hex 24`,
  );

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 0 || port > 65535) fail("PORT must be a number from 0 to 65535");
// Listen on loopback unless told otherwise, so a quick local run is not exposed to the network.
const host = process.env.HOST ?? "127.0.0.1";
const upstreamUrl = process.env.WICKET_UPSTREAM_URL ?? "http://localhost:4010";
const dbPath = process.env.WICKET_DB ?? "wicket.db";
const timeout = Number(process.env.WICKET_UPSTREAM_TIMEOUT_MS ?? 120_000);
if (!Number.isFinite(timeout) || timeout < 1) fail("WICKET_UPSTREAM_TIMEOUT_MS must be a positive number");

let prices;
if (process.env.WICKET_PRICES_FILE) {
  try {
    prices = parsePriceTable(JSON.parse(readFileSync(process.env.WICKET_PRICES_FILE, "utf8")));
  } catch (err) {
    fail(`cannot use WICKET_PRICES_FILE: ${(err as Error).message}`);
  }
}

let approvalWebhook;
if (process.env.WICKET_APPROVAL_WEBHOOK_URL) {
  try {
    approvalWebhook = {
      url: validateWebhookUrl(process.env.WICKET_APPROVAL_WEBHOOK_URL),
      secret: process.env.WICKET_WEBHOOK_SECRET,
    };
  } catch (err) {
    fail(`cannot use WICKET_APPROVAL_WEBHOOK_URL: ${(err as Error).message}`);
  }
}

const quiet = process.env.WICKET_LOG === "off";
const logger = quiet
  ? undefined
  : (record: Record<string, unknown>) => console.log(JSON.stringify({ time: new Date().toISOString(), ...record }));

const app = createGatewayApp({
  upstreamUrl,
  adminToken,
  dbPath,
  prices,
  auditKey: process.env.WICKET_AUDIT_KEY,
  upstreamTimeoutMs: timeout,
  logger,
  approvalWebhook,
});
if (!process.env.WICKET_AUDIT_KEY) {
  console.warn(
    "wicket: WICKET_AUDIT_KEY is not set, so the audit head is signed with a key derived from the admin token. Set a separate key in production.",
  );
}

if (approvalWebhook && !approvalWebhook.secret) {
  console.warn(
    "wicket: WICKET_WEBHOOK_SECRET is not set, so approval messages are not signed and the receiver cannot tell where they came from.",
  );
}

app.server.listen(port, host, () => {
  console.log(`wicket listening on http://${host}:${port}, upstream ${upstreamUrl}, database ${dbPath}`);
  console.log(`dashboard: http://${host}:${port}/dashboard`);
});

// Finish requests that are already running, then exit. After ten seconds, cut the rest off.
let stopping = false;
function shutdown(signal: string): void {
  if (stopping) return;
  stopping = true;
  console.log(`wicket: ${signal} received, shutting down`);
  app.server.close(() => process.exit(0));
  app.server.closeIdleConnections();
  setTimeout(() => {
    app.server.closeAllConnections();
  }, 10_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
