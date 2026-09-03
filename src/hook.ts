import { readStdinJson, processHookEvent } from "./guard.js";
import { loadConfig } from "./config.js";
import { refreshPreciseIfStale } from "./precise.js";
import type { HarnessName } from "./toolsets.js";

/**
 * Encode a warn-level context hint for the harness. Kimi appends plain stdout
 * to the model context; Claude Code wants hookSpecificOutput.additionalContext
 * (plain stdout is only context on a few events there). Gemini mandates JSON
 * stdout ("silence is mandatory") — additionalContext where the event supports
 * it, systemMessage (user-visible) otherwise.
 */
export function encodeHint(event: string, harness: HarnessName, text: string): string {
  if (harness === "gemini") {
    const ctxEvents = new Set(["BeforeAgent", "AfterTool", "SessionStart"]);
    if (ctxEvents.has(event)) {
      return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
    }
    return JSON.stringify({ systemMessage: text });
  }
  if (harness !== "kimi") {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
  }
  return text;
}

/** Gemini event names → our canonical names. */
export const GEMINI_EVENT_MAP: Record<string, string> = {
  BeforeTool: "PreToolUse",
  AfterTool: "PostToolUse",
  BeforeAgent: "UserPromptSubmit",
  AfterAgent: "Stop",
  PreCompress: "PreCompact",
  SessionEnd: "SessionEnd",
};

/** Translate a Gemini hook invocation into our canonical event + payload shape. */
export function translateGeminiEvent(event: string, payload: Record<string, unknown>): { event: string; payload: Record<string, unknown> } {
  let e = GEMINI_EVENT_MAP[event] ?? event;
  if (event === "AfterTool") {
    const tr = payload["tool_response"] as Record<string, unknown> | undefined;
    if (tr && tr["error"]) e = "PostToolUseFailure";
  }
  return { event: e, payload };
}

/** Entry point used by the `agentguard hook <event>` CLI command. */
export async function runHook(eventArg: string, harness: HarnessName = "kimi"): Promise<number> {
  const rawPayload = await readStdinJson();
  // Gemini events arrive under its own names (BeforeTool/AfterTool/...) — translate
  // to our canonical names before the pipeline; encode hints under the original name.
  const { event, payload } = harness === "gemini" ? translateGeminiEvent(eventArg, rawPayload) : { event: eventArg, payload: rawPayload };
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
  if (outcome.stdout) process.stdout.write(encodeHint(eventArg, harness, outcome.stdout) + "\n");
  if (outcome.stderr) process.stderr.write(outcome.stderr + "\n");
  return outcome.code;
}

export { readStdinJson };
