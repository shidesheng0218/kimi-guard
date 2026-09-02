#!/usr/bin/env node
/**
 * Fake Kimi Code Wire server for integration tests.
 * Speaks the JSON-RPC 2.0 Wire protocol over stdin/stdout.
 * Scenario is chosen via FAKE_SCENARIO env var:
 *   ok      — one tool call, then finish
 *   loop    — repeats the SAME Grep call 5× (blocks make the fake model stop repeating)
 *   nogain  — 4 Grep calls with different args but identical output (warn→steer, then block)
 *   maxsteps — reports max_steps_reached immediately
 *   approval — one approval request (records the client's decision), then finishes
 *   dispatch — one Task (subagent dispatch) call, exercising the budget gate
 *   steercap — emits a warn-worthy pattern repeatedly to exercise the steer cap
 * All client decisions are appended to FAKE_LOG (JSONL) for assertions.
 */
import readline from "node:readline";
import fs from "node:fs";

const scenario = process.env.FAKE_SCENARIO ?? "ok";
const logFile = process.env.FAKE_LOG;
const log = (entry) => {
  if (logFile) fs.appendFileSync(logFile, JSON.stringify(entry) + "\n");
};

let nextId = 0;
const pending = new Map();

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  log({ dir: "in", msg });

  if (msg.id && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id);
    if (p) {
      pending.delete(msg.id);
      p(msg);
    }
    return;
  }

  switch (msg.method) {
    case "initialize":
      respond(msg.id, {
        protocol_version: "1.10",
        server: { name: "fake-kimi", version: "0.0.1" },
        capabilities: { supports_question: true },
        hooks: { supported_events: ["PreToolUse"], configured: {} },
      });
      break;
    case "prompt":
      runScenario(msg.id, msg.params?.user_input ?? "");
      break;
    case "steer":
      log({ dir: "steer", text: msg.params?.user_input });
      respond(msg.id, { status: "steered" });
      break;
    case "cancel":
      cancelled = true;
      respond(msg.id, {});
      break;
    default:
      break;
  }
});

