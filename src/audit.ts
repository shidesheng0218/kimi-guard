import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openAuditDb } from "./auditDb.js";
import { auditFindings, type AuditFinding } from "./auditRules.js";
import { loadConfig } from "./config.js";
import { budgetSnapshot, type BudgetSnapshot } from "./meter.js";
import { guardHome } from "./paths.js";

export interface AuditScope {
  session?: string;
  sinceMs: number;
  harness: string;
}

export interface AuditTotals {
  sessions: number;
  calls: number;
  subagentCalls: number;
  turns: number;
  subagentDispatches: number;
  blocks: number;
}

export interface AuditBucket {
  start: number;
  turns: number;
  subagents: number;
  blocks: number;
}

export interface AuditSessionRow {
  sessionId: string;
  turns: number;
  calls: number;
  subagentCalls: number;
  blocks: number;
  lastTs: number;
}

export interface AuditAgentRow {
  agent: string;
  dispatches: number;
  calls: number;
}

export interface AuditToolRow {
  tool: string;
  calls: number;
}

export interface AuditRunRow {
  runId: string;
  harness: string;
  sessionId?: string;
  startedAtMs: number;
  endReason: string;
  tokens: { inputOther: number; output: number; cacheRead: number; cacheCreation: number };
  cacheRatio: number | null;
  stepRetries: number;
}

export interface AuditReport {
  generatedAt: number;
  scope: AuditScope;
  budget: BudgetSnapshot;
  totals: AuditTotals;
  timeline: AuditBucket[];
  sessions: AuditSessionRow[];
  agents: AuditAgentRow[];
  tools: AuditToolRow[];
  harnessBreakdown: Array<{ harness: string; turns: number; subagents: number }>;
  retries: { stepRetries: number; stopFailures: number; interrupts: number; maxIn30Min: number };
  runs: AuditRunRow[];
  runsUnlinked: number;
  findings: AuditFinding[];
  provenance: { observed: string[]; estimated: string[]; inferred: string[] };
}

const FIFTEEN_MIN = 15 * 60_000;
const THIRTY_MIN = 30 * 60_000;

interface CallRow {
  session_id: string;
  tool_name: string;
  ts: number;
}

interface EventRow {
  session_id: string;
  kind: string;
  meta_json: string;
  ts: number;
  harness: string;
}

interface BlockRow {
  session_id: string;
  tool_name: string;
  kind: string;
  ts: number;
}

function parentOf(sessionId: string): { parent: string; subagent?: string } {
  const m = /^(.+?)\|sub\|(.+)$/.exec(sessionId);
  return m ? { parent: m[1]!, subagent: m[2]! } : { parent: sessionId };
}

function parseMeta(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw) as unknown;
    return v !== null && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function inScope(sessionId: string, session?: string): boolean {
  if (!session) return true;
  return sessionId === session || sessionId.startsWith(`${session}|sub|`);
}

function query<T>(db: DatabaseSync, sql: string, ...params: Array<string | number>): T[] {
  return db.prepare(sql).all(...params) as T[];
}

function emptyBudget(harness: string): BudgetSnapshot {
  const win = (label: string) => ({ label, used: 0, limit: 0, percent: 0, resetsInMs: 0 });
  return {
    enabled: false,
    plan: "unknown",
    harness,
    scope: "harness",
    fiveHour: win("5h"),
    weekly: win("weekly"),
    turnsLastHour: 0,
    subagentsLastHour: 0,
    projectedFiveHour: 0,
    precise: false,
  };
}

function inferHarness(command: unknown): string {
  const text = Array.isArray(command) ? command.join(" ").toLowerCase() : "";
  if (text.includes("claude")) return "claude";
  if (text.includes("codex")) return "codex";
  if (text.includes("kimi")) return "kimi";
  return "unknown";
}

