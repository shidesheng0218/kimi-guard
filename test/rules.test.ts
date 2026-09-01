import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { fingerprint, hashOutput, normalizeCall, extractFile } from "../src/events.js";
import { analyzeCall } from "../src/analysis.js";
import { resolveFindings, isKillSwitchTripped } from "../src/policy.js";
import { recordCall, resetDbForTests, type CallRow } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-test-"));
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

const mk = (
  tool: string,
  args: unknown,
  opts?: { output?: unknown; status?: "ok" | "failure"; file?: string | null; ago?: number },
): CallRow => ({
  tool_name: tool,
  args_hash: fingerprint(tool, args),
  args_json: JSON.stringify(args),
  output_hash: opts?.output !== undefined ? hashOutput(opts.output) : null,
  file_path: opts?.file !== undefined ? opts.file : extractFile(args),
  status: opts?.status ?? "ok",
  ts: Date.now() - (opts?.ago ?? 0),
});

describe("fingerprint (near-duplicate tolerance)", () => {
  it("collapses whitespace for whitespace-insensitive tools", () => {
    expect(fingerprint("SetTodoList", { title: "foo  bar" })).toBe(
      fingerprint("SetTodoList", { title: "foo bar" }),
    );
  });

  it("preserves whitespace for whitespace-sensitive tools (a different command is a different call)", () => {
    expect(fingerprint("Grep", { pattern: "foo  bar", path: "src" })).not.toBe(
      fingerprint("Grep", { pattern: "foo bar", path: "src" }),
    );
    expect(fingerprint("Shell", { command: "echo a b" })).not.toBe(fingerprint("Shell", { command: "echo ab" }));
  });

  it("is key-order independent", () => {
    expect(fingerprint("Shell", { a: 1, b: 2 })).toBe(fingerprint("Shell", { b: 2, a: 1 }));
  });

  it("still distinguishes real differences", () => {
    expect(fingerprint("Grep", { pattern: "foo", path: "a" })).not.toBe(fingerprint("Grep", { pattern: "foo", path: "b" }));
  });
});

describe("hashOutput (no-information-gain signal)", () => {
  it("same content, different formatting → same hash", () => {
    expect(hashOutput("line1\nline2")).toBe(hashOutput("line1\n  line2"));
  });

  it("different content → different hash", () => {
    expect(hashOutput("a")).not.toBe(hashOutput("b"));
  });

  it("empty output → null", () => {
    expect(hashOutput("")).toBeNull();
    expect(hashOutput(null)).toBeNull();
  });
});

describe("normalizeCall", () => {
  it("tolerates schema variants", () => {
    const a = normalizeCall({ session_id: "s", tool_name: "Grep", tool_input: { pattern: "x" } }, "PreToolUse");
    const b = normalizeCall({ sessionId: "s", toolName: "Grep", input: { pattern: "x" } }, "PreToolUse");
    expect(a?.argsHash).toBe(b?.argsHash);
    expect(a?.sessionId).toBe("s");
  });

  it("returns null without a tool name", () => {
    expect(normalizeCall({ session_id: "s" }, "PreToolUse")).toBeNull();
  });
});

