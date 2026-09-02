import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { installClaudeHooks, uninstallClaudeHooks, claudeHooksInstalled, CLAUDE_COMMAND_MARKER } from "../src/harness/claude.js";
import { installCodexHooks, uninstallCodexHooks, codexHooksInstalled, CODEX_COMMAND_MARKER } from "../src/harness/codex.js";
import { loadConfig } from "../src/config.js";
import { encodeHint } from "../src/hook.js";
import { guardHome } from "../src/paths.js";
import { resetDbForTests } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-harness-"));
  process.env.KIMI_GUARD_HOME = tmp;
  process.env.CLAUDE_SETTINGS_PATH = path.join(tmp, "claude", "settings.json");
  process.env.CODEX_HOOKS_PATH = path.join(tmp, "codex", "hooks.json");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.CLAUDE_SETTINGS_PATH;
  delete process.env.CODEX_HOOKS_PATH;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("claude settings.json installer", () => {
  it("creates settings with all guard events", () => {
    const r = installClaudeHooks();
    expect(r.created).toBe(true);
    const settings = JSON.parse(fs.readFileSync(r.configPath, "utf8")) as { hooks: Record<string, unknown[]> };
    expect(Object.keys(settings.hooks)).toContain("PreToolUse");
    expect(Object.keys(settings.hooks)).toContain("PostToolUseFailure");
    expect(Object.keys(settings.hooks)).toContain("Stop");
    expect(claudeHooksInstalled()).toBe(true);
    const pre = settings.hooks["PreToolUse"]![0] as { hooks: Array<{ command: string }> };
    expect(pre.hooks[0]!.command).toContain("--harness claude");
  });

  it("is idempotent and preserves unrelated settings", () => {
    fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH!), { recursive: true });
    fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH!, JSON.stringify({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other-tool hook" }] }] } }));
    installClaudeHooks();
    installClaudeHooks(); // second run must not duplicate
    const settings = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8")) as { model: string; hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(settings.model).toBe("opus");
    const pre = settings.hooks["PreToolUse"]!;
    expect(pre.some((g) => g.hooks.some((h) => h.command === "other-tool hook"))).toBe(true);
    expect(pre.filter((g) => g.hooks.some((h) => h.command.includes(CLAUDE_COMMAND_MARKER)))).toHaveLength(1);
    expect(fs.existsSync(process.env.CLAUDE_SETTINGS_PATH! + ".agentguard.bak")).toBe(true);
  });

  it("uninstall removes only our entries", () => {
    fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH!), { recursive: true });
    fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH!, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "", hooks: [{ type: "command", command: "other-tool hook" }] }] } }));
    installClaudeHooks();
    const r = uninstallClaudeHooks();
    expect(r.removed).toBe(true);
    expect(claudeHooksInstalled()).toBe(false);
    const settings = JSON.parse(fs.readFileSync(process.env.CLAUDE_SETTINGS_PATH!, "utf8")) as { hooks: Record<string, unknown[]> };
    expect(settings.hooks["PreToolUse"]).toHaveLength(1); // other tool survives
    expect(settings.hooks["PostToolUse"]).toBeUndefined(); // ours fully removed
  });

  it("survives a malformed settings file (backs up, starts hooks fresh)", () => {
    fs.mkdirSync(path.dirname(process.env.CLAUDE_SETTINGS_PATH!), { recursive: true });
    fs.writeFileSync(process.env.CLAUDE_SETTINGS_PATH!, "{ not json");
    const r = installClaudeHooks();
    expect(claudeHooksInstalled()).toBe(true);
    expect(r.backupPath).toBeDefined();
  });
});

describe("codex hooks.json installer", () => {
  it("creates hooks.json with codex event names and marker", () => {
    const r = installCodexHooks();
    expect(r.created).toBe(true);
    const file = JSON.parse(fs.readFileSync(r.configPath, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(Object.keys(file.hooks)).toContain("PreToolUse");
    expect(Object.keys(file.hooks)).toContain("Interrupt");
    expect(Object.keys(file.hooks)).not.toContain("PostToolUseFailure"); // codex has no such event
    expect(file.hooks["PreToolUse"]![0]!.hooks[0]!.command).toContain("--harness codex");
    expect(codexHooksInstalled()).toBe(true);
  });

  it("is idempotent and uninstall removes only our entries", () => {
    fs.mkdirSync(path.dirname(process.env.CODEX_HOOKS_PATH!), { recursive: true });
    fs.writeFileSync(process.env.CODEX_HOOKS_PATH!, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "^Bash$", hooks: [{ type: "command", command: "other hook" }] }] } }));
    installCodexHooks();
    installCodexHooks();
    let file = JSON.parse(fs.readFileSync(process.env.CODEX_HOOKS_PATH!, "utf8")) as { hooks: Record<string, Array<{ hooks: Array<{ command: string }> }>> };
    expect(file.hooks["PreToolUse"]!.filter((g) => g.hooks.some((h) => h.command.includes(CODEX_COMMAND_MARKER)))).toHaveLength(1);
    const r = uninstallCodexHooks();
    expect(r.removed).toBe(true);
    expect(codexHooksInstalled()).toBe(false);
    file = JSON.parse(fs.readFileSync(process.env.CODEX_HOOKS_PATH!, "utf8")) as typeof file;
    expect(file.hooks["PreToolUse"]).toHaveLength(1);
  });
});

