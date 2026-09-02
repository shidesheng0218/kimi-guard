import fs from "node:fs";
import { Command } from "commander";
import { version } from "./version.js";
import { loadConfig, writeConfigTemplate } from "./config.js";
import { installHooks, uninstallHooks } from "./installer.js";
import { installClaudeHooks, uninstallClaudeHooks } from "./harness/claude.js";
import { installCodexHooks, uninstallCodexHooks } from "./harness/codex.js";
import { claudeDetected, codexDetected } from "./paths.js";
import { runHook } from "./hook.js";
import type { HarnessName } from "./toolsets.js";
import { setMeta, listBlocks, setBlockFeedback } from "./store.js";
import { cmdStatus, cmdDoctor, buildGuardReport } from "./status.js";
import { probeLogPath, userConfigPath } from "./paths.js";
import { captureCheckpoint, latestSessionId, latestCheckpointFile, renderResumeBlock } from "./checkpoint.js";
import { budgetSnapshot, formatSnapshot, resolveLimits, PLANS } from "./meter.js";
import { refreshPreciseUsage } from "./precise.js";
import { runSupervised, formatReport } from "./wire/supervisor.js";

const program = new Command();

program
  .name("agentguard")
  .description("Runtime behavior guard for coding agents (Kimi Code CLI & Claude Code): loop detection, quota gates, checkpoints")
  .version(version, "-V, --version", "print version");

program
  .command("install")
  .description("install hook rules into detected agent CLIs (Kimi Code config.toml and/or Claude Code settings.json)")
  .option("--compat", "legacy-safe mode: only the 3 universally supported hook events (for older kimi-cli versions)")
  .option("--harness <name>", "kimi | claude | codex | all (default: auto-detect installed harnesses, fallback kimi)")
  .action((opts: { compat?: boolean; harness?: string }) => {
    const which = opts.harness ?? "auto";
    const known = ["kimi", "claude", "codex", "all", "auto"];
    if (!known.includes(which)) {
      console.error(`unknown harness: ${which}`);
      process.exitCode = 1;
      return;
    }
    const doKimi = which === "kimi" || which === "all" || which === "auto";
    const doClaude = which === "claude" || which === "all" || (which === "auto" && claudeDetected());
    const doCodex = which === "codex" || which === "all" || (which === "auto" && codexDetected());

    if (doKimi) {
      const r = installHooks("agentguard", Boolean(opts.compat));
      console.log(`✓ [kimi] config: ${r.configPath}${r.created ? " (created)" : ""}`);
      if (r.backupPath) console.log(`✓ [kimi] backup: ${r.backupPath}`);
      console.log(`✓ [kimi] managed hook block ${r.replaced ? "updated" : "added"}${opts.compat ? " (compat)" : ""}`);
      if (!opts.compat) {
        console.log("  note: if your CLI fails to load config after this (older kimi-cli), reinstall with: agentguard install --compat");
      }
    }
    if (doClaude) {
      const r = installClaudeHooks("agentguard", Boolean(opts.compat));
      console.log(`✓ [claude] config: ${r.configPath}${r.created ? " (created)" : ""}`);
      if (r.backupPath) console.log(`✓ [claude] backup: ${r.backupPath}`);
      console.log(`✓ [claude] hooks ${r.updated ? "installed" : "already up to date"}${opts.compat ? " (compat)" : ""}`);
    }
    if (doCodex) {
      const r = installCodexHooks("agentguard", Boolean(opts.compat));
      console.log(`✓ [codex] config: ${r.configPath}${r.created ? " (created)" : ""}`);
      if (r.backupPath) console.log(`✓ [codex] backup: ${r.backupPath}`);
      console.log(`✓ [codex] hooks ${r.updated ? "installed" : "already up to date"}${opts.compat ? " (compat)" : ""}`);
      console.log("  note: Codex hooks cover shell/apply_patch/local function tools; hosted tools (e.g. WebSearch) are not observable.");
    }
    console.log("  restart the agent CLI (or /reload) to take effect.");
  });

