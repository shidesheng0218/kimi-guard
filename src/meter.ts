import { countEvents, countBlocks, oldestEventTs, type StatusReport } from "./store.js";
import type { Finding } from "./analysis.js";

export interface PlanPreset {
  weekly: number;
  fiveHour: number;
}

/** Kimi Coding Plan tiers (requests). Verify against your plan page; `custom` overrides. */
export const PLANS: Record<string, PlanPreset> = {
  tier1: { weekly: 1024, fiveHour: 200 },
  tier2: { weekly: 2048, fiveHour: 200 },
  tier3: { weekly: 7168, fiveHour: 200 },
};

export interface BudgetConfig {
  enabled: boolean;
  plan: string;
  weekly: number;
  fiveHour: number;
  reservePercent: number;
  subagentWeight: number;
  warnPercent: number;
}

export interface WindowUsage {
  label: string;
  used: number;
  limit: number;
  percent: number;
  resetsInMs: number;
}

export interface BudgetSnapshot {
  enabled: boolean;
  plan: string;
  fiveHour: WindowUsage;
  weekly: WindowUsage;
  /** LLM turn events in the last hour — the burn rate */
  turnsLastHour: number;
  subagentsLastHour: number;
  /** projected requests by the end of the rolling 5h window at current burn rate */
  projectedFiveHour: number;
}

const HOUR = 3_600_000;
const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * 24 * HOUR;

export function resolveLimits(cfg: BudgetConfig): PlanPreset {
  const custom = { weekly: cfg.weekly, fiveHour: cfg.fiveHour };
  if (custom.weekly > 0 || custom.fiveHour > 0) {
    const preset = PLANS[cfg.plan] ?? { weekly: 0, fiveHour: 0 };
    return {
      weekly: custom.weekly > 0 ? custom.weekly : preset.weekly,
      fiveHour: custom.fiveHour > 0 ? custom.fiveHour : preset.fiveHour,
    };
  }
  return PLANS[cfg.plan] ?? { weekly: 0, fiveHour: 0 };
}

/**
 * Usage model:
 *  - a TurnStarted event ≈ 1 LLM request against the plan
 *  - a dispatched subagent ≈ subagentWeight requests (its own turns are not
 *    observed by main-session hooks)
 * Both are approximations until exact usage APIs are available; they err on
 * the conservative side (overcounting), which is the safe direction for a guard.
 */
export function budgetSnapshot(sessionId: string, cfg: BudgetConfig, now = Date.now()): BudgetSnapshot {
  const turns = countEvents(sessionId, ["turn"], now - HOUR);
  const subagents = countEvents(sessionId, ["subagent"], now - HOUR);
  const used5h = countEvents(sessionId, ["turn"], now - FIVE_HOURS) + countEvents(sessionId, ["subagent"], now - FIVE_HOURS) * cfg.subagentWeight;
  const usedWeek = countEvents(sessionId, ["turn"], now - WEEK) + countEvents(sessionId, ["subagent"], now - WEEK) * cfg.subagentWeight;
  const limits = resolveLimits(cfg);

  // Rolling-window semantics: the window ends `span` after the OLDEST event
  // still inside it. With no events the window has not started — a full span
  // lies ahead. (Epoch-aligned modulo arithmetic would be cheaper but wrong.)
  const mk = (label: string, used: number, limit: number, span: number, oldestTs: number | null): WindowUsage => ({
    label,
    used,
    limit,
    percent: limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0,
    resetsInMs: oldestTs !== null ? Math.max(0, oldestTs + span - now) : span,
  });

  const five = mk("5h", used5h, limits.fiveHour, FIVE_HOURS, oldestEventTs(sessionId, ["turn", "subagent"], now - FIVE_HOURS));
  const week = mk("weekly", usedWeek, limits.weekly, WEEK, oldestEventTs(sessionId, ["turn", "subagent"], now - WEEK));

  const hoursLeft5h = Math.max(0.25, (five.resetsInMs) / HOUR);
  const projected = used5h + turns * hoursLeft5h + subagents * cfg.subagentWeight * hoursLeft5h;

  return {
    enabled: cfg.enabled,
    plan: cfg.plan,
    fiveHour: five,
    weekly: week,
    turnsLastHour: turns,
    subagentsLastHour: subagents,
    projectedFiveHour: Math.round(projected),
  };
}

