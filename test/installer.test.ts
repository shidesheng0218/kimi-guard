import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MANAGED_BEGIN, installHooks, uninstallHooks, hooksInstalled } from "../src/installer.js";

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-install-"));
  configPath = path.join(tmp, "config.toml");
  process.env.KIMI_CONFIG_PATH = configPath;
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  delete process.env.KIMI_CONFIG_PATH;
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("installer", () => {
  it("creates config when missing and appends managed block", () => {
    const r = installHooks();
    expect(r.created).toBe(true);
    expect(r.replaced).toBe(false);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain(MANAGED_BEGIN);
    expect(text).toContain('event = "PreToolUse"');
    expect(text).toContain("kguard hook PreToolUse");
    expect(hooksInstalled(configPath)).toBe(true);
  });

  it("preserves existing user content and backs up before first install", () => {
    fs.writeFileSync(configPath, 'default_model = "kimi-k3"\n', "utf8");
    const r = installHooks();
    expect(r.created).toBe(false);
    expect(r.backupPath).toBeDefined();
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.startsWith('default_model = "kimi-k3"')).toBe(true);
    expect(fs.readFileSync(r.backupPath!, "utf8")).toBe('default_model = "kimi-k3"\n');
  });

  it("is idempotent on double install (replaces, no duplicate)", () => {
    installHooks();
    const r2 = installHooks();
    expect(r2.replaced).toBe(true);
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.match(/\[\[hooks\]\]/g)?.length).toBe(11);
    expect(text.match(new RegExp(MANAGED_BEGIN, "g"))?.length).toBe(1);
  });

  it("uninstall removes the managed block", () => {
    installHooks();
    const r = uninstallHooks();
    expect(r.removed).toBe(true);
    expect(hooksInstalled(configPath)).toBe(false);
    expect(fs.readFileSync(configPath, "utf8")).not.toContain("kimi-guard");
  });

  it("uninstall is a no-op when nothing installed", () => {
    const r = uninstallHooks();
    expect(r.removed).toBe(false);
  });

  it("coexists with a kimi-boost managed block", () => {
    fs.writeFileSync(
      configPath,
      [
        "# >>> kimi-boost managed >>>",
        "[[hooks]]",
        'event = "PreToolUse"',
        'command = "node hooks/x.mjs"',
        "# <<< kimi-boost managed <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    installHooks();
    const text = fs.readFileSync(configPath, "utf8");
    expect(text).toContain("kimi-boost managed");
    expect(text).toContain("kimi-guard managed");
    expect(text.match(/\[\[hooks\]\]/g)?.length).toBe(12);
  });
});
