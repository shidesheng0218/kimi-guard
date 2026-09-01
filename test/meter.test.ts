import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { resetDbForTests, recordEvent, countEvents, knownSessions } from "../src/store.js";
import { budgetSnapshot, evaluateBudgetGate, resolveLimits, formatSnapshot } from "../src/meter.js";
import { buildBrief, captureCheckpoint, latestCheckpointFile, renderResumeBlock } from "../src/checkpoint.js";
import { processHookEvent } from "../src/guard.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-meter-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function budgetCfg() {
  return { ...structuredClone(defaultConfig.budget), plan: "tier1", weekly: 1024, fiveHour: 200 };
}

describe("budget metering", () => {
  it("counts turns and weighted subagents per window", () => {
    const now = Date.now();
    for (let i = 0; i < 30; i++) recordEvent("s1", "turn", {}, now - i * 60_000);
    recordEvent("s1", "subagent", {}, now - 120_000);
    const snap = budgetSnapshot("s1", budgetCfg(), now);
    expect(snap.turnsLastHour).toBe(30);
    // 30 turns within 5h window + 1 subagent × weight 5
    expect(snap.fiveHour.used).toBe(35);
    expect(snap.weekly.used).toBe(35);
  });

  it("old events outside the window do not count", () => {
    const now = Date.now();
    for (let i = 0; i < 10; i++) recordEvent("s1", "turn", {}, now - 6 * 3_600_000);
    const snap = budgetSnapshot("s1", budgetCfg(), now);
    expect(snap.fiveHour.used).toBe(0);
  });

  it("blocks dispatch when the 5h window is exhausted past reserve", () => {
    const now = Date.now();
    for (let i = 0; i < 190; i++) recordEvent("s1", "turn", {}, now - i * 30_000);
    const cfgB = budgetCfg();
    cfgB.reservePercent = 10;
    const finding = evaluateBudgetGate("s1", cfgB, now);
    expect(finding?.severity).toBe("block");
    expect(finding?.message).toContain("Quota gate");
  });

  it("warns at high burn rate projection", () => {
    const now = Date.now();
    for (let i = 0; i < 150; i++) recordEvent("s1", "turn", {}, now - i * 12_000);
    const finding = evaluateBudgetGate("s1", budgetCfg(), now);
    expect(finding !== null).toBe(true);
  });

  it("disabled budget → no findings", () => {
    const cfgB = { ...budgetCfg(), enabled: false };
    expect(evaluateBudgetGate("s1", cfgB)).toBeNull();
  });

  it("custom limits override plan presets", () => {
    const limits = resolveLimits({ ...budgetCfg(), plan: "tier3", weekly: 500, fiveHour: 0 });
    expect(limits.weekly).toBe(500);
    expect(limits.fiveHour).toBe(200);
  });

  it("formatSnapshot renders bars", () => {
    const snap = budgetSnapshot("s1", budgetCfg());
    const text = formatSnapshot(snap);
    expect(text).toContain("5h:");
    expect(text).toContain("weekly:");
  });
});

describe("event recording", () => {
  it("records TurnStarted/SubagentStart via the hook pipeline", () => {
    const cfg = structuredClone(defaultConfig);
    processHookEvent("TurnStarted", cfg, { session_id: "s1", origin_kind: "user" });
    processHookEvent("SubagentStart", cfg, { session_id: "s1", agent_name: "coder" });
    expect(countEvents("s1", ["turn"], Date.now() - 60_000)).toBe(1);
    expect(countEvents("s1", ["subagent"], Date.now() - 60_000)).toBe(1);
    expect(knownSessions(1)[0]?.session_id).toBe("s1");
  });
});

