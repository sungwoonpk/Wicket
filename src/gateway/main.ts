import { createGateway } from "./server.js";

const adminToken = process.env.WICKET_ADMIN_TOKEN;
if (!adminToken) {
  console.error("WICKET_ADMIN_TOKEN is required. Set it to a long random string.");
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8080);
const upstreamUrl = process.env.WICKET_UPSTREAM_URL ?? "http://localhost:4010";
const dbPath = process.env.WICKET_DB ?? "wicket.db";

createGateway({ upstreamUrl, adminToken, dbPath }).listen(port, () => {
  console.log(`wicket listening on http://localhost:${port}, upstream ${upstreamUrl}, database ${dbPath}`);
  console.log(`dashboard: http://localhost:${port}/dashboard`);
});
