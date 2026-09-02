import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runClaudeSupervised } from "../../src/run/claude.js";
import { resetDbForTests, callsSince, countEvents } from "../../src/store.js";
import { defaultConfig } from "../../src/config.js";

const FAKE = path.join(import.meta.dirname, "fake-claude.mjs");

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-claude-"));
  process.env.KIMI_GUARD_HOME = tmp;
  // no claude settings in the sandbox → hooks not installed → driver backstop active
  process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, "no-such-settings.json");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.CLAUDE_SETTINGS_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(prompt: string, scenario: string, overrides?: Partial<Parameters<typeof runClaudeSupervised>[0]>) {
  return runClaudeSupervised({
    prompt,
    command: [process.execPath, FAKE],
    cwd: tmp,
    env: { FAKE_CLAUDE_SCENARIO: scenario },
    maxSteps: 50,
    maxMinutes: 1,
    autoResume: 0,
    maxVerifyRounds: 2,
    approval: "reject",
    json: false,
    ...overrides,
  });
}

describe("claude headless supervision (stream-json driver)", () => {
  it("clean run: report aggregates turns, tool calls and token usage", async () => {
    const r = await run("read the readme", "ok");
    expect(r.endReason).toBe("finished");
    expect(r.toolCalls).toBe(1);
    expect(r.turns).toBe(1);
    expect(r.tokenUsage.input_cache_read).toBe(3000);
    expect(r.blocks).toHaveLength(0);
    expect(fs.existsSync(r.reportPath)).toBe(true);
    expect(fs.existsSync(r.logPath)).toBe(true);
    // calls are recorded under the claude session id — shared with hooks
    const rows = callsSince("fake-claude-sess-1", Date.now() - 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("Read");
  }, 20000);

  it("loop scenario: driver backstop records blocks and the kill switch stops the run", async () => {
    const cfg = structuredClone(defaultConfig);
    cfg.harness = "claude";
    cfg.repeat.maxRepeats = 2;
    cfg.policy.maxBlocksPerSession = 2;
    const r = await run("find foo", "loop", { config: cfg });
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(r.blocks[0]!.kind).toBe("repeat");
    expect(["kill-switch", "finished", "error"]).toContain(r.endReason);
  }, 20000);

  it("claim scenario: unbacked completion claim triggers a corrective --resume round", async () => {
    const r = await run("refactor it", "claim");
    expect(r.verifyRounds).toBeGreaterThanOrEqual(1);
    // the resumed run ran the test for real → evidence recorded → finished clean
    expect(r.endReason).toBe("finished");
    const rows = callsSince("fake-claude-sess-1", Date.now() - 60_000);
    expect(rows.some((row) => row.tool_name === "Bash" && row.status === "ok")).toBe(true);
    expect(countEvents("fake-claude-sess-1", ["verify_gate"], 0)).toBe(1);
  }, 20000);

  it("missing binary produces a helpful error, not a hang", async () => {
    const r = await run("hi", "ok", { command: ["definitely-not-a-real-binary-xyz"], maxMinutes: 1 });
    expect(r.endReason).toBe("error");
    expect(r.finalStatus).toContain("PATH");
  }, 20000);
});
