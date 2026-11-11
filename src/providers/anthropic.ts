/**
 * Translation between the OpenAI chat format Wicket speaks and the Anthropic Messages API.
 * Text, tool calls, tool results and streaming are covered. Images and other non-text content are not.
 */

export class UnsupportedContentError extends Error {}

type Json = Record<string, any>;

const FINISH: Record<string, string> = {
  end_turn: "stop",
  stop_sequence: "stop",
  max_tokens: "length",
  tool_use: "tool_calls",
  pause_turn: "stop",
  refusal: "content_filter",
};

function textOf(content: unknown): string {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (part && typeof part === "object" && (part as Json).type === "text") return String((part as Json).text ?? "");
        throw new UnsupportedContentError("only text content is supported for Anthropic upstreams");
      })
      .join("");
  }
  throw new UnsupportedContentError("unsupported message content");
}

function parseArguments(raw: unknown): Json {
  if (raw && typeof raw === "object") return raw as Json;
  if (typeof raw !== "string" || raw.trim() === "") return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: Json[];
}

/** Converts an OpenAI chat request body into a Messages API request body. */
export function toAnthropicRequest(body: Json): Json {
  const system: string[] = [];
  const messages: AnthropicMessage[] = [];

  const push = (role: "user" | "assistant", blocks: Json[]) => {
    if (blocks.length === 0) return;
    const last = messages[messages.length - 1];
    // The API expects alternating turns, so adjacent messages of one role are merged.
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };

  for (const m of (body.messages ?? []) as Json[]) {
    if (m.role === "system" || m.role === "developer") {
      system.push(textOf(m.content));
    } else if (m.role === "user") {
      const text = textOf(m.content);
      if (text !== "") push("user", [{ type: "text", text }]);
    } else if (m.role === "assistant") {
      const blocks: Json[] = [];
      const text = textOf(m.content);
      if (text !== "") blocks.push({ type: "text", text });
      for (const tc of (m.tool_calls ?? []) as Json[]) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input: parseArguments(tc.function?.arguments) });
      }
      push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: textOf(m.content) }]);
    }
  }

  const out: Json = {
    model: body.model,
    max_tokens: body.max_tokens ?? body.max_completion_tokens ?? 1024,
    messages,
  };
  if (system.length > 0) out.system = system.join("\n\n");
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stop !== undefined) out.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];
  if (body.stream === true) out.stream = true;

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((t: Json) => ({
      name: t.function?.name,
      description: t.function?.description,
      input_schema: t.function?.parameters ?? { type: "object", properties: {} },
    }));
    const choice = body.tool_choice;
    if (choice === "auto") out.tool_choice = { type: "auto" };
    else if (choice === "required") out.tool_choice = { type: "any" };
    else if (choice === "none") out.tool_choice = { type: "none" };
    else if (choice && typeof choice === "object") out.tool_choice = { type: "tool", name: choice.function?.name };
  }
  return out;
}

function usageOf(usage: Json | undefined): Json {
  const prompt = usage?.input_tokens ?? 0;
  const completion = usage?.output_tokens ?? 0;
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
}

/** Converts a Messages API response body into an OpenAI chat completion. */
export function fromAnthropicResponse(body: Json, requestedModel: string): Json {
  const blocks = (body.content ?? []) as Json[];
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const toolCalls = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
  const message: Json = { role: "assistant", content: toolCalls.length > 0 && text === "" ? null : text };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return {
    id: body.id ?? "chatcmpl-anthropic",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: body.model ?? requestedModel,
    choices: [{ index: 0, message, finish_reason: FINISH[body.stop_reason] ?? "stop" }],
    usage: usageOf(body.usage),
  };
}

/** Converts an Anthropic error body into the OpenAI error shape, keeping the message. */
export function fromAnthropicError(body: Json): Json {
  const err = body?.error ?? {};
  return { error: { message: err.message ?? "upstream error", type: err.type ?? "upstream_error" } };
}

/**
 * Turns an Anthropic event stream into OpenAI chunks, as text. Feed it response text as it arrives
 * and write whatever `push` returns. Call `end` once the upstream closes.
 */
export class StreamTranslator {
  private buffer = "";
  private id = "chatcmpl-anthropic";
  private model: string;
  private created = Math.floor(Date.now() / 1000);
  private toolIndex = new Map<number, number>();
  private nextTool = 0;
  private promptTokens = 0;
  private completionTokens = 0;
  private finish: string | null = null;
  private done = false;

  constructor(requestedModel: string) {
    this.model = requestedModel;
  }

  private chunk(delta: Json, finish: string | null = null, usage?: Json): string {
    const payload: Json = {
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) payload.usage = usage;
    return `data: ${JSON.stringify(payload)}\n\n`;
  }

  private handle(event: Json): string {
    switch (event.type) {
      case "message_start": {
        this.id = event.message?.id ?? this.id;
        this.model = event.message?.model ?? this.model;
        this.promptTokens = event.message?.usage?.input_tokens ?? 0;
        return this.chunk({ role: "assistant", content: "" });
      }
      case "content_block_start": {
        const block = event.content_block ?? {};
        if (block.type !== "tool_use") return "";
        const index = this.nextTool++;
        this.toolIndex.set(event.index, index);
        return this.chunk({ tool_calls: [{ index, id: block.id, type: "function", function: { name: block.name, arguments: "" } }] });
      }
      case "content_block_delta": {
        const delta = event.delta ?? {};
        if (delta.type === "text_delta") return this.chunk({ content: delta.text ?? "" });
        if (delta.type === "input_json_delta") {
          const index = this.toolIndex.get(event.index);
          if (index === undefined) return "";
          return this.chunk({ tool_calls: [{ index, function: { arguments: delta.partial_json ?? "" } }] });
        }
        return "";
      }
      case "message_delta": {
        if (event.delta?.stop_reason) this.finish = FINISH[event.delta.stop_reason] ?? "stop";
        if (event.usage?.output_tokens !== undefined) this.completionTokens = event.usage.output_tokens;
        return "";
      }
      case "message_stop":
        return this.finalize();
      case "error": {
        this.done = true;
        const err = event.error ?? {};
        return `data: ${JSON.stringify({ error: { message: err.message ?? "upstream error", type: err.type ?? "upstream_error" } })}\n\ndata: [DONE]\n\n`;
      }
      default:
        return "";
    }
  }

  private finalize(): string {
    if (this.done) return "";
    this.done = true;
    const usage = { prompt_tokens: this.promptTokens, completion_tokens: this.completionTokens, total_tokens: this.promptTokens + this.completionTokens };
    return this.chunk({}, this.finish ?? "stop", usage) + "data: [DONE]\n\n";
  }

  push(text: string): string {
    this.buffer += text;
    let out = "";
    let at: number;
    while ((at = this.buffer.indexOf("\n\n")) !== -1) {
      const block = this.buffer.slice(0, at);
      this.buffer = this.buffer.slice(at + 2);
      const data = block.split("\n").find((l) => l.startsWith("data:"));
      if (!data) continue;
      try {
        out += this.handle(JSON.parse(data.slice(5).trim()));
      } catch {
        // A malformed event is skipped rather than ending the stream.
      }
    }
    return out;
  }

  /** Closes the stream if the upstream ended without a final event. */
  end(): string {
    return this.finalize();
  }
}
