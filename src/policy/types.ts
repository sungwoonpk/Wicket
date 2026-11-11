export type Detector = "email" | "ssn" | "credit_card" | "phone" | "api_key";
export type ToolAction = "allow" | "deny" | "require_approval";

export interface Condition {
  /** Dot path into the parsed tool arguments, for example "amount" or "customer.id". */
  arg: string;
  op: "equals" | "contains" | "matches" | "gt" | "lt";
  value: string | number;
}

export interface ToolRule {
  /** Tool name, with `*` as a wildcard. */
  tool: string;
  action: ToolAction;
  /** All conditions must hold for the rule to match. No conditions means it always matches. */
  when?: Condition[];
  reason?: string;
}

export interface Policy {
  redaction: {
    mode: "off" | "redact" | "block";
    detectors: Detector[];
  };
  /** Evaluated in order, first match wins. */
  tools: ToolRule[];
  defaultToolAction: ToolAction;
}

export const DEFAULT_POLICY: Policy = {
  redaction: { mode: "off", detectors: ["email", "ssn", "credit_card", "phone", "api_key"] },
  tools: [],
  defaultToolAction: "allow",
};

export interface ToolCall {
  id?: string;
  name: string;
  /** Parsed arguments. Unparseable arguments become an empty object and are flagged. */
  args: Record<string, unknown>;
  argsValid: boolean;
}

export interface ToolDecision {
  call: ToolCall;
  action: ToolAction;
  reason: string;
  ruleIndex: number | null;
}

export interface Finding {
  type: Detector;
  count: number;
}
