import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordCall, resetDbForTests } from "../src/store.js";
import { tsxArgs } from "./util/tsx.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-auditcli-"));
  process.env.AGENT_GUARD_HOME = tmp;
  delete process.env.KIMI_GUARD_HOME;
  recordCall({
    sessionId: "s1",
    toolName: "Read",
    argsHash: "h",
    argsJson: "{}",
    outputHash: null,
    outputSample: null,
    filePath: null,
    status: "ok",
    ts: Date.now(),
  });
});

afterEach(() => {
  resetDbForTests();
  delete process.env.AGENT_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runCli(...args: string[]): { stdout: string; stderr: string; status: number } {
  const [node, tsx] = tsxArgs(path.join(import.meta.dirname, "..", "src", "cli.ts"), ...args);
  try {
    const stdout = execFileSync(node, tsx, { encoding: "utf8", env: { ...process.env, AGENT_GUARD_HOME: tmp } });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", status: e.status ?? 1 };
  }
}

describe("agentguard audit CLI", () => {
  it("prints a text report and exits 0", () => {
    const r = runCli("audit");
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("agentguard audit");
    expect(r.stdout).toContain("provenance");
  });

  it("--json prints parseable AuditReport with provenance", () => {
    const r = runCli("audit", "--json");
    expect(r.status).toBe(0);
    const report = JSON.parse(r.stdout) as { totals: { calls: number }; provenance: Record<string, string[]> };
    expect(report.totals.calls).toBe(1);
    expect(Object.keys(report.provenance)).toEqual(["observed", "estimated", "inferred"]);
  });

  it("--md prints a Markdown heading", () => {
    const r = runCli("audit", "--md");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("# agentguard audit");
  });

  it("an invalid --since exits 1", () => {
    const r = runCli("audit", "--since", "99x");
    expect(r.status).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("since");
  });
});