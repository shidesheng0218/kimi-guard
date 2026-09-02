import fs from "node:fs";
import path from "node:path";
import { claudeSettingsPath } from "../paths.js";

/**
 * Claude Code hooks live in ~/.claude/settings.json (JSON, no comment syntax).
 * Our entries are identified by the command marker instead of TOML comments.
 * Idempotent: existing entries with our marker are replaced in place.
 */
export const CLAUDE_COMMAND_MARKER = "agentguard hook";

/** Events we install for Claude Code (33 exist; these are the ones the guard handles). */
const CLAUDE_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Stop",
  "SubagentStart",
  "SessionStart",
  "SessionEnd",
  "PreCompact",
  "PostCompact",
  "StopFailure",
];

const CLAUDE_EVENTS_COMPAT = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];

interface ClaudeHookHandler {
  type: string;
  command: string;
  timeout?: number;
}

interface ClaudeHookGroup {
  matcher?: string;
  hooks: ClaudeHookHandler[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, ClaudeHookGroup[]> };

function isOurs(group: ClaudeHookGroup): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(CLAUDE_COMMAND_MARKER));
}

function ourGroup(event: string, bin: string): ClaudeHookGroup {
  return {
    matcher: "",
    hooks: [{ type: "command", command: `${bin} hook ${event} --harness claude`, timeout: 5 }],
  };
}

export interface ClaudeInstallResult {
  configPath: string;
  created: boolean;
  updated: boolean;
  backupPath?: string;
}

export function installClaudeHooks(bin = "agentguard", compat = false): ClaudeInstallResult {
  const configPath = claudeSettingsPath();
  const created = !fs.existsSync(configPath);
  let settings: Settings = {};
  let backupPath: string | undefined;

  if (!created) {
    const raw = fs.readFileSync(configPath, "utf8");
    try {
      settings = JSON.parse(raw) as Settings;
    } catch {
      // don't clobber a malformed file — back it up and start the hooks section fresh
      backupPath = `${configPath}.agentguard.bak`;
      fs.copyFileSync(configPath, backupPath);
      settings = {};
    }
    if (!backupPath) {
      backupPath = `${configPath}.agentguard.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
  }

  const events = compat ? CLAUDE_EVENTS_COMPAT : CLAUDE_EVENTS;
  const hooks = (settings.hooks ??= {});
  let updated = false;
  for (const event of events) {
    const groups = (hooks[event] ?? []).filter((g) => !isOurs(g));
    const before = JSON.stringify(hooks[event] ?? []);
    groups.push(ourGroup(event, bin));
    hooks[event] = groups;
    if (JSON.stringify(groups) !== before) updated = true;
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { configPath, created, updated: updated || created, backupPath: created ? undefined : backupPath };
}

export function uninstallClaudeHooks(): { configPath: string; removed: boolean } {
  const configPath = claudeSettingsPath();
  if (!fs.existsSync(configPath)) return { configPath, removed: false };
  let settings: Settings;
  try {
    settings = JSON.parse(fs.readFileSync(configPath, "utf8")) as Settings;
  } catch {
    return { configPath, removed: false };
  }
  const hooks = settings.hooks;
  if (!hooks) return { configPath, removed: false };
  let removed = false;
  for (const event of Object.keys(hooks)) {
    const kept = hooks[event]!.filter((g) => !isOurs(g));
    if (kept.length !== hooks[event]!.length) removed = true;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }
  if (removed) fs.writeFileSync(configPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
  return { configPath, removed };
}

export function claudeHooksInstalled(configPath = claudeSettingsPath()): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8")) as Settings;
    return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isOurs));
  } catch {
    return false;
  }
}