program
  .command("uninstall")
  .description("remove the managed hook entries from Kimi Code config.toml and Claude Code settings.json")
  .option("--harness <name>", "kimi | claude | codex | all (default: all)")
  .action((opts: { harness?: string }) => {
    const which = opts.harness ?? "all";
    if (which === "kimi" || which === "all") {
      const r = uninstallHooks();
      console.log(r.removed ? `✓ [kimi] removed managed block from ${r.configPath}` : `[kimi] no managed block found in ${r.configPath}`);
    }
    if (which === "claude" || which === "all") {
      const r = uninstallClaudeHooks();
      console.log(r.removed ? `✓ [claude] removed hooks from ${r.configPath}` : `[claude] no managed hooks found in ${r.configPath}`);
    }
    if (which === "codex" || which === "all") {
      const r = uninstallCodexHooks();
      console.log(r.removed ? `✓ [codex] removed hooks from ${r.configPath}` : `[codex] no managed hooks found in ${r.configPath}`);
    }
  });

program
  .command("hook")
  .argument("<event>", "hook event name, e.g. PreToolUse")
  .description("hook entrypoint invoked by the agent CLI (reads JSON payload from stdin)")
  .option("--harness <name>", "kimi | claude | codex (default: kimi)", "kimi")
  .action(async (event: string, opts: { harness: string }) => {
    const harness: HarnessName = opts.harness === "claude" ? "claude" : opts.harness === "codex" ? "codex" : "kimi";
    process.exitCode = await runHook(event, harness);
  });

program
  .command("status")
  .description("guard activity: calls, interventions, sessions, budget windows")
  .action(() => cmdStatus());

program
  .command("doctor")
  .description("verify environment: node, state db, kimi config, PATH, probe samples")
  .action(() => {
    process.exitCode = cmdDoctor();
  });

program
  .command("budget")
  .description("show the quota metering snapshot (windows, burn rate, projection)")
  .option("-s, --session <id>", "session id (defaults to the most recent)")
  .action(async (opts: { session?: string }) => {
    const cfg = loadConfig();
    if (cfg.budget.precise) {
      const p = await refreshPreciseUsage(cfg.budget);
      if (!p) console.error("[agent-guard] precise metering unavailable (missing KIMI_API_KEY or API error) — showing event-based estimates");
    }
    const sid = opts.session ?? latestSessionId() ?? "unknown";
    console.log(formatSnapshot(budgetSnapshot(sid, cfg.budget)));
    const limits = resolveLimits(cfg.budget);
    if (limits.weekly === 0) {
      console.log(`\navailable plans: ${Object.keys(PLANS).join(", ")} — or set weekly/fiveHour in config`);
    }
  });

program
  .command("checkpoint")
  .description("capture a research-state checkpoint for a session (also auto-captured on failures/interrupts)")
  .option("-s, --session <id>", "session id (defaults to the most recent)")
  .option("-r, --reason <text>", "why the checkpoint is being taken", "manual")
  .action((opts: { session?: string; reason: string }) => {
    const sid = opts.session ?? latestSessionId();
    if (!sid) {
      console.log("no recorded sessions yet");
      return;
    }
    const cp = captureCheckpoint(sid, opts.reason);
    if (!cp) {
      console.log("nothing to checkpoint (no recent activity)");
      return;
    }
    console.log(`✓ checkpoint saved: ${cp.path}`);
    console.log(`  resume later with: kguard resume`);
  });

program
  .command("resume")
  .description("print a paste-ready context block built from the latest checkpoint")
  .option("-f, --file <path>", "use a specific checkpoint file (defaults to the latest)")
  .action((opts: { file?: string }) => {
    const file = opts.file ?? latestCheckpointFile();
    if (!file || !fs.existsSync(file)) {
      console.log("no checkpoints found — run 'kguard checkpoint' first");
      return;
    }
    const content = fs.readFileSync(file, "utf8");
    const reason = /- reason: (.*)/.exec(content)?.[1] ?? "interrupted";
    const idx = content.indexOf("## Observed activity");
    const brief = idx >= 0 ? content.slice(idx) : content;
    console.log(renderResumeBlock(brief, reason));
  });