/**
 * Quota gate for subagent dispatch: block when a window is exhausted or the
 * current burn rate projects past the 5h limit before it resets.
 */
export function evaluateBudgetGate(
  sessionId: string,
  cfg: BudgetConfig,
  now = Date.now(),
): Finding | null {
  if (!cfg.enabled) return null;
  const snap = budgetSnapshot(sessionId, cfg, now);
  const reserve = Math.max(0, Math.min(50, cfg.reservePercent));

  for (const w of [snap.fiveHour, snap.weekly]) {
    if (w.limit <= 0) continue;
    if (w.percent >= 100 - reserve) {
      return {
        kind: "budget",
        severity: "block",
        tool: "dispatch",
        message:
          `Quota gate: your ${w.label} request window is ${w.percent}% consumed (${w.used}/${w.limit}) ` +
          `and the guard keeps a ${reserve}% reserve. Do not dispatch subagents — continue the task ` +
          `directly in this session with minimal tool usage, or ask the user to wait for the ` +
          `window reset or raise [budget] limits.`,
        evidence: `window=${w.label} used=${w.used} limit=${w.limit}`,
      };
    }
  }

  if (snap.fiveHour.limit > 0 && snap.projectedFiveHour > snap.fiveHour.limit * (1 - reserve / 100)) {
    return {
      kind: "budget",
      severity: "warn",
      tool: "dispatch",
      message:
        `Burn rate warning: at the current rate (~${snap.turnsLastHour} req/h + ${snap.subagentsLastHour} subagent/h) ` +
        `you are projected to reach ~${snap.projectedFiveHour} requests in this 5h window (limit ${snap.fiveHour.limit}). ` +
        `Prefer fewer, larger subagent dispatches.`,
      evidence: `projected=${snap.projectedFiveHour} limit=${snap.fiveHour.limit}`,
    };
  }

  if (snap.fiveHour.percent >= cfg.warnPercent || snap.weekly.percent >= cfg.warnPercent) {
    return {
      kind: "budget",
      severity: "warn",
      tool: "dispatch",
      message: `Budget: 5h window ${snap.fiveHour.percent}% used, weekly window ${snap.weekly.percent}% used.`,
      evidence: `5h=${snap.fiveHour.used}/${snap.fiveHour.limit} week=${snap.weekly.used}/${snap.weekly.limit}`,
    };
  }

  return null;
}

export function formatSnapshot(snap: BudgetSnapshot): string {
  if (!snap.enabled) return "budget guard disabled";
  const bar = (w: WindowUsage): string => {
    if (w.limit <= 0) return `${w.used} used (no limit configured)`;
    const filled = Math.round((w.percent / 100) * 20);
    return `[${"█".repeat(filled)}${"░".repeat(20 - filled)}] ${w.percent}% (${w.used}/${w.limit})`;
  };
  return [
    `plan: ${snap.plan}`,
    `5h:     ${bar(snap.fiveHour)}  resets in ${Math.round(snap.fiveHour.resetsInMs / HOUR)}h`,
    `weekly: ${bar(snap.weekly)}  resets in ${Math.round(snap.weekly.resetsInMs / (24 * HOUR))}d`,
    `burn rate: ${snap.turnsLastHour} req + ${snap.subagentsLastHour} subagents in the last hour`,
    `projected 5h usage at current rate: ~${snap.projectedFiveHour}`,
  ].join("\n");
}

export function budgetFindingsForStatus(status: StatusReport): string[] {
  return status.events24h.map((e) => `${e.kind}×${e.n}`);
}

export { countBlocks };
