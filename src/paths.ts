import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function guardHome(): string {
  const env = process.env.KIMI_GUARD_HOME;
  if (env && env.trim()) return path.resolve(env);
  return path.join(os.homedir(), ".kimi-guard");
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
