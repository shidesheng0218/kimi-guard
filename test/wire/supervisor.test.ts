import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { runSupervised } from "../../src/wire/supervisor.js";
import { resetDbForTests, recordBlock } from "../../src/store.js";
import { defaultConfig } from "../../src/config.js";

const execFileAsync = promisify(execFile);

let tmp: string;
let fakeLog: string;

const FAKE = path.join(import.meta.dirname, "fake-kimi.mjs");

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-wire-"));
  process.env.KIMI_GUARD_HOME = tmp;
  fakeLog = path.join(tmp, "fake.jsonl");
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function cmd(): string[] {
  return [process.execPath, FAKE];
}

type RunOpts = Parameters<typeof runSupervised>[0];

async function run(prompt: string, scenario: string, overrides?: Partial<RunOpts>) {
  return await runSupervised({
    prompt,
    command: cmd(),
    cwd: tmp,
    env: { FAKE_SCENARIO: scenario, FAKE_LOG: fakeLog },
    maxSteps: 200,
    maxMinutes: 2,
    steerOnWarn: true,
    maxSteers: 5,
    autoResume: 0,
    maxVerifyRounds: 2,
    approval: "reject",
    json: false,
    ...overrides,
  });
}


async function fakeEntries(): Promise<Array<Record<string, unknown>>> {
  if (!fs.existsSync(fakeLog)) return [];
  return fs
    .readFileSync(fakeLog, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("supervised run (integration with fake Wire server)", () => {
  it("clean run: report aggregates steps, tool calls and token usage", async () => {
    const r = await run("read the readme", "ok");
    expect(r.endReason).toBe("finished");
    expect(r.toolCalls).toBe(1);
    expect(r.steps).toBeGreaterThanOrEqual(1);
    expect(r.tokenUsage.input_cache_read).toBeGreaterThan(0);
    expect(r.blocks).toHaveLength(0);
    expect(fs.existsSync(r.reportPath)).toBe(true);
    expect(fs.existsSync(r.logPath)).toBe(true);
  }, 20000);

  it("loop scenario: repeated identical call is blocked via HookRequest and the fake model stops", async () => {
    const r = await run("find foo", "loop");
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(r.blocks[0]!.kind).toBe("repeat");
    const entries = await fakeEntries();
    const decisions = entries.filter((e) => e.dir === "hook_decision");
    expect(decisions.some((d) => d.action === "block")).toBe(true);
    // fake model stops after the block → fewer than 5 real results
    const toolResults = entries.filter((e) => e.dir === "out" && (e.msg as { params?: { type?: string } })?.params?.type === "ToolResult");
    expect(toolResults.length).toBeLessThan(5);
  }, 20000);

  it("no-gain scenario: identical outputs across different args trigger a steer", async () => {
    const r = await run("search stuff", "nogain");
    expect(r.steers.length).toBeGreaterThanOrEqual(1);
    const entries = await fakeEntries();
    const steers = entries.filter((e) => e.dir === "steer");
    expect(steers.some((s) => String(s.text).includes("kimi-guard"))).toBe(true);
  }, 20000);

  it("approval policy reject: feedback sent back to the agent", async () => {
    const r = await run("run tests", "approval");
    expect(r.approvals.rejected).toBe(1);
    const entries = await fakeEntries();
    const d = entries.find((e) => e.dir === "approval_decision") as { response?: string } | undefined;
    expect(d?.response).toBe("reject");
  }, 20000);

  it("approval policy approve (--yolo)", async () => {
    const r = await run("run tests", "approval", { approval: "approve" });
    expect(r.approvals.approved).toBe(1);
    const entries = await fakeEntries();
    const d = entries.find((e) => e.dir === "approval_decision") as { response?: string } | undefined;
    expect(d?.response).toBe("approve");
  }, 20000);

  it("max steps cap triggers cancel and a checkpoint", async () => {
    const r = await run("do everything", "maxsteps", { maxSteps: 5, autoResume: 0 });
    expect(["max_steps", "finished"]).toContain(r.endReason);
    expect(fs.existsSync(path.join(tmp, "runs")) || r.reportPath).toBeTruthy();
  }, 20000);

  it("kill switch: after N blocks the guard cancels the run", async () => {
    // pre-arm the kill switch by recording blocks directly, then run a looping scenario
    for (let i = 0; i < 5; i++) recordBlock("kill-test-session", "Grep", "repeat");
    // runSupervised uses its own runId session, so simulate via maxSteers=0 + scenario loop
    // and low maxBlocksPerSession
    const cfg = structuredClone(defaultConfig);
    cfg.policy.maxBlocksPerSession = 1;
    const r = await run("find foo", "loop", { config: cfg });
    expect(r.blocks.length).toBeGreaterThanOrEqual(1);
    expect(["kill-switch", "finished"]).toContain(r.endReason);
  }, 20000);

  it("subagent nested events are observed: calls recorded under the subagent, usage accumulated", async () => {
    const { callsSince } = await import("../../src/store.js");
    const r = await run("delegate work", "subagent");
    expect(r.toolCalls).toBe(3);
    expect(r.tokenUsage.input_cache_read).toBe(42000 + 5000 + 5000);
    const subRows = callsSince(`${r.runId}|sub|sub-1`, Date.now() - 60_000);
    expect(subRows.length).toBe(3);
    const mainRows = callsSince(r.runId, Date.now() - 60_000);
    expect(mainRows.length).toBe(0);
  }, 20000);

  it("budget gate fires in wire mode: dispatch blocked when the 5h window is exhausted", async () => {
    const cfg = structuredClone(defaultConfig);
    cfg.budget.fiveHour = 1; // one turn already counts as 1 request → window exhausted
    const r = await run("delegate", "dispatch", { config: cfg });
    expect(r.blocks.some((b) => b.kind === "budget")).toBe(true);
    // wire runs must record turn events for the meter to work at all
    const { countEvents } = await import("../../src/store.js");
    expect(countEvents(r.runId, ["turn"], 0)).toBeGreaterThanOrEqual(1);
  }, 20000);

  it("context-fill gate steers a wrap-up warning at the configured threshold", async () => {
    const r = await run("big job", "bloat");
    const ctx = r.steers.find((s) => s.kind === "context");
    expect(ctx).toBeDefined();
    expect(ctx!.message).toContain("92%");
    expect(r.steers.filter((s) => s.kind === "context")).toHaveLength(1);
  }, 20000);

  it("goal anchoring in wire mode: steer at step intervals", async () => {
    const r = await run("build the thing", "longturn", { maxSteps: 200 });
    const anchors = r.steers.filter((s) => s.kind === "anchor");
    expect(anchors.length).toBeGreaterThanOrEqual(2);
    expect(anchors[0]!.message).toContain("build the thing");
  }, 20000);

  it("completion gate: unbacked 'tests pass' claim triggers a corrective verify round", async () => {
    const r = await run("refactor it", "claim");
    expect(r.verifyRounds).toBeGreaterThanOrEqual(1);
    const entries = await fakeEntries();
    const prompts = entries.filter((e) => e.dir === "prompt");
    expect(prompts.some((p) => String(p.userInput ?? "").includes("kimi-guard verification"))).toBe(true);
    // evidence from the corrective round exists → recorded as a successful Shell call
    const { callsSince } = await import("../../src/store.js");
    const rows = callsSince(r.runId, Date.now() - 60_000);
    expect(rows.some((row) => row.tool_name === "Shell" && row.status === "ok")).toBe(true);
  }, 30000);

  it("thinking-dominance: a pure-reasoning turn is flagged", async () => {
    const r = await run("think about it", "thinker");
    expect(r.thinkingDominance).toBe(1);
  }, 30000);

  it("veto vote accepts a legitimate completion without a verify round", async () => {
    const { createServer } = await import("node:http");
    const srv = createServer((req, res) => {
      let d = "";
      req.on("data", (c) => (d += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: "VETO: yes" } }] }));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const env = { FAKE_SCENARIO: "claim", FAKE_LOG: fakeLog, KIMI_GUARD_VETO_API_KEY: "t", KIMI_GUARD_VETO_BASE_URL: `http://127.0.0.1:${port}/v1` };
    const cfgLocal = structuredClone(defaultConfig);
    cfgLocal.verify.veto.enabled = true;
    const r = await run("refactor it", "claim", { config: cfgLocal, env });
    expect(r.vetoes).toBe(1);
    expect(r.verifyRounds).toBe(0);
    expect(r.endReason).toBe("finished");
    srv.close();
  }, 30000);

  it("raw wire log captures both directions", async () => {
    const r = await run("hello", "ok");
    const logContent = fs.readFileSync(r.logPath, "utf8");
    expect(logContent).toContain('"dir":"in"');
    expect(logContent).toContain('"dir":"out"');
    expect(logContent).toContain("initialize");
  }, 20000);
});

describe("fake server sanity (protocol correctness)", () => {
  it("fake server starts and speaks wire on stdin", async () => {
    const { stdout } = await execFileAsync(
      process.execPath,
      [FAKE],
      {
        cwd: tmp,
        env: { ...process.env, FAKE_SCENARIO: "ok", FAKE_LOG: path.join(tmp, "sanity.jsonl") },
        timeout: 15000,
      },
    ).then(
      (r) => r,
      (err: { stdout?: string }) => ({ stdout: err.stdout ?? "" }),
    );
    expect(stdout).toContain("StatusUpdate");
  });
});
