import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockOptions {
  /** Fixed delay before the first byte, in milliseconds. */
  latencyMs?: number;
  /** The key the Anthropic-style route requires in `x-api-key`. */
  anthropicKey?: string;
}

interface ChatMessage {
  role: string;
  content?: unknown;
}

/** Rough, deterministic token estimate: one token per four characters, at least one. */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length === 0 ? {} : JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The text of a message, whether its content is a string or a list of text parts. */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content.map((p) => (p && typeof p === "object" ? String((p as any).text ?? "") : "")).join("");
  return "";
}

function lastUserText(messages: ChatMessage[]): string {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return contentText(last?.content);
}

/** Builds the deterministic reply text for a request. */
export function replyFor(messages: ChatMessage[]): string {
  return `mock reply to: ${lastUserText(messages)}`;
}

export interface MockToolCall {
  name: string;
  /** Arguments exactly as the model would send them: a JSON string. */
  arguments: string;
}

/**
 * Looks for `[[tool:NAME {json}]]` in the last user message. When present, the mock answers with
 * that tool call instead of text, which lets tests and demos produce any tool call on demand.
 */
export function toolCallFor(messages: ChatMessage[]): MockToolCall | undefined {
  const match = /\[\[tool:([A-Za-z0-9_.-]+)(?: ([^\]]*))?\]\]/.exec(lastUserText(messages));
  if (!match) return undefined;
  return { name: match[1]!, arguments: match[2] ?? "{}" };
}

interface Scenario {
  /** Respond with this status and an error body. */
  status?: number;
  /** Respond 200 with a body that is not JSON. */
  badJson?: boolean;
  /** Wait this long before answering. */
  slowMs?: number;
  /** Use this exact text as the reply. */
  say?: string;
}

/** Directives in the last user message that make the mock misbehave on purpose, for edge-case tests. */
function scenarioFor(messages: ChatMessage[]): Scenario {
  const text = lastUserText(messages);
  const s: Scenario = {};
  const status = /\[\[status:(\d{3})\]\]/.exec(text);
  if (status) s.status = Number(status[1]);
  if (/\[\[badjson\]\]/.test(text)) s.badJson = true;
  const slow = /\[\[slow:(\d+)\]\]/.exec(text);
  if (slow) s.slowMs = Math.min(Number(slow[1]), 30_000);
  const say = /\[\[say:([^\]]*)\]\]/.exec(text);
  if (say) s.say = say[1];
  // A reply that carries personal data, without the request carrying any, so response scanning can be tested alone.
  if (/\[\[leak\]\]/.test(text)) s.say = "You can reach ann@example.com or 123-45-6789";
  return s;
}

function openAiStream(
  res: ServerResponse,
  model: string,
  reply: string,
  toolCall: MockToolCall | undefined,
  usage: object,
): void {
  const id = "chatcmpl-mock";
  const created = 0;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const send = (delta: object, finish: string | null, withUsage = false) => {
    const chunk: any = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (withUsage) chunk.usage = usage;
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  if (toolCall) {
    // Split the arguments in two fragments, as real providers stream them.
    const half = Math.ceil(toolCall.arguments.length / 2);
    send(
      {
        role: "assistant",
        tool_calls: [
          {
            index: 0,
            id: "call_mock_1",
            type: "function",
            function: { name: toolCall.name, arguments: toolCall.arguments.slice(0, half) },
          },
        ],
      },
      null,
    );
    send({ tool_calls: [{ index: 0, function: { arguments: toolCall.arguments.slice(half) } }] }, null);
    send({}, "tool_calls", true);
  } else {
    reply
      .split(" ")
      .forEach((word, i) => send(i === 0 ? { role: "assistant", content: word } : { content: ` ${word}` }, null));
    send({}, "stop", true);
  }
  res.write("data: [DONE]\n\n");
  res.end();
}

function anthropicStream(
  res: ServerResponse,
  model: string,
  reply: string,
  toolCall: MockToolCall | undefined,
  inputTokens: number,
  outputTokens: number,
): void {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const send = (event: string, data: object) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  send("message_start", {
    message: {
      id: "msg_mock",
      type: "message",
      role: "assistant",
      model,
      content: [],
      usage: { input_tokens: inputTokens, output_tokens: 1 },
    },
  });
  send("ping", {});
  if (toolCall) {
    send("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "toolu_mock_1", name: toolCall.name, input: {} },
    });
    const half = Math.ceil(toolCall.arguments.length / 2);
    send("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: toolCall.arguments.slice(0, half) },
    });
    send("content_block_delta", {
      index: 0,
      delta: { type: "input_json_delta", partial_json: toolCall.arguments.slice(half) },
    });
    send("content_block_stop", { index: 0 });
  } else {
    send("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    reply
      .split(" ")
      .forEach((word, i) =>
        send("content_block_delta", { index: 0, delta: { type: "text_delta", text: i === 0 ? word : ` ${word}` } }),
      );
    send("content_block_stop", { index: 0 });
  }
  send("message_delta", {
    delta: { stop_reason: toolCall ? "tool_use" : "end_turn" },
    usage: { output_tokens: outputTokens },
  });
  send("message_stop", {});
  res.end();
}

