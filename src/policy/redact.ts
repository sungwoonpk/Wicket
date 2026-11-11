import type { Detector, Finding } from "./types.js";

function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

interface DetectorSpec {
  pattern: RegExp;
  /** Extra check on a match. Matches that fail it are left alone. */
  accept?: (match: string) => boolean;
}

const SPECS: Record<Detector, DetectorSpec> = {
  email: { pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  ssn: { pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  credit_card: {
    pattern: /\b\d(?:[ -]?\d){12,18}\b/g,
    accept: (m) => {
      const digits = m.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  phone: { pattern: /(?<![\d-])(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}\b/g },
  api_key: { pattern: /\b(?:sk-[A-Za-z0-9_-]{16,}|wk_[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,})\b/g },
};

/** Order matters: more specific patterns run first so a card number is not read as a phone. */
const ORDER: Detector[] = ["api_key", "email", "ssn", "credit_card", "phone"];

// Characters that render as nothing. Putting them inside an address or number is the easy way to slip past a pattern.
const INVISIBLE = /[\u00AD\u200B-\u200F\u2060\u2061-\u2064\uFEFF\u180E]/g;

/** Folds look-alike forms (fullwidth digits, ligatures) and removes invisible characters before matching. */
export function normalizeForScan(text: string): string {
  return text.normalize("NFKC").replace(INVISIBLE, "");
}

export function redactText(text: string, detectors: Detector[]): { text: string; findings: Finding[] } {
  const active = ORDER.filter((d) => detectors.includes(d));
  const counts = new Map<Detector, number>();
  // Scanning the normalized text means the output is normalized too, which is the safe direction.
  let out = active.length > 0 ? normalizeForScan(text) : text;
  for (const type of active) {
    const spec = SPECS[type];
    out = out.replace(spec.pattern, (match) => {
      if (spec.accept && !spec.accept(match)) return match;
      counts.set(type, (counts.get(type) ?? 0) + 1);
      return `[REDACTED:${type.toUpperCase()}]`;
    });
  }
  return { text: out, findings: [...counts].map(([type, count]) => ({ type, count })) };
}

interface Message {
  content?: unknown;
  [key: string]: unknown;
}

/**
 * Redacts the text of chat messages without mutating the input. Handles both string content
 * and the array-of-parts form. Returns the new messages and the merged findings.
 */
export function redactMessages(
  messages: Message[],
  detectors: Detector[],
): { messages: Message[]; findings: Finding[] } {
  const merged = new Map<Detector, number>();
  const add = (findings: Finding[]) => {
    for (const f of findings) merged.set(f.type, (merged.get(f.type) ?? 0) + f.count);
  };

  const result = messages.map((message) => {
    const content = message.content;
    if (typeof content === "string") {
      const r = redactText(content, detectors);
      add(r.findings);
      return { ...message, content: r.text };
    }
    if (Array.isArray(content)) {
      const parts = content.map((part) => {
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          const r = redactText((part as { text: string }).text, detectors);
          add(r.findings);
          return { ...part, text: r.text };
        }
        return part;
      });
      return { ...message, content: parts };
    }
    return message;
  });

  return { messages: result, findings: [...merged].map(([type, count]) => ({ type, count })) };
}
