import type { DatabaseSync } from "node:sqlite";
import { DEFAULT_POLICY, type Detector, type Policy, type ToolAction } from "../policy/types.js";

const ACTIONS: ToolAction[] = ["allow", "deny", "require_approval"];
const DETECTORS: Detector[] = ["email", "ssn", "credit_card", "phone", "api_key"];
const OPS = ["equals", "contains", "matches", "gt", "lt"];

export class PolicyError extends Error {}

/** Validates an untrusted policy document and returns it in canonical form. */
export function parsePolicy(input: unknown): Policy {
  if (!input || typeof input !== "object") throw new PolicyError("policy must be an object");
  const doc = input as Record<string, any>;

  const redaction = doc.redaction ?? DEFAULT_POLICY.redaction;
  if (!["off", "redact", "block"].includes(redaction.mode))
    throw new PolicyError("redaction.mode must be off, redact or block");
  const detectors: Detector[] = redaction.detectors ?? DEFAULT_POLICY.redaction.detectors;
  if (!Array.isArray(detectors) || detectors.some((d) => !DETECTORS.includes(d))) {
    throw new PolicyError(`redaction.detectors must be a list of: ${DETECTORS.join(", ")}`);
  }

  const defaultToolAction = doc.defaultToolAction ?? "allow";
  if (!ACTIONS.includes(defaultToolAction))
    throw new PolicyError("defaultToolAction must be allow, deny or require_approval");

  const tools = doc.tools ?? [];
  if (!Array.isArray(tools)) throw new PolicyError("tools must be a list");
  const rules = tools.map((rule: any, i: number) => {
    if (typeof rule?.tool !== "string" || rule.tool === "")
      throw new PolicyError(`tools[${i}].tool must be a non-empty string`);
    if (!ACTIONS.includes(rule.action))
      throw new PolicyError(`tools[${i}].action must be allow, deny or require_approval`);
    const when = rule.when ?? [];
    if (!Array.isArray(when)) throw new PolicyError(`tools[${i}].when must be a list`);
    for (const c of when) {
      if (typeof c?.arg !== "string" || !OPS.includes(c?.op) || !["string", "number"].includes(typeof c?.value)) {
        throw new PolicyError(`tools[${i}].when has an invalid condition`);
      }
      if (c.op === "matches") {
        try {
          new RegExp(c.value);
        } catch {
          throw new PolicyError(`tools[${i}].when has an invalid regular expression`);
        }
      }
    }
    return {
      tool: rule.tool,
      action: rule.action,
      ...(when.length ? { when } : {}),
      ...(typeof rule.reason === "string" ? { reason: rule.reason } : {}),
    };
  });

  return { redaction: { mode: redaction.mode, detectors }, tools: rules, defaultToolAction };
}

export class PolicyStore {
  /**
   * Parsed policies by scope. A policy is read on every request, so it is parsed once and kept until a
   * policy changes. Policies are only changed through this class, so clearing on any write is enough.
   * This assumes one gateway process owns the database.
   */
  private cache = new Map<string, Policy | null>();

  constructor(private readonly db: DatabaseSync) {}

  private cached(key: string, load: () => Policy | null): Policy | null {
    if (!this.cache.has(key)) this.cache.set(key, load());
    return this.cache.get(key) ?? null;
  }

  /** The organization-wide policy, used by every team that has none of its own. */
  get(): Policy {
    return this.cached("org", () => {
      const row = this.db.prepare("SELECT doc FROM policy WHERE id = 1").get() as { doc: string } | undefined;
      return row ? parsePolicy(JSON.parse(row.doc)) : DEFAULT_POLICY;
    })!;
  }

  set(input: unknown): Policy {
    const policy = parsePolicy(input);
    this.db
      .prepare("INSERT INTO policy (id, doc) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET doc = excluded.doc")
      .run(JSON.stringify(policy));
    this.cache.clear();
    return policy;
  }

  /** A team's own policy, or undefined when the team follows the organization policy. */
  getTeam(team: string): Policy | undefined {
    return (
      this.cached(`team:${team}`, () => {
        const row = this.db.prepare("SELECT doc FROM team_policies WHERE team = ?").get(team) as
          { doc: string } | undefined;
        return row ? parsePolicy(JSON.parse(row.doc)) : null;
      }) ?? undefined
    );
  }

  setTeam(team: string, input: unknown): Policy {
    const policy = parsePolicy(input);
    this.db
      .prepare("INSERT INTO team_policies (team, doc) VALUES (?, ?) ON CONFLICT(team) DO UPDATE SET doc = excluded.doc")
      .run(team, JSON.stringify(policy));
    this.cache.clear();
    return policy;
  }

  deleteTeam(team: string): boolean {
    const removed = this.db.prepare("DELETE FROM team_policies WHERE team = ?").run(team).changes === 1;
    this.cache.clear();
    return removed;
  }

  /** The policy that applies to a team: its own if it has one, otherwise the organization policy. */
  effective(team: string): Policy {
    return this.getTeam(team) ?? this.get();
  }

  /** Teams that have their own policy. */
  teamsWithPolicy(): string[] {
    return (this.db.prepare("SELECT team FROM team_policies ORDER BY team").all() as { team: string }[]).map(
      (r) => r.team,
    );
  }
}
