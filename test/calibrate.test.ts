import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resetDbForTests, recordBlock, recordCall, setBlockFeedback, crossSessionRepeats } from "../src/store.js";
import { buildCalibrateReport, formatCalibrateReport } from "../src/calibrate.js";
import { fingerprint } from "../src/events.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-cal-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("calibrate", () => {
  it("suggests raising thresholds when FP rate > 30% with ≥5 samples", () => {
    for (let i = 0; i < 10; i++) {
      const id = recordBlock("s1", "Grep", "repeat");
      if (i < 5) setBlockFeedback(id, "fp");
    }
    const r = buildCalibrateReport();
    const sug = r.detectorSuggestions.find((d) => d.kind === "repeat");
    expect(sug).toBeDefined();
    expect(sug!.toml).toContain("maxRepeats = 5"); // default 3 + 2
    expect(sug!.fpRate).toBe(0.5);
  });

  it("suggests exemptPatterns from repeat false-positives with a stable command prefix", () => {
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
    const r = buildCalibrateReport();
    expect(r.exemptSuggestions).toContain("git status");
  });

  it("stays quiet with clean data", () => {
    for (let i = 0; i < 6; i++) {
      const id = recordBlock("s1", "Grep", "repeat");
      setBlockFeedback(id, "tp");
    }
    const r = buildCalibrateReport();
    expect(r.detectorSuggestions).toHaveLength(0);
    expect(formatCalibrateReport(r)).toContain("looks fine");
  });
});

describe("cross-session repeats", () => {
  it("reports only signatures repeated across multiple sessions", () => {
    const h = fingerprint("Shell", { command: "make test" });
    for (const sess of ["a", "b", "c"]) {
      recordCall({ sessionId: sess, toolName: "Shell", argsHash: h, argsJson: "{}", outputHash: null, filePath: null, status: "ok" });
    }
    recordCall({ sessionId: "solo", toolName: "Grep", argsHash: "other", argsJson: "{}", outputHash: null, filePath: null, status: "ok" });
    const rows = crossSessionRepeats(Date.now() - 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool_name).toBe("Shell");
    expect(rows[0]!.sessions).toBe(3);
    expect(rows[0]!.n).toBe(3);
  });
});
