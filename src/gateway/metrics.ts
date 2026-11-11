import type { Summary } from "./requests.js";

/** Renders Prometheus text exposition format. Counters come from the database, so they survive restarts. */
export function renderMetrics(summary: Summary, pendingApprovals: number, agents: number): string {
  const lines: string[] = [];
  lines.push("# HELP wicket_requests_total Requests handled, by outcome.");
  lines.push("# TYPE wicket_requests_total counter");
  for (const [outcome, n] of Object.entries(summary.byOutcome).sort()) {
    lines.push(`wicket_requests_total{outcome="${outcome}"} ${n}`);
  }
  lines.push("# HELP wicket_tokens_total Prompt and completion tokens billed by the upstream.");
  lines.push("# TYPE wicket_tokens_total counter");
  lines.push(`wicket_tokens_total ${summary.tokens}`);
  lines.push("# HELP wicket_cost_usd_total Estimated spend in US dollars.");
  lines.push("# TYPE wicket_cost_usd_total counter");
  lines.push(`wicket_cost_usd_total ${summary.spendUsd}`);
  lines.push("# HELP wicket_approvals_pending Tool calls waiting for a human decision.");
  lines.push("# TYPE wicket_approvals_pending gauge");
  lines.push(`wicket_approvals_pending ${pendingApprovals}`);
  lines.push("# HELP wicket_agents Registered agents.");
  lines.push("# TYPE wicket_agents gauge");
  lines.push(`wicket_agents ${agents}`);
  return lines.join("\n") + "\n";
}