program
  .command("blocks")
  .description("list recent guard blocks (with ids for feedback)")
  .option("-n, --last <n>", "how many blocks to show", "20")
  .action((opts: { last: string }) => {
    const rows = listBlocks(Number(opts.last));
    if (rows.length === 0) {
      console.log("no blocks recorded yet");
      return;
    }
    for (const r of rows) {
      const fb = r.feedback ? ` [${r.feedback === "fp" ? "FALSE POSITIVE" : "confirmed"}]` : "";
      console.log(`#${r.id}  ${new Date(r.ts).toISOString()}  ${r.kind}  ${r.tool_name}  session=${r.session_id.slice(0, 16)}${fb}`);
    }
    console.log(`\nmark a false positive: kguard feedback fp <id>   (confirmed: kguard feedback tp <id>)`);
  });

program
  .command("feedback")
  .description("mark a block as a false positive (fp) or confirmed (tp) — feeds detector calibration")
  .argument("<verdict>", "fp | tp")
  .argument("<id>", "block id from 'kguard blocks' or the block message")
  .action((verdict: string, id: string) => {
    if (verdict !== "fp" && verdict !== "tp") {
      console.error("verdict must be 'fp' (false positive) or 'tp' (confirmed)");
      process.exitCode = 1;
      return;
    }
    if (setBlockFeedback(Number(id), verdict)) {
      console.log(`✓ block #${id} marked ${verdict === "fp" ? "false positive" : "confirmed"}`);
    } else {
      console.error(`no block with id ${id} — see 'kguard blocks'`);
      process.exitCode = 1;
    }
  });

program
  .command("report")
  .description("anonymized aggregate of guard activity (no args/paths/commands — safe to share)")
  .option("--json", "print JSON (default is a text summary)")
  .action((opts: { json?: boolean }) => {
    const report = buildGuardReport() as {
      generatedAt: string;
      sessions: number;
      calls24h: number;
      blocks24h: number;
      detectors: Array<{ kind: string; blocks: number; falsePositives: number; confirmed: number; fpRate: number }>;
      budget: { plan: string; precise: boolean; fiveHourPercent: number; weeklyPercent: number };
    };
    if (opts.json) {
      console.log(JSON.stringify({ ...report, version }, null, 2));
      return;
    }
    console.log(`agent-guard report (${report.generatedAt})`);
    console.log(`  sessions: ${report.sessions}   calls 24h: ${report.calls24h}   blocks 24h: ${report.blocks24h}`);
    if (report.detectors.length === 0) console.log("  detectors: no blocks recorded");
    for (const d of report.detectors) {
      console.log(`  ${d.kind.padEnd(12)} blocks=${d.blocks}  fp=${d.falsePositives} (${Math.round(d.fpRate * 100)}%)  tp=${d.confirmed}`);
    }
    console.log(`  budget: ${report.budget.plan}${report.budget.precise ? " (precise)" : ""}  5h=${report.budget.fiveHourPercent}%  weekly=${report.budget.weeklyPercent}%`);
    console.log("  (aggregate only — no arguments, paths or commands are included)");
  });

const probe = program.command("probe").description("capture raw hook payloads for schema discovery");
probe
  .command("on")
  .action(() => {
    setMeta("probe_enabled", "1");
    console.log(`✓ probe on → ${probeLogPath()}`);
  });
probe
  .command("off")
  .action(() => {
    setMeta("probe_enabled", "0");
    console.log("✓ probe off");
  });
probe
  .command("show")
  .option("-n, --last <n>", "how many samples to show", "10")
  .action((opts: { last: string }) => {
    if (!fs.existsSync(probeLogPath())) {
      console.log("no probe samples yet — run 'kguard probe on' first");
      return;
    }
    const lines = fs.readFileSync(probeLogPath(), "utf8").trim().split("\n").filter(Boolean);
    for (const line of lines.slice(-Number(opts.last))) console.log(line);
  });

