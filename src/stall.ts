/**
 * Stall detection — the one failure mode a hook-driven guard is blind to.
 * A stalled agent (hung API call, silent wedge, reasoning dead loop with no
 * tool calls) produces NO events, so every detector that analyzes tool calls
 * never sees it. This module is the watchdog for silence itself.
 *
 * Two shapes:
 * - createStallWatch: real-time, for the long-running supervised drivers
 *   (wire / claude / codex). Alerts when no event has arrived for `minutes`
 *   AND no tool call is in flight — a 30-minute build is not a stall, ten
 *   silent minutes between tool calls is. One alert per stall, re-arms when
 *   activity resumes. Alert-only: it never touches the agent process.
 * - stallGapAlert (in guard.ts): the hook-path backstop. Hooks only fire on
 *   agent activity, so real-time detection is impossible there — instead the
 *   FIRST event after a mid-turn silence reports the stall that just ended.
 */

export interface StallWatchOptions {
  minutes: number;
  /** a tool call is in flight — silence while busy is normal, not a stall */
  isBusy?: () => boolean;
  onStall: (idleMinutes: number) => void;
  checkEveryMs?: number;
  /** clock injection for tests */
  now?: () => number;
}

export interface StallWatch {
  /** call on every observed event — resets the idle clock and re-arms */
  ping(): void;
  /** force a check (tests) */
  check(): void;
  stop(): void;
}

export function createStallWatch(opts: StallWatchOptions): StallWatch {
  const now = opts.now ?? (() => Date.now());
  const thresholdMs = Math.max(0.001, opts.minutes) * 60_000;
  let lastActivity = now();
  let alerted = false;

  const check = (): void => {
    if (alerted) return;
    if (opts.isBusy?.()) return;
    const idleMs = now() - lastActivity;
    if (idleMs >= thresholdMs) {
      alerted = true;
      try {
        opts.onStall(idleMs / 60_000);
      } catch {
        /* notifications never break the guard */
      }
    }
  };

  const timer = setInterval(check, opts.checkEveryMs ?? 30_000);
  timer.unref();

  return {
    ping() {
      lastActivity = now();
      alerted = false;
    },
    check,
    stop() {
      clearInterval(timer);
    },
  };
}

/**
 * Hook events after which a long silence means the MODEL/harness side went
 * quiet mid-turn (hung generation, dead stream). Silence after the other
 * events is normal: Stop/SessionEnd/Interrupt hand control back to the user,
 * and PreToolUse means a tool is running (builds legitimately take ages).
 */
export const STALL_SUSPICIOUS_AFTER: ReadonlySet<string> = new Set([
  "PostToolUse",
  "PostToolUseFailure",
  "TurnStarted",
  "UserPromptSubmit",
  "SubagentStart",
  "PostCompact",
]);
