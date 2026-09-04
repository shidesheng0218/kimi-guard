import readline from "node:readline";
import { knownSessions, listBlocks, openDb } from "../store.js";
import { budgetSnapshot } from "../meter.js";
import { latestSessionId } from "../checkpoint.js";
import { loadConfig } from "../config.js";
import { renderDashboard, type WatchState } from "./render.js";

const ALT_SCREEN_ON = "\x1b[?1049h";
const ALT_SCREEN_OFF = "\x1b[?1049l";
const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const HOME = "\x1b[H";

function gather(now = Date.now()): WatchState {
  const cfg = loadConfig();
  const sid = latestSessionId() ?? "unknown";
  return {
    sessions: knownSessions(8),
    blocks: listBlocks(50),
    budget: budgetSnapshot(sid, cfg.budget, now),
    now,
  };
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
      const state = gather();
      for (const line of renderDashboard(state, 100, 40)) console.log(line.trimEnd());
      resolve();
      return;
    }
    openDb();

    let lastFrame = "";
    const draw = (): void => {
      const w = out.columns ?? 100;
      const h = out.rows ?? 40;
      const frame = renderDashboard(gather(), w, h).join("\n");
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
      if (key.name === "q" || (key.ctrl && key.name === "c")) cleanup();
    });
    process.on("SIGINT", cleanup);

    draw();
    const timer = setInterval(draw, intervalMs);
  });
}
