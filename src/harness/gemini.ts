import fs from "node:fs";
import path from "node:path";
import { geminiSettingsPath } from "../paths.js";

/**
 * Gemini CLI hooks live in ~/.gemini/settings.json under a top-level "hooks"
 * object: event → array of { matcher, hooks: [{ type: "command", command, timeout(ms) }] }.
 * Our entries are identified by the command marker. Idempotent; backs up first.
 */
export const GEMINI_COMMAND_MARKER = "agentguard hook";

/** Gemini events the guard handles (mapped internally to our event names). */
const GEMINI_EVENTS = ["BeforeTool", "AfterTool", "BeforeAgent", "AfterAgent", "PreCompress", "SessionEnd"];

interface GeminiHookHandler {
  type: string;
  command: string;
  timeout?: number;
  name?: string;
}

interface GeminiHookGroup {
  matcher?: string;
  sequential?: boolean;
  hooks: GeminiHookHandler[];
}

type Settings = Record<string, unknown> & { hooks?: Record<string, GeminiHookGroup[]> };

function isOurs(group: GeminiHookGroup): boolean {
  return (group.hooks ?? []).some((h) => typeof h.command === "string" && h.command.includes(GEMINI_COMMAND_MARKER));
}

function ourGroup(event: string, bin: string): GeminiHookGroup {
  return {
    matcher: "",
    sequential: false,
    hooks: [{ type: "command", command: `${bin} hook ${event} --harness gemini`, timeout: 5000, name: "agentguard" }],
  };
}

export interface GeminiInstallResult {
  configPath: string;
  created: boolean;
  updated: boolean;
  backupPath?: string;
}

export function installGeminiHooks(bin = "agentguard"): GeminiInstallResult {
  const configPath = geminiSettingsPath();
  const created = !fs.existsSync(configPath);
  let settings: Settings = {};
  let backupPath: string | undefined;

  if (!created) {
    const raw = fs.readFileSync(configPath, "utf8");
    try {
      settings = JSON.parse(raw) as Settings;
    } catch {
      backupPath = `${configPath}.agentguard.bak`;
      fs.copyFileSync(configPath, backupPath);
      settings = {};
    }
    if (!backupPath) {
      backupPath = `${configPath}.agentguard.bak`;
      fs.writeFileSync(backupPath, raw, "utf8");
    }
  }

  const hooks = (settings.hooks ??= {});
  let updated = false;
  for (const event of GEMINI_EVENTS) {
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

export function uninstallGeminiHooks(): { configPath: string; removed: boolean } {
  const configPath = geminiSettingsPath();
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

export function geminiHooksInstalled(configPath = geminiSettingsPath()): boolean {
  try {
    const settings = JSON.parse(fs.readFileSync(configPath, "utf8")) as Settings;
    return Object.values(settings.hooks ?? {}).some((groups) => groups.some(isOurs));
  } catch {
    return false;
  }
}
