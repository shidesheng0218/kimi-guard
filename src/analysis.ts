import type { CallRow } from "./store.js";
import { fingerprint } from "./events.js";
import type { GuardConfig } from "./config.js";

export type FindingKind = "repeat" | "cycle" | "noGain" | "churn" | "noProgress" | "nearRepeat" | "budget";
export type Severity = "warn" | "block";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  tool?: string;
  message: string;
  evidence: string;
}

const allow: Finding[] = [];

function fmtEvidence(r: CallRow): string {
  let s: string;
  try {
    const parsed = JSON.parse(r.args_json) as unknown;
    s = JSON.stringify(parsed);
  } catch {
    s = r.args_json;
  }
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

/**
 * Does the proposed call match a user-configured exemption pattern? Exempt
 * calls (e.g. polling commands like `git status`) never trigger repeat
 * findings. Patterns are matched against the JSON-serialized arguments.
 */
export function isRepeatExempt(proposed: { tool: string; args?: unknown }, cfg: GuardConfig): boolean {
  if (cfg.repeat.exemptPatterns.length === 0) return false;
  let text: string;
  try {
    text = JSON.stringify(proposed.args ?? {});
  } catch {
    text = String(proposed.args);
  }
  for (const p of cfg.repeat.exemptPatterns) {
    try {
      if (new RegExp(p).test(text)) return true;
    } catch {
      /* invalid pattern — skip */
    }
  }
  return false;
}

/**
 * Exact / near-duplicate repetition of (tool, args) signature.
 * Warns first (soft nudge), blocks at the repeat threshold.
 */
export function analyzeRepetition(
  history: CallRow[],
  proposed: { tool: string; argsHash: string; args?: unknown },
  cfg: GuardConfig,
  now: number,
): Finding[] {
  if (!cfg.repeat.enabled) return allow;
  const watched = cfg.repeat.watch.includes(proposed.tool) || proposed.tool in cfg.repeat.thresholds;
  if (!watched) return allow;
  if (isRepeatExempt(proposed, cfg)) return allow;
  const threshold = cfg.repeat.thresholds[proposed.tool] ?? cfg.repeat.maxRepeats;
  const since = now - cfg.repeat.windowMinutes * 60_000;
  const n = history.filter(
    (r) => r.tool_name === proposed.tool && r.args_hash === proposed.argsHash && r.ts >= since,
  ).length;
  if (n >= threshold) {
    return [
      {
        kind: "repeat",
        severity: "block",
        tool: proposed.tool,
        message:
          `"${proposed.tool}" has already been called ${n} times with identical arguments in the last ` +
          `${cfg.repeat.windowMinutes} minutes. The previous results are already in context — use them ` +
          `instead of re-running. If a retry is genuinely required, change the arguments or state why ` +
          `the previous result is insufficient.`,
        evidence: `signature count=${n}, threshold=${threshold}`,
      },
    ];
  }
  if (cfg.repeat.warnAt > 0 && n >= cfg.repeat.warnAt) {
    return [
      {
        kind: "repeat",
        severity: "warn",
        tool: proposed.tool,
        message:
          `"${proposed.tool}" has been called ${n} times with identical arguments — the result is already ` +
          `in context. Identical calls are blocked at ${threshold}; make sure any retry adds new information.`,
        evidence: `signature count=${n}, warnAt=${cfg.repeat.warnAt}`,
      },
    ];
  }
  return allow;
}

/**
 * Periodic loop detection: A→A→A (period 1, covered by repetition too but
 * catches unwatched tools), A→B→A→B (period 2), A→B→C→A→B→C (period 3).
 * Requires several full repetitions of the period before firing.
 */
export function analyzeCycles(history: CallRow[], cfg: GuardConfig, now: number): Finding[] {
  if (!cfg.cycle.enabled) return allow;
  const since = now - cfg.cycle.windowMinutes * 60_000;
  const recent = history
    .filter((r) => r.ts >= since)
    .slice(-16)
    .map((r) => `${r.tool_name}:${r.args_hash}`);
  if (recent.length < 8) return allow;

  const findings: Finding[] = [];
  for (let period = 1; period <= 3; period++) {
    const minReps = period === 1 ? 5 : 3;
    const needed = period * minReps;
    const tail = recent.slice(-needed);
    if (tail.length < needed) continue;
    const base = tail.slice(0, period);
    let isCycle = true;
    for (let i = period; i < tail.length; i++) {
      if (tail[i] !== base[i % period]) {
        isCycle = false;
        break;
      }
    }
    if (isCycle) {
      const desc =
        period === 1
          ? `the same call (${base[0]})`
          : `a ${period}-step cycle (${base.map((s) => s.split(":")[0]).join(" → ")})`;
      findings.push({
        kind: "cycle",
        severity: "block",
        tool: base[0]?.split(":")[0],
        message:
          `Loop detected: the agent has repeated ${desc} ${minReps}+ times in a row without ` +
          `progress. Stop re-running this sequence. Re-read the results already in context, ` +
          `reassess the approach, and either proceed differently or end the turn with a summary.`,
        evidence: `period=${period}, reps>=${minReps}`,
      });
      break;
    }
  }
  return findings;
}

/**
 * No-information-gain detection: different arguments but byte-identical
 * (normalized) output repeated — the model is spinning without new data.
 */
export function analyzeNoGain(history: CallRow[], cfg: GuardConfig, now: number): Finding[] {
  if (!cfg.noGain.enabled) return allow;
  const since = now - cfg.noGain.windowMinutes * 60_000;
  const byPair = new Map<string, number>();
  for (const r of history) {
    if (r.ts < since || !r.output_hash) continue;
    const key = `${r.tool_name}:${r.output_hash}`;
    byPair.set(key, (byPair.get(key) ?? 0) + 1);
  }
  const findings: Finding[] = [];
  for (const [key, n] of byPair) {
    if (n < cfg.noGain.warnAt) continue;
    const tool = key.split(":")[0]!;
    if (n >= cfg.noGain.blockAt) {
      findings.push({
        kind: "noGain",
        severity: "block",
        tool,
        message:
          `No-progress loop: ${tool} returned the exact same output ${n} times despite different ` +
          `arguments. You are not gaining new information. Stop calling ${tool}, analyze the ` +
          `result you already have, change strategy, or report your findings.`,
        evidence: `tool=${tool} identical_output_count=${n}`,
      });
    } else {
      findings.push({
        kind: "noGain",
        severity: "warn",
        tool,
        message: `${tool} has returned the same output ${n} times — verify you are not repeating work.`,
        evidence: `tool=${tool} identical_output_count=${n}`,
      });
    }
  }
  return findings.slice(0, 2);
}

const DEFAULT_CHURN_TOOLS = ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"];

export function editToolSet(cfg: GuardConfig): Set<string> {
  return new Set(cfg.churn.tools.length > 0 ? cfg.churn.tools : DEFAULT_CHURN_TOOLS);
}

/**
 * No-progress stretch (histori-style D3): a run of tool calls with no
 * successful edit landing — the agent is doing motion, not progress.
 * If the proposed call itself is an edit, we stay silent and let the edit
 * break the streak.
 */
export function analyzeNoProgress(
  history: CallRow[],
  proposed: { tool: string; argsHash: string },
  cfg: GuardConfig,
  now: number,
): Finding[] {
  if (!cfg.noProgress.enabled) return allow;
  if (editToolSet(cfg).has(proposed.tool)) return allow;
  const since = now - cfg.noProgress.windowMinutes * 60_000;
  const tools = editToolSet(cfg);
  let lastEditTs = -1;
  for (const r of history) {
    if (r.ts < since) continue;
    if (tools.has(r.tool_name) && r.status === "ok") lastEditTs = Math.max(lastEditTs, r.ts);
  }
  const stretch = history.filter((r) => r.ts >= since && r.ts > lastEditTs).length;
  if (stretch < cfg.noProgress.warnAt) return allow;

  if (stretch >= cfg.noProgress.blockAt) {
    return [
      {
        kind: "noProgress",
        severity: "block",
        tool: proposed.tool,
        message:
          `No progress: ${stretch} tool calls in the last ${cfg.noProgress.windowMinutes} minutes ` +
          `with no successful file edit landing. You are circling, not converging. Stop, pick the ` +
          `single most valuable next change, make it deliberately, or report what is blocking you.`,
        evidence: `stretch=${stretch} warnAt=${cfg.noProgress.warnAt} blockAt=${cfg.noProgress.blockAt}`,
      },
    ];
  }
  return [
    {
      kind: "noProgress",
      severity: "warn",
      tool: proposed.tool,
      message: `${stretch} calls without a landed edit recently — make sure the next step actually produces a change.`,
      evidence: `stretch=${stretch}`,
    },
  ];
}

/**
 * Edit churn ("thrashing"): the same file edited over and over, usually a
 * sign the agent is guessing instead of understanding the failure.
 */
export function analyzeChurn(history: CallRow[], cfg: GuardConfig, now: number): Finding[] {
  if (!cfg.churn.enabled) return allow;
  const since = now - cfg.churn.windowMinutes * 60_000;
  const tools = new Set(cfg.churn.tools.length > 0 ? cfg.churn.tools : DEFAULT_CHURN_TOOLS);
  const byFile = new Map<string, number>();
  for (const r of history) {
    if (r.ts < since || !r.file_path || !tools.has(r.tool_name)) continue;
    byFile.set(r.file_path, (byFile.get(r.file_path) ?? 0) + 1);
  }
  const findings: Finding[] = [];
  for (const [file, n] of byFile) {
    if (n >= cfg.churn.blockAt) {
      findings.push({
        kind: "churn",
        severity: "block",
        tool: "edit",
        message:
          `Edit churn: ${file} has been modified ${n} times in the last ${cfg.churn.windowMinutes} ` +
          `minutes without converging. Stop editing. Re-read the file and the error output, ` +
          `form an explicit hypothesis about why previous fixes failed, then make a single ` +
          `deliberate change — or ask the user for help.`,
        evidence: `file=${file} edits=${n}`,
      });
    } else if (n >= cfg.churn.warnAt) {
      findings.push({
        kind: "churn",
        severity: "warn",
        tool: "edit",
        message: `${file} has been edited ${n} times recently — step back and verify your approach before editing again.`,
        evidence: `file=${file} edits=${n}`,
      });
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1)).slice(0, 1);
}

export interface AnalysisResult {
  findings: Finding[];
}

/**
 * Fuzzy near-duplicate detection: arguments that differ only in punctuation,
 * quotes, case or reordering still collapse to the same key. Riskier than the
 * exact fingerprint, so it starts at warn level and blocks only at a high count.
 */
export function fuzzyKey(tool: string, argsJson: string): string {
  let text = argsJson;
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    const parts: string[] = [];
    for (const v of Object.values(obj)) {
      if (typeof v === "string") parts.push(v);
      else if (v !== null && v !== undefined) parts.push(JSON.stringify(v));
    }
    if (parts.length > 0) text = parts.join("|");
  } catch {
    /* raw fallback */
  }
  return `${tool}:${text.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "")}`;
}

