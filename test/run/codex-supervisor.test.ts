import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCodexSupervised } from "../../src/run/codex.js";
import { mergeHookBlocks } from "../../src/run/blocks.js";
import { resetDbForTests, callsSince, countEvents, recordBlock } from "../../src/store.js";
import { defaultConfig } from "../../src/config.js";

const FAKE = path.join(import.meta.dirname, "fake-codex.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-codex-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.CODEX_HOOKS_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(prompt: string, scenario: string, overrides?: Partial<Parameters<typeof runCodexSupervised>[0]>) {
  return runCodexSupervised({
    prompt,
    command: [process.execPath, FAKE],
    cwd: tmp,
    env: { FAKE_CODEX_SCENARIO: scenario },
    maxSteps: 50,
    maxMinutes: 1,
    approval: "reject",
    json: false,
    ...overrides,
  });
}

describe("codex headless supervision", () => {
  it("clean run: records calls under the codex thread id, meters tokens", async () => {
    const r = await run("list files", "ok");
    expect(r.endReason).toBe("finished");
    expect(r.toolCalls).toBe(1);
    expect(r.turns).toBe(1);
    expect(r.tokenUsage.input_other).toBe(1200);
    expect(r.tokenUsage.input_cache_read).toBe(800);
    const rows = callsSince("fake-codex-thread", Date.now() - 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("Bash");
    expect(rows[0]!.output_sample).toContain("a.ts");
    expect(countEvents("fake-codex-thread", ["turn"], 0)).toBe(1);
  }, 20000);

  it("hooks live: the driver does not duplicate call rows; hook blocks merge into the report", async () => {
    const hooksPath = path.join(tmp, "hooks.json");
    process.env.CODEX_HOOKS_PATH = hooksPath;
    fs.writeFileSync(
      hooksPath,
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "agentguard hook PreToolUse" }] }] } }),
    );
    const r = await run("list files", "ok");
    expect(r.endReason).toBe("finished");
    expect(r.toolCalls).toBe(1);
    expect(callsSince("fake-codex-thread", 0)).toHaveLength(0);
    // the Stop hook owns turn accounting when hooks are live
    expect(countEvents("fake-codex-thread", ["turn"], 0)).toBe(0);
    recordBlock("fake-codex-thread", "Bash", "repeat", Date.now(), "blocked by hook");
    mergeHookBlocks(r, "fake-codex-thread", Date.parse(r.startedAt));
    expect(r.blocks.some((b) => b.kind === "repeat" && b.tool === "Bash")).toBe(true);
  }, 20000);

  it("loop scenario: repeat blocks are recorded by the driver backstop", async () => {
    const cfg = structuredClone(defaultConfig);
    cfg.harness = "codex";
    cfg.repeat.maxRepeats = 2;
    const r = await run("find foo", "loop", { config: cfg });
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(r.blocks[0]!.kind).toBe("repeat");
    expect(r.blocks[0]!.tool).toBe("Bash");
  }, 20000);

  it("missing binary produces a helpful error, not a hang", async () => {
    const r = await run("hi", "ok", { command: ["definitely-not-codex-xyz"] });
    expect(r.endReason).toBe("error");
    expect(r.finalStatus).toContain("PATH");
  }, 20000);
});
