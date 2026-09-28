import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStallWatch, STALL_SUSPICIOUS_AFTER } from "../src/stall.js";
import { processHookEvent } from "../src/guard.js";
import { defaultConfig, loadConfig } from "../src/config.js";
import { resetDbForTests } from "../src/store.js";
import type { WebhookPayload } from "../src/notify.js";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-stall-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("createStallWatch (injected clock)", () => {
  it("fires once when idle past the threshold, re-arms after ping", () => {
    let t = 1_000_000;
    const stalls: number[] = [];
    const w = createStallWatch({ minutes: 10, now: () => t, onStall: (m) => stalls.push(m) });

    t += 9 * 60_000;
    w.check();
    expect(stalls).toHaveLength(0);

    t += 2 * 60_000; // 11 min idle
    w.check();
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toBeCloseTo(11, 0);

    w.check(); // latched: no double alert for the same stall
    t += 30 * 60_000;
    w.check();
    expect(stalls).toHaveLength(1);

    w.ping(); // activity resumes → re-arm
    t += 11 * 60_000;
    w.check();
    expect(stalls).toHaveLength(2);
    w.stop();
  });

  it("never fires while a tool is in flight (long builds are not stalls)", () => {
    let t = 0;
    const stalls: number[] = [];
    let busy = true;
    const w = createStallWatch({ minutes: 10, now: () => t, isBusy: () => busy, onStall: () => stalls.push(1) });
    t += 60 * 60_000; // an hour of silence with a tool running
    w.check();
    expect(stalls).toHaveLength(0);
    busy = false;
    w.check();
    expect(stalls).toHaveLength(1);
    w.stop();
  });

  it("works with the real interval timer (smoke)", async () => {
    const stalls: number[] = [];
    const w = createStallWatch({ minutes: 0.001, checkEveryMs: 20, onStall: (m) => stalls.push(m) });
    await vi.waitFor(() => expect(stalls.length).toBeGreaterThan(0), { timeout: 3000 });
    w.stop();
  });
});

describe("[stall] config", () => {
  it("defaults: enabled, 10 minutes", () => {
    const c = loadConfig(path.join(tmp, "nope.toml"));
    expect(c.stall.enabled).toBe(true);
    expect(c.stall.minutes).toBe(10);
  });

  it("parses overrides", () => {
    const p = path.join(tmp, "c.toml");
    fs.writeFileSync(p, `[stall]\nenabled = false\nminutes = 25\n`);
    const c = loadConfig(p);
    expect(c.stall.enabled).toBe(false);
    expect(c.stall.minutes).toBe(25);
  });
});

describe("hook-path stall gap (alert when a stall ends)", () => {
  let server: Server | null = null;
  let received: WebhookPayload[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    received = [];
  });

  async function startServer(): Promise<string> {
    received = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push(JSON.parse(data || "{}") as WebhookPayload);
        res.writeHead(200);
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  function cfgWith(url: string) {
    const cfg = structuredClone(defaultConfig);
    cfg.notify.webhookUrl = url;
    cfg.stall.minutes = 10;
    return cfg;
  }

  const T0 = 1_800_000_000_000;
  const grep = { session_id: "stall-sess", tool_name: "Grep", tool_input: { pattern: "x" } };

  it("a 20-min silence after PostToolUse alerts once the session resumes", async () => {
    const cfg = cfgWith(await startServer());
    processHookEvent("PostToolUse", cfg, grep, T0);
    processHookEvent("PreToolUse", cfg, grep, T0 + 20 * 60_000);
    await vi.waitFor(() => expect(received.some((p) => p.event === "stall")).toBe(true), { timeout: 3000 });
    const stall = received.find((p) => p.event === "stall")!;
    expect(stall.session).toBe("stall-sess");
    expect(stall.text).toContain("PostToolUse");
  });

  it("silence after Stop is the user thinking — never a stall", async () => {
    const cfg = cfgWith(await startServer());
    processHookEvent("Stop", cfg, grep, T0);
    processHookEvent("UserPromptSubmit", cfg, { session_id: "stall-sess", prompt: "next" }, T0 + 60 * 60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((p) => p.event === "stall")).toHaveLength(0);
  });

  it("short gaps never alert", async () => {
    const cfg = cfgWith(await startServer());
    processHookEvent("PostToolUse", cfg, grep, T0);
    processHookEvent("PreToolUse", cfg, grep, T0 + 5 * 60_000);
    await new Promise((r) => setTimeout(r, 300));
    expect(received.filter((p) => p.event === "stall")).toHaveLength(0);
  });

  it("STALL_SUSPICIOUS_AFTER excludes user-side and tool-running events", () => {
    for (const ev of ["Stop", "SessionEnd", "Interrupt", "PreToolUse", "PreCompact"]) {
      expect(STALL_SUSPICIOUS_AFTER.has(ev)).toBe(false);
    }
  });
});
