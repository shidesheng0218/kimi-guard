import fs from "node:fs";
import path from "node:path";
import { WireClient } from "./client.js";
import type { TokenUsage, ToolCallPayload, ToolResultPayload, StatusUpdatePayload, StepBeginPayload, StepRetryPayload, HookRequestPayload, HookResponse, ApprovalRequestPayload, SubagentEventPayload } from "./protocol.js";
import { hashOutput, fingerprint } from "../events.js";
import type { HookPayload } from "../events.js";
import { recordCall, recordEvent, recordBlock, callsSince, countBlocks, openDb } from "../store.js";
import { analyzeCall } from "../analysis.js";
import { loadConfig, type GuardConfig } from "../config.js";
import { evaluateBudgetGate } from "../meter.js";
import { captureCheckpoint } from "../checkpoint.js";
import { guardHome } from "../paths.js";
import { findClaims, hasEvidence, WIRE_VERIFY_CORRECTIVE } from "../verify.js";
import { castVetoVote, collectVetoContext } from "../veto.js";

export interface RunOptions {
  prompt: string;
  command?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  maxSteps: number;
  maxMinutes: number;
  /** soft, mid-turn corrections via `steer` on warn-level findings */
  steerOnWarn: boolean;
  maxSteers: number;
  /** re-prompt after max_steps_reached / kill-switch, injecting the checkpoint brief */
  autoResume: number;
  /** extra verification rounds when the final message makes unbacked completion claims */
  maxVerifyRounds: number;
  approval: "reject" | "approve";
  config?: GuardConfig;
  json: boolean;
}

export interface BlockRecord {
  tool: string;
  kind: string;
  message: string;
  ts: number;
}

export interface SteerRecord {
  kind: string;
  message: string;
  ts: number;
}

export interface RunReport {
  runId: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  turns: number;
  steps: number;
  toolCalls: number;
  stepRetries: Array<{ n: number; error_type: string; status_code: number | null }>;
  blocks: BlockRecord[];
  steers: SteerRecord[];
  approvals: { approved: number; rejected: number };
  tokenUsage: Required<TokenUsage>;
  finalStatus: string;
  endReason: "finished" | "max_steps" | "timeout" | "kill-switch" | "verify" | "error";
  resumes: number;
  verifyRounds: number;
  vetoes: number;
  thinkingDominance: number;
  reportPath: string;
  logPath: string;
}

const zeroUsage = (): Required<TokenUsage> => ({ input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 });

function addUsage(acc: Required<TokenUsage>, u: TokenUsage): void {
  acc.input_other += u.input_other ?? 0;
  acc.output += u.output ?? 0;
  acc.input_cache_read += u.input_cache_read ?? 0;
  acc.input_cache_creation += u.input_cache_creation ?? 0;
}