export function createMockUpstream(options: MockOptions = {}): Server {
  const anthropicKey = options.anthropicKey ?? "mock-anthropic-key";

  return createServer(async (req, res) => {
    try {
      const path = req.url?.split("?")[0];
      if (req.method !== "POST" || (path !== "/v1/chat/completions" && path !== "/v1/messages")) {
        sendJson(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
        return;
      }
      const anthropic = path === "/v1/messages";

      if (anthropic) {
        if (req.headers["x-api-key"] !== anthropicKey) {
          sendJson(res, 401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
          return;
        }
        if (!req.headers["anthropic-version"]) {
          sendJson(res, 400, {
            type: "error",
            error: { type: "invalid_request_error", message: "anthropic-version header is required" },
          });
          return;
        }
      }

      const body = await readJson(req);
      const messages: ChatMessage[] = body.messages ?? [];
      if (messages.length === 0) {
        const error = { message: "messages is required", type: "invalid_request_error" };
        sendJson(res, 400, anthropic ? { type: "error", error } : { error });
        return;
      }
      if (anthropic && typeof body.max_tokens !== "number") {
        sendJson(res, 400, {
          type: "error",
          error: { type: "invalid_request_error", message: "max_tokens is required" },
        });
        return;
      }

      const scenario = scenarioFor(messages);
      if (options.latencyMs) await sleep(options.latencyMs);
      if (scenario.slowMs) await sleep(scenario.slowMs);
      if (scenario.status) {
        const error = { message: `mock error ${scenario.status}`, type: "mock_error" };
        sendJson(
          res,
          scenario.status,
          anthropic ? { type: "error", error } : { error },
          scenario.status === 429 ? { "retry-after": "1" } : {},
        );
        return;
      }
      if (scenario.badJson) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{this is not json");
        return;
      }

      const model = body.model ?? "mock-model";
      const toolCall = toolCallFor(messages);
      const reply = toolCall ? "" : (scenario.say ?? replyFor(messages));
      const promptTokens = estimateTokens(messages.map((m) => contentText(m.content)).join("\n"));
      const completionTokens = estimateTokens(toolCall ? toolCall.name + toolCall.arguments : reply);

      if (anthropic) {
        if (body.stream) {
          anthropicStream(res, model, reply, toolCall, promptTokens, completionTokens);
          return;
        }
        const content = toolCall
          ? [{ type: "tool_use", id: "toolu_mock_1", name: toolCall.name, input: JSON.parse(toolCall.arguments) }]
          : [{ type: "text", text: reply }];
        sendJson(res, 200, {
          id: "msg_mock",
          type: "message",
          role: "assistant",
          model,
          content,
          stop_reason: toolCall ? "tool_use" : "end_turn",
          usage: { input_tokens: promptTokens, output_tokens: completionTokens },
        });
        return;
      }

      const usage = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      };
      if (body.stream) {
        openAiStream(res, model, reply, toolCall, usage);
        return;
      }
      const message = toolCall
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_mock_1", type: "function", function: { name: toolCall.name, arguments: toolCall.arguments } },
            ],
          }
        : { role: "assistant", content: reply };
      sendJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message, finish_reason: toolCall ? "tool_calls" : "stop" }],
        usage,
      });
    } catch (err) {
      const bad = err instanceof SyntaxError;
      sendJson(res, bad ? 400 : 500, {
        error: { message: bad ? "invalid JSON body" : "internal error", type: "invalid_request_error" },
      });
    }
  });
}
