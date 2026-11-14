import { normalizeForScan, redactText } from "./redact.js";
import { SseSplitter, sseData } from "./sse.js";
import type { Detector, Finding } from "./types.js";

/**
 * Masks sensitive data in a streamed reply.
 *
 * A reply arrives in small pieces and a card number or an email can be split between two of them, so a piece cannot
 * be scanned on its own. Text is held back until it is certain that nothing a detector could match crosses the end
 * of what is sent on, and the held part is scanned together with whatever arrives next.
 *
 * Where that cut may fall follows from what the detectors match. An email, a social security number and an API key
 * contain no whitespace. A card or a phone number is made only of digits, spaces, dashes, dots, plus signs and
 * brackets. So text may be cut where one side is whitespace (which ends the first kind) and not both sides can be
 * part of a number (which ends the second kind).
 */

const NUMBER_PART = /[0-9 \-.()+]/;
const SPACE = /\s/;
/** Text that goes on holding for this long without a safe cut is cut anyway, so one endless word cannot stall a stream. */
const MAX_HELD = 4096;
const TAIL_KEPT = 64;

interface Kind {
  /** Renders as nothing once normalized, so it counts as not being there. */
  skip: boolean;
  number: boolean;
  space: boolean;
}

const cache = new Map<string, Kind>();

/** What a character becomes when the scanner normalizes it, as far as a cut is concerned. */
function kindOf(ch: string): Kind {
  const code = ch.charCodeAt(0);
  if (code < 128) return { skip: false, number: NUMBER_PART.test(ch), space: SPACE.test(ch) };
  let kind = cache.get(ch);
  if (!kind) {
    const folded = normalizeForScan(ch);
    kind = {
      skip: folded === "",
      // Cautious on both counts: any part of it could belong to a number, and it is whitespace only if all of it is.
      number: [...folded].some((c) => NUMBER_PART.test(c)),
      space: folded !== "" && [...folded].every((c) => SPACE.test(c)),
    };
    if (cache.size < 5000) cache.set(ch, kind);
  }
  return kind;
}

/** The latest index at which `text` can be cut, or 0 when there is none yet. */
export function safeCut(text: string): number {
  // Work in code points so a surrogate pair is never split.
  const chars = [...text];
  const offsets: number[] = [];
  let at = 0;
  for (const ch of chars) {
    offsets.push(at);
    at += ch.length;
  }
  offsets.push(at);

  for (let i = chars.length - 1; i >= 1; i--) {
    let left = i - 1;
    while (left >= 0 && kindOf(chars[left]!).skip) left--;
    let right = i;
    while (right < chars.length && kindOf(chars[right]!).skip) right++;
    if (left < 0 || right >= chars.length) continue;
    const a = kindOf(chars[left]!);
    const b = kindOf(chars[right]!);
    if ((!a.number || !b.number) && (a.space || b.space)) return offsets[i]!;
  }
  return 0;
}

/**
 * Masks the text of a stream of OpenAI chunks, one event at a time. Feed it each raw event and send on what it
 * returns. Events that carry no text pass through as they came. Text is returned a little behind where it
 * arrived, and the end of a choice (or of the stream) releases whatever is still held.
 */
export class StreamRedactor {
  private held = new Map<number, string>();
  private counts = new Map<Detector, number>();
  private frame: Record<string, unknown> = { object: "chat.completion.chunk" };

  constructor(private readonly detectors: Detector[]) {}

  private take(index: number, text: string, final: boolean): string {
    const pending = (this.held.get(index) ?? "") + text;
    let cut = final ? pending.length : safeCut(pending);
    if (!final && pending.length - cut > MAX_HELD) cut = pending.length - TAIL_KEPT;
    const piece = pending.slice(0, cut);
    this.held.set(index, pending.slice(cut));
    const result = redactText(piece, this.detectors);
    for (const f of result.findings) this.counts.set(f.type, (this.counts.get(f.type) ?? 0) + f.count);
    // Text with nothing to mask is sent as it was, not in its normalized form.
    return result.findings.length > 0 ? result.text : piece;
  }

  /** Sends on one raw event, or what replaces it. */
  push(event: string): string {
    const data = sseData(event);
    if (data === undefined) return event;
    if (data.trim() === "[DONE]") return this.flush() + event;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return event;
    }
    if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.choices)) return event;

    const { id, object, created, model } = parsed;
    this.frame = { id, object, created, model };

    let changed = false;
    for (const choice of parsed.choices) {
      if (choice === null || typeof choice !== "object") continue;
      const index = Number(choice.index ?? 0);
      const finishing = choice.finish_reason !== null && choice.finish_reason !== undefined;
      if (choice.delta && typeof choice.delta.content === "string") {
        choice.delta.content = this.take(index, choice.delta.content, finishing);
        changed = true;
      } else if (finishing && (this.held.get(index) ?? "") !== "") {
        choice.delta = { ...(choice.delta ?? {}), content: this.take(index, "", true) };
        changed = true;
      }
    }
    return changed ? `data: ${JSON.stringify(parsed)}\n\n` : event;
  }

  /** Releases everything still held, as chunks of its own. For a stream that ends without a closing event. */
  flush(): string {
    let out = "";
    for (const index of [...this.held.keys()].sort((a, b) => a - b)) {
      const text = this.take(index, "", true);
      if (text === "") continue;
      const chunk = { ...this.frame, choices: [{ index, delta: { content: text }, finish_reason: null }] };
      out += `data: ${JSON.stringify(chunk)}\n\n`;
    }
    this.held.clear();
    return out;
  }

  findings(): Finding[] {
    return [...this.counts].map(([type, count]) => ({ type, count }));
  }
}

/** Masks a stream that has been read in full. Returns the text unchanged when there was nothing to mask. */
export function redactSse(text: string, detectors: Detector[]): { text: string; findings: Finding[] } {
  const redactor = new StreamRedactor(detectors);
  const splitter = new SseSplitter();
  let out = "";
  for (const event of [...splitter.push(text), ...splitter.flush()]) out += redactor.push(event);
  out += redactor.flush();
  const findings = redactor.findings();
  return { text: findings.length > 0 ? out : text, findings };
}
