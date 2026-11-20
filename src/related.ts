import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { detectKimiConfig } from "./paths.js";

/** Read-only view of the other tool. Detection never writes and never throws. */
export interface RelatedToolStatus {
  /** The other tool's home directory exists. */
  present: boolean;
  /** At least one managed marker or marker command exists in a harness config. */
  active: boolean;
  home?: string;
  markers: { kimi: boolean; claude: boolean; codex: boolean };
}

export const KIMI_BOOST_MARKER = "# >>> kimi-boost managed >>>";
export const KIMI_BOOST_COMMAND_RE = /\.kimi-boost[/\\]+hooks[/\\]+/;

function readText(file: string): string {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** Walk the Claude hook JSON shape and collect every command string. */
function commandEntries(raw: string): string[] {
  const out: string[] = [];
  if (!raw.trim()) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out;
  }
  const hooks = (parsed as { hooks?: unknown } | null)?.hooks;
  if (!hooks || typeof hooks !== "object") return out;
  for (const groups of Object.values(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const handlers = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers)) continue;
      for (const handler of handlers) {
        const command = (handler as { command?: unknown } | null)?.command;
        if (typeof command === "string") out.push(command);
      }
    }
  }
  return out;
}

function kimiConfigPath(): string {
  return process.env.KIMI_CONFIG_PATH ?? detectKimiConfig().path;
}

function claudeSettingsPath(): string {
  return process.env.CLAUDE_SETTINGS_PATH ?? path.join(process.env.CLAUDE_CODE_HOME ?? path.join(os.homedir(), ".claude"), "settings.json");
}

function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "config.toml");
}

export function detectKimiBoost(): RelatedToolStatus {
  const home = process.env.KIMI_BOOST_HOME ?? path.join(os.homedir(), ".kimi-boost");
  const markers = { kimi: false, claude: false, codex: false };
  try {
    const kimiText = readText(kimiConfigPath());
    markers.kimi = kimiText.includes(KIMI_BOOST_MARKER) || KIMI_BOOST_COMMAND_RE.test(kimiText);
    markers.claude = commandEntries(readText(claudeSettingsPath())).some((c) => KIMI_BOOST_COMMAND_RE.test(c));
    markers.codex = KIMI_BOOST_COMMAND_RE.test(readText(codexConfigPath()));
    return {
      present: fs.existsSync(home),
      active: markers.kimi || markers.claude || markers.codex,
      home,
      markers,
    };
  } catch {
    return { present: false, active: false, home, markers };
  }
}