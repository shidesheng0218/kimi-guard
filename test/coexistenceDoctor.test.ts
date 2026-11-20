import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cmdDoctor, kimiBoostCoexistenceMessage } from "../src/status.js";
import { installHooks } from "../src/installer.js";

const ENV_KEYS = ["AGENT_GUARD_HOME", "KIMI_GUARD_HOME", "KIMI_BOOST_HOME", "KIMI_CONFIG_PATH", "CLAUDE_SETTINGS_PATH", "CODEX_HOME", "CODEX_HOOKS_PATH", "GEMINI_SETTINGS_PATH"] as const;

let tmp: string;
let configPath: string;
let saved: Map<string, string | undefined>;

const emptyMarkers = { kimi: false, claude: false, codex: false };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-coexist-doctor-"));
  configPath = path.join(tmp, "config.toml");
  saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.AGENT_GUARD_HOME = path.join(tmp, "guard-home");
  process.env.KIMI_BOOST_HOME = path.join(tmp, "kboost");
  process.env.KIMI_CONFIG_PATH = configPath;
  process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, "claude-settings.json");
  process.env.CODEX_HOME = path.join(tmp, "codex");
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.CODEX_HOOKS_PATH;
  delete process.env.GEMINI_SETTINGS_PATH;
  fs.mkdirSync(process.env.AGENT_GUARD_HOME, { recursive: true });
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH, "{}", "utf8");
  installHooks("kguard");
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function runDoctorCaptured(): { code: number; output: string } {
  const lines: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  });
  const code = cmdDoctor();
  spy.mockRestore();
  return { code, output: lines.join("\n") };
}

describe("kimiBoostCoexistenceMessage", () => {
  it("returns the detected message for an active boost install", () => {
    expect(kimiBoostCoexistenceMessage({ present: true, active: true, markers: { ...emptyMarkers, kimi: true } })).toBe(
      "coexistence: kimi-boost detected (install-time presets; complementary)",
    );
  });

  it("returns the installed-not-wired message for a present-only install", () => {
    expect(kimiBoostCoexistenceMessage({ present: true, active: false, markers: emptyMarkers })).toBe(
      "coexistence: kimi-boost installed (hooks not detected)",
    );
  });

  it("returns null when boost is absent", () => {
    expect(kimiBoostCoexistenceMessage({ present: false, active: false, markers: emptyMarkers })).toBeNull();
  });
});

describe("cmdDoctor coexistence output", () => {
  it("prints exactly one coexistence line and no security-layer warning", () => {
    const control = runDoctorCaptured();
    fs.appendFileSync(
      configPath,
      [
        "",
        "# >>> kimi-boost managed >>>",
        "[[hooks]]",
        'event = "PreToolUse"',
        'command = "node \\"C:\\\\Users\\\\x\\\\.kimi-boost\\\\hooks\\\\core\\\\protect-main.mjs\\""',
        "# <<< kimi-boost managed <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    const active = runDoctorCaptured();
    const boostLines = active.output.split("\n").filter((l) => l.includes("coexistence: kimi-boost"));
    expect(boostLines).toHaveLength(1);
    expect(active.output).not.toContain("no security-layer hooks detected");
    expect(active.code).toBe(control.code);
  });

  it("prints no boost line when boost is absent", () => {
    const { output } = runDoctorCaptured();
    expect(output).not.toContain("kimi-boost");
  });
});