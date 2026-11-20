import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installHooks, uninstallHooks } from "../src/installer.js";
import { installClaudeHooks, uninstallClaudeHooks } from "../src/harness/claude.js";

const ENV_KEYS = ["AGENT_GUARD_HOME", "KIMI_GUARD_HOME", "KIMI_CONFIG_PATH", "CLAUDE_SETTINGS_PATH"] as const;

let tmp: string;
let configPath: string;
let claudeSettings: string;
let saved: Map<string, string | undefined>;

const kimiBoostFixture = path.join(import.meta.dirname, "fixtures", "coexistence", "kimi-boost-block.toml");
const claudeBoostFixture = path.join(import.meta.dirname, "fixtures", "coexistence", "claude-boost-settings.json");

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-coexist-"));
  configPath = path.join(tmp, "config.toml");
  claudeSettings = path.join(tmp, "claude-settings.json");
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.AGENT_GUARD_HOME = path.join(tmp, "guard-home");
  process.env.KIMI_CONFIG_PATH = configPath;
  process.env.CLAUDE_SETTINGS_PATH = claudeSettings;
  delete process.env.KIMI_GUARD_HOME;
  fs.mkdirSync(process.env.AGENT_GUARD_HOME, { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("kimi coexists with kimi-boost", () => {
  it("installHooks preserves the kimi-boost block byte-for-byte", () => {
    const original = fs.readFileSync(kimiBoostFixture, "utf8");
    fs.writeFileSync(configPath, original, "utf8");
    installHooks("kguard");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain(original.trim());
    expect(text).toContain("# >>> kimi-guard managed >>>");
  });

  it("uninstallHooks preserves the kimi-boost block", () => {
    const original = fs.readFileSync(kimiBoostFixture, "utf8");
    fs.writeFileSync(configPath, original, "utf8");
    installHooks("kguard");
    uninstallHooks();
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain(original.trim());
    expect(text).not.toContain("# >>> kimi-guard managed >>>");
  });

  it("installClaudeHooks preserves boost's Claude command", () => {
    const original = fs.readFileSync(claudeBoostFixture, "utf8");
    fs.writeFileSync(claudeSettings, original, "utf8");
    installClaudeHooks("agentguard");
    const text = fs.readFileSync(claudeSettings, "utf8");
    expect(text).toContain(".kimi-boost");
  });

  it("uninstallClaudeHooks preserves boost's Claude command", () => {
    const original = fs.readFileSync(claudeBoostFixture, "utf8");
    fs.writeFileSync(claudeSettings, original, "utf8");
    installClaudeHooks("agentguard");
    uninstallClaudeHooks();
    const text = fs.readFileSync(claudeSettings, "utf8");
    expect(text).toContain(".kimi-boost");
  });
});