function readRuns(sinceMs: number, now: number, session?: string): { runs: AuditRunRow[]; unlinked: number } {
  const root = path.join(guardHome(), "runs");
  const runs: AuditRunRow[] = [];
  let unlinked = 0;
  if (!fs.existsSync(root)) return { runs, unlinked };

  for (const entry of fs.readdirSync(root)) {
    const file = path.join(root, entry, "report.json");
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      continue;
    }
    const startedAtMs =
      typeof raw["startedAtMs"] === "number" ? raw["startedAtMs"] : Date.parse(String(raw["startedAt"] ?? ""));
    if (!Number.isFinite(startedAtMs) || startedAtMs < sinceMs || startedAtMs > now) continue;

    const harness = typeof raw["harness"] === "string" ? raw["harness"] : inferHarness(raw["command"]);
    const sessionId = typeof raw["sessionId"] === "string" ? raw["sessionId"] : undefined;
    if (session) {
      if (sessionId === undefined) {
        unlinked++;
        continue;
      }
      if (sessionId !== session) continue;
    } else if (sessionId === undefined) {
      unlinked++;
    }

    const usage = (raw["tokenUsage"] ?? {}) as Record<string, unknown>;
    const num = (k: string): number => (typeof usage[k] === "number" ? (usage[k] as number) : 0);
    const tokens = {
      inputOther: num("input_other"),
      output: num("output"),
      cacheRead: num("input_cache_read"),
      cacheCreation: num("input_cache_creation"),
    };
    const cacheRatio = tokens.cacheRead > 0 ? tokens.cacheRead / Math.max(1, tokens.inputOther) : null;
    const stepRetries = Array.isArray(raw["stepRetries"]) ? raw["stepRetries"].length : 0;
    runs.push({
      runId: String(raw["runId"] ?? entry),
      harness,
      sessionId,
      startedAtMs,
      endReason: String(raw["endReason"] ?? "unknown"),
      tokens,
      cacheRatio,
      stepRetries,
    });
  }
  return { runs, unlinked };
}

