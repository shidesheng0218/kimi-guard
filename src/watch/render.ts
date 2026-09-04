import type { BlockRow } from "../store.js";
import type { BudgetSnapshot } from "../meter.js";

/**
 * Pure render layer for `agentguard watch`. Everything here is a function of
 * (state, width, height) → string lines; the TUI loop only polls and redraws.
 */

export interface WatchSession {
  session_id: string;
  last_ts: number;
  n: number;
}

export interface WatchState {
  sessions: WatchSession[];
  blocks: BlockRow[];
  budget: BudgetSnapshot;
  now: number;
}

function relAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function bar(percent: number, width = 18): string {
  const filled = Math.round((Math.min(100, percent) / 100) * width);
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}]`;
}

/** Visible-width truncation (no ANSI codes inside — the render layer is plain text). */
function cut(s: string, width: number): string {
  return s.length > width ? s.slice(0, Math.max(0, width - 1)) + "…" : s;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

export function renderDashboard(state: WatchState, width: number, height: number): string[] {
  const W = Math.max(40, width);
  const lines: string[] = [];
  const rule = "─".repeat(W);

  lines.push(` 🛡️  agent-guard watch    ${new Date(state.now).toISOString().slice(11, 19)}    q=quit`);
  lines.push(rule);

  // Budget panel
  const b = state.budget;
  if (b.enabled) {
    lines.push(` BUDGET  5h     ${bar(b.fiveHour.percent)} ${String(b.fiveHour.percent).padStart(3)}%  (${b.fiveHour.used}/${b.fiveHour.limit})`);
    lines.push(`         weekly ${bar(b.weekly.percent)} ${String(b.weekly.percent).padStart(3)}%  (${b.weekly.used}/${b.weekly.limit})   burn ${b.turnsLastHour} req + ${b.subagentsLastHour} sub/h`);
  } else {
    lines.push(" BUDGET  disabled");
  }
  lines.push(rule);

  // Sessions panel
  lines.push(` SESSIONS (${state.sessions.length})`);
  const sessionRows = Math.max(1, Math.floor((height - lines.length - 10) / 2));
  if (state.sessions.length === 0) {
    lines.push("   (no sessions recorded yet — the guard sees nothing until an agent runs)");
  }
  for (const s of state.sessions.slice(0, sessionRows)) {
    const hot = state.blocks.some((bk) => bk.session_id === s.session_id);
    const marker = hot ? "🔴" : "  ";
    lines.push(cut(` ${marker} ${s.session_id.slice(0, 24).padEnd(24)}  calls=${String(s.n).padStart(4)}  last=${relAge(s.last_ts, state.now)}`, W - 1));
  }
  lines.push(rule);

  // Interventions panel
  lines.push(` INTERVENTIONS (${state.blocks.length})`);
  const remain = height - lines.length - 1;
  if (state.blocks.length === 0) {
    lines.push("   (no interventions — agents are behaving)");
  }
  for (const blk of state.blocks.slice(0, Math.max(1, remain))) {
    const t = new Date(blk.ts).toISOString().slice(11, 19);
    const fb = blk.feedback === "fp" ? " [fp]" : blk.feedback === "tp" ? " [ok]" : "";
    lines.push(cut(`  ${t}  ${blk.kind.padEnd(12)} ${blk.tool_name.padEnd(12)} ${blk.session_id.slice(0, 12)}${fb}`, W - 1));
  }

  const out = lines.map((l) => pad(cut(l, W), W)).slice(0, height);
  while (out.length < height) out.push(" ".repeat(W)); // pad to full height so stale rows get cleared
  return out;
}