describe("repetition analyzer", () => {
  it("blocks at threshold, counts failures too", () => {
    const c = cfg();
    const args = { pattern: "x" };
    const history = [
      mk("Grep", args),
      mk("Grep", args),
      mk("Grep", args, { status: "failure" }),
    ];
    const r = analyzeCall(history, { tool: "Grep", argsHash: fingerprint("Grep", args), args }, c);
    expect(r.findings.some((f) => f.kind === "repeat" && f.severity === "block")).toBe(true);
  });

  it("respects window", () => {
    const c = cfg();
    const args = { pattern: "x" };
    const old = Date.now() - 60 * 60_000;
    const history = [mk("Grep", args, { ago: Date.now() - old }), mk("Grep", args, { ago: Date.now() - old })];
    void old;
    const stale = history.map((h) => ({ ...h, ts: old }));
    const r = analyzeCall(stale, { tool: "Grep", argsHash: fingerprint("Grep", args), args }, c);
    expect(r.findings.find((f) => f.kind === "repeat")).toBeUndefined();
  });

  it("per-tool threshold override (ReadFile): warn below, block at threshold", () => {
    const c = cfg();
    const args = { path: "a.ts" };
    const history = Array.from({ length: 4 }, () => mk("ReadFile", args));
    const r = analyzeCall(history, { tool: "ReadFile", argsHash: fingerprint("ReadFile", args), args }, c);
    expect(r.findings.find((f) => f.kind === "repeat" && f.severity === "block")).toBeUndefined();
    expect(r.findings.find((f) => f.kind === "repeat" && f.severity === "warn")).toBeDefined();
    const history5 = [...history, mk("ReadFile", args)];
    const r2 = analyzeCall(history5, { tool: "ReadFile", argsHash: fingerprint("ReadFile", args), args }, c);
    expect(r2.findings.some((f) => f.kind === "repeat" && f.severity === "block")).toBe(true);
  });

  it("exemptPatterns never trigger repeat findings (polling commands)", () => {
    const c = cfg();
    c.repeat.exemptPatterns = ["git status"];
    const args = { command: "git status --short" };
    const history = Array.from({ length: 6 }, (_, i) => mk("Shell", args, { ago: (6 - i) * 60_000 }));
    for (const h of history) recordCall({ sessionId: "s1", toolName: h.tool_name, argsHash: h.args_hash, argsJson: h.args_json, outputHash: h.output_hash, filePath: h.file_path, status: h.status as "ok", ts: h.ts });
    const r = analyzeCall(history, { tool: "Shell", argsHash: fingerprint("Shell", args), args }, c);
    expect(r.findings.find((f) => f.kind === "repeat")).toBeUndefined();
  });

  it("warn fires below the block threshold", () => {
    const c = cfg();
    const args = { pattern: "w" };
    const history = [mk("Grep", args), mk("Grep", args)];
    const r = analyzeCall(history, { tool: "Grep", argsHash: fingerprint("Grep", args), args }, c);
    expect(r.findings.find((f) => f.kind === "repeat")?.severity).toBe("warn");
  });
});

describe("cycle analyzer (oscillation)", () => {
  it("detects a period-2 loop", () => {
    const c = cfg();
    const a = mk("Grep", { pattern: "a" });
    const b = mk("Glob", { pattern: "*.ts" });
    const history = [a, b, a, b, a, b, a, b];
    const r = analyzeCall(history, { tool: "Glob", argsHash: b.args_hash, args: {} }, c);
    expect(r.findings.some((f) => f.kind === "cycle" && f.severity === "block")).toBe(true);
  });

  it("does not fire on varied activity", () => {
    const c = cfg();
    const history = [
      mk("Grep", { pattern: "a" }),
      mk("Glob", { pattern: "*.ts" }),
      mk("ReadFile", { path: "x.ts" }),
      mk("Shell", { command: "make" }),
      mk("Grep", { pattern: "b" }),
      mk("Glob", { pattern: "*.js" }),
      mk("ReadFile", { path: "y.ts" }),
      mk("Shell", { command: "test" }),
    ];
    const r = analyzeCall(history, { tool: "Shell", argsHash: "zzz", args: {} }, c);
    expect(r.findings.find((f) => f.kind === "cycle")).toBeUndefined();
  });
});

describe("no-gain analyzer", () => {
  it("warns then blocks when outputs are identical despite different args", () => {
    const c = cfg();
    const out = "no results found";
    const history = [
      mk("Grep", { pattern: "a" }, { output: out }),
      mk("Grep", { pattern: "b" }, { output: out }),
    ];
    const proposed = { tool: "Grep", argsHash: fingerprint("Grep", { pattern: "c" }), args: { pattern: "c" } };
    const w0 = analyzeCall(history, proposed, c);
    expect(w0.findings.find((f) => f.kind === "noGain")).toBeUndefined();

    const history3 = [...history, mk("Grep", { pattern: "c2" }, { output: out })];
    const w = analyzeCall(history3, proposed, c);
    expect(w.findings.find((f) => f.kind === "noGain")?.severity).toBe("warn");

    const history4 = [...history3, mk("Grep", { pattern: "c3" }, { output: out })];
    const b = analyzeCall(history4, proposed, c);
    expect(b.findings.find((f) => f.kind === "noGain")?.severity).toBe("block");
  });

  it("ignores distinct outputs", () => {
    const c = cfg();
    const history = [
      mk("Grep", { pattern: "a" }, { output: "r1" }),
      mk("Grep", { pattern: "b" }, { output: "r2" }),
      mk("Grep", { pattern: "c" }, { output: "r3" }),
    ];
    const r = analyzeCall(history, { tool: "Grep", argsHash: "q", args: {} }, c);
    expect(r.findings.find((f) => f.kind === "noGain")).toBeUndefined();
  });
});

