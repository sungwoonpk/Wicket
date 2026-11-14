import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface MockOptions {
  /** Fixed delay before the first byte, in milliseconds. */
  latencyMs?: number;
  /** The key the Anthropic-style route requires in `x-api-key`. */
  anthropicKey?: string;
  /** Never report token usage, like a server that does not support it. */
  omitUsage?: boolean;
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
  /** Frame the event stream the way some servers do: CRLF line ends, and no space after `data:`. */
  crlf?: boolean;
  bare?: boolean;
}

/** Directives in the last user message that make the mock misbehave on purpose, for edge-case tests. */
function scenarioFor(messages: ChatMessage[]): Scenario {
  const text = lastUserText(messages);
  const s: Scenario = {};
  const status = /\[\[status:(\d{3})\]\]/.exec(text);
  if (status) s.status = Number(status[1]);
  if (/\[\[badjson\]\]/.test(text)) s.badJson = true;
  if (/\[\[crlf\]\]/.test(text)) s.crlf = true;
  if (/\[\[bare\]\]/.test(text)) s.bare = true;
  const slow = /\[\[slow:(\d+)\]\]/.exec(text);
  if (slow) s.slowMs = Math.min(Number(slow[1]), 30_000);
  const say = /\[\[say:([^\]]*)\]\]/.exec(text);
  if (say) s.say = say[1];
  // A reply that carries personal data, without the request carrying any, so response scanning can be tested alone.
  if (/\[\[leak\]\]/.test(text)) s.say = "You can reach ann@example.com or 123-45-6789";
  return s;
}

interface StreamStyle {
  /** Send token usage only when the caller asked for it with `stream_options.include_usage`, as OpenAI does. */
  includeUsage: boolean;
  /** Answer with the older `function_call` shape instead of `tool_calls`. */
  legacy: boolean;
  crlf: boolean;
  bare: boolean;
}

function openAiStream(
  res: ServerResponse,
  model: string,
  reply: string,
  toolCall: MockToolCall | undefined,
  usage: object,
  style: StreamStyle,
): void {
  const id = "chatcmpl-mock";
  const created = 0;
  const eol = style.crlf ? "\r\n" : "\n";
  const field = style.bare ? "data:" : "data: ";
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const emit = (payload: string) => res.write(`${field}${payload}${eol}${eol}`);
  const send = (delta: object, finish: string | null) => {
    const chunk: any = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (style.includeUsage) chunk.usage = null;
    emit(JSON.stringify(chunk));
  };

  if (toolCall) {
    // Split the arguments in two fragments, as real providers stream them.
    const half = Math.ceil(toolCall.arguments.length / 2);
    if (reply) send({ role: "assistant", content: reply }, null);
    const head = style.legacy
      ? { function_call: { name: toolCall.name, arguments: toolCall.arguments.slice(0, half) } }
      : {
          tool_calls: [
            {
              index: 0,
              id: "call_mock_1",
              type: "function",
              function: { name: toolCall.name, arguments: toolCall.arguments.slice(0, half) },
            },
          ],
        };
    send(reply ? head : { role: "assistant", ...head }, null);
    const rest = toolCall.arguments.slice(half);
    send(
      style.legacy
        ? { function_call: { arguments: rest } }
        : { tool_calls: [{ index: 0, function: { arguments: rest } }] },
      null,
    );
    send({}, style.legacy ? "function_call" : "tool_calls");
  } else {
    reply
      .split(" ")
      .forEach((word, i) => send(i === 0 ? { role: "assistant", content: word } : { content: ` ${word}` }, null));
    send({}, "stop");
  }
  // Like OpenAI, usage comes as one last chunk with no choices, and only when it was asked for.
  if (style.includeUsage) {
    emit(JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage }));
  }
  emit("[DONE]");
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
      // A tool call normally comes alone. With `[[say:...]]` or `[[leak]]` the reply text comes with it, as models do.
      const reply = toolCall ? (scenario.say ?? "") : (scenario.say ?? replyFor(messages));
      const promptTokens = estimateTokens(messages.map((m) => contentText(m.content)).join("\n"));
      const completionTokens = estimateTokens(toolCall ? reply + toolCall.name + toolCall.arguments : reply);

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
      // A request that declares `functions` and no `tools` is answered in the older `function_call` shape.
      const legacy = Array.isArray(body.functions) && !Array.isArray(body.tools);
      if (body.stream) {
        openAiStream(res, model, reply, toolCall, usage, {
          includeUsage: body.stream_options?.include_usage === true && !options.omitUsage,
          legacy,
          crlf: scenario.crlf === true,
          bare: scenario.bare === true,
        });
        return;
      }
      const message = toolCall
        ? legacy
          ? {
              role: "assistant",
              content: reply || null,
              function_call: { name: toolCall.name, arguments: toolCall.arguments },
            }
          : {
              role: "assistant",
              content: reply || null,
              tool_calls: [
                {
                  id: "call_mock_1",
                  type: "function",
                  function: { name: toolCall.name, arguments: toolCall.arguments },
                },
              ],
            }
        : { role: "assistant", content: reply };
      const finish = toolCall ? (legacy ? "function_call" : "tool_calls") : "stop";
      sendJson(res, 200, {
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: 0,
        model,
        choices: [{ index: 0, message, finish_reason: finish }],
        ...(options.omitUsage ? {} : { usage }),
      });
    } catch (err) {
      const bad = err instanceof SyntaxError;
      sendJson(res, bad ? 400 : 500, {
        error: { message: bad ? "invalid JSON body" : "internal error", type: "invalid_request_error" },
      });
    }
  });
}
