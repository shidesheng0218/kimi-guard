import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { resetDbForTests, openDb, getMeta, recordBlock, listBlocks, blockKindStats } from "../src/store.js";
import { stalenessWarning } from "../src/status.js";
import { castVetoVote } from "../src/veto.js";
import { createServer, type Server } from "node:http";

const nodeRequire = createRequire(import.meta.url);

let tmp: string;
let srv: Server | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-trust-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.KIMI_GUARD_VETO_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (srv) await new Promise<void>((r) => srv!.close(() => r()));
  srv = null;
});

describe("block reason persistence", () => {
  it("recordBlock stores the reason; listBlocks returns it", () => {
    const id = recordBlock("s1", "Grep", "repeat", Date.now(), "blocked: too many identical calls");
    const rows = listBlocks();
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.reason).toContain("too many identical calls");
  });

  it("v4 → v5 migration adds the reason column without touching rows", () => {
    resetDbForTests();
    const file = path.join(tmp, "state.db");
    const { DatabaseSync } = nodeRequire("node:sqlite") as typeof import("node:sqlite");
    const d = new DatabaseSync(file);
    d.exec(`
      CREATE TABLE calls (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, args_hash TEXT NOT NULL, args_json TEXT NOT NULL, output_hash TEXT, output_sample TEXT, file_path TEXT, status TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, kind TEXT NOT NULL, meta_json TEXT NOT NULL, ts INTEGER NOT NULL);
      CREATE TABLE blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, tool_name TEXT NOT NULL, kind TEXT NOT NULL, ts INTEGER NOT NULL, feedback TEXT);
      CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      INSERT INTO meta (k, v) VALUES ('schema_version', '4');
      INSERT INTO blocks (session_id, tool_name, kind, ts) VALUES ('old', 'Grep', 'repeat', 42);
    `);
    d.close();

    openDb();
    expect(getMeta("schema_version")).toBe("5");
    const rows = listBlocks();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).toBeNull();
    expect(recordBlock("new", "Shell", "churn", Date.now(), "why")).toBeGreaterThan(0);
    expect(listBlocks()[0]!.reason).toBe("why");
  });
});

describe("staleness warning", () => {
  it("warns when hooks installed but silent 24h+ while an agent runs", () => {
    const now = Date.now();
    expect(stalenessWarning(now - 25 * 3_600_000, now, true, true)).toContain("silently inert");
  });
  it("quiet when recent, when not installed, or when no agent is running", () => {
    const now = Date.now();
    expect(stalenessWarning(now - 60_000, now, true, true)).toBeNull();
    expect(stalenessWarning(0, now, false, true)).toBeNull();
    expect(stalenessWarning(now - 25 * 3_600_000, now, true, false)).toBeNull();
  });
  it("never-fired guard gets a distinct warning", () => {
    expect(stalenessWarning(0, Date.now(), true, false)).toContain("never fired");
  });
});

describe("veto cost logging", () => {
  it("vote results carry model/elapsed/prompt metadata", async () => {
    srv = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "VETO: yes" } }] }));
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const cfg = { enabled: true, model: "cheap-model", baseUrl: `http://127.0.0.1:${port}/v1`, maxCallsPerSession: 3, timeoutMs: 5000 };
    const env = { ...process.env, KIMI_GUARD_VETO_API_KEY: "k" };
    const vote = await castVetoVote({ sessionId: "v1", claims: [], goal: "g", recentCommands: [], editedFiles: [] }, cfg, env);
    expect(vote.vetoed).toBe(true);
    expect(vote.model).toBe("cheap-model");
    expect(vote.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(vote.promptChars).toBeGreaterThan(100);
    expect(vote.maxOutputTokens).toBe(8);
  });
});

describe("canary (proof-of-life, real CLI)", () => {
  const repoRoot = path.join(import.meta.dirname, "..");
  const CLI = path.join(repoRoot, "node_modules", ".bin", "tsx");

  it("fires synthetic calls through the real hook path and shows the block", () => {
    const out = execFileSync(CLI, ["src/cli.ts", "canary"], { cwd: repoRoot, env: { ...process.env }, encoding: "utf8" });
    expect(out).toContain("guard is LIVE");
    expect(out).toContain("exit 2");
    // canary traffic must be purged — no synthetic blocks in the stats
    expect(blockKindStats().filter((k) => k.kind === "repeat")).toHaveLength(0);
  }, 60000);
});
