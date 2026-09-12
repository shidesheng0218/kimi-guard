import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCodexSupervised } from "../../src/run/codex.js";
import { resetDbForTests, callsSince, countEvents } from "../../src/store.js";
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
