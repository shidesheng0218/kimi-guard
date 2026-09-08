import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { processHookEvent } from "../src/guard.js";
import {
  resetDbForTests,
  getMeta,
  recordCall,
  recordBlock,
  listBlocks,
  blocksSince,
  callsSince,
  countCallsWindow,
  setBlockFeedback,
} from "../src/store.js";
import { renderDashboard } from "../src/watch/render.js";
import { estSavedFromBlocks, STREAK_WINDOW_MS } from "../src/estSaved.js";
import { applyCalibrate } from "../src/calibrate.js";
import { buildDigest, formatDigestMarkdown } from "../src/digest.js";
import { fingerprint } from "../src/events.js";
import { budgetSnapshot } from "../src/meter.js";

let tmp: string;

beforeEach(() => {
  resetDbForTests(); // close any singleton inherited from a previous file in this worker
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-opt-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("auto-prune (throttled, blocks preserved)", () => {
  it("prunes old calls/events on hook entry, keeps blocks, throttles to once per day", () => {
    const now = Date.now();
    const old = now - 40 * 86_400_000;
    recordCall({ sessionId: "s", toolName: "Grep", argsHash: "h", argsJson: "{}", outputHash: null, filePath: null, status: "ok", ts: old });
    recordCall({ sessionId: "s", toolName: "Grep", argsHash: "h2", argsJson: "{}", outputHash: null, filePath: null, status: "ok", ts: now });
    const blockId = recordBlock("s", "Grep", "repeat", old);

        processHookEvent("TurnStarted", structuredClone(defaultConfig), { session_id: "s" }, now);
    expect(getMeta("last_prune_ts")).toBe(String(now));
    const remaining = callsSince("s", 0);
    expect(remaining).toHaveLength(1); // only the fresh call survives
    expect(listBlocks(10)[0]!.id).toBe(blockId); // blocks never pruned

    // throttle: same-day run doesn't change last_prune_ts
    processHookEvent("TurnStarted", structuredClone(defaultConfig), { session_id: "s" }, now + 1000);
    expect(getMeta("last_prune_ts")).toBe(String(now));
  });
});

describe("watch render: block reasons + session detail", () => {
  const base = {
    budget: budgetSnapshot("s", structuredClone(defaultConfig.budget)),
    now: Date.now(),
  };

  it("shows the persisted reason under each intervention", () => {
    const text = renderDashboard(
      {
        ...base,
        sessions: [],
        blocks: [{ id: 1, session_id: "s", tool_name: "Grep", kind: "repeat", ts: Date.now(), feedback: null, reason: "already been called 3 times with identical arguments" }],
      },
      100,
      30,
    ).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(text).toContain("already been called 3 times with identical arguments");
  });

  it("marks the selected session and renders detail view", () => {
    const sessions = [{ session_id: "sess-a", last_ts: Date.now(), n: 3 }];
    const overview = renderDashboard({ ...base, sessions, blocks: [], selected: 0 }, 100, 30).join("\n");
    expect(overview).toContain("▸");
    const detail = renderDashboard(
      { ...base, sessions, blocks: [], detail: { sessionId: "sess-a", calls: [{ tool_name: "Grep", ts: Date.now(), status: "ok" }] } },
      100,
      30,
    ).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
    expect(detail).toContain("DETAIL");
    expect(detail).toContain("sess-a");
    expect(detail).toContain("Grep");
    expect(detail).toContain("esc to go back");
  });
});

describe("calibrate --apply", () => {
  it("writes suggested exemptions with backup, union with existing config", () => {
    fs.writeFileSync(path.join(tmp, "config.toml"), `[repeat]\nexemptPatterns = ["keep-this"]\n`);
    for (let i = 0; i < 3; i++) {
      const ts = Date.now() - i * 1000;
      recordCall({
        sessionId: "s1",
        toolName: "Shell",
        argsHash: fingerprint("Shell", { command: "git status --short" }),
        argsJson: JSON.stringify({ command: "git status --short" }),
        outputHash: "o",
        filePath: null,
        status: "ok",
        ts,
      });
      const id = recordBlock("s1", "Shell", "repeat", ts);
      setBlockFeedback(id, "fp");
    }
    const r = applyCalibrate();
    expect(r.applied).toContain("git status");
    expect(r.backupPath).toBeDefined();
    const cfg = loadConfig(path.join(tmp, "config.toml"));
    expect(cfg.repeat.exemptPatterns).toContain("git status");
    expect(cfg.repeat.exemptPatterns).toContain("keep-this");
  });

  it("no-ops when there is nothing to apply", () => {
    const r = applyCalibrate();
    expect(r.applied).toHaveLength(0);
  });
});

describe("estSaved observed streaks", () => {
  it("raises the estimate for loops that were observed longer than the default", () => {
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      recordCall({ sessionId: "s", toolName: "Grep", argsHash: fingerprint("Grep", { p: "x" }), argsJson: "{}", outputHash: null, filePath: null, status: "ok", ts: now - 1000 });
    }
    recordBlock("s", "Grep", "repeat", now);
    const blocks = blocksSince(now - 1000);
    const saved = estSavedFromBlocks(blocks, (b) => countCallsWindow(b.session_id, b.tool_name, b.ts - STREAK_WINDOW_MS, b.ts));
    expect(saved).toBe(8); // observed streak 8 > default 5
  });

  it("falls back to the coefficient without observations", () => {
    recordBlock("s", "Grep", "repeat", Date.now());
    const saved = estSavedFromBlocks(blocksSince(Date.now() - 1000), () => 0);
    expect(saved).toBe(5);
  });
});

describe("digest markdown", () => {
  it("renders a shareable markdown digest", () => {
    recordBlock("s", "Grep", "repeat", Date.now());
    const md = formatDigestMarkdown(buildDigest(1));
    expect(md).toContain("# agent-guard weekly digest");
    expect(md).toContain("| metric | value |");
    expect(md).toContain("**repeat**");
    expect(md).toContain("heuristic");
  });
});

describe("blocks filters (CLI)", () => {
  const repoRoot = path.join(import.meta.dirname, "..");
  const CLI = path.join(repoRoot, "node_modules", ".bin", "tsx");

  it("filters by kind / session / fp", () => {
    const id1 = recordBlock("sess-aaa", "Grep", "repeat");
    recordBlock("sess-bbb", "Shell", "churn");
    setBlockFeedback(id1, "fp");
    const env = { ...process.env, KIMI_GUARD_HOME: tmp };
    const run = (args: string[]) => execFileSync(CLI, ["src/cli.ts", "blocks", ...args], { cwd: repoRoot, env, encoding: "utf8" });
    expect(run(["--kind", "repeat"])).toContain("sess-aaa");
    expect(run(["--kind", "repeat"])).not.toContain("sess-bbb");
    expect(run(["--session", "bbb"])).toContain("churn");
    const fp = run(["--fp"]);
    expect(fp).toContain("FALSE POSITIVE");
    expect(fp).not.toContain("churn");
  }, 60000);
});

