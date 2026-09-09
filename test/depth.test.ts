import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { analyzeArgSimilarity, analyzeEditRevert, analyzeCrossSession } from "../src/analysis.js";
import { compoundUpgrade, resolveFindings } from "../src/policy.js";
import { hasEvidence } from "../src/verify.js";
import { recordCall, resetDbForTests, type CallRow } from "../src/store.js";
import { fingerprint } from "../src/events.js";
import type { Finding } from "../src/analysis.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-depth-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mk = (
  tool: string,
  args: unknown,
  opts?: { status?: "ok" | "failure"; file?: string | null; ago?: number },
): CallRow => ({
  tool_name: tool,
  args_hash: fingerprint(tool, args),
  args_json: JSON.stringify(args),
  output_hash: null,
  output_sample: null,
  file_path: opts?.file !== undefined ? opts.file : null,
  status: opts?.status ?? "ok",
  ts: Date.now() - (opts?.ago ?? 0),
});

describe("D1: evidence freshness", () => {
  const cfg = () => structuredClone(defaultConfig);

  it("verification before the last edit does NOT count", () => {
    const now = Date.now();
    recordCall({ sessionId: "s", toolName: "Shell", argsHash: "v", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok", ts: now - 60_000 });
    recordCall({ sessionId: "s", toolName: "WriteFile", argsHash: "e", argsJson: "{}", outputHash: null, filePath: "a.ts", status: "ok", ts: now - 10_000 });
    expect(hasEvidence("s", cfg(), now)).toBe(false);
  });

  it("verification after the last edit counts", () => {
    const now = Date.now();
    recordCall({ sessionId: "s", toolName: "WriteFile", argsHash: "e", argsJson: "{}", outputHash: null, filePath: "a.ts", status: "ok", ts: now - 60_000 });
    recordCall({ sessionId: "s", toolName: "Shell", argsHash: "v", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok", ts: now - 10_000 });
    expect(hasEvidence("s", cfg(), now)).toBe(true);
  });

  it("freshAfterEdits=false restores the old lenient behavior", () => {
    const c = cfg();
    c.verify.freshAfterEdits = false;
    const now = Date.now();
    recordCall({ sessionId: "s", toolName: "Shell", argsHash: "v", argsJson: JSON.stringify({ command: "npm test" }), outputHash: "o", filePath: null, status: "ok", ts: now - 60_000 });
    recordCall({ sessionId: "s", toolName: "WriteFile", argsHash: "e", argsJson: "{}", outputHash: null, filePath: "a.ts", status: "ok", ts: now - 10_000 });
    expect(hasEvidence("s", c, now)).toBe(true);
  });
});

describe("D2: arg-level similarity", () => {
  it("warns when proposed args are near-identical to a recent call", () => {
    const c = structuredClone(defaultConfig);
    const history = [mk("Grep", { pattern: "class Decompress", path: "src" })];
    const r = analyzeArgSimilarity(history, { tool: "Grep", argsHash: "new", args: { pattern: "class Decompress ", path: "src" } }, c, Date.now());
    expect(r[0]?.severity).toBe("warn");
    expect(r[0]?.kind).toBe("argSimilarity");
  });

  it("silent for exact duplicates (repeat's job) and genuinely different args", () => {
    const c = structuredClone(defaultConfig);
    const args = { pattern: "class Decompress", path: "src" };
    const history = [mk("Grep", args)];
    const dup = analyzeArgSimilarity(history, { tool: "Grep", argsHash: fingerprint("Grep", args), args }, c, Date.now());
    expect(dup).toHaveLength(0);
    const diff = analyzeArgSimilarity(history, { tool: "Grep", argsHash: "new", args: { pattern: "unrelated text entirely", path: "lib" } }, c, Date.now());
    expect(diff).toHaveLength(0);
  });
});

describe("D3: edit revert loops", () => {
  it("warns on A→B→A content oscillation in one file", () => {
    const c = structuredClone(defaultConfig);
    const a = mk("WriteFile", { file_path: "a.ts", content: "v1" }, { file: "a.ts" });
    const b = mk("WriteFile", { file_path: "a.ts", content: "v2" }, { file: "a.ts" });
    const history = [a, b, a];
    const r = analyzeEditRevert(history, c, Date.now());
    expect(r[0]?.kind).toBe("editRevert");
    expect(r[0]?.severity).toBe("warn");
  });

  it("silent on converging edits", () => {
    const c = structuredClone(defaultConfig);
    const history = [0, 1, 2].map((i) => mk("WriteFile", { file_path: "a.ts", content: `v${i}` }, { file: "a.ts" }));
    expect(analyzeEditRevert(history, c, Date.now())).toHaveLength(0);
  });
});

describe("D4: compound scoring (opt-in)", () => {
  const threeWarns: Finding[] = [
    { kind: "repeat", severity: "warn", message: "a", evidence: "" },
    { kind: "noGain", severity: "warn", message: "b", evidence: "" },
    { kind: "explore", severity: "warn", message: "c", evidence: "" },
  ];

  it("off by default: warns stay warns", () => {
    const out = compoundUpgrade(threeWarns, false);
    expect(out.every((f) => f.severity === "warn")).toBe(true);
    const d = resolveFindings(threeWarns, { blocksInSession: 0, cfg: { killSwitch: true, maxBlocksPerSession: 5, compoundBlocks: false } });
    expect(d.action).toBe("warn");
  });

  it("opted in: three distinct warns upgrade to a block", () => {
    const out = compoundUpgrade(threeWarns, true);
    expect(out[0]?.severity).toBe("block");
    expect(out[0]?.kind).toBe("compound");
    const d = resolveFindings(threeWarns, { blocksInSession: 0, cfg: { killSwitch: true, maxBlocksPerSession: 5, compoundBlocks: true } });
    expect(d.action).toBe("block");
    expect(d.blockReason).toContain("compound");
  });

  it("two warns never compound even when enabled", () => {
    expect(compoundUpgrade(threeWarns.slice(0, 2), true).every((f) => f.severity === "warn")).toBe(true);
  });
});

describe("D5: evidence in block/warn messages", () => {
  it("block reasons carry the evidence", () => {
    const d = resolveFindings(
      [{ kind: "repeat", severity: "block", message: "too many", evidence: "signature count=4" }],
      { blocksInSession: 0, cfg: { killSwitch: true, maxBlocksPerSession: 5 } },
    );
    expect(d.blockReason).toContain("signature count=4");
  });
});

describe("D6: cross-session warn", () => {
  it("warns when the signature repeats across ≥2 other sessions", () => {
    const c = structuredClone(defaultConfig);
    const sessions = ["s1", "s2", "s3"];
    const r = analyzeCrossSession(
      { tool: "Grep", argsHash: "h", sessionId: "current" },
      () => sessions,
      c,
    );
    expect(r[0]?.severity).toBe("warn");
    expect(r[0]?.kind).toBe("crossSession");
  });

  it("silent when only the current session or one other", () => {
    const c = structuredClone(defaultConfig);
    expect(analyzeCrossSession({ tool: "Grep", argsHash: "h", sessionId: "current" }, () => ["current"], c)).toHaveLength(0);
    expect(analyzeCrossSession({ tool: "Grep", argsHash: "h", sessionId: "current" }, () => ["current", "other"], c)).toHaveLength(0);
  });
});
