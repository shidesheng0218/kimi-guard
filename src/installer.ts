import fs from "node:fs";
import path from "node:path";
import { detectKimiConfig } from "./paths.js";

export const MANAGED_BEGIN = "# >>> kimi-guard managed >>> DO NOT EDIT";
export const MANAGED_END = "# <<< kimi-guard <<<";

interface HookRule {
  event: string;
  matcher?: string;
  command: string;
  timeout: number;
}

export function hookRules(commandName = "kguard", compat = false): HookRule[] {
  const c = (event: string): string => `${commandName} hook ${event}`;
  const base: HookRule[] = [
    { event: "PreToolUse", command: c("PreToolUse"), timeout: 5 },
    { event: "PostToolUse", command: c("PostToolUse"), timeout: 5 },
    { event: "PostToolUseFailure", command: c("PostToolUseFailure"), timeout: 5 },
  ];
  if (compat) return base;
  return [
    ...base,
    { event: "Stop", command: c("Stop"), timeout: 5 },
    { event: "TurnStarted", command: c("TurnStarted"), timeout: 5 },
    { event: "SubagentStart", command: c("SubagentStart"), timeout: 5 },
    { event: "StopFailure", command: c("StopFailure"), timeout: 5 },
    { event: "Interrupt", command: c("Interrupt"), timeout: 5 },
    { event: "SessionEnd", command: c("SessionEnd"), timeout: 5 },
    { event: "PreCompact", command: c("PreCompact"), timeout: 5 },
    { event: "PostCompact", command: c("PostCompact"), timeout: 5 },
  ];
}

function tomlStr(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function hookToToml(h: HookRule): string {
  const lines = ["[[hooks]]", `event = "${tomlStr(h.event)}"`, `command = "${tomlStr(h.command)}"`];
  if (h.matcher) lines.push(`matcher = "${tomlStr(h.matcher)}"`);
  lines.push(`timeout = ${h.timeout}`);
  return lines.join("\n");
}

export function managedBlock(commandName = "kguard", compat = false): string {
  return [MANAGED_BEGIN, ...hookRules(commandName, compat).map(hookToToml), MANAGED_END].join("\n");
}

function findManagedBlock(text: string): { start: number; end: number } | undefined {
  const begin = text.indexOf(MANAGED_BEGIN);
  if (begin < 0) return undefined;
  const end = text.indexOf(MANAGED_END, begin);
  if (end < 0) return undefined;
  return { start: begin, end: end + MANAGED_END.length };
}

export interface InstallResult {
  configPath: string;
  created: boolean;
  replaced: boolean;
  backupPath?: string;
}

export function installHooks(commandName = "kguard", compat = false): InstallResult {
  const { path: configPath, exists } = detectKimiConfig();
  const created = !exists;
  let text = exists ? fs.readFileSync(configPath, "utf8") : "";

  const block = findManagedBlock(text);
  const replaced = block !== undefined;
  if (exists && !replaced) {
    const backupPath = `${configPath}.kimi-guard.bak`;
    fs.writeFileSync(backupPath, text, "utf8");
  }

  const newBlock = managedBlock(commandName, compat);
  if (block) {
    text = text.slice(0, block.start) + newBlock + text.slice(block.end);
  } else {
    const prefix = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    text = text + prefix + newBlock + "\n";
  }

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, text, "utf8");
  return {
    configPath,
    created,
    replaced,
    backupPath: exists && !replaced ? `${configPath}.kimi-guard.bak` : undefined,
  };
}

export function uninstallHooks(): { configPath: string; removed: boolean } {
  const { path: configPath, exists } = detectKimiConfig();
  if (!exists) return { configPath, removed: false };
  const text = fs.readFileSync(configPath, "utf8");
  const block = findManagedBlock(text);
  if (!block) return { configPath, removed: false };
  let out = text.slice(0, block.start) + text.slice(block.end);
  out = out.replace(/^\n{2,}/, "\n");
  fs.writeFileSync(configPath, out, "utf8");
  return { configPath, removed: true };
}

export function hooksInstalled(configPath?: string): boolean {
  const p = configPath ?? detectKimiConfig().path;
  try {
    return fs.readFileSync(p, "utf8").includes(MANAGED_BEGIN);
  } catch {
    return false;
  }
}
