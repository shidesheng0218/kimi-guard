import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectKimiBoost } from "../src/related.js";

const ENV_KEYS = [
  "AGENT_GUARD_HOME",
  "KIMI_GUARD_HOME",
  "KIMI_BOOST_HOME",
  "KIMI_CONFIG_PATH",
  "CLAUDE_SETTINGS_PATH",
  "CODEX_HOME",
] as const;

let tmp: string;
let saved: Map<string, string | undefined>;
let kimiConfig: string;
let claudeSettings: string;
let codexHome: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "kguard-related-"));
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.AGENT_GUARD_HOME = join(tmp, "agent-guard");
  process.env.KIMI_BOOST_HOME = join(tmp, "kboost");
  kimiConfig = join(tmp, "kimi-config.toml");
  claudeSettings = join(tmp, "claude-settings.json");
  codexHome = join(tmp, "codex");
  process.env.KIMI_CONFIG_PATH = kimiConfig;
  process.env.CLAUDE_SETTINGS_PATH = claudeSettings;
  process.env.CODEX_HOME = codexHome;
  delete process.env.KIMI_GUARD_HOME;
  mkdirSync(process.env.AGENT_GUARD_HOME, { recursive: true });
  writeFileSync(kimiConfig, "", "utf8");
  writeFileSync(claudeSettings, "{}", "utf8");
  mkdirSync(codexHome, { recursive: true });
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const windowsCommand = 'node "C:\\Users\\x\\.kimi-boost\\hooks\\core\\block-dangerous.mjs"';

describe("detectKimiBoost", () => {
  it("reports absent when the boost home and markers do not exist", () => {
    const r = detectKimiBoost();
    expect(r.present).toBe(false);
    expect(r.active).toBe(false);
    expect(r.markers).toEqual({ kimi: false, claude: false, codex: false });
  });

  it("reports present but not active when only the boost home exists", () => {
    mkdirSync(process.env.KIMI_BOOST_HOME!, { recursive: true });
    const r = detectKimiBoost();
    expect(r.present).toBe(true);
    expect(r.active).toBe(false);
  });

  it("detects the Kimi managed block", () => {
    writeFileSync(kimiConfig, '# >>> kimi-boost managed >>>\n[[hooks]]\ncommand = "node hooks/x.mjs"\n# <<< kimi-boost managed <<<\n', "utf8");
    const r = detectKimiBoost();
    expect(r.markers.kimi).toBe(true);
    expect(r.active).toBe(true);
  });

  it("detects a quoted Windows-style Claude command", () => {
    writeFileSync(
      claudeSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: windowsCommand, timeout: 5 }] }],
        },
      }),
      "utf8",
    );
    const r = detectKimiBoost();
    expect(r.markers.claude).toBe(true);
    expect(r.active).toBe(true);
  });

  it("detects a Codex config.toml command", () => {
    writeFileSync(join(codexHome, "config.toml"), `[[hooks]]\nevent = "PreToolUse"\ncommand = ${JSON.stringify(windowsCommand)}\n`, "utf8");
    const r = detectKimiBoost();
    expect(r.markers.codex).toBe(true);
    expect(r.active).toBe(true);
  });
});