import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { KeyStore } from "./keys.js";
import { RequestLog } from "./log.js";

export interface GatewayOptions {
  /** Base URL of the OpenAI-compatible upstream, for example http://localhost:4010. */
  upstreamUrl: string;
  /** Bearer token that protects the /admin routes. */
  adminToken: string;
  keys?: KeyStore;
  log?: RequestLog;
}

const MAX_BODY_BYTES = 1_000_000;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
  ) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return undefined;
  return header.slice("Bearer ".length).trim();
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function parseJson(raw: Buffer): any {
  try {
    return raw.length === 0 ? {} : JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
}

export function createGateway(options: GatewayOptions): Server {
  const keys = options.keys ?? new KeyStore();
  const log = options.log ?? new RequestLog();
  const upstream = options.upstreamUrl.replace(/\/+$/, "");

  function requireAdmin(req: IncomingMessage): void {
    const token = bearer(req);
    if (!token || !safeEqual(token, options.adminToken)) throw new HttpError(401, "invalid admin token", "authentication_error");
  }

  async function chatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const key = bearer(req);
    const agent = key ? keys.authenticate(key) : undefined;
    if (!agent) throw new HttpError(401, "invalid or missing API key", "authentication_error");

    const raw = await readBody(req);
    const body = parseJson(raw);
    const stream = body.stream === true;
    const started = performance.now();

    let upstreamRes: Response;
    try {
      upstreamRes = await fetch(`${upstream}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: new Uint8Array(raw),
      });
    } catch {
      log.add({
        at: new Date().toISOString(), agentId: agent.id, agentName: agent.name,
        model: String(body.model ?? ""), stream, status: 502,
        latencyMs: Math.round(performance.now() - started),
      });
      throw new HttpError(502, "upstream unreachable", "upstream_error");
    }

    const contentType = upstreamRes.headers.get("content-type") ?? "application/json";
    res.writeHead(upstreamRes.status, { "content-type": contentType });

    // Keep a copy of the response text so usage can be read once the stream ends.
    let captured = "";
    if (upstreamRes.body) {
      const decoder = new TextDecoder();
      for await (const chunk of upstreamRes.body as unknown as AsyncIterable<Uint8Array>) {
        captured += decoder.decode(chunk, { stream: true });
        res.write(chunk);
      }
    }
    res.end();

    log.add({
      at: new Date().toISOString(), agentId: agent.id, agentName: agent.name,
      model: String(body.model ?? ""), stream, status: upstreamRes.status,
      latencyMs: Math.round(performance.now() - started),
      ...extractUsage(captured, stream),
    });
  }

  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");

      if (req.method === "GET" && url.pathname === "/healthz") {
        sendJson(res, 200, { status: "ok" });
      } else if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await chatCompletions(req, res);
      } else if (req.method === "POST" && url.pathname === "/admin/keys") {
        requireAdmin(req);
        const body = parseJson(await readBody(req));
        if (typeof body.name !== "string" || body.name.trim() === "") throw new HttpError(400, "name is required");
        const { agent, key } = keys.create(body.name.trim());
        sendJson(res, 201, { agent, key });
      } else if (req.method === "GET" && url.pathname === "/admin/agents") {
        requireAdmin(req);
        sendJson(res, 200, { agents: keys.list() });
      } else if (req.method === "GET" && url.pathname === "/admin/logs") {
        requireAdmin(req);
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100) || 100, 1), 1000);
        sendJson(res, 200, { logs: log.recent(limit) });
      } else {
        throw new HttpError(404, "not found");
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: { message: err.message, type: err.type } });
      } else {
        sendJson(res, 500, { error: { message: "internal error", type: "server_error" } });
      }
    }
  });
}

/** Reads token usage from a JSON response, or from the last usage-bearing SSE event. */
export function extractUsage(
  text: string,
  stream: boolean,
): { promptTokens?: number; completionTokens?: number } {
  try {
    let usage: any;
    if (stream) {
      const events = text.split("\n\n").filter((e) => e.startsWith("data: {"));
      for (const event of events) {
        const parsed = JSON.parse(event.slice(6));
        if (parsed.usage) usage = parsed.usage;
      }
    } else {
      usage = JSON.parse(text).usage;
    }
    if (!usage) return {};
    return { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens };
  } catch {
    return {};
  }
}
