import fs from "node:fs";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { guardHome, probeLogPath, stateDbPath, detectKimiConfig, userConfigPath, claudeDetected, claudeSettingsPath, codexDetected, codexHooksPath, geminiDetected, geminiSettingsPath } from "./paths.js";
import { hooksInstalled } from "./installer.js";
import { claudeHooksInstalled } from "./harness/claude.js";
import { codexHooksInstalled } from "./harness/codex.js";
import { geminiHooksInstalled } from "./harness/gemini.js";
import { buildStatus, openDb, knownSessions, getMeta, blockKindStats, crossSessionRepeats, type BlockKindStat } from "./store.js";
import { budgetSnapshot, formatSnapshot } from "./meter.js";
import { latestSessionId } from "./checkpoint.js";
import { vetoKeyConfigured } from "./veto.js";
import { preciseKeyConfigured } from "./precise.js";

function ok(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${pc.yellow("!")} ${msg}`);
}

function fail(msg: string): void {
  console.log(`${pc.red("✗")} ${msg}`);
}

/** Config knob to raise when a detector misfires too often. */
const CALIBRATION_KEYS: Record<string, string> = {
  repeat: "repeat.maxRepeats",
  nearRepeat: "nearRepeat.blockAt",
  noGain: "noGain.blockAt",
  noGainFuzzy: "noGain.fuzzyBlockAt",
  churn: "churn.blockAt",
  noProgress: "noProgress.blockAt",
  explore: "explore.blockAt",
  budget: "budget.reservePercent",
  cycle: "cycle.enabled = false",
  verify: "verify.blockOnNoEvidence = false (or enable verify.veto)",
  killSwitch: "policy.maxBlocksPerSession",
};

/**
 * Calibration hints from user feedback: a detector whose blocks are marked
 * false-positive in more than 30% of cases (with ≥5 samples) is too tight.
 */
export function calibrationHints(stats: BlockKindStat[]): string[] {
  const hints: string[] = [];
  for (const s of stats) {
    if (s.n < 5) continue;
    const rate = s.fp / s.n;
    if (rate > 0.3) {
      const key = CALIBRATION_KEYS[s.kind] ?? `${s.kind} thresholds`;
      hints.push(`${s.kind}: ${s.fp}/${s.n} blocks marked false positive (${Math.round(rate * 100)}%) — consider raising ${key}`);
    }
  }
  return hints;
}

/**
 * Anonymized aggregate for `kguard report` — the raw material for public
 * runaway-pattern reports. Contains counts and rates only: no args, paths,
 * commands, or session identifiers.
 */
export function buildGuardReport(cfg = loadConfig(), opts?: { sessions?: boolean }): Record<string, unknown> {
  const s = buildStatus();
  const detectors = blockKindStats().map((k) => ({
    kind: k.kind,
    blocks: k.n,
    falsePositives: k.fp,
    confirmed: k.tp,
    fpRate: k.n > 0 ? Math.round((k.fp / k.n) * 100) / 100 : 0,
  }));
  const sid = latestSessionId() ?? "unknown";
  const snap = budgetSnapshot(sid, cfg.budget);
  const report: Record<string, unknown> = {
    tool: "agent-guard",
    generatedAt: new Date().toISOString(),
    sessions: knownSessions(1000).length,
    calls24h: s.calls24h,
    blocks24h: s.blocks24h.reduce((acc, b) => acc + b.n, 0),
    detectors,
    budget: {
      plan: cfg.budget.plan,
      precise: snap.precise,
      fiveHourPercent: snap.fiveHour.percent,
      weeklyPercent: snap.weekly.percent,
    },
  };
  if (opts?.sessions) {
    report["crossSessionRepeats"] = crossSessionRepeats(Date.now() - 7 * 86_400_000);
  }
  return report;
}

/** Best-effort detection of a running agent CLI process (unix only). */
function agentProcessRunning(): boolean {
  if (process.platform !== "darwin" && process.platform !== "linux") return false;
  try {
    const r = spawnSync("ps", ["-eo", "args"], { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) return false;
    return r.stdout.split("\n").some((line) => {
      const l = line.trim();
      if (l.includes("agentguard") || l.includes("kimi-guard") || l.includes("kguard")) return false;
      return /(?:^|[/\s])(kimi|claude|codex|gemini)(?:\s|$)/.test(l);
    });
  } catch {
    return false;
  }
}

export function cmdStatus(): void {
  const cfg = loadConfig();
  const s = buildStatus();
  const dt = s.lastActivityTs ? new Date(s.lastActivityTs).toISOString() : "never";
  const lastHookTs = Number(getMeta("last_hook_ts") ?? "0");
  const lastHook = lastHookTs > 0 ? `${new Date(lastHookTs).toISOString()} (${getMeta("last_hook_event") ?? "?"})` : "never";
  const normalizeMisses = Number(getMeta("normalize_misses") ?? "0");
  console.log(`${pc.bold(pc.magentaBright("◆ agent-guard status"))} ${pc.dim(`(state: ${stateDbPath()})`)}`);
  console.log(`  ${pc.dim("profile:")}             ${pc.bold(cfg.profile)}`);
  console.log(`  ${pc.dim("last activity:")}       ${dt}`);
  console.log(`  ${pc.dim("last hook activity:")}  ${lastHook}`);
  if (normalizeMisses > 0) {
    console.log(`  ${pc.yellow("!")} payload normalization misses: ${normalizeMisses} — possible upstream schema drift; run 'kguard probe on' and compare 'kguard doctor' field coverage`);
  }
  console.log(`  ${pc.dim("tool calls (24h):")}    ${s.calls24h}`);
  const parts24 = s.blocks24h.map((b) => `${b.kind}×${b.n}`).join(", ");
  console.log(`  ${pc.dim("interventions (24h):")} ${parts24 || "none"}`);
  const stats = blockKindStats();
  const withFeedback = stats.filter((k) => k.fp + k.tp > 0);
  if (withFeedback.length > 0) {
    console.log(`  ${pc.bold("intervention quality (all time):")}`);
    for (const k of stats) {
      const rate = k.n > 0 ? Math.round((k.fp / k.n) * 100) : 0;
      const fpText = k.fp > 0 ? pc.red(`${k.fp} (${rate}%)`) : pc.green("0");
      console.log(`    ${k.kind.padEnd(12)} blocks=${k.n}  fp=${fpText}  confirmed=${k.tp}`);
    }
    for (const h of calibrationHints(stats)) console.log(`  ${pc.yellow("!")} calibration: ${h}`);
  }
  if (s.events24h.length > 0) {
    console.log(`  agent events (24h):  ${s.events24h.map((e) => `${e.kind}×${e.n}`).join(", ")}`);
  }
  const sessions = knownSessions(3);
  if (sessions.length > 0) {
    console.log("  recent sessions:");
    for (const sess of sessions) {
      console.log(`    ${sess.session_id.slice(0, 24)}  calls=${sess.n}  last=${new Date(sess.last_ts).toISOString()}`);
    }
  }
  if (s.topRepeated.length > 0) {
    console.log("  top repeated call signatures:");
    for (const r of s.topRepeated) console.log(`    ${r.tool_name} [${r.args_hash}] ×${r.n}`);
  }
  console.log("");
  console.log(`budget (${cfg.budget.plan}):`);
  const sid = latestSessionId() ?? "unknown";
  console.log(
    formatSnapshot(budgetSnapshot(sid, cfg.budget))
      .split("\n")
      .map((l) => "  " + l)
      .join("\n"),
  );
}

export function cmdDoctor(): number {
  let failures = 0;
  const cfg = loadConfig();
  const check = (good: boolean, okMsg: string, failMsg: string) => {
    if (good) ok(okMsg);
    else {
      fail(failMsg);
      failures++;
    }
  };

  check(
    Number(process.versions.node.split(".")[0]!) >= 22,
    `node ${process.versions.node}`,
    `node ${process.versions.node} is too old (need >=22.13 for node:sqlite)`,
  );

  try {
    fs.mkdirSync(guardHome(), { recursive: true });
    fs.accessSync(guardHome(), fs.constants.W_OK);
    check(true, `state dir writable: ${guardHome()}`, "");
    openDb().prepare("SELECT 1").get();
    check(true, `state db opens: ${stateDbPath()}`, "");
  } catch (err) {
    check(false, "", `state dir/db problem: ${(err as Error).message}`);
  }

  const kimi = detectKimiConfig();
  const hasClaude = claudeDetected();
  const hasCodex = codexDetected();
  const hasGemini = geminiDetected();
  if (kimi.exists || (!hasClaude && !hasCodex && !hasGemini)) {
    check(
      kimi.exists,
      `kimi config found: ${kimi.path}`,
      `kimi config not found (looked at ${kimi.path}); is Kimi Code CLI installed?`,
    );
    if (kimi.exists) {
      check(hooksInstalled(kimi.path), "[kimi] hooks managed block present in kimi config", "[kimi] hooks not installed — run: agentguard install");
    }
  } else {
    console.log(`  ${pc.dim("-")} kimi code not detected (skipped)`);
  }

  if (hasClaude) {
    check(
      claudeHooksInstalled(),
      `[claude] hooks present in ${claudeSettingsPath()}`,
      `[claude] hooks not installed — run: agentguard install --harness claude`,
    );
  } else {
    console.log(`  ${pc.dim("-")} claude code not detected (skipped)`);
  }

  if (codexDetected()) {
    check(
      codexHooksInstalled(),
      `[codex] hooks present in ${codexHooksPath()}`,
      `[codex] hooks not installed — run: agentguard install --harness codex`,
    );
  } else {
    console.log(`  ${pc.dim("-")} codex not detected (skipped)`);
  }

  if (geminiDetected()) {
    check(
      geminiHooksInstalled(),
      `[gemini] hooks present in ${geminiSettingsPath()}`,
      `[gemini] hooks not installed — run: agentguard install --harness gemini`,
    );
  } else {
    console.log(`  ${pc.dim("-")} gemini not detected (skipped)`);
  }

  const kimiConfigText = fs.existsSync(kimi.path) ? fs.readFileSync(kimi.path, "utf8") : "";
  const hasSecurityLayer = /kimi-boost managed|destructive|secret-guard|branch-guard|block-dangerous/i.test(kimiConfigText);
  if (hasSecurityLayer) {
    ok("security-layer hooks detected (authorization axis covered)");
  } else {
    warn("no security-layer hooks detected — agent-guard covers runtime behavior only (authorization axis). Consider kimi-boost presets: npx kimi-boost install");
  }

  const which = spawnSync("agentguard", ["--version"], { encoding: "utf8" });
  check(
    which.status === 0 || Boolean(process.argv[1]?.includes("agentguard") || process.argv[1]?.includes("kimi-guard")),
    "agentguard resolves on PATH",
    "agentguard is not on PATH — hook commands will fail-open. Install globally: npm i -g @shidesheng0218/agentguard",
  );

  const probeFile = probeLogPath();
  if (fs.existsSync(probeFile)) {
    const lines = fs.readFileSync(probeFile, "utf8").trim().split("\n").filter(Boolean);
    ok(`probe log has ${lines.length} samples (${probeFile})`);
    const keys = new Map<string, number>();
    for (const line of lines.slice(-50)) {
      try {
        const p = JSON.parse(line) as { payload?: Record<string, unknown> };
        for (const k of Object.keys(p.payload ?? {})) keys.set(k, (keys.get(k) ?? 0) + 1);
      } catch {
        /* skip */
      }
    }
    if (keys.size > 0) {
      console.log(`  observed payload keys: ${[...keys.entries()].map(([k, n]) => `${k}(${n})`).join(", ")}`);
    }
  } else {
    warn("no probe samples yet — run 'kguard probe on', use Kimi Code a bit, then 'kguard doctor'");
  }

  if (fs.existsSync(userConfigPath())) ok(`config present: ${userConfigPath()}`);
  else warn("no user config (defaults in effect) — run 'kguard config init' to create one");

  // Guard liveness: a guard that silently stops receiving hook payloads is the
  // worst failure mode (fail-open by design). Surface the signals we do have.
  try {
    const normalizeMisses = Number(getMeta("normalize_misses") ?? "0");
    if (normalizeMisses > 0) {
      const lastMiss = getMeta("last_normalize_miss_ts");
      warn(
        `${normalizeMisses} hook payload(s) failed to normalize (last: ${lastMiss ? new Date(Number(lastMiss)).toISOString() : "unknown"}) — ` +
          `possible upstream schema drift; run 'kguard probe on', use the CLI, then 'kguard probe show'`,
      );
    } else {
      ok("hook payload normalization: no misses recorded");
    }

    const lastHookTs = Number(getMeta("last_hook_ts") ?? "0");
    if (hooksInstalled(kimi.path)) {
      if (lastHookTs === 0) {
        warn("hooks installed but no hook activity recorded yet — the guard has never fired in this state db");
      } else if (Date.now() - lastHookTs > 24 * 3_600_000 && agentProcessRunning()) {
        warn(
          `hooks installed but no hook activity for over 24h while a kimi process is running — ` +
            `the guard may be silently inert (CLI update? reinstall hooks with 'kguard install')`,
        );
      } else {
        ok(`hook activity last seen ${new Date(lastHookTs).toISOString()}`);
      }
    }
  } catch {
    /* liveness checks are advisory — never fail doctor over them */
  }

  if (cfg.verify.veto.enabled) {
    if (vetoKeyConfigured()) ok(`verify veto: enabled, KIMI_GUARD_VETO_API_KEY present`);
    else warn("verify veto enabled but KIMI_GUARD_VETO_API_KEY is not set — the veto is inert at runtime (deterministic gate still works)");
  } else {
    ok("verify veto: off (pure deterministic gate)");
  }

  if (cfg.budget.precise) {
    if (preciseKeyConfigured()) ok("budget precise metering: enabled, KIMI_API_KEY present");
    else warn("budget precise metering enabled but KIMI_API_KEY is not set — falling back to event-based estimates");
  }

  if (failures === 0) console.log("\nAll checks passed.");
  else console.log(`\n${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}