export function analyzeNearRepeat(history: CallRow[], cfg: GuardConfig, now = Date.now()): Finding[] {
  if (!cfg.nearRepeat.enabled) return allow;
  const since = now - cfg.nearRepeat.windowMinutes * 60_000;
  const byKey = new Map<string, { n: number; tool: string }>();
  for (const r of history) {
    if (r.ts < since) continue;
    const key = fuzzyKey(r.tool_name, r.args_json);
    const cur = byKey.get(key) ?? { n: 0, tool: r.tool_name };
    cur.n++;
    byKey.set(key, cur);
  }
  const findings: Finding[] = [];
  for (const [, v] of byKey) {
    if (v.n >= cfg.nearRepeat.blockAt) {
      findings.push({
        kind: "nearRepeat",
        severity: "block",
        tool: v.tool,
        message:
          `Near-duplicate loop: ${v.tool} has been called ${v.n} times with arguments that differ ` +
          `only trivially (punctuation, case, spacing, order). You are not trying anything new. ` +
          `Use the results already in context or change the approach substantially.`,
        evidence: `fuzzy_count=${v.n} blockAt=${cfg.nearRepeat.blockAt}`,
      });
    } else if (v.n >= cfg.nearRepeat.warnAt) {
      findings.push({
        kind: "nearRepeat",
        severity: "warn",
        tool: v.tool,
        message: `${v.tool} has ${v.n} near-identical calls recently — verify these calls differ meaningfully.`,
        evidence: `fuzzy_count=${v.n}`,
      });
    }
  }
  return findings.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "block" ? -1 : 1)).slice(0, 1);
}

export function analyzeCall(
  history: CallRow[],
  proposed: { tool: string; argsHash: string; args: unknown },
  cfg: GuardConfig,
  now = Date.now(),
): AnalysisResult {
  const findings = [
    ...analyzeRepetition(history, proposed, cfg, now),
    ...analyzeCycles(history, cfg, now),
    ...analyzeNoGain(history, cfg, now),
    ...analyzeChurn(history, cfg, now),
    ...analyzeNoProgress(history, proposed, cfg, now),
    ...analyzeNearRepeat(history, cfg, now),
  ];
  const rank = { block: 0, warn: 1 } as const;
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { findings: findings.slice(0, 2) };
}

export { fmtEvidence, fingerprint };
