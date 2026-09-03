import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadConfig } from "../src/config.js";
import { applyProfile } from "../src/profiles.js";
import { resetDbForTests } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-profile-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.AGENT_GUARD_PROFILE;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("threshold profiles", () => {
  it("strict tightens the loop thresholds", () => {
    const c = structuredClone(defaultConfig);
    applyProfile(c, "strict");
    expect(c.repeat.maxRepeats).toBe(2);
    expect(c.repeat.warnAt).toBe(1);
    expect(c.policy.maxBlocksPerSession).toBe(3);
    expect(c.profile).toBe("strict");
  });

  it("chill loosens them", () => {
    const c = structuredClone(defaultConfig);
    applyProfile(c, "chill");
    expect(c.repeat.maxRepeats).toBe(5);
    expect(c.policy.maxBlocksPerSession).toBe(8);
    expect(c.profile).toBe("chill");
  });

  it("unknown profile falls back to balanced", () => {
    const c = structuredClone(defaultConfig);
    applyProfile(c, "paranoid");
    expect(c.profile).toBe("balanced");
    expect(c.repeat.maxRepeats).toBe(defaultConfig.repeat.maxRepeats);
  });

  it("profile key in config.toml applies; explicit keys still win", () => {
    const p = path.join(tmp, "config.toml");
    fs.writeFileSync(p, `profile = "strict"\n[repeat]\nmaxRepeats = 9\n`);
    const c = loadConfig(p);
    expect(c.profile).toBe("strict");
    expect(c.noGain.warnAt).toBe(2); // from profile
    expect(c.repeat.maxRepeats).toBe(9); // user key wins over profile
  });

  it("env var and flag override the file", () => {
    const p = path.join(tmp, "config.toml");
    fs.writeFileSync(p, `profile = "chill"\n`);
    process.env.AGENT_GUARD_PROFILE = "strict";
    expect(loadConfig(p).repeat.maxRepeats).toBe(2); // env beats file
    expect(loadConfig(p, "kimi", "chill").repeat.maxRepeats).toBe(5); // flag beats env
  });
});
