import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { recordCall, recordEvent, recordBlock, countBlocks, callsSince } from "../store.js";
import { analyzeCall } from "../analysis.js";
import { fingerprint, outputSampleOf, hashOutput } from "../events.js";
import { loadConfig, type GuardConfig } from "../config.js";
import { captureCheckpoint } from "../checkpoint.js";
import { guardHome } from "../paths.js";
import { notifyDesktop } from "../notify.js";
import type { RunReport } from "../wire/supervisor.js";

export interface CodexRunOptions {
  prompt: string;
  command?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxSteps: number;
  maxMinutes: number;
  approval: "reject" | "approve";
  config?: GuardConfig;
  json: boolean;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    status?: string;
    changes?: Array<{ path?: string }>;
    server?: string;
    tool?: string;
    arguments?: unknown;
    text?: string;
  };
  usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number };
  error?: { message?: string };
}

/** Map codex item types to our tool taxonomy. */
function toolNameFor(item: CodexEvent["item"]): { tool: string; args: unknown } | null {
  if (!item?.type) return null;
  if (item.type === "command_execution") return { tool: "Bash", args: { command: item.command ?? "" } };
  if (item.type === "file_change") {
    const first = item.changes?.[0];
    return { tool: "apply_patch", args: { path: first?.path ?? "" } };
  }
  if (item.type === "mcp_tool_call") return { tool: item.tool ?? "mcp", args: item.arguments ?? {} };
  if (item.type === "web_search") return { tool: "WebSearch", args: {} };
  return null;
}

/**
 * Supervised headless run for Codex CLI (`codex exec --json`).
 * Read-only stream (like Claude): observation + caps + kill-switch backstop;
 * hard blocking comes from the installed hooks.
 */
export async function runCodexSupervised(opts: CodexRunOptions): Promise<RunReport> {
  const cfg = opts.config ?? loadConfig(undefined, "codex");
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const logDir = path.join(guardHome(), "runs", runId);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "stream.jsonl");

  const startedAt = Date.now();
  const report: RunReport = {
    runId,
    command: [...(opts.command ?? ["codex"]), "exec", "--json", "<prompt>"],
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

  let threadId = "";
  let finalText = "";
  const sid = () => threadId || runId;
  const bin = (opts.command ?? ["codex"])[0]!;
  const binArgs = (opts.command ?? ["codex"]).slice(1);

  const appendLog = (line: string): void => {
    try {
      fs.appendFileSync(logPath, line + "\n");
    } catch {
      /* best effort */
    }
  };

  await new Promise<void>((resolve) => {
    const args = [
      ...binArgs,
      "exec",
      "--json",
      "--skip-git-repo-check",
      opts.approval === "approve" ? "--dangerously-bypass-approvals-and-sandbox" : "--full-auto",
      opts.prompt,
    ];
    const child = spawn(bin, args, { cwd: opts.cwd, env: { ...process.env, ...opts.env } });
    const rl = readline.createInterface({ input: child.stdout! });

    const killTimer = setTimeout(() => {
      report.endReason = "timeout";
      child.kill("SIGINT");
      setTimeout(() => child.kill("SIGKILL"), 5000).unref();
    }, opts.maxMinutes * 60_000);
    killTimer.unref();

    rl.on("line", (line) => {
      appendLog(line);
      let ev: CodexEvent;
      try {
        ev = JSON.parse(line) as CodexEvent;
      } catch {
        return;
      }
      if (ev.type === "thread.started" && ev.thread_id) {
        threadId = ev.thread_id;
        recordEvent(runId, "run_start", { prompt: opts.prompt.slice(0, 200), harness: "codex" });
        return;
      }
      if (ev.type === "turn.started") {
        report.turns++;
        recordEvent(sid(), "turn", { wire: true });
        return;
      }
      if (ev.type === "turn.completed" && ev.usage) {
        report.tokenUsage.input_other += ev.usage.input_tokens ?? 0;
        report.tokenUsage.output += ev.usage.output_tokens ?? 0;
        report.tokenUsage.input_cache_read += ev.usage.cached_input_tokens ?? 0;
        return;
      }
      if (ev.type === "item.completed" && ev.item) {
        if (ev.item.type === "agent_message" && ev.item.text) {
          finalText = ev.item.text;
          return;
        }
        const mapped = toolNameFor(ev.item);
        if (!mapped) return;
        report.toolCalls++;
        report.steps++;
        recordCall({
          sessionId: sid(),
          toolName: mapped.tool,
          argsHash: fingerprint(mapped.tool, mapped.args),
          argsJson: JSON.stringify(mapped.args ?? {}).slice(0, 2048),
          outputHash: hashOutput(ev.item.aggregated_output ?? ev.item.text ?? null),
          outputSample: outputSampleOf(ev.item.aggregated_output ?? ev.item.text ?? null),
          filePath: typeof (mapped.args as Record<string, unknown>)?.["path"] === "string" ? ((mapped.args as Record<string, string>)["path"] as string) : null,
          status: ev.item.exit_code !== undefined && ev.item.exit_code !== 0 ? "failure" : ev.item.status === "failed" ? "failure" : "ok",
        });
        // kill-switch backstop (same as claude driver)
        const since = Date.now() - 30 * 60_000;
        const analysis = analyzeCall(callsSince(sid(), since), { tool: mapped.tool, argsHash: fingerprint(mapped.tool, mapped.args), args: mapped.args }, cfg);
        const block = analysis.findings.find((f) => f.severity === "block");
        if (block) {
          recordBlock(sid(), mapped.tool, block.kind, Date.now(), `[agent-guard] Blocked (${block.kind}): ${block.message}`);
          report.blocks.push({ tool: mapped.tool, kind: block.kind, message: block.message, ts: Date.now() });
          if (cfg.notify.enabled && cfg.notify.onBlock) notifyDesktop("🛡️ agent-guard", `blocked ${block.kind} on ${mapped.tool}`);
        }
        const blocksInSession = countBlocks(sid(), startedAt - cfg.policy.blockWindowMinutes * 60_000);
        if (cfg.policy.killSwitch && blocksInSession >= cfg.policy.maxBlocksPerSession) {
          report.endReason = "kill-switch";
          child.kill("SIGINT");
          setTimeout(() => child.kill("SIGKILL"), 3000).unref();
        }
        return;
      }
      if (ev.type === "turn.failed" || ev.type === "error") {
        report.stepRetries.push({ n: 0, error_type: ev.error?.message ?? "turn_failed", status_code: null });
      }
    });

    child.on("error", (err) => {
      report.finalStatus = /ENOENT/.test(err.message) ? `${err.message} — is Codex CLI installed and on PATH?` : err.message;
      report.endReason = "error";
      resolve();
    });
    child.on("close", (code) => {
      clearTimeout(killTimer);
      if (report.finalStatus === "") report.finalStatus = code === 0 ? "finished" : `exit ${code}`;
      if (report.endReason === "finished" && code !== 0) report.endReason = "error";
      resolve();
    });
  });

  if (report.endReason === "kill-switch") captureCheckpoint(sid(), "kill-switch", Date.now(), cfg);
  if (finalText) recordEvent(sid(), "final_text", { chars: finalText.length });
  recordEvent(runId, "run_end", { endReason: report.endReason, blocks: report.blocks.length, harness: "codex" });
  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  try {
    fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  return report;
}
