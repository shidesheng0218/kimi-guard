import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig } from "../src/config.js";
import { analyzeCall } from "../src/analysis.js";
import { fingerprint } from "../src/events.js";
import { resetDbForTests, type CallRow } from "../src/store.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-perf-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mkRow = (i: number): CallRow => ({
  tool_name: i % 3 === 0 ? "Grep" : i % 3 === 1 ? "Shell" : "ReadFile",
  args_hash: fingerprint("Grep", { pattern: `p${i}` }),
  args_json: JSON.stringify({ pattern: `pattern-${i}`, path: `src/m${i % 7}.ts` }),
  output_hash: `h${i % 11}`,
  output_sample: `output content ${i % 13} with some text to compare against`,
  file_path: `src/m${i % 7}.ts`,
  status: "ok",
  ts: Date.now() - i * 1000,
});

describe("analyzer latency budget (guard must never slow the agent loop)", () => {
  it("analyzeCall stays under 50ms per call with a 500-row history window", () => {
    const cfg = structuredClone(defaultConfig);
    const history = Array.from({ length: 500 }, (_, i) => mkRow(i));
    const proposed = { tool: "Grep", argsHash: fingerprint("Grep", { pattern: "new" }), args: { pattern: "new" } };
    const t0 = performance.now();
    for (let i = 0; i < 50; i++) analyzeCall(history, proposed, cfg);
    const perCall = (performance.now() - t0) / 50;
    expect(perCall).toBeLessThan(50);
  });

  it("fingerprint stays under 50ms per 1000 hashes", () => {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) fingerprint("Shell", { command: `git status ${i}`, cwd: "/tmp" });
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