export function buildAudit(opts: { session?: string; sinceMs?: number; harness?: string; now?: number } = {}): AuditReport {
  const now = opts.now ?? Date.now();
  const windowMs = opts.sinceMs ?? 86_400_000;
  const since = now - windowMs;
  const cfg = loadConfig();
  const harness = opts.harness ?? cfg.harness;
  const db = openAuditDb();

  const calls: CallRow[] = [];
  const events: EventRow[] = [];
  const blocks: BlockRow[] = [];
  if (db) {
    calls.push(...query<CallRow>(db, "SELECT session_id, tool_name, ts FROM calls WHERE ts >= ?", since));
    events.push(...query<EventRow>(db, "SELECT session_id, kind, meta_json, ts, harness FROM events WHERE ts >= ?", since));
    blocks.push(...query<BlockRow>(db, "SELECT session_id, tool_name, kind, ts FROM blocks WHERE ts >= ?", since));
  }
  const scopedCalls = calls.filter((c) => inScope(c.session_id, opts.session));
  const scopedEvents = events.filter((e) => inScope(e.session_id, opts.session));
  const scopedBlocks = blocks.filter((b) => inScope(b.session_id, opts.session));

  const sessionRows = new Map<string, AuditSessionRow>();
  const rowFor = (sessionId: string): AuditSessionRow => {
    const { parent } = parentOf(sessionId);
    let row = sessionRows.get(parent);
    if (!row) {
      row = { sessionId: parent, turns: 0, calls: 0, subagentCalls: 0, blocks: 0, lastTs: 0 };
      sessionRows.set(parent, row);
    }
    return row;
  };

  for (const c of scopedCalls) {
    const row = rowFor(c.session_id);
    row.calls++;
    if (parentOf(c.session_id).subagent) row.subagentCalls++;
    row.lastTs = Math.max(row.lastTs, c.ts);
  }
  for (const b of scopedBlocks) {
    const row = rowFor(b.session_id);
    row.blocks++;
    row.lastTs = Math.max(row.lastTs, b.ts);
  }

  const compaction = new Map<string, number>();
  const retryTimes: number[] = [];
  const agentDispatches = new Map<string, number>();
  const agentCalls = new Map<string, number>();
  const bucketMap = new Map<number, AuditBucket>();
  const harnessMap = new Map<string, { turns: number; subagents: number }>();
  let turns = 0;
  let dispatches = 0;
  let stepRetries = 0;
  let stopFailures = 0;
  let interrupts = 0;
  let stalls = 0;

  const bucket = (ts: number): AuditBucket => {
    const start = Math.floor(ts / FIFTEEN_MIN) * FIFTEEN_MIN;
    let b = bucketMap.get(start);
    if (!b) {
      b = { start, turns: 0, subagents: 0, blocks: 0 };
      bucketMap.set(start, b);
    }
    return b;
  };

  for (const e of scopedEvents) {
    const row = rowFor(e.session_id);
    row.lastTs = Math.max(row.lastTs, e.ts);
    if (e.harness) {
      const h = harnessMap.get(e.harness) ?? { turns: 0, subagents: 0 };
      if (e.kind === "turn") h.turns++;
      if (e.kind === "subagent") h.subagents++;
      harnessMap.set(e.harness, h);
    }
    if (e.harness !== harness) continue;

    if (e.kind === "turn") {
      turns++;
      row.turns++;
      bucket(e.ts).turns++;
    } else if (e.kind === "subagent") {
      dispatches++;
      bucket(e.ts).subagents++;
      const agent = String(parseMeta(e.meta_json)["agent"] ?? "") || "unknown";
      agentDispatches.set(agent, (agentDispatches.get(agent) ?? 0) + 1);
    } else if (e.kind === "compaction") {
      const phase = String(parseMeta(e.meta_json)["phase"] ?? "");
      if (phase === "pre" || phase === "wire") {
        const { parent } = parentOf(e.session_id);
        compaction.set(parent, (compaction.get(parent) ?? 0) + 1);
      }
    } else if (e.kind === "step_retry") {
      stepRetries++;
      retryTimes.push(e.ts);
    } else if (e.kind === "stop_failure") {
      stopFailures++;
      retryTimes.push(e.ts);
    } else if (e.kind === "interrupt") {
      interrupts++;
      retryTimes.push(e.ts);
    } else if (e.kind === "stall") {
      stalls++;
    }
  }
  for (const c of scopedCalls) {
    const sub = parentOf(c.session_id).subagent;
    if (sub) agentCalls.set(sub, (agentCalls.get(sub) ?? 0) + 1);
  }
  for (const b of scopedBlocks) bucket(b.ts).blocks++;

  const sessions = [...sessionRows.values()].sort((a, b) => b.lastTs - a.lastTs);
  const toolsMap = new Map<string, number>();
  for (const c of scopedCalls) toolsMap.set(c.tool_name, (toolsMap.get(c.tool_name) ?? 0) + 1);
  const tools = [...toolsMap.entries()]
    .map(([tool, n]) => ({ tool, calls: n }))
    .sort((a, b) => b.calls - a.calls);
  const agentNames = new Set([...agentDispatches.keys(), ...agentCalls.keys()]);
  const agents = [...agentNames]
    .map((agent) => ({ agent, dispatches: agentDispatches.get(agent) ?? 0, calls: agentCalls.get(agent) ?? 0 }))
    .sort((a, b) => b.dispatches - a.dispatches || b.calls - a.calls);
  const harnessBreakdown = [...harnessMap.entries()]
    .map(([h, v]) => ({ harness: h, turns: v.turns, subagents: v.subagents }))
    .sort((a, b) => b.turns - a.turns);

  retryTimes.sort((a, b) => a - b);
  let maxIn30Min = 0;
  for (let i = 0, j = 0; i < retryTimes.length; i++) {
    while (retryTimes[i]! - retryTimes[j]! > THIRTY_MIN) j++;
    maxIn30Min = Math.max(maxIn30Min, i - j + 1);
  }

  const blocksByKindMap = new Map<string, number>();
  for (const b of scopedBlocks) blocksByKindMap.set(b.kind, (blocksByKindMap.get(b.kind) ?? 0) + 1);
  const blocksByKind = [...blocksByKindMap.entries()].map(([kind, n]) => ({ kind, n }));
  const { runs, unlinked } = readRuns(since, now, opts.session);

  const budget = db
    ? budgetSnapshot(cfg.budget, harness, now, opts.session, db)
    : emptyBudget(harness);
  const totals: AuditTotals = {
    sessions: sessions.length,
    calls: scopedCalls.length,
    subagentCalls: scopedCalls.filter((c) => parentOf(c.session_id).subagent).length,
    turns,
    subagentDispatches: dispatches,
    blocks: scopedBlocks.length,
  };

  const findings = auditFindings({
    now,
    windowMs,
    reservePercent: cfg.budget.reservePercent,
    subagentWeight: cfg.budget.subagentWeight,
    budget,
    totals,
    sessions: sessions.map((s) => ({ sessionId: s.sessionId, compactionCycles: compaction.get(s.sessionId) ?? 0 })),
    retries: { stepRetries, stopFailures, interrupts, maxIn30Min },
    runs: runs.map((r) => ({ runId: r.runId, cacheRatio: r.cacheRatio })),
    stalls,
    blocksByKind,
  });

  return {
    generatedAt: now,
    scope: { session: opts.session, sinceMs: windowMs, harness },
    budget,
    totals,
    timeline: [...bucketMap.values()].sort((a, b) => a.start - b.start),
    sessions,
    agents,
    tools,
    harnessBreakdown,
    retries: { stepRetries, stopFailures, interrupts, maxIn30Min },
    runs,
    runsUnlinked: unlinked,
    findings,
    provenance: {
      observed: ["calls", "turns", "subagent dispatches", "blocks", "retries", "session/agent attribution", "supervised run tokens"],
      estimated: ["request burn", "projected 5h usage"],
      inferred: ["subagent weighted share", "cache-amplification interpretation"],
    },
  };
}

function clock(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function humanDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem === 0 ? `${h}h` : `${h}h${String(rem).padStart(2, "0")}m`;
}

