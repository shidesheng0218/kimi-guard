import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.js";
import { budgetSnapshot } from "./meter.js";
import { buildStatus, listBlocks } from "./store.js";
import { latestSessionId } from "./checkpoint.js";

/**
 * Menu bar integration via the xbar/SwiftBar plugin protocol: a script that
 * prints the menu bar line, a `---` separator, then dropdown menu entries.
 * xbar/SwiftBar polls it on an interval — they are the daemon, we stay one.
 */

export function menubarText(now = Date.now()): string {
  const cfg = loadConfig();
  const s = buildStatus();
  const sid = latestSessionId() ?? "unknown";
  const snap = budgetSnapshot(sid, cfg.budget, now);
  const blocks = listBlocks(1);
  const last = blocks[0];

  const headline = snap.enabled && snap.fiveHour.limit > 0 ? `🛡️ ${snap.fiveHour.percent}%` : "🛡️";
  const lines: string[] = [headline, "---"];
  lines.push(`5h window: ${snap.fiveHour.percent}% (${snap.fiveHour.used}/${snap.fiveHour.limit}) · weekly: ${snap.weekly.percent}% (${snap.weekly.used}/${snap.weekly.limit})`);
  lines.push(`interventions (24h): ${s.blocks24h.reduce((a, b) => a + b.n, 0)}${s.blocks24h.length > 0 ? ` (${s.blocks24h.map((b) => `${b.kind}×${b.n}`).join(", ")})` : ""}`);
  if (last) {
    const mins = Math.max(0, Math.round((now - last.ts) / 60000));
    lines.push(`last block: ${last.kind} on ${last.tool_name}, ${mins < 1 ? "just now" : `${mins}m ago`}`);
  } else {
    lines.push("last block: none");
  }
  lines.push("---");
  lines.push("Full status | shell=agentguard param1=status terminal=true");
  lines.push("Budget | shell=agentguard param1=budget terminal=true");
  lines.push("Watch dashboard | shell=agentguard param1=watch terminal=true");
  return lines.join("\n");
}

const PLUGIN_NAME = "agentguard.1m.sh";

const PLUGIN_SCRIPT = `#!/bin/sh
# agent-guard menu bar plugin (xbar/SwiftBar) — refreshes every minute
exec agentguard menubar
`;

function pluginDirs(): string[] {
  const home = os.homedir();
  return [
    path.join(home, "Library", "Application Support", "xbar", "plugins"),
    path.join(home, "Library", "Application Support", "SwiftBar", "Plugins"),
  ];
}

export function installMenubar(): { installed: string[]; missing: boolean } {
  const dirs = pluginDirs().filter((d) => fs.existsSync(d));
  const installed: string[] = [];
  for (const d of dirs) {
    const target = path.join(d, PLUGIN_NAME);
    fs.writeFileSync(target, PLUGIN_SCRIPT, { mode: 0o755 });
    installed.push(target);
  }
  return { installed, missing: dirs.length === 0 };
}