describe("churn analyzer", () => {
  it("warns and blocks on repeated edits of the same file", () => {
    const c = cfg();
    const args = { file_path: "src/app.ts", content: "..." };
    const history = Array.from({ length: 5 }, (_, i) => mk("WriteFile", { ...args, content: `v${i}` }));
    const r = analyzeCall(history, { tool: "WriteFile", argsHash: "new", args }, c);
    expect(r.findings.find((f) => f.kind === "churn")?.severity).toBe("warn");

    const history10 = Array.from({ length: 10 }, (_, i) => mk("WriteFile", { ...args, content: `v${i}` }));
    const r2 = analyzeCall(history10, { tool: "WriteFile", argsHash: "new", args }, c);
    expect(r2.findings.find((f) => f.kind === "churn")?.severity).toBe("block");
  });
});

describe("policy resolution + kill switch", () => {
  it("block outranks warn", () => {
    const findings = [
      { kind: "noGain" as const, severity: "warn" as const, message: "w", evidence: "" },
      { kind: "repeat" as const, severity: "block" as const, message: "b", evidence: "" },
    ];
    const d = resolveFindings(findings, { blocksInSession: 0, cfg: { killSwitch: true, maxBlocksPerSession: 5 } });
    expect(d.action).toBe("block");
    expect(d.blockReason).toContain("repeat");
  });

  it("warn becomes a context hint (stdout)", () => {
    const d = resolveFindings(
      [{ kind: "churn" as const, severity: "warn" as const, message: "w", evidence: "" }],
      { blocksInSession: 0, cfg: { killSwitch: true, maxBlocksPerSession: 5 } },
    );
    expect(d.action).toBe("warn");
    expect(d.contextHint).toContain("churn");
  });

  it("kill switch fires after max interventions", () => {
    expect(isKillSwitchTripped(5, { killSwitch: true, maxBlocksPerSession: 5 })).toBe(true);
    expect(isKillSwitchTripped(4, { killSwitch: true, maxBlocksPerSession: 5 })).toBe(false);
    const d = resolveFindings([], { blocksInSession: 5, cfg: { killSwitch: true, maxBlocksPerSession: 5 } });
    expect(d.action).toBe("block");
    expect(d.blockReason).toContain("CIRCUIT BREAK");
  });
});

describe("store roundtrip", () => {
  it("records and replays calls", async () => {
    const { callsSince } = await import("../src/store.js");
    const a = mk("Grep", { pattern: "x" });
    const b = mk("Shell", { command: "ls" }, { output: "out" });
    recordCall({ sessionId: "s1", toolName: a.tool_name, argsHash: a.args_hash, argsJson: a.args_json, outputHash: a.output_hash, filePath: a.file_path, status: a.status as "ok" });
    recordCall({ sessionId: "s1", toolName: b.tool_name, argsHash: b.args_hash, argsJson: b.args_json, outputHash: b.output_hash, filePath: b.file_path, status: "ok" });
    const rows = callsSince("s1", Date.now() - 60_000);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.output_hash).toBeNull();
    expect(rows[1]!.output_hash).toBe(hashOutput("out"));
  });

  it("lastActivityTs considers the events table too (observation-only sessions)", async () => {
    const { buildStatus, recordEvent } = await import("../src/store.js");
    const ts = Date.now() - 60_000;
    recordEvent("ev-only", "turn", {}, ts);
    expect(buildStatus().lastActivityTs).toBe(ts);
  });

  it("oldestEventTs returns the oldest matching event in the window", async () => {
    const { oldestEventTs, recordEvent } = await import("../src/store.js");
    const now = Date.now();
    recordEvent("o1", "turn", {}, now - 3_600_000);
    recordEvent("o1", "turn", {}, now - 60_000);
    recordEvent("o1", "other", {}, now - 2 * 3_600_000);
    expect(oldestEventTs("o1", ["turn"], now - 5 * 3_600_000)).toBe(now - 3_600_000);
    expect(oldestEventTs("o1", ["turn"], now - 30_000)).toBeNull();
    expect(oldestEventTs("ghost", ["turn"], 0)).toBeNull();
  });
});
