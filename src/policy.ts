import type { Finding } from "./analysis.js";

export type Action = "allow" | "warn" | "block";

export interface PolicyDecision {
  action: Action;
  /** stdout text — the CLI appends it to the model context (official mechanism) */
  contextHint?: string;
  /** stderr text — fed back to the model as a correction when blocking */
  blockReason?: string;
}

const KILL_SWITCH_MESSAGE =
  "[agent-guard] CIRCUIT BREAK: this session has hit the intervention limit. " +
  "Stop making tool calls immediately. Do not attempt to work around this guard. " +
  "Summarize what you have learned so far, state what remains blocked and why, " +
  "and end your turn so the user can review the situation.";

export function isKillSwitchTripped(
  blocksInSession: number,
  cfg: { killSwitch: boolean; maxBlocksPerSession: number },
): boolean {
  return cfg.killSwitch && cfg.maxBlocksPerSession > 0 && blocksInSession >= cfg.maxBlocksPerSession;
}

export function killSwitchDecision(): PolicyDecision {
  return { action: "block", blockReason: KILL_SWITCH_MESSAGE };
}

/**
 * Resolve findings into a single action. Highest severity wins; blocks
 * outrank warns; warns are surfaced as context hints.
 */
export function resolveFindings(
  findings: Finding[],
  ctx: { blocksInSession: number; cfg: { killSwitch: boolean; maxBlocksPerSession: number } },
): PolicyDecision {
  if (isKillSwitchTripped(ctx.blocksInSession, ctx.cfg)) {
    return killSwitchDecision();
  }
  const block = findings.find((f) => f.severity === "block");
  if (block) {
    return { action: "block", blockReason: `[agent-guard] Blocked (${block.kind}): ${block.message}` };
  }
  const warns = findings.filter((f) => f.severity === "warn");
  if (warns.length > 0) {
    const hint = warns.map((f) => `[agent-guard] note (${f.kind}): ${f.message}`).join(" | ");
    return { action: "warn", contextHint: hint };
  }
  return { action: "allow" };
}
