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
 * Compound scoring (opt-in): several DIFFERENT weak signals at once are
 * stronger evidence of a stuck agent than any single one. Off by default —
 * this is the stricter mode users opt into.
 */
export function compoundUpgrade(findings: Finding[], enabled: boolean): Finding[] {
  if (!enabled) return findings;
  if (findings.some((f) => f.kind === "compound" && f.severity === "block")) return findings; // already upgraded
  const warnKinds = new Set(findings.filter((f) => f.severity === "warn").map((f) => f.kind));
  if (warnKinds.size < 3) return findings;
  return [
    {
      kind: "compound",
      severity: "block",
      message:
        `Multiple weak signals at once (${[...warnKinds].join(", ")}): individually each is a warn, ` +
        `together they mean the agent is stuck. Stop, reassess the approach, and either proceed ` +
        `differently or end the turn with a summary.`,
      evidence: `distinct warn kinds=${warnKinds.size}`,
    },
    ...findings,
  ] as Finding[];
}

/**
 * Resolve findings into a single action. Highest severity wins; blocks
 * outrank warns; warns are surfaced as context hints.
 */
export function resolveFindings(
  findings: Finding[],
  ctx: { blocksInSession: number; cfg: { killSwitch: boolean; maxBlocksPerSession: number; compoundBlocks?: boolean } },
): PolicyDecision {
  if (isKillSwitchTripped(ctx.blocksInSession, ctx.cfg)) {
    return killSwitchDecision();
  }
  const withCompound = compoundUpgrade(findings, ctx.cfg.compoundBlocks === true);
  const block = withCompound.find((f) => f.severity === "block");
  if (block) {
    const evidence = block.evidence ? ` [evidence: ${block.evidence}]` : "";
    return { action: "block", blockReason: `[agent-guard] Blocked (${block.kind}): ${block.message}${evidence}` };
  }
  const warns = withCompound.filter((f) => f.severity === "warn");
  if (warns.length > 0) {
    const hint = warns
      .map((f) => `[agent-guard] note (${f.kind}): ${f.message}${f.evidence ? ` [${f.evidence}]` : ""}`)
      .join(" | ");
    return { action: "warn", contextHint: hint };
  }
  return { action: "allow" };
}
