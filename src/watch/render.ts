import type { BlockRow } from "../store.js";
import type { BudgetSnapshot } from "../meter.js";
import { ui, colorBar, label, pct, rule } from "../ui.js";

/**
 * Pure render layer for `agentguard watch`. Everything here is a function of
 * (state, width, height) → string lines; the TUI loop only polls and redraws.
 */

export interface WatchSession {
  session_id: string;
  last_ts: number;
  n: number;
}

export interface SessionDetail {
  sessionId: string;
  calls: Array<{ tool_name: string; ts: number; status: string }>;
}

export interface WatchState {
  sessions: WatchSession[];
  blocks: BlockRow[];
  budget: BudgetSnapshot;
  now: number;
  /** selected session index (highlighted) */
  selected?: number;
  /** expanded session detail, replaces the sessions panel body */
  detail?: SessionDetail;
}

const ANSI = /\x1b\[[0-9;]*m/g;

function vlen(s: string): number {
  return s.replace(ANSI, "").length;
}

/** Truncate to a visible width, preserving ANSI codes. */
function cut(s: string, width: number): string {
  if (vlen(s) <= width) return s;
  const plain = s.replace(ANSI, "");
  return plain.slice(0, Math.max(0, width - 1)) + "…" + "\x1b[0m";
}

function pad(s: string, width: number): string {
  const v = vlen(s);
  return v >= width ? s : s + " ".repeat(width - v);
}

function relAge(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

export function renderDashboard(state: WatchState, width: number, height: number): string[] {
  const W = Math.max(40, width);
  const lines: string[] = [];

  lines.push(
    pad(` ${ui.bold("🛡️  agent-guard")} ${ui.dim("watch")}`, W - 16) +
      ui.dim(`${new Date(state.now).toISOString().slice(11, 19)}  ${state.detail ? "esc=back" : "↑↓=select enter=detail"} q=quit`),
  );
  lines.push(rule(W));

  // Budget panel
  const b = state.budget;
  if (b.enabled) {
    lines.push(` ${label("BUDGET", 9)}${label("5h", 7)}${colorBar(b.fiveHour.percent)} ${pct(b.fiveHour.percent)}  ${ui.dim(`(${b.fiveHour.used}/${b.fiveHour.limit})`)}`);
    lines.push(
      pad(` ${label("", 9)}${label("weekly", 7)}${colorBar(b.weekly.percent)} ${pct(b.weekly.percent)}  ${ui.dim(`(${b.weekly.used}/${b.weekly.limit})`)}`, W - 30) +
        ui.dim(` burn ${b.turnsLastHour} req + ${b.subagentsLastHour} sub/h`),
    );
  } else {
    lines.push(` ${label("BUDGET", 9)}${ui.dim("disabled")}`);
  }
  lines.push(rule(W));

  // Sessions panel
  if (state.detail) {
    lines.push(` ${ui.bold(ui.accent("DETAIL"))} ${ui.dim(`(${state.detail.sessionId}) — esc to go back`)}`);
    for (const c of state.detail.calls.slice(-Math.max(1, height - lines.length - 4))) {
      const t = new Date(c.ts).toISOString().slice(11, 19);
      const st = c.status === "ok" ? ui.ok("ok") : ui.warn(c.status);
      lines.push(cut(`  ${ui.dim(t)}  ${c.tool_name.padEnd(14)} ${st}`, W - 1));
    }
    if (state.detail.calls.length === 0) lines.push(ui.dim("   (no calls recorded for this session)"));
    lines.push(rule(W));
  } else {
    lines.push(` ${ui.bold(ui.accent("SESSIONS"))} ${ui.dim(`(${state.sessions.length})`)}`);
    const sessionRows = Math.max(1, Math.floor((height - lines.length - 10) / 2));
    if (state.sessions.length === 0) {
      lines.push(ui.dim("   (no sessions recorded yet — the guard sees nothing until an agent runs)"));
    }
    for (const [i, s] of state.sessions.slice(0, sessionRows).entries()) {
      const hot = state.blocks.some((bk) => bk.session_id === s.session_id);
      const marker = hot ? "🔴" : "🟢";
      const sel = state.selected === i ? ui.bold(ui.accent("▸")) : " ";
      lines.push(
        cut(
          `${sel}${marker} ${ui.bold(s.session_id.slice(0, 24))}${" ".repeat(Math.max(0, 24 - s.session_id.length))}  ${ui.dim("calls=")}${String(s.n).padStart(4)}  ${ui.dim(`last=${relAge(s.last_ts, state.now)}`)}`,
          W - 1,
        ),
      );
    }
    lines.push(rule(W));
  }

  // Interventions panel
  lines.push(` ${ui.bold(ui.danger("INTERVENTIONS"))} ${ui.dim(`(${state.blocks.length})`)}`);
  const remain = height - lines.length - 1;
  if (state.blocks.length === 0) {
    lines.push(ui.dim("   (no interventions — agents are behaving)"));
  }
  const shown: typeof state.blocks = [];
  let used = 0;
  for (const blk of state.blocks) {
    const cost = blk.reason ? 2 : 1;
    if (used + cost > Math.max(1, remain)) break;
    used += cost;
    shown.push(blk);
  }
  for (const blk of shown) {
    const t = new Date(blk.ts).toISOString().slice(11, 19);
    const fb = blk.feedback === "fp" ? ui.warn(" [fp]") : blk.feedback === "tp" ? ui.ok(" [ok]") : "";
    lines.push(
      cut(`  ${ui.dim(t)}  ${ui.warn(blk.kind.padEnd(12))} ${ui.bold(blk.tool_name.padEnd(12))} ${ui.dim(blk.session_id.slice(0, 12))}${fb}`, W - 1),
    );
    if (blk.reason) {
      lines.push(cut(`     ${ui.dim(blk.reason.replace(/\s+/g, " ").slice(0, W - 10))}`, W - 1));
    }
  }

  const out = lines.map((l) => pad(cut(l, W), W)).slice(0, height);
  while (out.length < height) out.push(" ".repeat(W)); // pad to full height so stale rows get cleared
  return out;
}
