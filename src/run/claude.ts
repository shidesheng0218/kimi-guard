import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { recordCall, recordEvent, recordBlock, countBlocks, callsSince, openDb } from "../store.js";
import { analyzeCall } from "../analysis.js";
import { fingerprint, outputSampleOf, hashOutput, extractFile } from "../events.js";
import { loadConfig, type GuardConfig } from "../config.js";
import { captureCheckpoint } from "../checkpoint.js";
import { findClaims, hasEvidence, WIRE_VERIFY_CORRECTIVE } from "../verify.js";
import { castVetoVote, collectVetoContext } from "../veto.js";
import { claudeHooksInstalled } from "../harness/claude.js";
import { guardHome } from "../paths.js";
import { notifyDesktop } from "../notify.js";
import type { RunReport } from "../wire/supervisor.js";

export interface ClaudeRunOptions {
  prompt: string;
  command?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxSteps: number;
  maxMinutes: number;
  autoResume: number;
  maxVerifyRounds: number;
  /** reject → --permission-mode auto (classifier); approve → bypassPermissions (yolo) */
  approval: "reject" | "approve";
  config?: GuardConfig;
  json: boolean;
}

interface StreamMsg {
  type: string;
  subtype?: string;
  session_id?: string;
  message?: {
    content?: Array<Record<string, unknown>>;
    usage?: Record<string, number>;
  };
  // result fields
  is_error?: boolean;
  num_turns?: number;
  duration_ms?: number;
  total_cost_usd?: number;
  result?: string;
  usage?: Record<string, number>;
  terminal_reason?: string;
  api_error_status?: number | null;
}

interface PendingCall {
  name: string;
  input: unknown;
}

/**
 * Supervised headless run for Claude Code (`claude -p --output-format
 * stream-json`). The stream is read-only — hard blocking still happens in the
 * installed hooks (same state.db, so blocks are visible here for the kill
 * switch). The driver adds: caps (--max-turns + wall clock), kill switch
 * (SIGINT→SIGKILL) as a backstop when hooks are absent, verify rounds and
 * auto-resume via --resume, and exact token metering from result.usage.
 */
