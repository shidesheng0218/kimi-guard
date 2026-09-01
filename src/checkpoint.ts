import fs from "node:fs";
import path from "node:path";
import { callsSince, knownSessions, recordEvent } from "./store.js";
import { guardHome } from "./paths.js";

export interface Checkpoint {
  sessionId: string;
  path: string;
  brief: string;
  reason: string;
  ts: number;
}

const EDIT_TOOLS = new Set(["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit", "NotebookEdit"]);

function argSummary(argsJson: string, max = 100): string {
  try {
    const obj = JSON.parse(argsJson) as Record<string, unknown>;
    const parts: string[] = [];
    for (const [k, v] of Object.entries(obj)) {
      const s = typeof v === "string" ? v : JSON.stringify(v);
      parts.push(`${k}=${s.length > 60 ? s.slice(0, 57) + "..." : s}`);
    }
    const joined = parts.join(", ");
    return joined.length > max ? joined.slice(0, max - 3) + "..." : joined || "{}";
  } catch {
    return argsJson.slice(0, max);
  }
}

/**
 * Build an observed "research state" brief from the call history:
 * files touched, commands run, searches made, edits, and guard interventions.
 * This is what a resumed session needs to avoid re-exploring from scratch.
 */
export function buildBrief(sessionId: string, now = Date.now(), windowMs = 6 * 3_600_000): string {
  const calls = callsSince(sessionId, now - windowMs, 1000);
  if (calls.length === 0) return "";

  const files = new Map<string, { reads: number; edits: number }>();
  const commands: string[] = [];
  const searches: string[] = [];
  const failures: string[] = [];

  for (const r of calls) {
    const summary = argSummary(r.args_json, 90);
    if (EDIT_TOOLS.has(r.tool_name) && r.file_path) {
      const f = files.get(r.file_path) ?? { reads: 0, edits: 0 };
      f.edits++;
      files.set(r.file_path, f);
    } else if (r.file_path && (r.tool_name === "ReadFile" || r.tool_name === "Read")) {
      const f = files.get(r.file_path) ?? { reads: 0, edits: 0 };
      f.reads++;
      files.set(r.file_path, f);
    }
    if (r.tool_name === "Shell" || r.tool_name === "Bash") commands.push(summary);
    if (r.tool_name === "Grep" || r.tool_name === "Glob") searches.push(summary);
    if (r.status === "failure") failures.push(`${r.tool_name}: ${summary}`);
  }

  const lines: string[] = [];
  lines.push("## Observed activity (auto-captured by kimi-guard)");
  lines.push("");
  if (files.size > 0) {
    lines.push("### Files touched");
    for (const [f, c] of [...files.entries()].slice(0, 25)) {
      lines.push(`- ${f} (read ×${c.reads}, edited ×${c.edits})`);
    }
    lines.push("");
  }
  if (commands.length > 0) {
    lines.push("### Commands run (most recent last)");
    for (const c of commands.slice(-10)) lines.push(`- ${c}`);
    lines.push("");
  }
  if (searches.length > 0) {
    lines.push("### Searches performed (results are already known — do not redo them)");
    const seen = new Set<string>();
    for (const s of searches.slice(-15)) {
      if (seen.has(s)) continue;
      seen.add(s);
      lines.push(`- ${s}`);
    }
    lines.push("");
  }
  if (failures.length > 0) {
    lines.push("### Failed calls (avoid repeating these)");
    const seen = new Set<string>();
    for (const f of failures.slice(-8)) {
      if (seen.has(f)) continue;
      seen.add(f);
      lines.push(`- ${f}`);
    }
    lines.push("");
  }
  lines.push(`Total recorded tool calls in window: ${calls.length}`);
  return lines.join("\n");
}

export function captureCheckpoint(sessionId: string, reason: string, now = Date.now()): Checkpoint | null {
  const brief = buildBrief(sessionId, now);
  if (!brief) return null;
  const dir = path.join(guardHome(), "checkpoints", sessionId.replace(/[^\w.-]/g, "_"));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${now}-${reason.replace(/[^\w-]/g, "_")}.md`);
  const header = [
    `# kimi-guard checkpoint`,
    ``,
    `- session: ${sessionId}`,
    `- time: ${new Date(now).toISOString()}`,
    `- reason: ${reason}`,
    ``,
  ].join("\n");
  fs.writeFileSync(file, header + brief + "\n", "utf8");
  recordEvent(sessionId, "checkpoint", { reason, file }, now);
  return { sessionId, path: file, brief, reason, ts: now };
}

export function latestSessionId(): string | null {
  const sessions = knownSessions(1);
  return sessions[0]?.session_id ?? null;
}

export function latestCheckpointFile(sessionId?: string): string | null {
  const base = path.join(guardHome(), "checkpoints");
  if (!fs.existsSync(base)) return null;
  let dir = sessionId ? path.join(base, sessionId.replace(/[^\w.-]/g, "_")) : "";
  if (!dir || !fs.existsSync(dir)) {
    const dirs = fs
      .readdirSync(base)
      .map((d) => ({ d, m: fs.statSync(path.join(base, d)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (dirs.length === 0) return null;
    dir = path.join(base, dirs[0]!.d);
  }
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();
  return files[0] ? path.join(dir, files[0]) : null;
}

export function renderResumeBlock(brief: string, reason: string): string {
  return [
    `<kimi-guard-resume reason="${reason}">`,
    "You are resuming a task that was interrupted. Use the observed state below as verified",
    "prior knowledge. Do NOT re-explore files you have already read, do NOT redo searches",
    "listed here, and do NOT repeat failed calls. Continue from the last known state.",
    "",
    brief,
    "</kimi-guard-resume>",
  ].join("\n");
}