describe("codex config defaults", () => {
  it("codex harness uses apply_patch/Bash, empty read/search classifiers", () => {
    const c = loadConfig(path.join(tmp, "nonexistent.toml"), "codex");
    expect(c.harness).toBe("codex");
    expect(c.tools.shell).toEqual(["Bash"]);
    expect(c.tools.edit).toEqual(["apply_patch", "Edit", "Write"]);
    expect(c.tools.read).toEqual([]);
    expect(c.budget.dispatchTools).toContain("spawn_agent");
  });
});

describe("harness-aware config defaults", () => {
  it("claude defaults use Claude tool names", () => {
    const c = loadConfig(path.join(tmp, "nonexistent.toml"), "claude");
    expect(c.harness).toBe("claude");
    expect(c.tools.shell).toEqual(["Bash"]);
    expect(c.tools.edit).toContain("Edit");
    expect(c.tools.read).toEqual(["Read"]);
    expect(c.budget.dispatchTools).toEqual(["Task"]);
    expect(c.repeat.watch).toContain("Bash");
  });

  it("explicit [tools] config wins over harness defaults", () => {
    const p = path.join(tmp, "config.toml");
    fs.writeFileSync(p, `[tools]\nshell = ["execute_command"]\n`);
    const c = loadConfig(p, "claude");
    expect(c.tools.shell).toEqual(["execute_command"]);
  });
});

describe("output encoding per harness", () => {
  it("claude wraps hints in hookSpecificOutput.additionalContext", () => {
    const out = encodeHint("PreToolUse", "claude", "watch out");
    const parsed = JSON.parse(out) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PreToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toBe("watch out");
  });

  it("kimi passes plain stdout through", () => {
    expect(encodeHint("PreToolUse", "kimi", "watch out")).toBe("watch out");
  });
});

describe("guard home migration", () => {
  it("env vars take precedence, AGENT_GUARD_HOME over KIMI_GUARD_HOME", () => {
    process.env.AGENT_GUARD_HOME = path.join(tmp, "ag");
    expect(guardHome()).toBe(path.join(tmp, "ag"));
    delete process.env.AGENT_GUARD_HOME;
    expect(guardHome()).toBe(tmp); // KIMI_GUARD_HOME still honored
  });
});

describe("claude hook e2e (real CLI, claude payloads)", () => {
  const repoRoot = path.join(import.meta.dirname, "..");
  const CLI = path.join(repoRoot, "node_modules", ".bin", "tsx");

  function runClaudeHook(event: string, payload: unknown): { code: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(CLI, ["src/cli.ts", "hook", event, "--harness", "claude"], {
        cwd: repoRoot,
        env: { ...process.env },
        input: JSON.stringify(payload),
        encoding: "utf8",
      });
      return { code: 0, stdout, stderr: "" };
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return { code: e.status ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
    }
  }

  it("repeat loop on Bash is blocked with exit 2, warn emits additionalContext JSON", () => {
    const payload = { session_id: "cc-1", tool_name: "Bash", tool_input: { command: "npm test" } };
    expect(runClaudeHook("PostToolUse", { ...payload, tool_response: { stdout: "ok" } }).code).toBe(0);
    expect(runClaudeHook("PostToolUse", { ...payload, tool_response: { stdout: "ok" } }).code).toBe(0);
    // 2 identical in history → warn at warnAt=2: exit 0 with JSON additionalContext
    const warn = runClaudeHook("PreToolUse", payload);
    expect(warn.code).toBe(0);
    const parsed = JSON.parse(warn.stdout.trim()) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(parsed.hookSpecificOutput?.additionalContext).toContain("[agent-guard]");
    // one more in history → block at maxRepeats=3
    expect(runClaudeHook("PostToolUse", { ...payload, tool_response: { stdout: "ok" } }).code).toBe(0);
    const block = runClaudeHook("PreToolUse", payload);
    expect(block.code).toBe(2);
    expect(block.stderr).toContain("[agent-guard]");
  });
});
