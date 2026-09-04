import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listRuns, parseRunLog, renderTimeline } from "../src/replay.js";
import { runSupervised } from "../src/wire/supervisor.js";
import { resetDbForTests } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-replay-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("replay", () => {
  it("parses a recorded wire run into an annotated timeline", async () => {
    const fake = path.join(import.meta.dirname, "wire", "fake-kimi.mjs");
    const r = await runSupervised({
      prompt: "find foo",
      command: [process.execPath, fake],
      cwd: tmp,
      env: { FAKE_SCENARIO: "loop" },
      maxSteps: 50,
      maxMinutes: 1,
      steerOnWarn: true,
      maxSteers: 5,
      autoResume: 0,
      maxVerifyRounds: 2,
      approval: "reject",
      json: false,
    });

    const runs = listRuns();
    expect(runs.some((x) => x.runId === r.runId)).toBe(true);

    const events = parseRunLog(r.runId);
    expect(events.some((e) => e.kind === "call")).toBe(true);
    expect(events.some((e) => e.kind === "block")).toBe(true);

    const text = renderTimeline(events);
    expect(text).toContain("Grep");
    expect(text).toContain("🔴");
    expect(text).toMatch(/\d+ calls · \d+ blocks/);
  }, 30000);

  it("handles a missing/empty log gracefully", () => {
    expect(parseRunLog("no-such-run")).toHaveLength(0);
    expect(renderTimeline([])).toContain("no events");
  });
});
