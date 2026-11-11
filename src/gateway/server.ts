import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { handleAdmin } from "./admin.js";
import { handleAgentApproval, handleChat } from "./chat.js";
import { serveDashboard } from "./dashboard.js";
import { HttpError, sendJson } from "./http.js";
import { createServices, type GatewayOptions, type Services } from "./services.js";

export type { GatewayOptions } from "./services.js";
export { extractUsage } from "./chat.js";

export type GatewayApp = Services & { server: Server };

const REQUEST_ID = /^[\w.-]{1,64}$/;

/** Builds the gateway: the stores, the HTTP server and the routing between them. Nothing is listening until `server.listen`. */
export function createGatewayApp(options: GatewayOptions): GatewayApp {
  const svc = createServices(options);

  const server = createServer(async (req, res) => {
    const incoming = req.headers["x-request-id"];
    const requestId = typeof incoming === "string" && REQUEST_ID.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("cache-control", "no-store");
    res.setHeader("referrer-policy", "no-referrer");

    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      const method = req.method;

      if (path === "/healthz" && method === "GET") {
        sendJson(res, 200, { status: "ok" });
      } else if (path === "/readyz" && method === "GET") {
        svc.db.prepare("SELECT 1").get();
        sendJson(res, 200, { status: "ready" });
      } else if (method === "GET" && serveDashboard(res, path)) {
        // served
      } else if (path === "/v1/chat/completions") {
        if (method !== "POST") throw new HttpError(405, "use POST", "invalid_request_error", { allow: "POST" });
        await handleChat(svc, req, res);
      } else if (/^\/v1\/approvals\/[\w-]+$/.test(path)) {
        if (method !== "GET") throw new HttpError(405, "use GET", "invalid_request_error", { allow: "GET" });
        handleAgentApproval(svc, req, res, path.split("/").pop()!);
      } else if (!(await handleAdmin(svc, req, res, url))) {
        throw new HttpError(404, "not found");
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(
          res,
          err.status,
          { error: { message: err.message, type: err.type, request_id: requestId, ...err.extra } },
          err.headers,
        );
      } else {
        svc.log({ event: "error", requestId, message: err instanceof Error ? err.message : String(err) });
        sendJson(res, 500, { error: { message: "internal error", type: "server_error", request_id: requestId } });
      }
    }
  });

  // Slow or stalled clients should not hold connections open indefinitely.
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.on("close", () => svc.db.close());

  return { ...svc, server };
}

export function createGateway(options: GatewayOptions): Server {
  return createGatewayApp(options).server;
}
