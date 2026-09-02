#!/usr/bin/env node
/**
 * Fake Claude Code headless process for integration tests.
 * Emits stream-json lines on stdout like `claude -p --output-format stream-json --verbose`.
 * Scenario via FAKE_CLAUDE_SCENARIO env var:
 *   ok    — one Read call, then success
 *   loop  — 6 identical Grep calls (driver backstop must fire the kill switch)
 *   claim — result claims "All tests pass" with no evidence; on --resume, runs the test for real
 */
const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? "ok";
const args = process.argv.slice(2);
const prompt = args[args.indexOf("-p") + 1] ?? "";
const isResume = args.includes("--resume");
const sessionId = "fake-claude-sess-1";

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function init() {
  send({ type: "system", subtype: "init", session_id: sessionId, tools: ["Bash", "Read", "Grep"], model: "claude-sonnet-5" });
}
function toolUse(id, name, input) {
  send({ type: "assistant", session_id: sessionId, message: { content: [{ type: "tool_use", id, name, input }], usage: { input_tokens: 500, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 } } });
}
function toolResult(id, content, isError = false) {
  send({ type: "user", session_id: sessionId, message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error: isError }] } });
}
function text(t) {
  send({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: t }], usage: { input_tokens: 100, output_tokens: 20 } } });
}
function result(text_, { isError = false, subtype = "success" } = {}) {
  send({
    type: "result",
    subtype,
    is_error: isError,
    num_turns: 1,
    duration_ms: 100,
    total_cost_usd: 0.001,
    usage: { input_tokens: 1500, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
    result: text_,
    session_id: sessionId,
  });
}

process.on("SIGINT", () => {
  // graceful: emit a result and exit
  result("interrupted by supervisor", { isError: true, subtype: "error_during_execution" });
  process.exit(130);
});

async function main() {
  init();

  if (scenario === "loop") {
    for (let i = 1; i <= 6; i++) {
      toolUse(`tc-${i}`, "Grep", { pattern: "foo", path: "src" });
      toolResult(`tc-${i}`, `matches: ${i}`);
      await sleep(50);
    }
    result("done looping");
    return;
  }

  if (scenario === "claim") {
    if (isResume) {
      toolUse("tc-v", "Bash", { command: "npm test" });
      toolResult("tc-v", "all tests passed");
      text("All tests pass now. Verified for real.");
      result("All tests pass now. Verified for real.");
      return;
    }
    text("All tests pass. The refactor is complete.");
    result("All tests pass. The refactor is complete.");
    return;
  }

  // ok
  toolUse("tc-1", "Read", { file_path: "README.md" });
  toolResult("tc-1", "hello world");
  text("Read the file.");
  result("Read the file.");
}

main().then(() => process.exit(0));
