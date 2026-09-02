import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { findClaims, hasEvidence, hasRecentEdits, HOOKS_STOP_BLOCK_REASON } from "../src/verify.js";
import { processHookEvent } from "../src/guard.js";
import { recordCall, resetDbForTests } from "../src/store.js";
import { fingerprint } from "../src/events.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-verify-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cfg() {
  return structuredClone(defaultConfig);
}

describe("claim extraction", () => {
  it("detects English claims", () => {
    const claims = findClaims("Great news: all tests pass and the build succeeded.", cfg());
    expect(claims.length).toBeGreaterThanOrEqual(1);
    expect(claims[0]!.snippet).toContain("tests");
  });

  it("detects Chinese claims", () => {
    expect(findClaims("修复完成，测试全部通过。", cfg()).length).toBeGreaterThanOrEqual(1);
    expect(findClaims("构建成功，可以交付。", cfg()).length).toBeGreaterThanOrEqual(1);
  });

  it("ignores text without completion claims", () => {
    expect(findClaims("I will now write the test suite. Working on it.", cfg())).toHaveLength(0);
  });
});

describe("evidence detection", () => {
  it("accepts a successful test command as evidence", () => {
    recordCall({ sessionId: "v1", toolName: "Shell", argsHash: "h", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok" });
    expect(hasEvidence("v1", cfg())).toBe(true);
  });

  it("rejects failed test commands as evidence", () => {
    recordCall({ sessionId: "v2", toolName: "Shell", argsHash: "h", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "failure" });
    expect(hasEvidence("v2", cfg())).toBe(false);
  });

  it("rejects unrelated commands", () => {
    recordCall({ sessionId: "v3", toolName: "Shell", argsHash: "h", argsJson: JSON.stringify({ command: "ls -la" }), outputHash: "o", filePath: null, status: "ok" });
    expect(hasEvidence("v3", cfg())).toBe(false);
  });

  it("respects the evidence window", () => {
    const old = Date.now() - 3 * 3_600_000;
    recordCall({ sessionId: "v4", toolName: "Shell", argsHash: "h", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok", ts: old });
    expect(hasEvidence("v4", cfg())).toBe(false);
  });

  it("honors configurable shell tool names (upstream tool renames)", () => {
    recordCall({ sessionId: "v5", toolName: "execute_command", argsHash: "h", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok" });
    // default config only knows Shell/Bash → no evidence
    expect(hasEvidence("v5", cfg())).toBe(false);
    // after configuring the actual tool name (canonical [tools] shell), the same call counts
    const c = cfg();
    c.tools.shell = ["execute_command"];
    expect(hasEvidence("v5", c)).toBe(true);
  });
});

describe("hooks-path Stop gate", () => {
  it("blocks Stop after edits with no evidence, disabled by default", () => {
    const c = cfg();
    c.verify.blockOnNoEvidence = true;
    processHookEvent("PostToolUse", c, { session_id: "sg", tool_name: "WriteFile", tool_input: { file_path: "a.ts", content: "x" } });
    const out = processHookEvent("Stop", c, { session_id: "sg", stop_hook_active: false });
    expect(out.code).toBe(2);
    expect(out.stderr).toContain(HOOKS_STOP_BLOCK_REASON.slice(0, 40));
  });

  it("allows Stop once evidence exists", () => {
    const c = cfg();
    c.verify.blockOnNoEvidence = true;
    processHookEvent("PostToolUse", c, { session_id: "sg2", tool_name: "WriteFile", tool_input: { file_path: "a.ts", content: "x" } });
    processHookEvent("PostToolUse", c, { session_id: "sg2", tool_name: "Shell", tool_input: { command: "npm test" } });
    expect(processHookEvent("Stop", c, { session_id: "sg2" }).code).toBe(0);
  });

  it("default config: gate is off (interactive-friendly)", () => {
    const c = cfg();
    processHookEvent("PostToolUse", c, { session_id: "sg3", tool_name: "WriteFile", tool_input: { file_path: "a.ts", content: "x" } });
    expect(processHookEvent("Stop", c, { session_id: "sg3" }).code).toBe(0);
  });
});

describe("wire-path helpers", () => {
  it("hasRecentEdits detects successful edits", () => {
    recordCall({ sessionId: "w1", toolName: "WriteFile", argsHash: fingerprint("WriteFile", { file_path: "a.ts" }), argsJson: JSON.stringify({ file_path: "a.ts" }), outputHash: null, filePath: "a.ts", status: "ok" });
    expect(hasRecentEdits("w1", cfg())).toBe(true);
    expect(hasRecentEdits("ghost", cfg())).toBe(false);
  });
});
