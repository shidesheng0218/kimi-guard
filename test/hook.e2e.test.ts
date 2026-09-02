import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let tmp: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-e2e-"));
  env = {
    ...process.env,
    KIMI_GUARD_HOME: tmp,
    KIMI_CONFIG_PATH: path.join(tmp, "config.toml"),
  };
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const CLI = path.join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");

function runHook(event: string, payload: unknown, cwd: string): { code: number; stderr: string } {
  try {
    execFileSync(CLI, ["src/cli.ts", "hook", event], {
      cwd,
      env,
      input: JSON.stringify(payload),
      encoding: "utf8",
    });
    return { code: 0, stderr: "" };
  } catch (err) {
    const e = err as { status?: number; stderr?: string };
    return { code: e.status ?? 1, stderr: e.stderr ?? "" };
  }
}

function grepPayload(pattern: string): unknown {
  return { session_id: "sess-1", tool_name: "Grep", tool_input: { pattern } };
}

describe("hook e2e (spawns the real CLI)", () => {
  const repoRoot = path.join(import.meta.dirname, "..");

  it("third identical Grep call is blocked with exit code 2", () => {
    const payload = grepPayload("class Foo");
    expect(runHook("PostToolUse", payload, repoRoot).code).toBe(0);
    expect(runHook("PostToolUse", payload, repoRoot).code).toBe(0);
    expect(runHook("PostToolUse", payload, repoRoot).code).toBe(0);
    const pre = runHook("PreToolUse", payload, repoRoot);
    expect(pre.code).toBe(2);
    expect(pre.stderr).toContain("[agent-guard]");
    expect(pre.stderr).toContain("3 times");
  });

  it("different args pass", () => {
    expect(runHook("PreToolUse", grepPayload("a"), repoRoot).code).toBe(0);
    expect(runHook("PreToolUse", grepPayload("b"), repoRoot).code).toBe(0);
  });

  it("unknown event and empty payload exit 0", () => {
    expect(runHook("Notification", {}, repoRoot).code).toBe(0);
    expect(runHook("PreToolUse", {}, repoRoot).code).toBe(0);
  });

  it("PostToolUseFailure records failures", () => {
    const payload = { session_id: "sess-1", tool_name: "Shell", tool_input: { command: "make test" } };
    runHook("PostToolUseFailure", payload, repoRoot);
    runHook("PostToolUseFailure", payload, repoRoot);
    runHook("PostToolUseFailure", payload, repoRoot);
    const pre = runHook("PreToolUse", payload, repoRoot);
    expect(pre.code).toBe(2);
  });

  it("probe records payloads when enabled via meta", () => {
    execFileSync(CLI, ["src/cli.ts", "probe", "on"], { cwd: repoRoot, env, encoding: "utf8" });
    runHook("PostToolUse", { session_id: "s", tool_name: "Glob", tool_input: {} }, repoRoot);
    const probeFile = path.join(tmp, "probe.jsonl");
    expect(fs.existsSync(probeFile)).toBe(true);
    const line = JSON.parse(fs.readFileSync(probeFile, "utf8").trim()) as { event: string };
    expect(line.event).toBe("PostToolUse");
  });
});
