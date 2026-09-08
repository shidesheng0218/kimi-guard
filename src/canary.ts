import path from "node:path";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { purgeSession } from "./store.js";
import type { HarnessName } from "./toolsets.js";

/**
 * Proof-of-life: fire synthetic repeated calls through the REAL hook pipeline
 * (the same binary the agent CLI invokes) and show the 4th being blocked.
 * Canary traffic is purged afterwards so intervention stats stay honest.
 */

export interface CanaryResult {
  live: boolean;
  lines: string[];
}

export function runCanary(harness: HarnessName = "kimi"): CanaryResult {
  const session = `canary-${Date.now()}`;
  const payload = JSON.stringify({ session_id: session, tool_name: "Grep", tool_input: { pattern: "canary-signal" } });
  const script = path.resolve(process.argv[1]!);
  const repoRoot = path.dirname(path.dirname(script));
  const hookArgs = script.endsWith(".ts") ? [path.join(repoRoot, "node_modules", ".bin", "tsx"), script] : [script];
  const fire = (event: string) =>
    spawnSync(process.execPath, [...hookArgs, "hook", event, "--harness", harness], { input: payload, encoding: "utf8", timeout: 15000, cwd: repoRoot });

  const lines: string[] = [`canary: firing 3 identical PostToolUse + 1 PreToolUse through the real hook path (${session})…`];
  try {
    for (let i = 1; i <= 3; i++) {
      const r = fire("PostToolUse");
      if (r.status !== 0) {
        lines.push(`✗ PostToolUse #${i} exited ${r.status} — hook pipeline is unhealthy; run: agentguard doctor`);
        return { live: false, lines };
      }
      lines.push(`  PostToolUse #${i} → exit 0`);
    }
    const pre = fire("PreToolUse");
    if (pre.status === 2) {
      lines.push(`✓ guard is LIVE — the 4th identical call was blocked (exit 2)`);
      lines.push(`  ${pc.dim((pre.stderr ?? "").split("\n")[0] ?? "")}`);
      return { live: true, lines };
    }
    lines.push(`✗ expected a block (exit 2), got exit ${pre.status ?? "?"} — hooks may not be wired correctly; run: agentguard doctor`);
    return { live: false, lines };
  } finally {
    purgeSession(session);
  }
}
