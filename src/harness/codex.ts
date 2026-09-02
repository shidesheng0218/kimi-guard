import fs from "node:fs";
import path from "node:path";
import { codexHooksPath } from "../paths.js";

/**
 * Codex CLI hooks live in ~/.codex/hooks.json (event → matcher groups →
 * handlers). Our entries are identified by the command marker. Idempotent:
 * existing entries with our marker are replaced in place.
 */
export const CODEX_COMMAND_MARKER = "agentguard hook";

/** Codex events the guard handles (PascalCase in config; no PostToolUseFailure exists). */
const CODEX_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "Interrupt",
];

const CODEX_EVENTS_COMPAT = ["PreToolUse", "PostToolUse"];

interface CodexHookHandler {
  type: string;
  command: string;
  timeout?: number;
}

interface CodexHookGroup {
  matcher?: string;
  hooks: CodexHookHandler[];
}

type HooksFile = Record<string, unknown> & { hooks?: Record<string, CodexHookGroup[]> };

function isOurs(group: CodexHookGroup): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(CODEX_COMMAND_MARKER));
}

function ourGroup(event: string, bin: string): CodexHookGroup {
  return {
    matcher: "",
    hooks: [{ type: "command", command: `${bin} hook ${event} --harness codex`, timeout: 5 }],
  };
}

export interface CodexInstallResult {
  configPath: string;
  created: boolean;
  updated: boolean;
  backupPath?: string;
}

export function installCodexHooks(bin = "agentguard", compat = false): CodexInstallResult {
  const configPath = codexHooksPath();
  const created = !fs.existsSync(configPath);
  let file: HooksFile = {};
  let backupPath: string | undefined;

  if (!created) {
    const raw = fs.readFileSync(configPath, "utf8");
    try {
      file = JSON.parse(raw) as HooksFile;
    } catch {
      backupPath = `${configPath}.agentguard.bak`;
      fs.copyFileSync(configPath, backupPath);
      file = {};
    }
    if (!backupPath) {
      backupPath = `${configPath}.agentguard.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
  }

  const events = compat ? CODEX_EVENTS_COMPAT : CODEX_EVENTS;
  const hooks = (file.hooks ??= {});
  let updated = false;
  for (const event of events) {
    const groups = (hooks[event] ?? []).filter((g) => !isOurs(g));
    const before = JSON.stringify(hooks[event] ?? []);
    groups.push(ourGroup(event, bin));
    hooks[event] = groups;
    if (JSON.stringify(groups) !== before) updated = true;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  return { configPath, created, updated: updated || created, backupPath: created ? undefined : backupPath };
}

export function uninstallCodexHooks(): { configPath: string; removed: boolean } {
  const configPath = codexHooksPath();
  if (!fs.existsSync(configPath)) return { configPath, removed: false };
  let file: HooksFile;
  try {
    file = JSON.parse(fs.readFileSync(configPath, "utf8")) as HooksFile;
  } catch {
    return { configPath, removed: false };
  }
  const hooks = file.hooks;
  if (!hooks) return { configPath, removed: false };
  let removed = false;
  for (const event of Object.keys(hooks)) {
    const kept = hooks[event]!.filter((g) => !isOurs(g));
    if (kept.length !== hooks[event]!.length) removed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed) fs.writeFileSync(configPath, JSON.stringify(file, null, 2) + "\n", "utf8");
  return { configPath, removed };
}

export function codexHooksInstalled(configPath = codexHooksPath()): boolean {
  try {
    const file = JSON.parse(fs.readFileSync(configPath, "utf8")) as HooksFile;
    return Object.values(file.hooks ?? {}).some((groups) => groups.some(isOurs));
  } catch {
    return false;
  }
}
