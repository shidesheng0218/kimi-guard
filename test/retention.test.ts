import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig, serializeConfig, importConfig, findProjectConfig } from "../src/config.js";
import { estimateSaved, estSavedFromWindow } from "../src/estSaved.js";
import { buildDigest, formatDigest } from "../src/digest.js";
import { recordBlock, resetDbForTests } from "../src/store.js";

let tmp: string;
let origCwd: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-ret-"));
  process.env.KIMI_GUARD_HOME = tmp;
  origCwd = process.cwd();
});

afterEach(() => {
  process.chdir(origCwd);
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("estSaved estimation", () => {
  it("credits each block with kind-specific saved requests", () => {
    const e = estimateSaved([
      { kind: "repeat", n: 2, fp: 0, tp: 0 },
      { kind: "churn", n: 3, fp: 0, tp: 0 },
      { kind: "unknown", n: 5, fp: 0, tp: 0 },
    ]);
    expect(e.total).toBe(2 * 5 + 3 * 3 + 5 * 1);
    expect(e.byKind).toHaveLength(3);
  });

  it("window estimation sums kinds", () => {
    expect(estSavedFromWindow([{ kind: "repeat", n: 1 }, { kind: "explore", n: 2 }])).toBe(9);
  });
});

describe("digest", () => {
  it("summarizes activity with estimated savings", () => {
    const now = Date.now();
    for (let i = 0; i < 3; i++) recordBlock("s1", "Grep", "repeat", now - 1000);
    const d = buildDigest(1, now);
    expect(d.blocksByKind).toEqual([{ kind: "repeat", n: 3 }]);
    expect(d.estSaved).toBe(15);
    const text = formatDigest(d);
    expect(text).toContain("3 interventions");
    expect(text).toContain("~15");
    expect(text).toContain("heuristic");
  });

  it("empty period renders a friendly zero-state", () => {
    const text = formatDigest(buildDigest(1));
    expect(text).toContain("no agent activity recorded");
  });
});

describe("project config (.agentguard.toml)", () => {
  it("project file overrides user config; user overrides profile", () => {
    const userCfg = path.join(tmp, "user.toml");
    fs.writeFileSync(userCfg, `profile = "strict"\n[repeat]\nmaxRepeats = 7\n`);
    const repo = path.join(tmp, "repo", "sub", "dir");
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(tmp, "repo", ".agentguard.toml"), `[repeat]\nmaxRepeats = 2\n`);
    process.chdir(path.join(tmp, "repo", "sub", "dir"));

    const c = loadConfig(userCfg);
    expect(c.repeat.maxRepeats).toBe(2); // project wins over user
    expect(c.noGain.warnAt).toBe(2); // profile strict survives both
    expect(fs.realpathSync(c.projectConfigPath!)).toBe(fs.realpathSync(path.join(tmp, "repo", ".agentguard.toml")));
  });

  it("findProjectConfig walks up; returns null outside any project", () => {
    const repo = path.join(tmp, "x");
    fs.mkdirSync(path.join(repo, "deep", "deeper"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".agentguard.toml"), "");
    expect(fs.realpathSync(findProjectConfig(path.join(repo, "deep", "deeper"))!)).toBe(fs.realpathSync(path.join(repo, ".agentguard.toml")));
    expect(findProjectConfig(path.join(os.tmpdir(), "no-such-proj-" + Date.now()))).toBeNull();
  });
});

describe("config export/import", () => {
  it("export → import roundtrip preserves effective values", () => {
    const c = loadConfig(path.join(tmp, "nope.toml"));
    const toml = serializeConfig(c);
    expect(toml).toContain("[repeat]");
    expect(toml).toContain("maxRepeats = 3");

    const target = path.join(tmp, "user-config.toml");
    fs.writeFileSync(target, `[repeat]\nmaxRepeats = 3\n`);
    const exported = path.join(tmp, "shared.toml");
    fs.writeFileSync(exported, `[repeat]\nmaxRepeats = 9\n[nearRepeat]\nwarnAt = 4\n`);
    const r = importConfig(exported, target);
    expect(r.merged).toBe(true);
    expect(r.backupPath).toBeDefined();

    const after = loadConfig(target);
    expect(after.repeat.maxRepeats).toBe(9);
    expect(after.nearRepeat.warnAt).toBe(4);
    expect(after.churn.blockAt).toBe(defaultConfig.churn.blockAt); // untouched keys survive
  });

  it("refuses a malformed import file with a clear error", () => {
    const bad = path.join(tmp, "bad.toml");
    fs.writeFileSync(bad, "{{{{ not toml");
    const r = importConfig(bad, path.join(tmp, "user.toml"));
    expect(r.merged).toBe(false);
    expect(r.error).toContain("cannot parse");
  });
});

describe("digest inputs stay honest", () => {
  it("window stats only count the window", () => {
    const old = Date.now() - 30 * 86_400_000;
    recordBlock("s1", "Grep", "repeat", old);
    recordBlock("s1", "Grep", "repeat", Date.now());
    const d = buildDigest(1);
    expect(d.blocksByKind).toEqual([{ kind: "repeat", n: 1 }]);
    expect(d.estSaved).toBe(5);
  });
});
