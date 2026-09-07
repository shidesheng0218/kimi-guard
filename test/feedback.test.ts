import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { defaultConfig } from "../src/config.js";
import {
  resetDbForTests,
  openDb,
  recordBlock,
  recordCall,
  listBlocks,
  setBlockFeedback,
  blockKindStats,
  getMeta,
} from "../src/store.js";
import { processHookEvent } from "../src/guard.js";
import { calibrationHints, buildGuardReport } from "../src/status.js";
import { fingerprint } from "../src/events.js";

const nodeRequire = createRequire(import.meta.url);

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-fb-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("block feedback loop", () => {
  it("recordBlock returns an id; feedback roundtrips", () => {
    const id = recordBlock("s1", "Grep", "repeat");
    expect(id).toBeGreaterThan(0);
    expect(setBlockFeedback(id, "fp")).toBe(true);
    expect(setBlockFeedback(99999, "fp")).toBe(false);
    const rows = listBlocks();
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.feedback).toBe("fp");
    const stats = blockKindStats();
    expect(stats).toEqual([{ kind: "repeat", n: 1, fp: 1, tp: 0 }]);
  });

  it("v2 → v3 migration is additive: history survives, feedback column appears", () => {
    // fabricate a v2 database by hand (blocks without the feedback column)
    resetDbForTests();
    const file = path.join(tmp, "state.db");
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, args_json TEXT NOT NULL, output_hash TEXT, file_path TEXT, status TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, meta_json TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta (k, v) VALUES ('schema_version', '2');
      INSERT INTO blocks (session_id, tool_name, kind, ts) VALUES ('old', 'Grep', 'repeat', 123);
    `);
    d.close();

    // opening through the store must migrate without losing the row
    openDb();
    expect(getMeta("schema_version")).toBe("5");
    const rows = listBlocks();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.session_id).toBe("old");
    expect(rows[0]!.feedback).toBeNull();
    // and the migrated db accepts new feedback
    expect(setBlockFeedback(rows[0]!.id, "tp")).toBe(true);
  });

  it("v3 → v4 migration adds output_sample without touching existing rows", async () => {
    resetDbForTests();
    const file = path.join(tmp, "state.db");
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, args_json TEXT NOT NULL, output_hash TEXT, file_path TEXT, status TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, meta_json TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, feedback TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta (k, v) VALUES ('schema_version', '3');
      INSERT INTO calls (session_id, tool_name, args_hash, args_json, status, ts) VALUES ('s1', 'Grep', 'h', '{}', 'ok', 999);
    `);
    d.close();

    openDb();
    expect(getMeta("schema_version")).toBe("5");
    recordCall({ sessionId: "s1", toolName: "Grep", argsHash: "h2", argsJson: "{}", outputHash: "o", outputSample: "sample text", filePath: null, status: "ok" });
    const { callsSince } = await import("../src/store.js");
    const rows = callsSince("s1", 0);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.output_sample).toBeNull(); // old row untouched
    expect(rows[1]!.output_sample).toBe("sample text");
  });
});

describe("detector kind is recorded on blocks (hooks path)", () => {
  it("repeat block records kind=repeat and appends the feedback hint", () => {
    const cfg = structuredClone(defaultConfig);
    const payload = { session_id: "fb1", tool_name: "Grep", tool_input: { pattern: "x" } };
    for (let i = 0; i < 3; i++) processHookEvent("PostToolUse", cfg, payload);
    const out = processHookEvent("PreToolUse", cfg, payload);
    expect(out.code).toBe(2);
    expect(out.stderr).toMatch(/block #\d+ recorded/);
    expect(out.stderr).toContain("kguard feedback fp");
    const rows = listBlocks();
    expect(rows[0]!.kind).toBe("repeat");
  });
});

describe("calibration hints", () => {
  it("suggests raising thresholds when FP rate exceeds 30% with enough samples", () => {
    const hints = calibrationHints([
      { kind: "repeat", n: 10, fp: 4, tp: 2 },
      { kind: "churn", n: 3, fp: 3, tp: 0 }, // too few samples
      { kind: "budget", n: 8, fp: 1, tp: 5 }, // low FP rate
    ]);
    expect(hints).toHaveLength(1);
    expect(hints[0]).toContain("repeat");
    expect(hints[0]).toContain("repeat.maxRepeats");
    expect(hints[0]).toContain("40%");
  });

  it("stays silent with no feedback", () => {
    expect(calibrationHints([{ kind: "repeat", n: 20, fp: 0, tp: 0 }])).toHaveLength(0);
  });
});

describe("guard report (anonymized aggregate)", () => {
  it("contains counts only — no args, paths, commands or session ids", () => {
    const marker = "super-secret-command-xyz";
    recordCall({
      sessionId: "sess-private-id",
      toolName: "Shell",
      argsHash: fingerprint("Shell", { command: marker }),
      argsJson: JSON.stringify({ command: marker }),
      outputHash: null,
      filePath: "/home/user/private/project.ts",
      status: "ok",
    });
    recordBlock("sess-private-id", "Shell", "repeat");
    const report = buildGuardReport(structuredClone(defaultConfig));
    const text = JSON.stringify(report);
    expect(text).not.toContain(marker);
    expect(text).not.toContain("sess-private-id");
    expect(text).not.toContain("private/project.ts");
    const detectors = report["detectors"] as Array<{ kind: string; blocks: number }>;
    expect(detectors.find((d) => d.kind === "repeat")?.blocks).toBe(1);
  });
});
