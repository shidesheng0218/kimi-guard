import { createHash } from "node:crypto";

export interface HookPayload {
  [k: string]: unknown;
}

export interface NormalizedCall {
  sessionId: string;
  tool: string;
  args: unknown;
  argsHash: string;
  argsJson: string;
  outputHash: string | null;
  filePath: string | null;
  status: "ok" | "failure";
  ts: number;
}

function pickString(payload: HookPayload, keys: string[]): string {
  for (const k of keys) {
    const v = payload[k];
    if (typeof v === "string" && v) return v;
  }
  return "";
}

export function pickField(payload: HookPayload, keys: string[]): unknown {
  for (const k of keys) {
    if (payload[k] !== undefined) return payload[k];
  }
  return undefined;
}

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function sortDeep(value: unknown, collapseStrings: boolean): Json {
  if (Array.isArray(value)) return value.map((x) => sortDeep(x, collapseStrings));
  if (value !== null && typeof value === "object") {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = sortDeep((value as Record<string, unknown>)[k], collapseStrings);
    }
    return out;
  }
  if (value === undefined) return null;
  if (typeof value === "string") return collapseStrings ? collapseWs(value) : value;
  return value as Json;
}

/**
 * Tools whose string arguments are whitespace-sensitive: a shell command,
 * grep pattern or file write whose whitespace differs IS a different call,
 * so collapsing it would produce false "repeat" blocks. For everything else,
 * whitespace differences carry no semantic weight and are collapsed.
 */
const WHITESPACE_SENSITIVE = new Set(["Shell", "Bash", "Grep", "Glob", "FetchURL", "SearchWeb", "ReadFile", "WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit"]);

/**
 * Near-duplicate tolerant fingerprint: deep key-sorted JSON with collapsed
 * whitespace inside string values, except for whitespace-sensitive tools
 * where the original whitespace is preserved.
 */
export function fingerprint(tool: string, args: unknown): string {
  let v: unknown = args ?? {};
  if (v === null || typeof v !== "object") v = { value: v ?? null };
  const normalized = sortDeep(v, !WHITESPACE_SENSITIVE.has(tool));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex").slice(0, 16);
}

export function hashOutput(output: unknown): string | null {
  if (output === undefined || output === null) return null;
  let s: string;
  if (typeof output === "string") s = output;
  else {
    try {
      s = JSON.stringify(sortDeep(output, false));
    } catch {
      s = String(output);
    }
  }
  s = collapseWs(s).slice(0, 4096);
  if (!s) return null;
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}

const FILE_KEYS = ["file_path", "filePath", "path", "file", "filename", "notebook_path", "target"];

export function extractFile(args: unknown): string | null {
  if (args === null || typeof args !== "object") return null;
  const obj = args as Record<string, unknown>;
  for (const k of FILE_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v) return v;
  }
  return null;
}

export function normalizeCall(payload: HookPayload, event: string, ts = Date.now()): NormalizedCall | null {
  const sessionId = pickString(payload, ["session_id", "sessionId", "session", "sessionID"]) || "unknown";
  const tool = pickString(payload, ["tool_name", "toolName", "tool"]);
  if (!tool) return null;
  const args = pickField(payload, ["tool_input", "toolInput", "input"]) ?? {};
  const outputKeys = ["tool_output", "toolOutput", "output", "result"];
  const output =
    event === "PostToolUse"
      ? pickField(payload, outputKeys)
      : event === "PostToolUseFailure"
        ? pickField(payload, ["error", "error_message", ...outputKeys])
        : undefined;
  const argsJson = JSON.stringify(args).slice(0, 2048);
  return {
    sessionId,
    tool,
    args,
    argsHash: fingerprint(tool, args),
    argsJson,
    outputHash: output !== undefined ? hashOutput(output) : null,
    filePath: extractFile(args),
    status: event === "PostToolUseFailure" ? "failure" : "ok",
    ts,
  };
}
