import { beforeEach, afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { defaultConfig } from "../src/config.js";
import { resetDbForTests, recordEvent } from "../src/store.js";
import { budgetSnapshot, formatSnapshot } from "../src/meter.js";
import { parseUsagePayload, cachedPreciseUsage, refreshPreciseUsage, refreshPreciseIfStale } from "../src/precise.js";

let tmp: string;
let srv: Server | null = null;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-precise-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(async () => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.KIMI_API_KEY;
  fs.rmSync(tmp, { recursive: true, force: true });
  if (srv) await new Promise<void>((r) => srv!.close(() => r()));
  srv = null;
});

function budgetCfg() {
  return { ...structuredClone(defaultConfig.budget), plan: "tier1", weekly: 1024, fiveHour: 200 };
}

describe("parseUsagePayload (defensive across known API shapes)", () => {
  it("parses the data-list shape with model_name 'all' + 300-minute window", () => {
    const now = Date.now();
    const p = parseUsagePayload(
      {
        data: [
          { model_name: "all", limit: 1024, used: 300, resetTime: now + 86_400_000 },
          { detail: { duration: 300, timeUnit: "minute", limit_amount: 200, used_amount: 45, reset_in: 7200 } },
        ],
      },
      now,
    );
    expect(p?.weekly).toEqual({ used: 300, limit: 1024, resetsAt: now + 86_400_000 });
    expect(p?.fiveHour?.used).toBe(45);
    expect(p?.fiveHour?.limit).toBe(200);
    expect(p?.fiveHour?.resetsAt).toBe(now + 7200 * 1000);
  });

  it("parses the usage+limits shape with remaining-only counts", () => {
    const now = Date.now();
    const p = parseUsagePayload(
      { usage: { limit: 200, remaining: 150 }, limits: [{ duration: 7, time_unit: "day", limit: 1024, used: 10 }] },
      now,
    );
    // unlabeled usage block (no window info) is treated as weekly; derived used = limit - remaining
    expect(p?.weekly?.used).toBe(50);
  });

  it("accepts alternate field spellings (reset_at / used_amount / time_unit)", () => {
    const now = Date.now();
    const p = parseUsagePayload(
      { data: [{ scope: "all", limit_amount: 2048, used_amount: 7, reset_at: "2030-01-01T00:00:00Z" }] },
      now,
    );
    expect(p?.weekly?.limit).toBe(2048);
    expect(p?.weekly?.resetsAt).toBe(Date.parse("2030-01-01T00:00:00Z"));
  });

  it("returns null for garbage payloads", () => {
    expect(parseUsagePayload(null)).toBeNull();
    expect(parseUsagePayload({ data: [] })).toBeNull();
    expect(parseUsagePayload("nope")).toBeNull();
  });
});

describe("precise metering integration", () => {
  it("fresh official readings override event-based window estimates", async () => {
    const now = Date.now();
    recordEvent("s1", "turn", {}, now - 60_000); // event-based: 1 request
    srv = createServer((req, res) => {
      expect(req.url).toBe("/coding/v1/usages");
      expect(req.headers.authorization).toBe("Bearer test-key");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ model_name: "all", limit: 1024, used: 900 }, { duration: 300, timeUnit: "minute", limit: 200, used: 187 }] }));
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv!.address() as { port: number }).port;

    const cfg = { ...budgetCfg(), precise: true, preciseUrl: `http://127.0.0.1:${port}/coding/v1` };
    const usage = await refreshPreciseUsage(cfg, { ...process.env, KIMI_API_KEY: "test-key" });
    expect(usage?.fiveHour?.used).toBe(187);

    const snap = budgetSnapshot("s1", cfg, now);
    expect(snap.precise).toBe(true);
    expect(snap.fiveHour.used).toBe(187); // not 1
    expect(snap.weekly.used).toBe(900);
    expect(formatSnapshot(snap)).toContain("official API");
  });

  it("cache TTL is honored — no second fetch within preciseCacheSeconds", async () => {
    let hits = 0;
    srv = createServer((_req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ model_name: "all", limit: 100, used: 1 }] }));
    });
    await new Promise<void>((r) => srv!.listen(0, "127.0.0.1", r));
    const port = (srv!.address() as { port: number }).port;
    const env = { ...process.env, KIMI_API_KEY: "k" };
    const cfg = { ...budgetCfg(), precise: true, preciseUrl: `http://127.0.0.1:${port}` };
    await refreshPreciseUsage(cfg, env);
    await refreshPreciseUsage(cfg, env);
    expect(hits).toBe(1);
  });

  it("fail-open: API down → null, gate falls back to event-based estimates", async () => {
    recordEvent("s1", "turn", {}, Date.now() - 60_000);
    const cfg = { ...budgetCfg(), precise: true, preciseUrl: "http://127.0.0.1:1" }; // unreachable
    const usage = await refreshPreciseUsage(cfg, { ...process.env, KIMI_API_KEY: "k" });
    expect(usage).toBeNull();
    const snap = budgetSnapshot("s1", cfg);
    expect(snap.precise).toBe(false);
    expect(snap.fiveHour.used).toBe(1);
  });

  it("disabled or no key → no fetch, no cache", async () => {
    const cfg = { ...budgetCfg(), precise: false, preciseUrl: "http://127.0.0.1:1" };
    expect(await refreshPreciseUsage(cfg, { ...process.env, KIMI_API_KEY: "k" })).toBeNull();
    const cfg2 = { ...budgetCfg(), precise: true };
    expect(await refreshPreciseUsage(cfg2, process.env)).toBeNull();
    expect(cachedPreciseUsage(cfg2)).toBeNull();
  });

  it("refreshPreciseIfStale is a no-op when cache is fresh", async () => {
    const cfg = { ...budgetCfg(), precise: true };
    const { setMeta } = await import("../src/store.js");
    setMeta("precise_usage", JSON.stringify({ fiveHour: null, weekly: { used: 5, limit: 100, resetsAt: null } }));
    setMeta("precise_usage_ts", String(Date.now()));
    // unreachable URL — if it fetched, this would take ~timeout; it must not fetch at all
    await refreshPreciseIfStale({ ...cfg, preciseUrl: "http://127.0.0.1:1" }, { ...process.env, KIMI_API_KEY: "k" });
    expect(cachedPreciseUsage(cfg)?.weekly?.used).toBe(5);
  });
});
