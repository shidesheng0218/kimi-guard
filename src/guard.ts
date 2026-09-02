import fs from "node:fs";
import { callsSince, countBlocks, getMeta, recordBlock, recordCall, recordEvent, setMeta } from "./store.js";
import { probeLogPath } from "./paths.js";
import type { GuardConfig } from "./config.js";
import { analyzeCall } from "./analysis.js";
import { isKillSwitchTripped, resolveFindings } from "./policy.js";
import { evaluateBudgetGate } from "./meter.js";
import { captureCheckpoint } from "./checkpoint.js";
import { hasEvidence, hasRecentEdits, HOOKS_STOP_BLOCK_REASON } from "./verify.js";
import { normalizeCall } from "./events.js";
import type { HookPayload } from "./events.js";

export type { HookPayload };
export function probeEnabled(): boolean {
  if (process.env.KIMI_GUARD_PROBE === "1") return true;
  try {
    return getMeta("probe_enabled") === "1";
  } catch {
    return false;
  }
}

export function appendProbe(event: string, payload: HookPayload): void {
  const line = JSON.stringify({ ts: Date.now(), event, payload }) + "\n";
  fs.appendFileSync(probeLogPath(), line, "utf8");
}

export interface HookOutcome {
  code: number;
  stdout?: string;
  stderr?: string;
}

export async function readStdinJson(): Promise<HookPayload> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as HookPayload) : { value: parsed };
  } catch {
    return { _unparsed: raw.slice(0, 4096) };
  }
}

/**
 * Pure decision pipeline — also used by tests. Returns the exit code plus any
 * context hints (stdout) or block reason (stderr).
 */
export function processHookEvent(event: string, cfg: GuardConfig, payload: HookPayload, now = Date.now()): HookOutcome {
  if (probeEnabled()) {
    try {
      appendProbe(event, payload);
    } catch {
      /* probe must never break the guard */
    }
  }

  // Liveness tracking: the guard can only detect its own schema drift while
  // hooks still fire. last_hook_* feeds `kguard status`/`doctor`; a payload
  // that no longer normalizes increments normalize_misses.
  try {
    setMeta("last_hook_ts", String(now));
    setMeta("last_hook_event", event);
  } catch {
    /* fail-open */
  }

  const sessionId =
    (typeof payload["session_id"] === "string" && payload["session_id"]) ||
    (typeof payload["sessionId"] === "string" && payload["sessionId"]) ||
    (typeof payload["session"] === "string" && payload["session"]) ||
    "unknown";

  switch (event) {
    case "PreToolUse":
      return handlePreToolUse(event, cfg, payload, sessionId, now);
    case "PostToolUse":
    case "PostToolUseFailure":
      return handlePostTool(event, cfg, payload, sessionId, now);
    case "Stop": {
      // Claude Code has no TurnStarted event; one Stop ≈ one completed turn ≈ 1+ requests
      if (cfg.harness === "claude") recordEvent(sessionId, "turn", { origin: "stop" }, now);
      if (!cfg.verify.enabled || !cfg.verify.blockOnNoEvidence) return { code: 0 };
      if (!hasRecentEdits(sessionId, cfg, now)) return { code: 0 };
      if (hasEvidence(sessionId, cfg, now)) return { code: 0 };
      const id = recordBlock(sessionId, "Stop", "verify", now);
      return { code: 2, stderr: HOOKS_STOP_BLOCK_REASON + feedbackHint(id) };
    }
    case "UserPromptSubmit": {
      return handleGoalAnchor(payload, sessionId, cfg, now);
    }
    case "PreCompact":
      recordEvent(sessionId, "compaction", { phase: "pre" }, now);
      setSessionMeta(sessionId, "last_compact_ts", String(now));
      captureCheckpoint(sessionId, "pre-compact", now, cfg);
      return { code: 0 };
    case "PostCompact":
      recordEvent(sessionId, "compaction", { phase: "post" }, now);
      return { code: 0 };
    case "TurnStarted":
      recordEvent(sessionId, "turn", { origin: payload["origin_kind"] ?? payload["origin"] ?? "" }, now);
      return { code: 0 };
    case "SubagentStart":
      recordEvent(sessionId, "subagent", { agent: payload["agent_name"] ?? "" }, now);
      return { code: 0 };
    case "StopFailure":
      recordEvent(sessionId, "stop_failure", { error: String(payload["error_message"] ?? payload["error_type"] ?? "") }, now);
      captureCheckpoint(sessionId, "stop-failure", now, cfg);
      return { code: 0 };
    case "Interrupt":
      recordEvent(sessionId, "interrupt", { reason: String(payload["reason"] ?? "") }, now);
      captureCheckpoint(sessionId, "interrupt", now, cfg);
      return { code: 0 };
    case "SessionEnd":
      captureCheckpoint(sessionId, "session-end", now, cfg);
      return { code: 0 };
    default:
      return { code: 0 };
  }
}

/** Appended to every block message: the feedback loop's entry point. */
function feedbackHint(id: number): string {
  return `\n[agent-guard] block #${id} recorded. If this was a false positive, run: kguard feedback fp ${id}`;
}

