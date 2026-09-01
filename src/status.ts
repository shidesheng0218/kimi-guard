import fs from "node:fs";
import { spawnSync } from "node:child_process";
import pc from "picocolors";
import { loadConfig } from "./config.js";
import { guardHome, probeLogPath, stateDbPath, detectKimiConfig, userConfigPath } from "./paths.js";
import { hooksInstalled } from "./installer.js";
import { buildStatus, openDb, knownSessions } from "./store.js";
import { budgetSnapshot, formatSnapshot } from "./meter.js";
import { latestSessionId } from "./checkpoint.js";
import { vetoKeyConfigured } from "./veto.js";

function ok(msg: string): void {
  console.log(`${pc.green("✓")} ${msg}`);
}

function warn(msg: string): void {
  console.log(`${pc.yellow("!")} ${msg}`);
}

function fail(msg: string): void {
  console.log(`${pc.red("✗")} ${msg}`);
}

export function cmdStatus(): void {
  const cfg = loadConfig();
  const s = buildStatus();
  const dt = s.lastActivityTs ? new Date(s.lastActivityTs).toISOString() : "never";
  console.log(`kimi-guard status (state: ${stateDbPath()})`);
  console.log(`  last activity:       ${dt}`);
  console.log(`  tool calls (24h):    ${s.calls24h}`);
  const parts24 = s.blocks24h.map((b) => `${b.kind}×${b.n}`).join(", ");
  console.log(`  interventions (24h): ${parts24 || "none"}`);
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
    check(true, `state db opens (schema v2): ${stateDbPath()}`, "");
  } catch (err) {
    check(false, "", `state dir/db problem: ${(err as Error).message}`);
  }

  const kimi = detectKimiConfig();
  check(
    kimi.exists,
    `kimi config found: ${kimi.path}`,
    `kimi config not found (looked at ${kimi.path}); is Kimi Code CLI installed?`,
  );
  check(hooksInstalled(kimi.path), "hooks managed block present in kimi config", "hooks not installed — run: kguard install");

  const kimiConfigText = fs.existsSync(kimi.path) ? fs.readFileSync(kimi.path, "utf8") : "";
  const hasSecurityLayer = /kimi-boost managed|destructive|secret-guard|branch-guard|block-dangerous/i.test(kimiConfigText);
  if (hasSecurityLayer) {
    ok("security-layer hooks detected (authorization axis covered)");
  } else {
    warn("no security-layer hooks detected — kimi-guard covers runtime behavior only (authorization axis). Consider kimi-boost presets: npx kimi-boost install");
  }

  const which = spawnSync("kguard", ["--version"], { encoding: "utf8" });
  check(
    which.status === 0 || Boolean(process.argv[1]?.includes("kimi-guard")),
    "kguard resolves on PATH",
    "kguard is not on PATH — hook commands will fail-open. Install globally: npm i -g kimi-guard",
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

  if (cfg.verify.veto.enabled) {
    if (vetoKeyConfigured()) ok(`verify veto: enabled, KIMI_GUARD_VETO_API_KEY present`);
    else warn("verify veto enabled but KIMI_GUARD_VETO_API_KEY is not set — the veto is inert at runtime (deterministic gate still works)");
  } else {
    ok("verify veto: off (pure deterministic gate)");
  }

  if (failures === 0) console.log("\nAll checks passed.");
  else console.log(`\n${failures} check(s) failed.`);
  return failures === 0 ? 0 : 1;
}