export async function runSupervised(opts: RunOptions): Promise<RunReport> {
  const cfg = opts.config ?? loadConfig();
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  const logDir = path.join(guardHome(), "runs", runId);
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, "wire.jsonl");
  const rawLog = (direction: "in" | "out", line: string): void => {
    try {
      fs.appendFileSync(logPath, JSON.stringify({ dir: direction, ts: Date.now(), line }) + "\n");
    } catch {
      /* best effort */
    }
  };

  const startedAt = Date.now();
  const report: RunReport = {
    runId,
    command: opts.command ?? ["kimi", "--wire"],
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
    tokenUsage: zeroUsage(),
    finalStatus: "",
    endReason: "finished",
    resumes: 0,
    verifyRounds: 0,
    vetoes: 0,
    thinkingDominance: 0,
    reportPath: path.join(logDir, "report.json"),
    logPath,
  };

  let steersSent = 0;
  let cancelled = false;
  const pendingToolCalls = new Map<string, { name: string; args: unknown }>();
  /** subagents seen so far — first sight ≈ one dispatch for budget accounting */
  const seenSubagents = new Set<string>();
  const hintedPatterns = new Set<string>();
  const anchoredSteps = new Set<number>();
  let killSwitchArmed = false;
  let timeoutTimer: NodeJS.Timeout | null = null;
  let turnThinkChars = 0;
  let turnTextChars = 0;
  let turnText = "";

  const client = new WireClient({
    command: opts.command,
    cwd: opts.cwd,
    env: opts.env,
    onRawLine: rawLog,
    hooks: [{ id: "kguard", event: "PreToolUse", matcher: "", timeout: 10 }],
    onEvent: (type, payload) => {
      void handleEvent(type, payload);
    },
    onRequest: (type, payload) => handleRequest(type, payload),
  });

  function sessionId(): string {
    return runId;
  }

  async function steerOnce(kind: string, message: string): Promise<void> {
    if (!opts.steerOnWarn || steersSent >= opts.maxSteers) return;
    steersSent++;
    report.steers.push({ kind, message, ts: Date.now() });
    try {
      await client.steer(`[kimi-guard] ${message}`);
    } catch {
      /* no turn in progress or steer unsupported — advisory only */
    }
  }

  function anchorText(): string {
    const goal = opts.prompt.slice(0, cfg.anchor.maxChars);
    return (
      `goal anchor: the user's task for this run, verbatim: "${goal}". ` +
      `Re-evaluate: does the current work still serve this goal? If you have drifted, get back on ` +
      `target; if the goal is already met, stop and summarize.`
    );
  }

  async function handleEvent(type: string, payload: Record<string, unknown>): Promise<void> {
    switch (type) {
      case "SubagentEvent": {
        handleSubagentEvent(payload as unknown as SubagentEventPayload);
        break;
      }
      case "StepBegin": {
        const p = payload as unknown as StepBeginPayload;
        report.steps = p.n;
        recordEvent(sessionId(), "step", { n: p.n });
        if (cfg.anchor.enabled && opts.steerOnWarn && p.n > 1 && p.n % cfg.anchor.everyNPrompts === 0 && !anchoredSteps.has(p.n)) {
          anchoredSteps.add(p.n);
          await steerOnce("anchor", anchorText());
        }
        if (p.n > opts.maxSteps && !cancelled) {
          cancelled = true;
          report.endReason = "max_steps";
          void client.cancel().catch(() => {});
        }
        break;
      }
      case "CompactionEnd": {
        recordEvent(sessionId(), "compaction", { phase: "wire" });
        if (cfg.anchor.enabled && opts.steerOnWarn) {
          await steerOnce("anchor", `context was just compacted. ${anchorText()}`);
        }
        break;
      }
      case "StepRetry": {
        const p = payload as unknown as StepRetryPayload;
        report.stepRetries.push({ n: p.n, error_type: p.error_type, status_code: p.status_code ?? null });
        recordEvent(sessionId(), "step_retry", { error_type: p.error_type, status_code: p.status_code ?? null });
        break;
      }
      case "ContentPart": {
        const part = payload as { type?: string; text?: string; think?: string };
        if (part.type === "think" && part.think) turnThinkChars += part.think.length;
        if (part.type === "text" && part.text) {
          turnTextChars += part.text.length;
          turnText = (turnText + part.text).slice(-16_000);
        }
        break;
      }
      case "TurnBegin": {
        turnThinkChars = 0;
        turnTextChars = 0;
        turnText = "";
        // budget accounting: a turn ≈ 1 request, same as TurnStarted in hooks mode
        recordEvent(sessionId(), "turn", { wire: true });
        break;
      }
      case "TurnEnd": {
        if (cfg.thinking.enabled && turnThinkChars >= cfg.thinking.minThinkChars && turnTextChars / (turnThinkChars + turnTextChars) <= cfg.thinking.maxTextRatio) {
          report.thinkingDominance++;
          recordEvent(sessionId(), "thinking_dominance", { think_chars: turnThinkChars, text_chars: turnTextChars });
        }
        break;
      }
      case "StatusUpdate": {
        const p = payload as unknown as StatusUpdatePayload;
        if (p.token_usage) addUsage(report.tokenUsage, p.token_usage);
        if (cfg.context.enabled && typeof p.context_usage === "number" && p.context_usage * 100 >= cfg.context.warnPercent && !hintedPatterns.has("context-fill")) {
          hintedPatterns.add("context-fill");
          await steerOnce(
            "context",
            `context window is ${Math.round(p.context_usage * 100)}% full. Wrap up the current unit of work, ` +
              `summarize what you have learned, and avoid starting large new explorations — compaction is imminent.`,
          );
        }
        break;
      }
      case "ToolCall": {
        const p = payload as unknown as ToolCallPayload;
        let args: unknown = {};
        try {
          args = p.function.arguments ? JSON.parse(p.function.arguments) : {};
        } catch {
          args = { _raw: p.function.arguments ?? "" };
        }
        pendingToolCalls.set(`main:${p.id}`, { name: p.function.name, args });
        break;
      }
      case "ToolResult": {
        const p = payload as unknown as ToolResultPayload;
        const call = pendingToolCalls.get(`main:${p.tool_call_id}`);
        if (!call) break;
        pendingToolCalls.delete(`main:${p.tool_call_id}`);
        recordObservedCall(sessionId(), call, p.return_value);
        break;
      }
      default:
        break;
    }
  }

  function handleSubagentEvent(p: SubagentEventPayload): void {
    const agentKey = p.agent_id ?? p.subagent_type ?? "unknown";
    if (!seenSubagents.has(agentKey)) {
      seenSubagents.add(agentKey);
      // budget accounting: wire has no SubagentStart event — the first event
      // from an agent is the dispatch, same as SubagentStart in hooks mode
      recordEvent(sessionId(), "subagent", { agent: agentKey });
    }
    const nested = p.event as { type?: string; payload?: Record<string, unknown> } | undefined;
    if (!nested?.type) return;
    switch (nested.type) {
      case "ToolCall": {
        const tp = nested.payload as unknown as ToolCallPayload;
        let args: unknown = {};
        try {
          args = tp.function.arguments ? JSON.parse(tp.function.arguments) : {};
        } catch {
          args = { _raw: tp.function.arguments ?? "" };
        }
        pendingToolCalls.set(`sub:${agentKey}:${tp.id}`, { name: tp.function.name, args });
        break;
      }
      case "ToolResult": {
        const tp = nested.payload as unknown as ToolResultPayload;
        const call = pendingToolCalls.get(`sub:${agentKey}:${tp.tool_call_id}`);
        if (!call) break;
        pendingToolCalls.delete(`sub:${agentKey}:${tp.tool_call_id}`);
        recordObservedCall(`${sessionId()}|sub|${agentKey}`, call, tp.return_value);
        break;
      }
      case "StatusUpdate": {
        const sp = nested.payload as unknown as StatusUpdatePayload;
        if (sp.token_usage) addUsage(report.tokenUsage, sp.token_usage);
        break;
      }
      case "StepBegin": {
        recordEvent(`${sessionId()}|sub|${agentKey}`, "step", { n: (nested.payload as unknown as StepBeginPayload)?.n });
        break;
      }
      default:
        break;
    }
  }

  function recordObservedCall(
    sessionId: string,
    call: { name: string; args: unknown },
    returnValue: ToolResultPayload["return_value"],
  ): void {
    report.toolCalls++;
    const output =
      typeof returnValue.output === "string" ? returnValue.output : JSON.stringify(returnValue.output);
    recordCall({
      sessionId,
      toolName: call.name,
      argsHash: fingerprint(call.name, call.args),
      argsJson: JSON.stringify(call.args).slice(0, 2048),
      outputHash: hashOutput(output),
      filePath: extractFile(call.args),
      status: returnValue.is_error ? "failure" : "ok",
    });
  }

  async function handleRequest(type: string, payload: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case "HookRequest": {
        const p = payload as unknown as HookRequestPayload;
        return await handleHookRequest(p);
      }
      case "ApprovalRequest": {
        const p = payload as unknown as ApprovalRequestPayload;
        if (opts.approval === "approve") {
          report.approvals.approved++;
          return { request_id: p.id, response: "approve" };
        }
        report.approvals.rejected++;
        return {
          request_id: p.id,
          response: "reject",
          feedback:
            "kimi-guard run: interactive approvals are unavailable in supervised headless mode. Continue with non-interactive steps only, or summarize your findings.",
        };
      }
      case "QuestionRequest": {
        const p = payload as unknown as { id: string };
        return { request_id: p.id, answers: {} };
      }
      default:
        return {};
    }
  }

  async function handleHookRequest(p: HookRequestPayload): Promise<HookResponse> {
    if (killSwitchArmed) {
      return {
        request_id: p.id,
        action: "block",
        reason:
          "[kimi-guard] CIRCUIT BREAK: this session has hit the intervention limit. Stop making tool calls, summarize your findings, and end the turn.",
      };
    }
    if (cancelled) {
      return { request_id: p.id, action: "allow", reason: "" };
    }

    const hookPayload = { ...p.input_data, session_id: sessionId() } as HookPayload;
    const call = hookPayload as { tool_name?: string; tool_input?: unknown };
    const toolName = typeof call.tool_name === "string" ? call.tool_name : p.target;

    const since = Date.now() - 30 * 60_000;
    const history = callsSince(sessionId(), since);
    const args = call.tool_input ?? {};
    const analysis = analyzeCall(history, { tool: toolName, argsHash: fingerprint(toolName, args), args }, cfg);

    if (cfg.budget.dispatchTools.includes(toolName)) {
      const budgetFinding = evaluateBudgetGate(sessionId(), cfg.budget, Date.now());
      if (budgetFinding) analysis.findings.unshift(budgetFinding);
    }

    const block = analysis.findings.find((f) => f.severity === "block");
    if (block) {
      recordBlock(sessionId(), toolName, block.kind);
      report.blocks.push({ tool: toolName, kind: block.kind, message: block.message, ts: Date.now() });
      const blocksInSession = countBlocks(sessionId(), Date.now() - cfg.policy.blockWindowMinutes * 60_000);
      if (cfg.policy.killSwitch && blocksInSession >= cfg.policy.maxBlocksPerSession) {
        killSwitchArmed = true;
        report.endReason = "kill-switch";
        cancelled = true;
        void client.cancel().catch(() => {});
      }
      return { request_id: p.id, action: "block", reason: `[kimi-guard] Blocked (${block.kind}): ${block.message}` };
    }

    const warn = analysis.findings.find((f) => f.severity === "warn");
    if (warn) {
      const key = `${warn.kind}:${toolName}`;
      if (!hintedPatterns.has(key)) {
        hintedPatterns.add(key);
        await steerOnce(warn.kind, warn.message);
      }
    }
    return { request_id: p.id, action: "allow", reason: "" };
  }

  try {
    openDb();
    await client.start();
    recordEvent(sessionId(), "run_start", { prompt: opts.prompt.slice(0, 200) });

    timeoutTimer = setTimeout(() => {
      if (cancelled) return;
      cancelled = true;
      report.endReason = "timeout";
      void client.cancel().catch(() => {});
    }, opts.maxMinutes * 60_000);

    let attempt = 0;
    let currentPrompt = opts.prompt;
    while (true) {
      attempt++;
      report.turns++;
      const result = (await client.prompt(currentPrompt, opts.maxMinutes * 60_000 + 60_000)) as { status: string; steps?: number };
      report.finalStatus = result.status;

      if (result.status === "finished") {
        if (cfg.verify.enabled && report.verifyRounds < opts.maxVerifyRounds) {
          const claims = findClaims(turnText, cfg);
          if (claims.length > 0 && !hasEvidence(sessionId(), cfg)) {
            if (cfg.verify.veto.enabled) {
              const ctx = {
                ...collectVetoContext(sessionId(), cfg),
                claims,
                goal: opts.prompt,
              };
              const env = { ...process.env, ...opts.env };
              const vote = await castVetoVote(ctx, cfg.verify.veto, env);
              if (vote.vetoed) {
                report.vetoes++;
                recordEvent(sessionId(), "veto", { claims: claims.length, raw: vote.raw });
                break;
              }
              if (vote.error) recordEvent(sessionId(), "veto_error", { error: vote.error });
            }
            report.verifyRounds++;
            report.endReason = "verify";
            recordEvent(sessionId(), "verify_gate", { claims: claims.length });
            captureCheckpoint(sessionId(), "verify-gate", Date.now(), cfg);
            currentPrompt = WIRE_VERIFY_CORRECTIVE;
            continue;
          }
        }
        if (report.endReason === "verify") report.endReason = "finished";
        break;
      }

      if (result.status === "max_steps_reached" && attempt <= opts.autoResume) {
        report.resumes++;
        const brief = captureCheckpoint(sessionId(), "auto-resume", Date.now(), cfg);
        const d6Note = report.thinkingDominance > 0
          ? " Note: the previous turns were dominated by thinking with little action — act more, think less."
          : "";
        currentPrompt =
          (brief ? `You were stopped at the step limit. Observed state so far:\n\n${brief.brief}\n\n` : "") +
          "You reached the step limit. Continue from where you stopped — do not repeat work already done." +
          d6Note;
        continue;
      }

      if (result.status === "cancelled" && report.endReason === "finished") {
        report.endReason = killSwitchArmed ? "kill-switch" : "timeout";
      }
      break;
    }

    if (killSwitchArmed) {
      captureCheckpoint(sessionId(), "kill-switch", Date.now(), cfg);
    }
  } catch (err) {
    report.endReason = "error";
    const msg = (err as Error).message;
    report.finalStatus = /ENOENT|spawn/i.test(msg)
      ? `${msg} — is the agent CLI installed and on PATH? Or pass --exec <command...>`
      : msg;
  } finally {
    if (timeoutTimer) clearTimeout(timeoutTimer);
    client.stop();
  }

  report.durationMs = Date.now() - startedAt;
  report.finishedAt = new Date().toISOString();
  recordEvent(sessionId(), "run_end", { endReason: report.endReason, blocks: report.blocks.length });

  try {
    fs.writeFileSync(report.reportPath, JSON.stringify(report, null, 2), "utf8");
  } catch {
    /* best effort */
  }
  return report;
}

