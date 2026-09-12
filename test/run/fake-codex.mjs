#!/usr/bin/env node
/**
 * Fake Codex CLI headless process for integration tests.
 * Emits `codex exec --json` JSONL events on stdout.
 * Scenarios via FAKE_CODEX_SCENARIO: ok | loop
 */
const scenario = process.env.FAKE_CODEX_SCENARIO ?? "ok";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

process.on("SIGINT", () => process.exit(130));

async function main() {
  send({ type: "thread.started", thread_id: "fake-codex-thread" });
  send({ type: "turn.started" });

  if (scenario === "loop") {
    for (let i = 1; i <= 6; i++) {
      send({ type: "item.completed", item: { id: `i${i}`, type: "command_execution", command: "grep -n foo src", aggregated_output: "src/a.ts:1:foo", exit_code: 0, status: "completed" } });
      await sleep(30);
    }
  } else {
    send({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "a.ts\nb.ts", exit_code: 0, status: "completed" } });
  }

  send({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "Done." } });
  send({ type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 800, output_tokens: 90 } });
  process.exit(0);
}

main();