export function formatAudit(r: AuditReport): string {
  const t = r.totals;
  const lines: string[] = [];
  lines.push(`agentguard audit · last ${humanDuration(r.scope.sinceMs)} · events harness=${r.scope.harness} (calls/blocks: all harnesses) · budget=${r.budget.precise ? "precise" : "estimate"}`);
  if (r.scope.session) lines.push(`session: ${r.scope.session} (includes subagents)`);
  lines.push("");
  lines.push(
    `usage   5h ${r.budget.fiveHour.percent}% (resets in ${humanDuration(r.budget.fiveHour.resetsInMs)}) · weekly ${r.budget.weekly.percent}%`,
  );
  lines.push(
    `volume  ${t.calls} calls (${t.subagentCalls} subagent) · ${t.turns} turns · ${t.subagentDispatches} subagent dispatches · ${t.blocks} blocks · ${t.sessions} sessions`,
  );
  lines.push("");

  const shown = r.timeline.filter((b) => b.turns || b.subagents || b.blocks).slice(-24);
  if (shown.length > 0) {
    const max = Math.max(1, ...shown.map((b) => b.turns + b.subagents));
    lines.push("burn (15m buckets, turns/subagents)");
    for (const b of shown) {
      const width = Math.max(1, Math.round(((b.turns + b.subagents) / max) * 24));
      lines.push(`  ${clock(b.start)} ${"█".repeat(width)} ${b.turns}/${b.subagents}${b.blocks ? ` · ${b.blocks} blocks` : ""}`);
    }
    lines.push("");
  }

  if (r.sessions.length > 0) {
    lines.push("top sessions");
    for (const s of r.sessions.slice(0, 5)) {
      lines.push(`  ${s.sessionId.slice(0, 24)}  ${s.turns} turns  ${s.calls} calls  ${s.blocks} blocks`);
    }
    lines.push("");
  }
  if (r.agents.length > 0) lines.push(`agents: ${r.agents.map((a) => `${a.agent}×${a.dispatches}/${a.calls}`).join(" · ")}`);
  if (r.tools.length > 0) lines.push(`tools:  ${r.tools.slice(0, 6).map((x) => `${x.tool}×${x.calls}`).join(" · ")}`);
  lines.push(`retries: step_retry ${r.retries.stepRetries} · stop_failure ${r.retries.stopFailures} · interrupt ${r.retries.interrupts}`);
  if (r.runs.length > 0) {
    lines.push("supervised runs");
    for (const run of r.runs) {
      const ratio = run.cacheRatio === null ? "n/a" : `${run.cacheRatio.toFixed(1)}x`;
      lines.push(
        `  ${run.runId}  ${run.harness}  ${run.endReason}  tokens in ${run.tokens.inputOther} / cache ${run.tokens.cacheRead} (${ratio}) / out ${run.tokens.output}`,
      );
    }
  } else {
    lines.push("supervised runs: none (hooks-only mode has no token detail)");
  }
  if (r.runsUnlinked > 0) lines.push(`runs without session linkage: ${r.runsUnlinked} (excluded from session scope)`);
  lines.push("");

  if (r.findings.length > 0) {
    lines.push("findings");
    for (const f of r.findings) {
      lines.push(`  ${f.severity === "warn" ? "⚠" : "ℹ"} ${f.id}  ${f.evidence}`);
      lines.push(`     ${f.advice}`);
    }
  } else {
    lines.push("findings: none");
  }
  lines.push("");
  lines.push("provenance");
  lines.push(`  observed: ${r.provenance.observed.join(", ")}`);
  lines.push(`  estimated: ${r.provenance.estimated.join(", ")}`);
  lines.push(`  inferred: ${r.provenance.inferred.join(", ")}`);
  return lines.join("\n");
}

export function auditToMarkdown(r: AuditReport): string {
  const t = r.totals;
  const lines: string[] = [
    `# agentguard audit · last ${humanDuration(r.scope.sinceMs)}`,
    "",
    `_events harness=${r.scope.harness}; calls/blocks are all harnesses; budget=${r.budget.precise ? "precise" : "estimate"}_`,
    "",
    "| metric | value |",
    "|---|---|",
    `| calls | ${t.calls} (${t.subagentCalls} subagent) |`,
    `| turns | ${t.turns} |`,
    `| subagent dispatches | ${t.subagentDispatches} |`,
    `| blocks | ${t.blocks} |`,
    `| sessions | ${t.sessions} |`,
    `| 5h / weekly | ${r.budget.fiveHour.percent}% / ${r.budget.weekly.percent}% |`,
  ];
  if (r.findings.length > 0) {
    lines.push("", "## findings", "");
    for (const f of r.findings) lines.push(`- **${f.id}** (${f.severity}): ${f.evidence} — ${f.advice}`);
  }
  lines.push("", "## provenance", "");
  lines.push(`- observed: ${r.provenance.observed.join(", ")}`);
  lines.push(`- estimated: ${r.provenance.estimated.join(", ")}`);
  lines.push(`- inferred: ${r.provenance.inferred.join(", ")}`);
  return `${lines.join("\n")}\n`;
}