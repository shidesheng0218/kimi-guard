import { spawnSync } from "node:child_process";
import type { GuardConfig } from "./config.js";

/**
 * Notifications, two independent channels, both fire-and-forget:
 * - macOS desktop (osascript) when [notify] enabled = true
 * - webhook POST when [notify] webhookUrl is set
 * Nothing here ever blocks or breaks the guard.
 */

export interface NotifyOptions {
  sound?: boolean;
  /** explicit user request (e.g. `digest --notify`) fires the desktop channel even when [notify] enabled = false */
  forceDesktop?: boolean;
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

export interface WebhookPayload {
  /** human-readable text (Slack-style) */
  text: string;
  /** same as text (Discord-style) */
  content: string;
  event: string;
  kind?: string;
  tool?: string;
  session?: string;
  ts: number;
}

/** POST a JSON payload to the configured webhook. 3s timeout, all failures swallowed. */
export async function postWebhook(url: string, payload: WebhookPayload): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Unified notify: macOS desktop when enabled + webhook when configured.
 * title/body = human text; extra = structured fields for the webhook payload.
 */
export function notify(
  cfg: GuardConfig,
  title: string,
  body: string,
  opts?: NotifyOptions & { event?: string; kind?: string; tool?: string; session?: string },
): void {
  if (cfg.notify.enabled || opts?.forceDesktop) notifyDesktop(title, body, opts);
  const url = cfg.notify.webhookUrl;
  if (url) {
    void postWebhook(url, {
      text: `${title} — ${body}`,
      content: `${title} — ${body}`,
      event: opts?.event ?? "info",
      kind: opts?.kind,
      tool: opts?.tool,
      session: opts?.session,
      ts: Date.now(),
    });
  }
}
