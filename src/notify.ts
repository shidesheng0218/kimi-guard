import { spawnSync } from "node:child_process";

/**
 * macOS desktop notifications via osascript — fire-and-forget, no daemon,
 * never blocks the guard (any failure is silently ignored).
 */

export interface NotifyOptions {
  sound?: boolean;
}

/** Build the AppleScript (exported for tests). */
export function buildNotifyScript(title: string, body: string, opts?: NotifyOptions): string {
  const esc = (s: string): string => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `display notification "${esc(body.slice(0, 200))}" with title "${esc(title.slice(0, 80))}"${opts?.sound ? ' sound name "Glass"' : ""}`;
}

export function notifyDesktop(title: string, body: string, opts?: NotifyOptions): void {
  if (process.platform !== "darwin") return;
  try {
    spawnSync("osascript", ["-e", buildNotifyScript(title, body, opts)], { stdio: "ignore", timeout: 5000 });
  } catch {
    /* fire-and-forget */
  }
}
