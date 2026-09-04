import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SCENARIOS, scoreScenario, totalScore, formatScoreboard } from "../src/bench/index.js";
import { resetDbForTests } from "../src/store.js";
import type { RunReport } from "../src/wire/supervisor.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-bench-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function fakeReport(overrides: Partial<RunReport>): RunReport {
  return {
    runId: "r", command: [], startedAt: "", finishedAt: "", durationMs: 0,
    turns: 1, steps: 1, toolCalls: 4, stepRetries: [], blocks: [], steers: [],
    approvals: { approved: 0, rejected: 0 },
    tokenUsage: { input_other: 0, output: 0, input_cache_read: 0, input_cache_creation: 0 },
    finalStatus: "finished", endReason: "finished", resumes: 0, verifyRounds: 0, vetoes: 0,
    thinkingDominance: 0, reportPath: "", logPath: "",
    ...overrides,
  };
}

describe("bench scoring (pure)", () => {
  const byId = (id: string) => SCENARIOS.find((s) => s.id === id)!;

  it("loop-storm: full score when blocked early, zero when not", () => {
    const blocked = fakeReport({ blocks: [{ tool: "Grep", kind: "repeat", message: "m", ts: 1 }], toolCalls: 4 });
    expect(scoreScenario(byId("loop-storm"), blocked).score).toBe(100);
    const free = fakeReport({ toolCalls: 8 });
    expect(scoreScenario(byId("loop-storm"), free).score).toBe(0);
  });

  it("fake-completion: verify round or veto scores 100", () => {
    expect(scoreScenario(byId("fake-completion"), fakeReport({ verifyRounds: 1 })).score).toBe(100);
    expect(scoreScenario(byId("fake-completion"), fakeReport({})).score).toBe(0);
  });

  it("totalScore averages; scoreboard renders all rows", () => {
    const results = [
      scoreScenario(byId("loop-storm"), fakeReport({ blocks: [{ tool: "Grep", kind: "repeat", message: "m", ts: 1 }], toolCalls: 4 })),
      scoreScenario(byId("think-too-much"), fakeReport({})),
    ];
    expect(totalScore(results)).toBe(50);
    const board = formatScoreboard(results);
    expect(board).toContain("Identical-call loop");
    expect(board).toContain("TOTAL");
    expect(board).toContain("50/100");
  });
});

describe("bench fixture run (integration)", () => {
  it("runs the suite against the fake agent and produces a scoreboard", async () => {
    const { runBench } = await import("../src/bench/index.js");
    const { results, total } = await runBench({ harness: "fixture", maxMinutes: 2, json: false, save: false });
    expect(results).toHaveLength(SCENARIOS.length);
    // the guard passes its own crash tests — every scenario should score > 0
    expect(results.every((r) => r.score > 0)).toBe(true);
    expect(total).toBeGreaterThan(80);
  }, 120000);
});
