import type { Target } from "../gateway/upstreams.js";
import {
  fromAnthropicError,
  fromAnthropicResponse,
  StreamTranslator,
  toAnthropicRequest,
  UnsupportedContentError,
} from "./anthropic.js";

export interface UpstreamResponse {
  status: number;
  contentType: string;
  /** The body in OpenAI format, whichever provider produced it. */
  chunks: AsyncIterable<string | Uint8Array>;
}

export class UpstreamConfigError extends Error {}
export class UpstreamUnreachableError extends Error {}
export class UpstreamTimeoutError extends Error {}
export { UnsupportedContentError };

async function* once(text: string): AsyncGenerator<string> {
  yield text;
}

function providerKey(target: Target, env: NodeJS.ProcessEnv): string | undefined {
  if (!target.apiKeyEnv) return undefined;
  const key = env[target.apiKeyEnv];
  if (!key)
    throw new UpstreamConfigError(`environment variable ${target.apiKeyEnv} is not set for upstream "${target.name}"`);
  return key;
}

async function* translated(source: AsyncIterable<Uint8Array>, model: string): AsyncGenerator<string> {
  const translator = new StreamTranslator(model);
  const decoder = new TextDecoder();
  for await (const chunk of source) {
    const out = translator.push(decoder.decode(chunk, { stream: true }));
    if (out) yield out;
  }
  const tail = translator.end();
  if (tail) yield tail;
}

/** Sends one chat request to the target and returns its response in OpenAI format. */
export async function callUpstream(
  target: Target,
  body: Record<string, any>,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<UpstreamResponse> {
  const key = providerKey(target, env);
  const stream = body.stream === true;
  const model = String(body.model ?? "");

  let res: Response;
  try {
    if (target.kind === "anthropic") {
      res = await fetch(`${target.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(key ? { "x-api-key": key } : {}),
        },
        body: JSON.stringify(toAnthropicRequest(body)),
        signal,
      });
    } else {
      res = await fetch(`${target.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal,
      });
    }
  } catch (err) {
    if (err instanceof UnsupportedContentError) throw err;
    if ((err as Error)?.name === "TimeoutError") throw new UpstreamTimeoutError(`upstream "${target.name}" timed out`);
    if ((err as Error)?.name === "AbortError") throw err;
    throw new UpstreamUnreachableError(`upstream "${target.name}" is unreachable`);
  }

  if (target.kind !== "anthropic") {
    return {
      status: res.status,
      contentType: res.headers.get("content-type") ?? "application/json",
      chunks: (res.body as unknown as AsyncIterable<Uint8Array>) ?? once(""),
    };
  }

  if (res.status >= 400) {
    let parsed: Record<string, any> = {};
    try {
      parsed = JSON.parse(await res.text());
    } catch {
      /* keep the generic message */
    }
    return {
      status: res.status,
      contentType: "application/json",
      chunks: once(JSON.stringify(fromAnthropicError(parsed))),
    };
  }

  if (stream && res.body) {
    return {
      status: res.status,
      contentType: "text/event-stream",
      chunks: translated(res.body as unknown as AsyncIterable<Uint8Array>, model),
    };
  }
  const json = JSON.parse(await res.text());
  return {
    status: res.status,
    contentType: "application/json",
    chunks: once(JSON.stringify(fromAnthropicResponse(json, model))),
  };
}
