import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditToMarkdown, buildAudit, formatAudit } from "../src/audit.js";
import { openDb, recordBlock, recordCall, recordEvent, resetDbForTests } from "../src/store.js";
import { guardHome } from "../src/paths.js";

let tmp: string;
let now: number;

const RUN_FIXTURE = path.join(import.meta.dirname, "fixtures", "audit", "run-report.json");
const HOUR = 3_600_000;
const MIN = 60_000;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-audit-"));
  process.env.AGENT_GUARD_HOME = tmp;
  delete process.env.KIMI_GUARD_HOME;
  now = Date.now();
});

afterEach(() => {
  resetDbForTests();
  delete process.env.AGENT_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function call(session: string, tool: string, ts: number): void {
  recordCall({
    sessionId: session,
    toolName: tool,
    argsHash: `${session}-${tool}-${ts}`,
    argsJson: "{}",
    outputHash: null,
    outputSample: null,
    filePath: null,
    status: "ok",
    ts,
  });
}

function event(session: string, kind: string, ts: number, meta: Record<string, unknown> = {}, harness = "kimi"): void {
  recordEvent(session, kind, meta, ts, harness);
}

function writeRun(id: string, overrides: Record<string, unknown> = {}): void {
  const dir = path.join(guardHome(), "runs", id);
  fs.mkdirSync(dir, { recursive: true });
  const base = JSON.parse(fs.readFileSync(RUN_FIXTURE, "utf8")) as Record<string, unknown>;
  fs.writeFileSync(path.join(dir, "report.json"), JSON.stringify({ ...base, ...overrides, runId: id }, null, 2), "utf8");
}

function seedMain(): void {
  call("parent1", "Read", now - 60 * MIN);
  call("parent1|sub|explorer", "Grep", now - 55 * MIN);
  event("parent1", "turn", now - 60 * MIN);
  event("parent1", "subagent", now - 55 * MIN, { agent: "explorer" });
  event("parent1", "compaction", now - 50 * MIN, { phase: "pre" });
  event("parent1", "compaction", now - 49 * MIN, { phase: "post" });
  for (let i = 0; i < 5; i++) event("parent1", "step_retry", now - 40 * MIN + i * MIN, { error_type: "api_error" });
  event("parent1", "stall", now - 30 * MIN, { idleMs: 11 * MIN, lastEvent: "PostToolUse" });
  recordBlock("parent1", "Grep", "repeat", now - 54 * MIN, "blocked");
}

describe("buildAudit", () => {
  it("returns a zero report and guard-inactive when the DB is absent", () => {
    const r = buildAudit({ now });
    expect(r.totals.calls).toBe(0);
    expect(r.totals.turns).toBe(0);
    expect(r.findings.some((f) => f.id === "guard-inactive")).toBe(true);
    expect(fs.existsSync(path.join(tmp, "state.db"))).toBe(false);
  });

  it("buckets turns/subagents/blocks into 15-minute timeline rows", () => {
    seedMain();
    const r = buildAudit({ now, sinceMs: 2 * HOUR });
    expect(r.timeline.length).toBeGreaterThan(0);
    expect(r.timeline.some((b) => b.turns > 0 || b.subagents > 0)).toBe(true);
    expect(r.timeline.some((b) => b.blocks > 0)).toBe(true);
  });

  it("collapses <parent>|sub|<agent> sessions and attributes calls to the agent", () => {
    seedMain();
    const r = buildAudit({ now, sinceMs: 2 * HOUR });
    expect(r.totals.sessions).toBe(1);
    expect(r.totals.calls).toBe(2);
    expect(r.totals.subagentCalls).toBe(1);
    expect(r.sessions[0]).toMatchObject({ sessionId: "parent1", calls: 2, subagentCalls: 1 });
    expect(r.agents).toEqual([{ agent: "explorer", dispatches: 1, calls: 1 }]);
  });

  it("--session includes child sessions and excludes other parents", () => {
    seedMain();
    expect(buildAudit({ session: "parent1", now, sinceMs: 2 * HOUR }).totals.calls).toBe(2);
    expect(buildAudit({ session: "other", now, sinceMs: 2 * HOUR }).totals.calls).toBe(0);
  });

  it("--harness filters events but leaves calls/blocks all-harness", () => {
    call("parent1", "Read", now - 60 * MIN);
    event("parent1", "turn", now - 60 * MIN, {}, "kimi");
    event("parent1", "turn", now - 50 * MIN, {}, "claude");
    const kimi = buildAudit({ now, sinceMs: 2 * HOUR, harness: "kimi" });
    const claude = buildAudit({ now, sinceMs: 2 * HOUR, harness: "claude" });
    expect(kimi.totals.turns).toBe(1);
    expect(claude.totals.turns).toBe(1);
    expect(kimi.totals.calls).toBe(1);
    expect(kimi.harnessBreakdown).toEqual(
      expect.arrayContaining([
        { harness: "kimi", turns: 1, subagents: 0 },
        { harness: "claude", turns: 1, subagents: 0 },
      ]),
    );
  });

  it("counts distinct compaction cycles (pre + wire, not post)", () => {
    for (let i = 0; i < 3; i++) {
      event("parent1", "compaction", now - 50 * MIN + i * MIN, { phase: "pre" });
      event("parent1", "compaction", now - 50 * MIN + i * MIN + 1000, { phase: "post" });
    }
    const r = buildAudit({ now, sinceMs: 2 * HOUR });
    const f = r.findings.find((x) => x.id === "context-pressure");
    expect(f).toBeDefined();
    expect(f!.evidence).toContain("cycles=3");
  });

  it("links a run report by sessionId and computes cacheRatio", () => {
    seedMain();
    writeRun("run-fixture-1", { startedAtMs: now - 10 * MIN, sessionId: "parent1" });
    const r = buildAudit({ session: "parent1", now, sinceMs: 2 * HOUR });
    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]).toMatchObject({ runId: "run-fixture-1", harness: "kimi", sessionId: "parent1" });
    expect(r.runs[0]!.cacheRatio).toBeCloseTo(12);
    expect(r.findings.some((f) => f.id === "cache-amplification")).toBe(true);
  });

  it("excludes a run report without sessionId from a session audit and counts runsUnlinked", () => {
    seedMain();
    writeRun("linked", { startedAtMs: now - 10 * MIN, sessionId: "parent1" });
    writeRun("unlinked", { startedAtMs: now - 9 * MIN, sessionId: undefined });
    const r = buildAudit({ session: "parent1", now, sinceMs: 2 * HOUR });
    expect(r.runs.map((x) => x.runId)).toEqual(["linked"]);
    expect(r.runsUnlinked).toBe(1);
  });

  it("reports retry-storm and stall-signal from seeded events", () => {
    seedMain();
    const r = buildAudit({ now, sinceMs: 2 * HOUR });
    expect(r.retries.maxIn30Min).toBe(5);
    expect(r.findings.some((f) => f.id === "retry-storm")).toBe(true);
    expect(r.findings.some((f) => f.id === "stall-signal")).toBe(true);
  });

  it("records a stall event when a session resumes after the threshold", async () => {
    const { processHookEvent } = await import("../src/guard.js");
    const { defaultConfig } = await import("../src/config.js");
    const cfg = { ...defaultConfig, stall: { enabled: true, minutes: 10 } };
    const t0 = now - 20 * MIN;
    processHookEvent("PostToolUse", cfg, { session_id: "stall-session" }, t0);
    processHookEvent("PreToolUse", cfg, { session_id: "stall-session" }, t0 + 11 * MIN);
    const rows = openDb().prepare("SELECT meta_json FROM events WHERE kind = 'stall'").all() as Array<{ meta_json: string }>;
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.meta_json).idleMs).toBeGreaterThanOrEqual(10 * MIN);
  });

  it("formatAudit and auditToMarkdown render the same totals", () => {
    seedMain();
    const r = buildAudit({ now, sinceMs: 2 * HOUR });
    expect(formatAudit(r)).toContain("agentguard audit");
    expect(formatAudit(r)).toContain("last 2h");
    expect(formatAudit(r)).toContain("provenance");
    expect(auditToMarkdown(r)).toContain("# agentguard audit");
    expect(auditToMarkdown(r)).toContain("| calls | 2 (1 subagent) |");
  });
});