describe("goal anchoring + compaction (hooks path)", () => {
  it("first prompt stores the goal, Nth prompt re-injects it", () => {
    const cfg = structuredClone(defaultConfig);
    cfg.anchor.everyNPrompts = 3;
    const p1 = processHookEvent("UserPromptSubmit", cfg, { session_id: "ga", prompt: "refactor the billing module" });
    expect(p1.stdout).toBeUndefined();
    const p2 = processHookEvent("UserPromptSubmit", cfg, { session_id: "ga", prompt: "continue" });
    expect(p2.stdout).toBeUndefined();
    const p3 = processHookEvent("UserPromptSubmit", cfg, { session_id: "ga", prompt: "keep going" });
    expect(p3.stdout).toContain("goal anchor");
    expect(p3.stdout).toContain("refactor the billing module");
    const p4 = processHookEvent("UserPromptSubmit", cfg, { session_id: "ga", prompt: "more" });
    expect(p4.stdout).toBeUndefined();
  });

  it("always re-anchors on the first prompt after a compaction", () => {
    const cfg = structuredClone(defaultConfig);
    cfg.anchor.everyNPrompts = 100;
    processHookEvent("UserPromptSubmit", cfg, { session_id: "gc", prompt: "audit auth code" });
    processHookEvent("PreCompact", cfg, { session_id: "gc", trigger: "auto" });
    const p2 = processHookEvent("UserPromptSubmit", cfg, { session_id: "gc", prompt: "continue" });
    expect(p2.stdout).toContain("after compaction");
    expect(p2.stdout).toContain("audit auth code");
  });

  it("PreCompact captures a checkpoint before compression", () => {
    const cfg = structuredClone(defaultConfig);
    processHookEvent("PostToolUse", cfg, { session_id: "cp", tool_name: "Shell", tool_input: { command: "npm test" } });
    processHookEvent("PreCompact", cfg, { session_id: "cp", trigger: "auto" });
    const file = latestCheckpointFile("cp");
    expect(file).not.toBeNull();
    expect(fs.readFileSync(file!, "utf8")).toContain("npm test");
  });
});

describe("checkpoint engine", () => {
  it("auto-captures on StopFailure with observed state", () => {
    const cfg = structuredClone(defaultConfig);
    const payload = { session_id: "s1", tool_name: "Shell", tool_input: { command: "make test" } };
    processHookEvent("PostToolUse", cfg, payload);
    processHookEvent("PostToolUseFailure", cfg, { ...payload, tool_input: { command: "make lint" } });
    processHookEvent("StopFailure", cfg, { session_id: "s1", error_type: "provider_error", error_message: "403 quota" });

    const file = latestCheckpointFile("s1");
    expect(file).not.toBeNull();
    const content = fs.readFileSync(file!, "utf8");
    expect(content).toContain("Commands run");
    expect(content).toContain("make test");
    expect(content).toContain("Failed calls");
    expect(content).toContain("make lint");
  });

  it("brief includes files touched and searches", () => {
    const cfg = structuredClone(defaultConfig);
    processHookEvent("PostToolUse", cfg, { session_id: "s2", tool_name: "ReadFile", tool_input: { file_path: "src/a.ts" } });
    processHookEvent("PostToolUse", cfg, { session_id: "s2", tool_name: "Grep", tool_input: { pattern: "foo" } });
    processHookEvent("PostToolUse", cfg, { session_id: "s2", tool_name: "WriteFile", tool_input: { file_path: "src/a.ts", content: "x" } });
    const brief = buildBrief("s2");
    expect(brief).toContain("src/a.ts");
    expect(brief).toContain("pattern=foo");
    expect(brief).toContain("do not redo");
  });

  it("resume renders a paste-ready injection block", () => {
    const cfg = structuredClone(defaultConfig);
    processHookEvent("PostToolUse", cfg, { session_id: "s3", tool_name: "Shell", tool_input: { command: "cargo test" } });
    const cp = captureCheckpoint("s3", "interrupt");
    expect(cp).not.toBeNull();
    const block = renderResumeBlock(cp!.brief, "interrupt");
    expect(block).toContain("<kimi-guard-resume");
    expect(block).toContain("Do NOT re-explore");
    expect(block).toContain("cargo test");
  });

  it("returns null when there is nothing to checkpoint", () => {
    expect(captureCheckpoint("ghost", "manual")).toBeNull();
  });
});