const cfgCmd = program.command("config").description("manage the guard config.toml");
cfgCmd
  .command("init")
  .description("create the config file with documented defaults")
  .action(() => {
    console.log(writeConfigTemplate() ? `✓ created ${userConfigPath()}` : `already exists: ${userConfigPath()}`);
  });
cfgCmd
  .command("path")
  .action(() => {
    console.log(userConfigPath());
  });
cfgCmd
  .command("show")
  .description("print the effective config (file values merged over defaults)")
  .action(() => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  });
cfgCmd
  .command("get <key>")
  .description("print one effective value, e.g. budget.plan or repeat.maxRepeats")
  .action((key: string) => {
    const cfg = loadConfig() as unknown as Record<string, unknown>;
    const value = key.split(".").reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), cfg);
    console.log(value === undefined ? `<unset: ${key}>` : typeof value === "object" ? JSON.stringify(value) : String(value));
  });

program
  .command("run")
  .description("supervised headless run: loop guards, token metering, auto-checkpoints. Kimi: Wire protocol (in-process steer); Claude Code: claude -p stream-json supervision")
  .argument("[prompt...]", "task prompt (or use --prompt)")
  .option("-p, --prompt <text>", "task prompt")
  .option("-e, --exec <command...>", "agent command to supervise (default: kimi --wire / claude)")
  .option("--harness <name>", "kimi | claude (default: kimi; claude uses claude -p stream-json)")
  .option("--max-steps <n>", "hard step cap (per turn)", "200")
  .option("--max-minutes <n>", "hard wall-clock cap for the whole run", "30")
  .option("--auto-resume <n>", "re-prompt with checkpoint brief after max_steps/kill-switch", "0")
  .option("--max-verify-rounds <n>", "corrective rounds when the final message makes unbacked completion claims", "2")
  .option("--no-steer", "disable soft mid-turn corrections")
  .option("--max-steers <n>", "cap on steer injections", "5")
  .option("--yolo", "auto-approve every approval request")
  .option("--json", "print machine-readable report JSON")
  .action(async (promptParts: string[], opts: {
    prompt?: string; exec?: string[]; harness?: string; maxSteps: string; maxMinutes: string;
    autoResume: string; maxVerifyRounds: string; steer: boolean; maxSteers: string; yolo?: boolean; json?: boolean;
  }) => {
    const prompt = opts.prompt ?? promptParts.join(" ");
    if (!prompt.trim()) {
      console.error("error: a prompt is required (argument or --prompt)");
      process.exit(1);
    }
    if (opts.harness === "claude") {
      const { runClaudeSupervised } = await import("./run/claude.js");
      const report = await runClaudeSupervised({
        prompt,
        command: opts.exec ?? ["claude"],
        maxSteps: Number(opts.maxSteps),
        maxMinutes: Number(opts.maxMinutes),
        autoResume: Number(opts.autoResume),
        maxVerifyRounds: Number(opts.maxVerifyRounds),
        approval: opts.yolo ? "approve" : "reject",
        json: Boolean(opts.json),
      });
      if (opts.json) console.log(JSON.stringify(report, null, 2));
      else console.log(formatReport(report));
      process.exitCode = report.endReason === "finished" ? 0 : 2;
      return;
    }
    const report = await runSupervised({
      prompt,
      command: opts.exec ?? ["kimi", "--wire"],
      maxSteps: Number(opts.maxSteps),
      maxMinutes: Number(opts.maxMinutes),
      steerOnWarn: opts.steer,
      maxSteers: Number(opts.maxSteers),
      autoResume: Number(opts.autoResume),
      maxVerifyRounds: Number(opts.maxVerifyRounds),
      approval: opts.yolo ? "approve" : "reject",
      json: Boolean(opts.json),
    });
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.log(formatReport(report));
    process.exitCode = report.endReason === "finished" ? 0 : 2;
  });

program.parseAsync(process.argv).catch((err: Error) => {
  process.stderr.write(`[agent-guard] ${err.message}\n`);
  process.exit(1);
});
