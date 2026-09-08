import readline from "node:readline";
import { knownSessions, listBlocks, callsSince, openDb } from "../store.js";
import { budgetSnapshot } from "../meter.js";
import { latestSessionId } from "../checkpoint.js";
import { loadConfig } from "../config.js";
import { renderDashboard, type WatchState } from "./render.js";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";

function gather(now: number, selected: number, detailMode: boolean): WatchState {
  const cfg = loadConfig();
  const sid = latestSessionId() ?? "unknown";
  const sessions = knownSessions(8);
  const state: WatchState = {
    sessions,
    blocks: listBlocks(50),
    budget: budgetSnapshot(sid, cfg.budget, now),
    now,
    selected: detailMode ? undefined : selected,
  };
  if (detailMode && sessions[selected]) {
    const id = sessions[selected]!.session_id;
    state.detail = {
      sessionId: id,
      calls: callsSince(id, now - 86_400_000, 8).slice(-8).map((c) => ({ tool_name: c.tool_name, ts: c.ts, status: c.status })),
    };
  }
  return state;
}

/**
 * Full-screen live dashboard. Polls the local SQLite state and redraws only
 * when the rendered frame changes. No deps — raw ANSI on the alternate screen.
 */
export function watch(intervalMs = 500): Promise<void> {
  return new Promise((resolve) => {
    const out = process.stdout;
    if (!out.isTTY) {
      // non-tty: print one frame and exit (CI/pipe-friendly)
      const state = gather(Date.now(), 0, false);
      for (const line of renderDashboard(state, 100, 40)) console.log(line.trimEnd());
      resolve();
      return;
    }
    openDb();

    let selected = 0;
    let detailMode = false;
    let lastFrame = "";
    const draw = (): void => {
      const w = out.columns ?? 100;
      const h = out.rows ?? 40;
      const frame = renderDashboard(gather(Date.now(), selected, detailMode), w, h).join("\n");
      if (frame === lastFrame) return;
      lastFrame = frame;
      out.write(HOME + frame);
    };

    const cleanup = (): void => {
      clearInterval(timer);
      out.write(SHOW_CURSOR + ALT_SCREEN_OFF);
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve();
    };

    out.write(ALT_SCREEN_ON + HIDE_CURSOR + HOME);
    readline.emitKeypressEvents(process.stdin);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", (_s, key: { name?: string; ctrl?: boolean }) => {
      if (key.name === "q" || (key.ctrl && key.name === "c")) {
        cleanup();
        return;
      }
      const sessions = knownSessions(8).length;
      if (key.name === "escape" && detailMode) {
        detailMode = false;
      } else if (key.name === "return" && sessions > 0) {
        detailMode = !detailMode;
      } else if (key.name === "up" && !detailMode) {
        selected = Math.max(0, selected - 1);
      } else if (key.name === "down" && !detailMode) {
        selected = Math.min(Math.max(0, sessions - 1), selected + 1);
      }
      lastFrame = ""; // force redraw on interaction
    });
    process.on("SIGINT", cleanup);

    draw();
    const timer = setInterval(draw, intervalMs);
  });
}
