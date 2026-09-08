import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSupervised } from "../src/wire/supervisor.js";
import { writeIncident, buildIncidentMarkdown, latestRunId } from "../src/incident.js";
import { resetDbForTests } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-inc-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("incident report", () => {
  it("generates a shareable post-mortem from a real run", async () => {
    const fake = path.join(import.meta.dirname, "wire", "fake-kimi.mjs");
    const r = await runSupervised({
      prompt: "find foo",
      command: [process.execPath, fake],
      cwd: tmp,
      env: { FAKE_SCENARIO: "loop" },
      maxSteps: 50,
      maxMinutes: 1,
      steerOnWarn: true,
      maxSteers: 5,
      autoResume: 0,
      maxVerifyRounds: 2,
      approval: "reject",
      json: false,
    });

    expect(latestRunId()).toBe(r.runId);
    const out = writeIncident(r.runId);
    expect(out).not.toBeNull();
    expect(fs.existsSync(out!.path)).toBe(true);

    const md = out!.markdown;
    expect(md).toContain("runaway agent caught");
    expect(md).toContain("repeat");
    expect(md).toContain("Interventions");
    expect(md).toContain("Timeline");
    expect(md).toContain("already been called 3 times");
    expect(md).toContain("Impact");
    // no duplicate block entries (report blocks + db blocks deduped)
    expect(md.match(/### repeat on/g)).toHaveLength(1);
  }, 30000);

  it("returns null when there is no data for the run", () => {
    expect(buildIncidentMarkdown("no-such-run")).toBeNull();
  });
});
