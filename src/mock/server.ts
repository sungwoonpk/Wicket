import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockOptions {
  /** Fixed delay before the first byte, in milliseconds. */
  latencyMs?: number;
}

interface ChatMessage {
  role: string;
  content?: string | null;
}

interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  stream?: boolean;
}

/** Rough, deterministic token estimate: one token per four characters, at least one. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Builds the deterministic reply text for a request. */
export function replyFor(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return `mock reply to: ${last?.content ?? ""}`;
}

export function createMockUpstream(options: MockOptions = {}): Server {
  return createServer(async (req, res) => {
    try {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
        return;
      }

      const body = (await readJson(req)) as ChatRequest;
      const messages = body.messages ?? [];
      if (messages.length === 0) {
        sendJson(res, 400, { error: { message: "messages is required", type: "invalid_request_error" } });
        return;
      }

      if (options.latencyMs) await sleep(options.latencyMs);

      const model = body.model ?? "mock-model";
      const reply = replyFor(messages);
      const promptTokens = estimateTokens(messages.map((m) => m.content ?? "").join("\n"));
      const completionTokens = estimateTokens(reply);
      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      const id = "chatcmpl-mock";
      const created = 0;

      if (!body.stream) {
        sendJson(res, 200, {
          id,
          object: "chat.completion",
          created,
          model,
          choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
          usage,
        });
        return;
      }

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const words = reply.split(" ");
      words.forEach((word, i) => {
        const piece = i === 0 ? word : ` ${word}`;
        const chunk = {
          id,
          object: "chat.completion.chunk",
          created,
          model,
          choices: [{ index: 0, delta: i === 0 ? { role: "assistant", content: piece } : { content: piece }, finish_reason: null }],
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      });
      const done = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage,
      };
      res.write(`data: ${JSON.stringify(done)}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
    } catch (err) {
      const message = err instanceof SyntaxError ? "invalid JSON body" : "internal error";
      sendJson(res, err instanceof SyntaxError ? 400 : 500, { error: { message, type: "invalid_request_error" } });
    }
  });
}
