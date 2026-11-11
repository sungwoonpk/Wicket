import type { Condition, Policy, ToolAction, ToolCall, ToolDecision, ToolRule } from "./types.js";

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

function getPath(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function holds(condition: Condition, args: Record<string, unknown>): boolean {
  const actual = getPath(args, condition.arg);
  if (actual === undefined) return false;
  switch (condition.op) {
    case "equals":
      return String(actual) === String(condition.value);
    case "contains":
      return String(actual).includes(String(condition.value));
    case "matches":
      try {
        return new RegExp(String(condition.value)).test(String(actual));
      } catch {
        return false;
      }
    case "gt":
      return Number(actual) > Number(condition.value);
    case "lt":
      return Number(actual) < Number(condition.value);
  }
}

function ruleMatches(rule: ToolRule, call: ToolCall): boolean {
  if (!globToRegExp(rule.tool).test(call.name)) return false;
  return (rule.when ?? []).every((c) => holds(c, call.args));
}

/** Decides one tool call. Arguments that are not valid JSON never match a conditional rule. */
export function decideToolCall(policy: Policy, call: ToolCall): ToolDecision {
  for (let i = 0; i < policy.tools.length; i++) {
    const rule = policy.tools[i]!;
    if (!call.argsValid && (rule.when?.length ?? 0) > 0) continue;
    if (ruleMatches(rule, call)) {
      return { call, action: rule.action, reason: rule.reason ?? `matched rule ${i + 1}`, ruleIndex: i };
    }
  }
  return { call, action: policy.defaultToolAction, reason: "default action", ruleIndex: null };
}

const SEVERITY: Record<ToolAction, number> = { allow: 0, require_approval: 1, deny: 2 };

/** The strictest decision wins: any deny blocks the response, otherwise any approval holds it. */
export function overallAction(decisions: ToolDecision[]): ToolAction {
  return decisions.reduce<ToolAction>(
    (worst, d) => (SEVERITY[d.action] > SEVERITY[worst] ? d.action : worst),
    "allow",
  );
}

function parseArgs(raw: unknown): { args: Record<string, unknown>; valid: boolean } {
  if (raw && typeof raw === "object") return { args: raw as Record<string, unknown>, valid: true };
  if (typeof raw !== "string" || raw.trim() === "") return { args: {}, valid: raw === "" || raw === undefined };
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
      const { args, valid } = parseArgs(tc?.function?.arguments);
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
    const { args, valid } = parseArgs(p.args);
    return { id: p.id, name: p.name, args, argsValid: valid };
  });
}
