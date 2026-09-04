import fs from "node:fs";
import path from "node:path";
import { guardHome } from "./paths.js";

/**
 * Replay a recorded run as an annotated timeline. Reads the raw logs the
 * supervisors already write: wire.jsonl (Kimi Wire) or stream.jsonl (Claude).
 * Parser is defensive — unknown lines are skipped, never fatal.
 */

export interface TimelineEvent {
  ts: number;
  kind: "call" | "result" | "block" | "steer" | "step" | "end" | "other";
  label: string;
}

export function listRuns(): Array<{ runId: string; mtime: number }> {
  const base = path.join(guardHome(), "runs");
  if (!fs.existsSync(base)) return [];
  return fs
    .readdirSync(base)
    .filter((d) => {
      const dir = path.join(base, d);
      return fs.statSync(dir).isDirectory() && (fs.existsSync(path.join(dir, "wire.jsonl")) || fs.existsSync(path.join(dir, "stream.jsonl")));
    })
    .map((d) => ({ runId: d, mtime: fs.statSync(path.join(base, d)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
}

function shortArgs(raw: string, max = 72): string {
  const s = raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
  return s.replace(/\s+/g, " ").trim();
}

function parseWireLine(dir: string, line: string, events: TimelineEvent[]): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  const method = msg["method"];
  // wire.jsonl direction is from the client's perspective: server events are "in"
  if (dir === "in" && method === "event") {
    const params = msg["params"] as { type?: string; payload?: Record<string, unknown> } | undefined;
    const type = params?.type;
    const p = params?.payload ?? {};
    if (type === "ToolCall") {
      const fn = p["function"] as { name?: string; arguments?: string } | undefined;
      events.push({ ts: 0, kind: "call", label: `${fn?.name ?? "?"} ${shortArgs(String(fn?.arguments ?? "{}"))}` });
    } else if (type === "ToolResult") {
      const rv = p["return_value"] as { is_error?: boolean } | undefined;
      events.push({ ts: 0, kind: "result", label: rv?.is_error ? "result (error)" : "result" });
    } else if (type === "StepBegin") {
      events.push({ ts: 0, kind: "step", label: `step ${p["n"] ?? "?"}` });
    } else if (type === "TurnEnd") {
      events.push({ ts: 0, kind: "end", label: "turn end" });
    }
  }
  if (dir === "out" && msg["id"] !== undefined && msg["result"]) {
    const result = msg["result"] as Record<string, unknown>;
    if (typeof result["action"] === "string") {
      if (result["action"] === "block") {
        events.push({ ts: 0, kind: "block", label: shortArgs(String(result["reason"] ?? "blocked"), 96) });
      }
    } else if (typeof result["status"] === "string" && result["status"] === "steered") {
      events.push({ ts: 0, kind: "steer", label: "steered" });
    }
  }
}

function parseStreamLine(line: string, events: TimelineEvent[]): void {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return;
  }
  if (msg["type"] === "assistant") {
    const content = (msg["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
    for (const block of content) {
      if (block["type"] === "tool_use") {
        events.push({ ts: 0, kind: "call", label: `${block["name"] ?? "?"} ${shortArgs(JSON.stringify(block["input"] ?? {}))}` });
      }
    }
  } else if (msg["type"] === "user") {
    const content = (msg["message"] as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [];
    for (const block of content) {
      if (block["type"] === "tool_result") {
        events.push({ ts: 0, kind: "result", label: block["is_error"] ? "result (error)" : "result" });
      }
    }
  } else if (msg["type"] === "result") {
    events.push({ ts: 0, kind: "end", label: `result: ${msg["subtype"] ?? "?"}${msg["is_error"] ? " (error)" : ""}` });
  }
}

export function parseRunLog(runId: string): TimelineEvent[] {
  const dir = path.join(guardHome(), "runs", runId);
  const wirePath = path.join(dir, "wire.jsonl");
  const streamPath = path.join(dir, "stream.jsonl");
  const events: TimelineEvent[] = [];
  if (fs.existsSync(wirePath)) {
    for (const line of fs.readFileSync(wirePath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec: { dir?: string; ts?: number; line?: string };
      try {
        rec = JSON.parse(line) as typeof rec;
      } catch {
        continue;
      }
      const before = events.length;
      parseWireLine(rec.dir ?? "", String(rec.line ?? ""), events);
      for (let i = before; i < events.length; i++) events[i]!.ts = rec.ts ?? 0;
    }
  } else if (fs.existsSync(streamPath)) {
    for (const line of fs.readFileSync(streamPath, "utf8").split("\n")) {
      if (line.trim()) parseStreamLine(line, events);
    }
  }
  return events;
}

const SYMBOLS: Record<TimelineEvent["kind"], string> = {
  call: "→",
  result: "←",
  block: "✖",
  steer: "≈",
  step: "·",
  end: "■",
  other: " ",
};

export function renderTimeline(events: TimelineEvent[]): string {
  if (events.length === 0) return "(no events in this run's log)";
  const t0 = events[0]!.ts || 0;
  const lines = events.map((e) => {
    const rel = e.ts && t0 ? `+${((e.ts - t0) / 1000).toFixed(1)}s` : "     ";
    const sym = SYMBOLS[e.kind];
    const pad = e.kind === "result" ? "     " : "";
    const marker = e.kind === "block" ? " 🔴" : "";
    return `${rel.padStart(7)}  ${sym} ${pad}${e.label}${marker}`;
  });
  const blocks = events.filter((e) => e.kind === "block").length;
  const calls = events.filter((e) => e.kind === "call").length;
  lines.push("", `  ${calls} calls · ${blocks} blocks · ${events.length} events`);
  return lines.join("\n");
}

export async function playTimeline(events: TimelineEvent[], speed = 2): Promise<void> {
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  for (const e of events) {
    console.log(`${SYMBOLS[e.kind]} ${e.label}${e.kind === "block" ? " 🔴" : ""}`);
    await sleep(300 / speed);
  }
}