function noteNormalizeMiss(now: number): void {
  try {
    const misses = Number(getMeta("normalize_misses") ?? "0") + 1;
    setMeta("normalize_misses", String(misses));
    setMeta("last_normalize_miss_ts", String(now));
  } catch {
    /* fail-open */
  }
}

function handlePreToolUse(event: string, cfg: GuardConfig, payload: HookPayload, sessionId: string, now: number): HookOutcome {
  const call = normalizeCall(payload, event, now);
  if (!call) {
    if (Object.keys(payload).length > 0) noteNormalizeMiss(now);
    return { code: 0 };
  }

  const since = now - Math.max(cfg.repeat.windowMinutes, cfg.cycle.windowMinutes, cfg.policy.blockWindowMinutes) * 60_000;
  const history = callsSince(sessionId, since);
  const analysis = analyzeCall(history, { tool: call.tool, argsHash: call.argsHash, args: call.args }, cfg, now);

  if (cfg.budget.dispatchTools.includes(call.tool)) {
    const budgetFinding = evaluateBudgetGate(sessionId, cfg.budget, now);
    if (budgetFinding) analysis.findings.unshift(budgetFinding);
  }

  const blocksInSession = countBlocks(sessionId, now - cfg.policy.blockWindowMinutes * 60_000);
  const decision = resolveFindings(analysis.findings, { blocksInSession, cfg: cfg.policy });

  if (decision.action === "block") {
    // Record the DETECTOR kind (repeat/churn/budget/...), not a generic label —
    // per-detector stats power the false-positive feedback loop.
    const kind = isKillSwitchTripped(blocksInSession, cfg.policy)
      ? "killSwitch"
      : (analysis.findings.find((f) => f.severity === "block")?.kind ?? "unknown");
    const id = recordBlock(sessionId, call.tool, kind, now);
    return { code: 2, stderr: decision.blockReason + feedbackHint(id) };
  }
  if (decision.action === "warn" && decision.contextHint) {
    return { code: 0, stdout: decision.contextHint };
  }
  return { code: 0 };
}

function sessionKey(sessionId: string, key: string): string {
  return `${key}:${sessionId}`;
}

function getSessionMeta(sessionId: string, key: string): string | undefined {
  return getMeta(sessionKey(sessionId, key));
}

function setSessionMeta(sessionId: string, key: string, value: string): void {
  setMeta(sessionKey(sessionId, key), value);
}

/**
 * Goal anchoring: remember the user's original task and re-inject it
 * periodically (every N prompts) and always after a compaction — the two
 * moments a long session is most likely to drift away from the goal.
 */
export function handleGoalAnchor(payload: HookPayload, sessionId: string, cfg: GuardConfig, now = Date.now()): HookOutcome {
  if (!cfg.anchor.enabled) return { code: 0 };
  const promptText =
    (typeof payload["prompt"] === "string" && payload["prompt"]) ||
    (typeof payload["user_input"] === "string" && payload["user_input"]) ||
    "";
  if (!promptText) return { code: 0 };

  const count = Number(getSessionMeta(sessionId, "anchor_count") ?? "0") + 1;
  setSessionMeta(sessionId, "anchor_count", String(count));
  recordEvent(sessionId, "prompt", { chars: promptText.length }, now);

  if (count === 1) {
    setSessionMeta(sessionId, "goal", promptText.slice(0, cfg.anchor.maxChars));
    setSessionMeta(sessionId, "last_anchor_ts", String(now));
    return { code: 0 };
  }

  const lastCompact = Number(getSessionMeta(sessionId, "last_compact_ts") ?? "0");
  const lastAnchor = Number(getSessionMeta(sessionId, "last_anchor_ts") ?? "0");
  const afterCompaction = lastCompact > lastAnchor;
  const periodic = count % cfg.anchor.everyNPrompts === 0;
  if (!afterCompaction && !periodic) return { code: 0 };

  const goal = getSessionMeta(sessionId, "goal") ?? "";
  if (!goal) return { code: 0 };
  setSessionMeta(sessionId, "last_anchor_ts", String(now));
  return {
    code: 0,
    stdout:
      `[agent-guard] goal anchor (injected ${afterCompaction ? "after compaction" : `every ${cfg.anchor.everyNPrompts} prompts`}): ` +
      `the user's task for this session, verbatim: "${goal}". ` +
      `Re-evaluate: does the current work still serve this goal? If you have drifted, get back on ` +
      `target; if the goal is already met, stop and summarize.`,
  };
}

function handlePostTool(event: string, cfg: GuardConfig, payload: HookPayload, sessionId: string, now: number): HookOutcome {  void cfg;
  const call = normalizeCall(payload, event, now);
  if (!call) return { code: 0 };
  recordCall({
    sessionId,
    toolName: call.tool,
    argsHash: call.argsHash,
    argsJson: call.argsJson,
    outputHash: call.outputHash,
    filePath: call.filePath,
    status: call.status,
    ts: now,
  });
  return { code: 0 };
}
