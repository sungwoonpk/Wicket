import { SseSplitter, sseData } from "../policy/sse.js";

export type Usage = { promptTokens?: number; completionTokens?: number };

/** Rough, deterministic estimate: one token for every four characters. Used only when an upstream reports nothing. */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function readUsage(usage: any): Usage {
  return { promptTokens: count(usage?.prompt_tokens), completionTokens: count(usage?.completion_tokens) };
}

/** How many characters of reply a completion or one streamed chunk carries: text, tool names and tool arguments. */
export function replyChars(body: any): number {
  let chars = 0;
  const choices = Array.isArray(body?.choices) ? body.choices : [];
  for (const choice of choices) {
    for (const part of [choice?.message, choice?.delta]) {
      if (!part || typeof part !== "object") continue;
      if (typeof part.content === "string") chars += part.content.length;
      const calls = Array.isArray(part.tool_calls) ? part.tool_calls : [];
      for (const call of [...calls.map((c: any) => c?.function), part.function_call]) {
        chars += String(call?.name ?? "").length + String(call?.arguments ?? "").length;
      }
    }
  }
  return chars;
}

/**
 * Follows a streamed reply event by event: the last usage the upstream reported, and how much reply there was.
 * It also says whether an event should be passed on, see `observe`.
 */
export class StreamMeter {
  usage: Usage = {};
  chars = 0;

  /**
   * Looks at one raw event. Returns false for a chunk that only carries usage, when the caller did not ask for
   * usage: Wicket asked the upstream for it so the request can be charged, and the caller never expected it.
   */
  observe(event: string, callerWantsUsage: boolean): boolean {
    const data = sseData(event);
    if (data === undefined) return true;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return true;
    }
    if (parsed === null || typeof parsed !== "object") return true;
    const hasUsage = parsed.usage !== null && typeof parsed.usage === "object";
    if (hasUsage) this.usage = readUsage(parsed.usage);
    this.chars += replyChars(parsed);
    const usageOnly = hasUsage && Array.isArray(parsed.choices) && parsed.choices.length === 0;
    return callerWantsUsage || !usageOnly;
  }
}

/** Reads token usage from a JSON response, or from the last usage-bearing event of a stream. */
export function extractUsage(text: string, stream: boolean): Usage {
  return meterText(text, stream).usage;
}

/** Usage and reply size of a response that has been read in full. */
export function meterText(text: string, stream: boolean): { usage: Usage; chars: number } {
  try {
    if (stream) {
      const meter = new StreamMeter();
      const splitter = new SseSplitter();
      for (const event of [...splitter.push(text), ...splitter.flush()]) meter.observe(event, true);
      return { usage: meter.usage, chars: meter.chars };
    }
    const body = JSON.parse(text);
    return { usage: body?.usage ? readUsage(body.usage) : {}, chars: replyChars(body) };
  } catch {
    return { usage: {}, chars: 0 };
  }
}

/**
 * What to charge for a reply. The upstream's own numbers are used when it sent any. When it sent none, a request
 * would cost nothing and a budget could never run out, so it is charged an estimate instead.
 */
export function resolveUsage(
  reported: Usage,
  requestBody: Record<string, any>,
  replyCharCount: number,
): { usage: Usage; estimated: boolean } {
  if (reported.promptTokens !== undefined || reported.completionTokens !== undefined)
    return { usage: reported, estimated: false };
  return {
    usage: {
      promptTokens: Math.max(1, estimateTokens(JSON.stringify(requestBody.messages ?? []).length)),
      completionTokens: estimateTokens(replyCharCount),
    },
    estimated: true,
  };
}
