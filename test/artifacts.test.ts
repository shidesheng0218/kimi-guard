import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { guardHome } from "../src/paths.js";
import { openDb, recordCall, resetDbForTests } from "../src/store.js";
import { appendProbe } from "../src/guard.js";
import { captureCheckpoint } from "../src/checkpoint.js";
import { hardenArtifacts, pruneArtifacts } from "../src/retention.js";
import { appendPrivateFile, ensurePrivateDir, writePrivateFile } from "../src/fsSecure.js";

const DAY = 86_400_000;
const POSIX = process.platform !== "win32";
const modeOf = (p: string): number => fs.statSync(p).mode & 0o777;

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-artifacts-"));
  process.env.AGENT_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.AGENT_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("artifact permissions", () => {
  it("creates the state directory and DB owner-only", () => {
    openDb();
    if (!POSIX) return;
    expect(modeOf(guardHome())).toBe(0o700);
    expect(modeOf(path.join(guardHome(), "state.db"))).toBe(0o600);
    for (const f of ["state.db-wal", "state.db-shm"]) {
      const p = path.join(guardHome(), f);
      if (fs.existsSync(p)) expect(modeOf(p)).toBe(0o600);
    }
  });

  it("creates probe logs, checkpoints and run artifacts owner-only", () => {
    openDb();
    recordCall({
      sessionId: "perm-session",
      toolName: "Grep",
      argsHash: "h",
      argsJson: "{}",
      outputHash: null,
      filePath: null,
      status: "ok",
    });
    appendProbe("PreToolUse", { tool_name: "Grep" });
    const cp = captureCheckpoint("perm-session", "test", Date.now(), structuredClone(defaultConfig));
    expect(cp).not.toBeNull();

    const runDir = path.join(guardHome(), "runs", "run-x");
    ensurePrivateDir(runDir);
    appendPrivateFile(path.join(runDir, "wire.jsonl"), "{}\n");
    writePrivateFile(path.join(runDir, "report.json"), "{}");

    if (!POSIX) return;
    expect(modeOf(path.join(guardHome(), "probe.jsonl"))).toBe(0o600);
    expect(modeOf(cp!.path)).toBe(0o600);
    expect(modeOf(path.dirname(cp!.path))).toBe(0o700);
    expect(modeOf(runDir)).toBe(0o700);
    expect(modeOf(path.join(runDir, "wire.jsonl"))).toBe(0o600);
    expect(modeOf(path.join(runDir, "report.json"))).toBe(0o600);
  });

  it("hardenArtifacts tightens files created by older versions", () => {
    if (!POSIX) return;
    const home = guardHome();
    fs.mkdirSync(home, { recursive: true, mode: 0o755 });
    const probe = path.join(home, "probe.jsonl");
    fs.writeFileSync(probe, "{}\n");
    fs.chmodSync(probe, 0o644);
    const runDir = path.join(home, "runs", "old");
    fs.mkdirSync(runDir, { recursive: true });
    const wire = path.join(runDir, "wire.jsonl");
    fs.writeFileSync(wire, "{}\n");
    fs.chmodSync(wire, 0o644);

    hardenArtifacts();

    expect(modeOf(home)).toBe(0o700);
    expect(modeOf(probe)).toBe(0o600);
    expect(modeOf(runDir)).toBe(0o700);
    expect(modeOf(wire)).toBe(0o600);
  });
});

describe("artifact retention", () => {
  function make(rel: string, ageSec: number, isDir = false): string {
    const p = path.join(guardHome(), rel);
    if (isDir) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, "x");
    }
    fs.utimesSync(p, ageSec, ageSec);
    return p;
  }

  it("prunes expired runs/checkpoints/incidents and keeps fresh ones", () => {
    const now = Date.now();
    const oldSec = (now - 100 * DAY) / 1000;
    const freshSec = (now - 1 * DAY) / 1000;

    const oldRun = make("runs/old-run", oldSec, true);
    fs.writeFileSync(path.join(oldRun, "wire.jsonl"), "old");
    fs.utimesSync(oldRun, oldSec, oldSec); // writing the file bumped the dir mtime
    const newRun = make("runs/new-run", freshSec, true);
    fs.writeFileSync(path.join(newRun, "wire.jsonl"), "new");

    const oldCpDir = make("checkpoints/old-session", oldSec, true);
    const oldCp = path.join(oldCpDir, "1-test.md");
    fs.writeFileSync(oldCp, "old");
    fs.utimesSync(oldCp, oldSec, oldSec);
    const newCp = make("checkpoints/new-session/1-test.md", freshSec);

    const oldInc = make("incidents/old.md", oldSec);
    const newInc = make("incidents/new.md", freshSec);

    const r = pruneArtifacts(now, { runsDays: 30, checkpointsDays: 30, incidentsDays: 90 });

    expect(r.runs).toBe(1);
    expect(r.checkpoints).toBe(1);
    expect(r.incidents).toBe(1);
    expect(r.bytes).toBeGreaterThan(0);
    expect(fs.existsSync(oldRun)).toBe(false);
    expect(fs.existsSync(oldCp)).toBe(false);
    expect(fs.existsSync(oldCpDir)).toBe(false); // empty session dir removed
    expect(fs.existsSync(oldInc)).toBe(false);
    expect(fs.existsSync(newRun)).toBe(true);
    expect(fs.existsSync(newCp)).toBe(true);
    expect(fs.existsSync(newInc)).toBe(true);
  });

  it("dry-run reports without deleting", () => {
    const now = Date.now();
    const oldSec = (now - 100 * DAY) / 1000;
    const oldInc = make("incidents/old.md", oldSec);
    const r = pruneArtifacts(now, { runsDays: 30, checkpointsDays: 30, incidentsDays: 90 }, { dryRun: true });
    expect(r.incidents).toBe(1);
    expect(fs.existsSync(oldInc)).toBe(true);
  });

  it("0 disables pruning for that category", () => {
    const now = Date.now();
    const oldSec = (now - 400 * DAY) / 1000;
    const oldInc = make("incidents/old.md", oldSec);
    const r = pruneArtifacts(now, { runsDays: 30, checkpointsDays: 30, incidentsDays: 0 });
    expect(r.incidents).toBe(0);
    expect(fs.existsSync(oldInc)).toBe(true);
  });
});