export async function runClaudeSupervised(opts: ClaudeRunOptions): Promise<RunReport> {
  const cfg = opts.config ?? loadConfig(undefined, "claude");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const logDir = path.join(guardHome(), "runs", runId);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "stream.jsonl");

  const startedAt = Date.now();
  const report: RunReport = {
    runId,
    command: [...(opts.command ?? ["claude"]), "-p", "<prompt>", "--output-format", "stream-json"],
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: "",
    durationMs: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    stepRetries: [],
    blocks: [],
    steers: [],
    approvals: { approved: 0, rejected: 0 },
    tokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    finalStatus: "",
    endReason: "finished",
    resumes: 0,
    verifyRounds: 0,
    vetoes: 0,
    thinkingDominance: 0,
    reportPath: path.join(logDir, "report.json"),
    logPath,
  };

  const bin = (opts.command ?? ["claude"])[0]!;
  const binArgs = (opts.command ?? ["claude"]).slice(1);
  const permissionMode = opts.approval === "approve" ? "bypassPermissions" : "auto";
  const hooksLive = claudeHooksInstalled();

  let sessionId = "";
  let attempt = 0;
  let currentPrompt = opts.prompt;
  let timedOut = false;

  const sid = () => sessionId || runId;

  function appendLog(line: string): void {
    try {
      fs.appendFileSync(logPath, line + "\n");
    } catch {
      /* best effort */
    }
  }

  function onToolResult(call: PendingCall, outputText: string, isError: boolean): void {
    report.toolCalls++;
    recordCall({
      sessionId: sid(),
      toolName: call.name,
      argsHash: fingerprint(call.name, call.input),
      argsJson: JSON.stringify(call.input ?? {}).slice(0, 2048),
      outputHash: hashOutput(outputText),
      outputSample: outputSampleOf(outputText),
      filePath: extractFile(call.input),
      status: isError ? "failure" : "ok",
    });

    // Backstop analysis: if hooks aren't installed, nothing else is watching.
    // A block-level finding here can't cancel the call (it already ran), but
    // repeated ones mean the model is ignoring corrections → kill switch.
    if (!hooksLive) {
      const since = Date.now() - 30 * 60_000;
      const analysis = analyzeCall(callsSince(sid(), since), { tool: call.name, argsHash: fingerprint(call.name, call.input), args: call.input }, cfg);
      const block = analysis.findings.find((f) => f.severity === "block");
      if (block) {
        recordBlock(sid(), call.name, block.kind);
        report.blocks.push({ tool: call.name, kind: block.kind, message: block.message, ts: Date.now() });
        if (cfg.notify.enabled && cfg.notify.onBlock) {
          notifyDesktop("🛡️ agent-guard", `blocked ${block.kind} on ${call.name}`);
        }
      }
    }
  }

  function runOnce(prompt: string): Promise<StreamMsg | null> {
    return new Promise((resolve) => {
      const pending = new Map<string, PendingCall>();
      const args = [
        ...binArgs,
        "-p",
        prompt,
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        String(opts.maxSteps),
        "--permission-mode",
        permissionMode,
      ];
      if (attempt > 1 && sessionId) args.push("--resume", sessionId);

      const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
      const rl = readline.createInterface({ input: child.stdout! });
      let result: StreamMsg | null = null;
      let sawInit = false;

      const killTimer = setTimeout(() => {
        timedOut = true;
        report.endReason = "timeout";
        child.kill("SIGINT"); // lets Claude finish the current turn and record a result
        setTimeout(() => child.kill("SIGKILL"), 5000).unref();
      }, opts.maxMinutes * 60_000);
      killTimer.unref();

      rl.on("line", (line) => {
        appendLog(line);
        let msg: StreamMsg;
        try {
          msg = JSON.parse(line) as StreamMsg;
        } catch {
          return;
        }
        switch (msg.type) {
          case "system":
            if (msg.subtype === "init" && msg.session_id) {
              sessionId = msg.session_id;
              if (!sawInit) recordEvent(runId, "run_start", { prompt: opts.prompt.slice(0, 200), harness: "claude" });
              sawInit = true;
            }
            break;
          case "assistant": {
            report.steps++;
            for (const block of msg.message?.content ?? []) {
              if (block["type"] === "tool_use") {
                pending.set(String(block["id"]), { name: String(block["name"]), input: block["input"] });
              }
            }
            break;
          }
          case "user": {
            for (const block of msg.message?.content ?? []) {
              if (block["type"] === "tool_result") {
                const call = pending.get(String(block["tool_use_id"]));
                const content = block["content"];
                const text =
                  typeof content === "string"
                    ? content
                    : Array.isArray(content)
                      ? content.map((c) => (c && typeof c === "object" ? String((c as Record<string, unknown>)["text"] ?? "") : "")).join("\n")
                      : JSON.stringify(content ?? "");
                if (call) {
                  pending.delete(String(block["tool_use_id"]));
                  onToolResult(call, text, Boolean(block["is_error"]));
                }
              }
            }
            break;
          }
          case "result": {
            result = msg;
            report.turns += msg.num_turns ?? 0;
            if (msg.usage) {
              report.tokenUsage.input_other += msg.usage["input_tokens"] ?? 0;
              report.tokenUsage.output += msg.usage["output_tokens"] ?? 0;
              report.tokenUsage.input_cache_read += msg.usage["cache_read_input_tokens"] ?? 0;
              report.tokenUsage.input_cache_creation += msg.usage["cache_creation_input_tokens"] ?? 0;
            }
            if (typeof msg.total_cost_usd === "number") recordEvent(sid(), "cost", { usd: msg.total_cost_usd });
            if (msg.api_error_status) report.stepRetries.push({ n: 0, error_type: "api_error", status_code: msg.api_error_status });
            break;
          }
          default:
            break;
        }
      });

      // kill switch: hooks record blocks into the same db; poll on a slow cadence
      const killWatch = setInterval(() => {
        const n = countBlocks(sid(), startedAt - cfg.policy.blockWindowMinutes * 60_000);
        if (cfg.policy.killSwitch && n >= cfg.policy.maxBlocksPerSession) {
          report.endReason = "kill-switch";
          child.kill("SIGINT");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
          clearInterval(killWatch);
        }
      }, 1000);
      killWatch.unref();

      child.on("error", (err) => {
        report.finalStatus = /ENOENT/.test(err.message) ? `${err.message} — is Claude Code installed and on PATH?` : err.message;
        resolve(null);
      });
      child.on("close", () => {
        clearTimeout(killTimer);
        clearInterval(killWatch);
        resolve(result);
      });
    });
  }

  openDb();
  while (true) {
    attempt++;
    const result = await runOnce(currentPrompt);
    if (!result) {
      if (report.finalStatus === "") report.finalStatus = "no result (process ended without a result message)";
      if (report.endReason === "finished") report.endReason = timedOut ? "timeout" : "error";
      break;
    }
    report.finalStatus = `${result.subtype ?? "?"}${result.is_error ? " (is_error)" : ""}`;

    const maxTurnsHit = result.subtype === "error_max_turns";
    if (maxTurnsHit && attempt <= opts.autoResume) {
      report.resumes++;
      report.endReason = "max_steps";
      const brief = captureCheckpoint(sid(), "auto-resume", Date.now(), cfg);
      currentPrompt =
        (brief ? `You were stopped at the turn limit. Observed state so far:\n\n${brief.brief}\n\n` : "") +
        "You reached the turn limit. Continue from where you stopped — do not repeat work already done.";
      continue;
    }

    if (!result.is_error && result.subtype === "success") {
      const text = result.result ?? "";
      if (cfg.verify.enabled && report.verifyRounds < opts.maxVerifyRounds) {
        const claims = findClaims(text, cfg);
        if (claims.length > 0 && !hasEvidence(sid(), cfg)) {
          if (cfg.verify.veto.enabled) {
            const vote = await castVetoVote({ ...collectVetoContext(sid(), cfg), claims, goal: opts.prompt }, cfg.verify.veto, { ...process.env, ...opts.env });
            if (vote.vetoed) {
              report.vetoes++;
              recordEvent(sid(), "veto", { claims: claims.length });
              break;
            }
          }
          report.verifyRounds++;
          report.endReason = "verify";
          recordEvent(sid(), "verify_gate", { claims: claims.length });
          captureCheckpoint(sid(), "verify-gate", Date.now(), cfg);
          currentPrompt = WIRE_VERIFY_CORRECTIVE;
          continue;
        }
      }
      if (report.endReason === "verify") report.endReason = "finished";
      break;
    }
    if (report.endReason === "finished" || report.endReason === "verify") report.endReason = result.is_error ? "error" : "finished";
    break;
  }

  if (report.endReason === "kill-switch") captureCheckpoint(sid(), "kill-switch", Date.now(), cfg);

  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  recordEvent(runId, "run_end", { endReason: report.endReason, blocks: report.blocks.length, harness: "claude" });
  try {
    fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  return report;
}
