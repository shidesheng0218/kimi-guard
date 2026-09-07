import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNotifyScript, notifyDesktop } from "../src/notify.js";
import { menubarText } from "../src/menubar.js";
import { resetDbForTests, recordBlock } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-desktop-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("desktop notifications", () => {
  it("builds a well-formed AppleScript (escaping, truncation, sound)", () => {
    const s = buildNotifyScript('title "x"', 'body with "quotes"', { sound: true });
    expect(s).toContain('with title "title \\"x\\""');
    expect(s).toContain('body with \\"quotes\\"');
    expect(s).toContain('sound name "Glass"');
    const noSound = buildNotifyScript("t", "b");
    expect(noSound).not.toContain("sound name");
  });

  it("never throws, even off-darwin", () => {
    expect(() => notifyDesktop("t", "b")).not.toThrow();
  });
});

describe("menubar (xbar/SwiftBar protocol)", () => {
  it("prints headline, separator, and menu entries", () => {
    recordBlock("s1", "Grep", "repeat");
    const out = menubarText();
    const lines = out.split("\n");
    expect(lines[0]).toContain("🛡️");
    expect(lines).toContain("---");
    expect(out).toContain("interventions (24h): 1");
    expect(out).toContain("last block: repeat on Grep");
    expect(out).toContain("shell=agentguard");
  });
});