let cancelled = false;

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function send(msg) {
  log({ dir: "out", msg });
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function request(type, payload) {
  return new Promise((resolve) => {
    const id = `fake-${nextId++}`;
    pending.set(id, (msg) => resolve(msg.result ?? {}));
    send({ jsonrpc: "2.0", method: "request", id, params: { type, payload } });
  });
}

function event(type, payload) {
  send({ jsonrpc: "2.0", method: "event", params: { type, payload } });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function hookPreToolUse(toolName, toolInput) {
  const decision = await request("HookRequest", {
    id: `hook-${nextId++}`,
    subscription_id: "kguard",
    event: "PreToolUse",
    target: toolName,
    input_data: { session_id: "fake-session", tool_name: toolName, tool_input: toolInput },
  });
  log({ dir: "hook_decision", tool: toolName, action: decision.action, reason: decision.reason });
  return decision;
}

const sleepMs = Number(process.env.FAKE_STEP_DELAY_MS ?? 15);

async function doToolCall(id, name, args, output, isError = false) {
  const decision = await hookPreToolUse(name, args);
  if (decision.action === "block") {
    // fake model "obeys" the guard: reports the block back to itself as a tool error
    event("ToolCall", { type: "function", id, function: { name, arguments: JSON.stringify(args) } });
    event("ToolResult", {
      tool_call_id: id,
      return_value: { is_error: true, output: `blocked: ${decision.reason}`, message: "blocked by kimi-guard", display: [] },
    });
    return false;
  }
  event("ToolCall", { type: "function", id, function: { name, arguments: JSON.stringify(args) } });
  event("ToolResult", {
    tool_call_id: id,
    return_value: { is_error: isError, output, message: "", display: [] },
  });
  return true;
}

function statusUpdate(inOther, out, cacheRead) {
  event("StatusUpdate", {
    token_usage: { input_other: inOther, output: out, input_cache_read: cacheRead, input_cache_creation: 0 },
    context_tokens: 1000,
    max_context_tokens: 262144,
  });
}

async function runScenario(promptId, userInput) {
  log({ dir: "prompt", scenario, userInput });
  event("TurnBegin", { user_input: userInput });
  event("StepBegin", { n: 1 });
  statusUpdate(1000, 200, 5000);

  if (scenario === "maxsteps") {
    event("TurnEnd", {});
    respond(promptId, { status: "max_steps_reached", steps: 1 });
    return;
  }

  if (scenario === "ok") {
    await doToolCall("tc-1", "ReadFile", { file_path: "README.md" }, "hello world");
    statusUpdate(1500, 300, 6000);
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "loop") {
    let blockedOnce = false;
    for (let i = 1; i <= 5; i++) {
      if (cancelled) break;
      const okCall = await doToolCall(`tc-${i}`, "Grep", { pattern: "foo", path: "src" }, `matches: ${i}`);
      if (!okCall) {
        blockedOnce = true;
        break;
      }
      statusUpdate(1000, 100, 4000);
      await sleep(sleepMs);
    }
    event("StepBegin", { n: 2 });
    event("TurnEnd", {});
    respond(promptId, { status: blockedOnce ? "finished" : "finished" });
    return;
  }

  if (scenario === "nogain") {
    for (let i = 1; i <= 4; i++) {
      if (cancelled) break;
      const okCall = await doToolCall(`tc-${i}`, "Grep", { pattern: `p${i}`, path: "src" }, "no matches found");
      if (!okCall) break;
      statusUpdate(800, 80, 3000);
      await sleep(sleepMs);
    }
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "approval") {
    const result = await request("ApprovalRequest", {
      id: "ap-1",
      tool_call_id: "tc-1",
      sender: "Shell",
      action: "run shell command",
      description: "Run command `make test`",
      display: [],
    });
    log({ dir: "approval_decision", response: result.response });
    event("ApprovalResponse", { request_id: "ap-1", response: result.response ?? "reject" });
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "dispatch") {
    // one subagent-dispatch tool call; the budget gate may block it
    await doToolCall("tc-d", "Task", { prompt: "do the subtask" }, "subtask done");
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "subagent") {
    // dispatch one subagent whose nested events contain 3 identical calls + usage
    for (let i = 1; i <= 3; i++) {
      event("SubagentEvent", {
        parent_tool_call_id: "tc-parent",
        agent_id: "sub-1",
        subagent_type: "coder",
        event: { type: "ToolCall", payload: { type: "function", id: `stc-${i}`, function: { name: "Grep", arguments: JSON.stringify({ pattern: "same" }) } } },
      });
      event("SubagentEvent", {
        parent_tool_call_id: "tc-parent",
        agent_id: "sub-1",
        subagent_type: "coder",
        event: { type: "ToolResult", payload: { tool_call_id: `stc-${i}`, return_value: { is_error: false, output: `r${i}`, message: "", display: [] } } },
      });
    }
    event("SubagentEvent", {
      parent_tool_call_id: "tc-parent",
      agent_id: "sub-1",
      subagent_type: "coder",
      event: { type: "StatusUpdate", payload: { token_usage: { input_other: 5000, output: 900, input_cache_read: 42000, input_cache_creation: 0 } } },
    });
    statusUpdate(1000, 200, 5000);
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "bloat") {
    event("StatusUpdate", { context_usage: 0.92, token_usage: { input_other: 900, output: 100, input_cache_read: 3000, input_cache_creation: 0 } });
    await sleep(sleepMs);
    event("StatusUpdate", { context_usage: 0.86, token_usage: { input_other: 900, output: 100, input_cache_read: 3000, input_cache_creation: 0 } });
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "longturn") {
    // 12 steps → anchor expected at step 5 and step 10 (everyNPrompts=5)
    for (let n = 2; n <= 12; n++) {
      if (cancelled) break;
      event("StepBegin", { n });
      await sleep(5);
    }
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "claim") {
    // first prompt: claims "All tests pass" with no evidence → expect a verify round;
    // corrective prompt (contains "agent-guard verification"): run tests for real, then finish
    if (userInput.includes("agent-guard verification")) {
      event("StepBegin", { n: 1 });
      const okCall = await doToolCall("tc-v", "Shell", { command: "npm test" }, "all tests passed");
      event("ContentPart", { type: "text", text: "All tests pass now. The refactor is verified." });
      event("TurnEnd", {});
      respond(promptId, { status: "finished" });
      void okCall;
      return;
    }
    event("ContentPart", { type: "text", text: "All tests pass. The refactor is complete." });
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  if (scenario === "thinker") {
    // huge thinking, tiny text → thinking-dominance flag
    event("ContentPart", { type: "think", think: "let me consider... ".repeat(2000) });
    event("ContentPart", { type: "text", text: "ok" });
    event("TurnEnd", {});
    respond(promptId, { status: "finished" });
    return;
  }

  event("TurnEnd", {});
  respond(promptId, { status: "finished" });
}

rl.on("close", () => process.exit(0));

process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "event", params: { type: "StatusUpdate", payload: {} } }) + "\n");
