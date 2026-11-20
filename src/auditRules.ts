import type { BudgetSnapshot } from "./meter.js";

export interface AuditRuleInput {
  now: number;
  windowMs: number;
  /** From cfg.budget.reservePercent; the snapshot does not carry it. */
  reservePercent: number;
  /** From cfg.budget.subagentWeight; the snapshot does not carry it. */
  subagentWeight: number;
  budget: BudgetSnapshot;
  totals: { calls: number; turns: number; subagentDispatches: number; blocks: number };
  sessions: Array<{ sessionId: string; compactionCycles: number }>;
  retries: { stepRetries: number; stopFailures: number; interrupts: number; maxIn30Min: number };
  runs: Array<{ runId: string; cacheRatio: number | null }>;
  stalls: number;
  blocksByKind: Array<{ kind: string; n: number }>;
}

export interface AuditFinding {
  id: string;
  severity: "info" | "warn";
  evidence: string;
  advice: string;
}

function pct(n: number): string {
  return `${Math.round(n)}%`;
}

function topKinds(rows: Array<{ kind: string; n: number }>, limit = 3): string {
  return [...rows]
    .sort((a, b) => b.n - a.n)
    .slice(0, limit)
    .map((r) => `${r.kind}×${r.n}`)
    .join(", ");
}

/** Deterministic findings over already-collected audit data. */
export function auditFindings(input: AuditRuleInput): AuditFinding[] {
  const out: AuditFinding[] = [];
  const { budget, totals, retries } = input;

  if (budget.fiveHour.percent >= 85 || budget.weekly.percent >= 85) {
    out.push({
      id: "quota-pressure",
      severity: "info",
      evidence: `5h=${pct(budget.fiveHour.percent)} weekly=${pct(budget.weekly.percent)}`,
      advice: "You are close to a plan limit. Finish the current task before dispatching more subagents or starting a large refactor.",
    });
  }

  if (budget.fiveHour.limit > 0) {
    const ceiling = budget.fiveHour.limit * (1 - input.reservePercent / 100);
    if (budget.projectedFiveHour >= ceiling) {
      out.push({
        id: "burn-projection",
        severity: "warn",
        evidence: `projected=${budget.projectedFiveHour} limit=${budget.fiveHour.limit} reserve=${input.reservePercent}%`,
        advice: "At the current burn rate the 5h window will hit the reserve. Pause, reduce fan-out, or wait for the window to reset.",
      });
    }
  }

  const weighted = budget.subagentsLastHour * input.subagentWeight;
  const share = weighted + budget.turnsLastHour > 0 ? weighted / (weighted + budget.turnsLastHour) : 0;
  if (budget.subagentsLastHour >= 3 && share >= 0.5) {
    out.push({
      id: "subagent-fanout",
      severity: "warn",
      evidence: `dispatches=${budget.subagentsLastHour}, weighted share=${pct(share * 100)}`,
      advice: "Subagent fan-out dominates recent requests. Cap parallel dispatches and check for retry loops (upstream #2615, #2647).",
    });
  }

  if (retries.maxIn30Min >= 5) {
    out.push({
      id: "retry-storm",
      severity: "warn",
      evidence: `retries_in_30m=${retries.maxIn30Min}`,
      advice: "Repeated retries after a failure usually mean the provider is refusing the request. Stop on 403/quota errors instead of retrying (upstream #2647).",
    });
  }

  const amplified = input.runs.filter((r) => r.cacheRatio !== null && r.cacheRatio > 10);
  if (amplified.length > 0) {
    out.push({
      id: "cache-amplification",
      severity: "warn",
      evidence: `run=${amplified[0]!.runId} cache_read/input=${amplified[0]!.cacheRatio!.toFixed(1)}x`,
      advice: "Cache-read billing is far above new input in this supervised run. Save the run report and compare with upstream #2626 before assuming workload caused it.",
    });
  }

  if (totals.calls === 0 && totals.turns === 0) {
    out.push({
      id: "guard-inactive",
      severity: "info",
      evidence: `calls=0 turns=0 window=${Math.round(input.windowMs / 3_600_000)}h`,
      advice: "No agent activity was recorded. Confirm the guard hooks are installed and the agent ran in this window.",
    });
  }

  if (totals.blocks >= 10) {
    out.push({
      id: "intervention-heavy",
      severity: "info",
      evidence: `blocks=${totals.blocks} top=${topKinds(input.blocksByKind)}`,
      advice: "The guard intervened repeatedly. Review recent blocks and mark false positives with 'agentguard feedback fp <id>' before tuning with 'agentguard calibrate'.",
    });
  }

  const compressed = input.sessions.filter((s) => s.compactionCycles >= 3);
  if (compressed.length > 0) {
    out.push({
      id: "context-pressure",
      severity: "info",
      evidence: `session=${compressed[0]!.sessionId} cycles=${compressed[0]!.compactionCycles}`,
      advice: "The session compacted repeatedly. Split the task or write intermediate findings to disk so later turns do not re-explore.",
    });
  }

  if (input.stalls > 0) {
    out.push({
      id: "stall-signal",
      severity: "info",
      evidence: `stalls=${input.stalls}`,
      advice: "A session went silent past the stall threshold. Check the upstream hang reports (#2598, #2582) and the agent log for a dead stream.",
    });
  }

  return out;
}