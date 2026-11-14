/**
 * Server-sent events, read the way the specification says. Lines end with CRLF, CR or LF, a blank line ends an
 * event, and `data:` may or may not be followed by a space. Reading less than that lets an upstream that frames
 * its stream differently slip past everything that looks inside the stream.
 */

// A line end followed by another one is a blank line. `\r` before `\n` is one line end, not two.
const EVENT_END = /(?:\r\n|\r(?!\n)|\n)(?:\r\n|\r|\n)/;
const LINE_END = /\r\n|\r|\n/;

/** The data of one event: its `data:` lines joined with a newline, or undefined when it has none. */
export function sseData(event: string): string | undefined {
  const parts: string[] = [];
  for (const line of event.split(LINE_END)) {
    if (!line.startsWith("data:")) continue;
    const value = line.slice(5);
    parts.push(value.startsWith(" ") ? value.slice(1) : value);
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/**
 * Cuts a stream into whole events as text arrives. Each event comes back exactly as it was written,
 * line ends included, so it can be passed on untouched.
 */
export class SseSplitter {
  private buffer = "";

  push(text: string): string[] {
    this.buffer += text;
    const events: string[] = [];
    for (;;) {
      const match = EVENT_END.exec(this.buffer);
      if (!match) break;
      const end = match.index + match[0].length;
      // A `\r` at the very end may be the first half of `\r\n`, so wait for the next text before deciding.
      if (end === this.buffer.length && match[0].endsWith("\r")) break;
      events.push(this.buffer.slice(0, end));
      this.buffer = this.buffer.slice(end);
    }
    return events;
  }

  /** What is left when the stream ends without a closing blank line. */
  flush(): string[] {
    const rest = this.buffer;
    this.buffer = "";
    return rest === "" ? [] : [rest];
  }
}

/** The data of every event in a complete stream, in order. */
export function sseDataOf(text: string): string[] {
  const splitter = new SseSplitter();
  const events = [...splitter.push(text), ...splitter.flush()];
  return events.map(sseData).filter((d): d is string => d !== undefined);
}

/** Like `sseDataOf`, parsed. Events that are not JSON objects, such as `[DONE]`, are left out. */
export function sseJson(text: string): any[] {
  const out: any[] = [];
  for (const data of sseDataOf(text)) {
    try {
      const parsed = JSON.parse(data);
      if (parsed !== null && typeof parsed === "object") out.push(parsed);
    } catch {
      /* not JSON */
    }
  }
  return out;
}
