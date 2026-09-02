import { readStdinJson, processHookEvent } from "./guard.js";
import { loadConfig } from "./config.js";
import { refreshPreciseIfStale } from "./precise.js";
import type { HarnessName } from "./toolsets.js";

/**
 * Encode a warn-level context hint for the harness. Kimi appends plain stdout
 * to the model context; Claude Code wants hookSpecificOutput.additionalContext
 * (plain stdout is only context on a few events there).
 */
export function encodeHint(event: string, harness: HarnessName, text: string): string {
  if (harness === "claude") {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  }
  return text;
}

/** Entry point used by the `agentguard hook <event>` CLI command. */
export async function runHook(event: string, harness: HarnessName = "kimi"): Promise<number> {
  const payload = await readStdinJson();
  let outcome;
  try {
    const cfg = loadConfig(undefined, harness);
    // Precise quota metering: refresh the official-API cache right before a
    // dispatch decision. Bounded to 3s, TTL-cached; any failure falls back to
    // event-based estimates.
    if (event === "PreToolUse" && cfg.budget.precise) {
      const tool =
        (typeof payload["tool_name"] === "string" && payload["tool_name"]) ||
        (typeof payload["toolName"] === "string" && payload["toolName"]) ||
        (typeof payload["tool"] === "string" && payload["tool"]) ||
        "";
      if (cfg.budget.dispatchTools.includes(tool)) await refreshPreciseIfStale(cfg.budget);
    }
    outcome = processHookEvent(event, cfg, payload);
  } catch (err) {
    process.stderr.write(`[agent-guard] guard error (fail-open): ${(err as Error).message}\n`);
    return 0;
  }
  if (outcome.stdout) process.stdout.write(encodeHint(event, harness, outcome.stdout) + "\n");
  if (outcome.stderr) process.stderr.write(outcome.stderr + "\n");
  return outcome.code;
}

export { readStdinJson };
