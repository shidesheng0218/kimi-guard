import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function guardHome(): string {
  const env = process.env.AGENT_GUARD_HOME ?? process.env.KIMI_GUARD_HOME;
  if (env && env.trim()) return path.resolve(env);
  const fresh = path.join(os.homedir(), ".agent-guard");
  const legacy = path.join(os.homedir(), ".kimi-guard");
  // legacy installs keep working in place until the user moves the directory
  if (!fs.existsSync(fresh) && fs.existsSync(legacy)) return legacy;
  return fresh;
}

/** Claude Code user settings (hooks live here). */
export function claudeSettingsPath(): string {
  const env = process.env.CLAUDE_SETTINGS_PATH;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Is Claude Code present on this machine? (settings file or config dir) */
export function claudeDetected(): boolean {
  return fs.existsSync(claudeSettingsPath()) || fs.existsSync(path.join(os.homedir(), ".claude"));
}

/** Codex CLI hooks file. */
export function codexHooksPath(): string {
  const env = process.env.CODEX_HOOKS_PATH;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".codex", "hooks.json");
}

/** Is Codex CLI present on this machine? */
export function codexDetected(): boolean {
  return fs.existsSync(path.join(os.homedir(), ".codex"));
}

export function stateDbPath(): string {
  return path.join(guardHome(), "state.db");
}

export function probeLogPath(): string {
  return path.join(guardHome(), "probe.jsonl");
}

export function userConfigPath(): string {
  return path.join(guardHome(), "config.toml");
}

/**
 * Locate the Kimi Code CLI config.toml.
 * Priority: $KIMI_CONFIG_PATH (authoritative) > ~/.kimi-code/config.toml (current) > ~/.kimi/config.toml (legacy).
 */
export function detectKimiConfig(): { path: string; exists: boolean } {
  const env = process.env.KIMI_CONFIG_PATH;
  if (env && env.trim()) {
    const p = path.resolve(env);
    return { path: p, exists: fs.existsSync(p) };
  }
  const candidates = [
    path.join(os.homedir(), ".kimi-code", "config.toml"),
    path.join(os.homedir(), ".kimi", "config.toml"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return { path: p, exists: true };
  }
  return { path: candidates[0]!, exists: false };
}
