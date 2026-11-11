import { createContext, Script } from "node:vm";
import type { Condition, Policy, ToolAction, ToolCall, ToolDecision, ToolRule } from "./types.js";

/** Matches a name against a pattern where `*` is a wildcard. Case-insensitive, so `Delete_X` cannot dodge `delete_*`. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`, "i");
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (UNSAFE_KEYS.has(key)) return undefined;
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

// Regular expressions come from policy documents, so a careless pattern could freeze the gateway.
// They run in a separate context with a hard time limit instead of on the main thread unchecked.
const sandbox = createContext({ re: null as RegExp | null, input: "" });
const runner = new Script("re.test(input)");
const MAX_REGEX_INPUT = 2048;
const REGEX_TIMEOUT_MS = 20;

type Verdict = boolean | "unknown";

function safeRegexTest(pattern: string, value: string): Verdict {
  try {
    const re = new RegExp(pattern);
    (sandbox as any).re = re;
    (sandbox as any).input = value.slice(0, MAX_REGEX_INPUT);
    return runner.runInContext(sandbox, { timeout: REGEX_TIMEOUT_MS }) === true;
  } catch {
    return "unknown";
  }
}

/**
 * Evaluates one condition. "unknown" means the data could not be judged: the argument is missing,
 * it is not a number where one is needed, or a pattern timed out. Unknowns fail closed, see `ruleMatches`.
 */
function evaluate(condition: Condition, call: ToolCall): Verdict {
  if (!call.argsValid) return "unknown";
  const actual = getPath(call.args, condition.arg);
  if (actual === undefined || actual === null) return "unknown";
  switch (condition.op) {
    case "equals":
      return String(actual) === String(condition.value);
    case "contains":
      return String(actual).includes(String(condition.value));
    case "matches":
      return safeRegexTest(String(condition.value), String(actual));
    case "gt":
    case "lt": {
      const n = typeof actual === "number" ? actual : typeof actual === "string" && actual.trim() !== "" ? Number(actual) : NaN;
      if (!Number.isFinite(n)) return "unknown";
      return condition.op === "gt" ? n > Number(condition.value) : n < Number(condition.value);
    }
  }
}

/**
 * A rule matches when every condition holds. Conditions that cannot be judged count as holding for
 * rules that deny or hold for approval, and as failing for rules that allow. A call with a missing
 * amount, a text amount or broken JSON therefore meets the strict rule and never the permissive one.
 */
function ruleMatches(rule: ToolRule, call: ToolCall): boolean {
  if (!globToRegExp(rule.tool).test(call.name)) return false;
  let unknown = false;
  for (const condition of rule.when ?? []) {
    const verdict = evaluate(condition, call);
    if (verdict === false) return false;
    if (verdict === "unknown") unknown = true;
  }
  return !unknown || rule.action !== "allow";
}

export function decideToolCall(policy: Policy, call: ToolCall): ToolDecision {
  for (let i = 0; i < policy.tools.length; i++) {
    const rule = policy.tools[i]!;
    if (ruleMatches(rule, call)) {
      return { call, action: rule.action, reason: rule.reason ?? `matched rule ${i + 1}`, ruleIndex: i };
    }
  }
  return { call, action: policy.defaultToolAction, reason: "default action", ruleIndex: null };
}

const SEVERITY: Record<ToolAction, number> = { allow: 0, require_approval: 1, deny: 2 };

/** The strictest decision wins: any deny blocks the whole response, otherwise any approval holds it. */
export function overallAction(decisions: ToolDecision[]): ToolAction {
  return decisions.reduce<ToolAction>(
    (worst, d) => (SEVERITY[d.action] > SEVERITY[worst] ? d.action : worst),
    "allow",
  );
}

export function parseToolArguments(raw: unknown): { args: Record<string, unknown>; valid: boolean } {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return { args: raw as Record<string, unknown>, valid: true };
  if (raw === undefined || raw === null || raw === "") return { args: {}, valid: true };
  if (typeof raw !== "string") return { args: {}, valid: false };
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { args: parsed, valid: true };
    return { args: {}, valid: false };
  } catch {
    return { args: {}, valid: false };
  }
}

/** Extracts tool calls from an OpenAI-style chat completion body. */
export function toolCallsFromCompletion(body: any): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const choice of body?.choices ?? []) {
    for (const tc of choice?.message?.tool_calls ?? []) {
      const { args, valid } = parseToolArguments(tc?.function?.arguments);
      calls.push({ id: tc?.id, name: String(tc?.function?.name ?? ""), args, argsValid: valid });
    }
  }
  return calls;
}

/** Rebuilds the tool calls of a streamed response from its server-sent events. */
export function toolCallsFromSse(text: string): ToolCall[] {
  const partial = new Map<string, { id?: string; name: string; args: string }>();
  for (const event of text.split("\n\n")) {
    if (!event.startsWith("data: {")) continue;
    let parsed: any;
    try {
      parsed = JSON.parse(event.slice(6));
    } catch {
      continue;
    }
    for (const choice of parsed.choices ?? []) {
      for (const tc of choice?.delta?.tool_calls ?? []) {
        const key = `${choice.index ?? 0}:${tc.index ?? 0}`;
        const entry = partial.get(key) ?? { name: "", args: "" };
        if (tc.id) entry.id = tc.id;
        if (tc.function?.name) entry.name += tc.function.name;
        if (tc.function?.arguments) entry.args += tc.function.arguments;
        partial.set(key, entry);
      }
    }
  }
  return [...partial.values()].map((p) => {
    const { args, valid } = parseToolArguments(p.args);
    return { id: p.id, name: p.name, args, argsValid: valid };
  });
}