function extractFile(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  for (const k of ["file_path", "filePath", "path", "file", "filename"]) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function formatReport(r: RunReport): string {
  const dur = Math.round(r.durationMs / 1000);
  const lines = [
    `kimi-guard run report`,
    `  run id:   ${r.runId}`,
    `  command:  ${r.command.join(" ")}`,
    `  duration: ${dur}s   steps: ${r.steps}   tool calls: ${r.toolCalls}   turns: ${r.turns}${r.resumes > 0 ? ` (resumed ×${r.resumes})` : ""}`,
    `  end:      ${r.endReason} (last prompt status: ${r.finalStatus})`,
    `  blocks:   ${r.blocks.length === 0 ? "none" : r.blocks.map((b) => `${b.kind}(${b.tool})`).join(", ")}`,
    `  steers:   ${r.steers.length === 0 ? "none" : String(r.steers.length)}`,
    r.verifyRounds > 0 ? `  verify:   ${r.verifyRounds} corrective round(s) for unbacked completion claims` : "",
    r.vetoes > 0 ? `  veto:     ${r.vetoes} false-positive veto vote(s) accepted the completion` : "",
    r.thinkingDominance > 0 ? `  thinking: ${r.thinkingDominance} thinking-dominated turn(s) flagged` : "",
    `  approvals: ${r.approvals.approved} approved, ${r.approvals.rejected} rejected`,
    `  tokens:   in ${r.tokenUsage.input_other + r.tokenUsage.input_cache_read + r.tokenUsage.input_cache_creation} (cache read ${r.tokenUsage.input_cache_read}) / out ${r.tokenUsage.output}`,
    r.stepRetries.length > 0 ? `  retries:  ${r.stepRetries.length} (last: ${r.stepRetries[r.stepRetries.length - 1]?.error_type})` : "",
    `  report:   ${r.reportPath}`,
    `  wire log: ${r.logPath}`,
  ];
  return lines.filter(Boolean).join("\n");
}
