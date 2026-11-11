import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";

export const MAX_BODY_BYTES = 1_000_000;

/** An error that maps straight to an HTTP response. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly type = "invalid_request_error",
    readonly headers: Record<string, string> = {},
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

export function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token === "" || token.length > 512 ? undefined : token;
}

/** Compares two secrets in constant time. Hashing first hides the length of the real one. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function readBody(req: IncomingMessage, max = MAX_BODY_BYTES): Promise<Buffer> {
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > max) throw new HttpError(413, "request body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new HttpError(413, "request body too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Parses a JSON object body. Arrays, strings and other values are refused. */
export function parseJsonObject(raw: Buffer): Record<string, any> {
  if (raw.length === 0) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new HttpError(400, "the request body must be a JSON object");
  return value as Record<string, any>;
}

export function clampLimit(url: URL, fallback = 100, max = 1000): number {
  const n = Number(url.searchParams.get("limit") ?? fallback);
  return Math.min(Math.max(Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback, 1), max);
}

/** The client address, used only to throttle failed logins. Proxy headers are not trusted. */
export function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

export async function collect(chunks: AsyncIterable<string | Uint8Array>, maxBytes: number): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  for await (const chunk of chunks) {
    size += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
    if (size > maxBytes) throw new HttpError(502, "the upstream response is too large", "upstream_error");
    text += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}
