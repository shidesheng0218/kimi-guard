import { createServer, type Server } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { castVetoVote, collectVetoContext, type VetoConfig } from "../src/veto.js";
import { resetDbForTests } from "../src/store.js";
import { defaultConfig } from "../src/config.js";

let tmp: string;
let server: Server | null = null;
let baseUrl = "";
let hits = 0;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kguard-veto-"));
  process.env.KIMI_GUARD_HOME = tmp;
});

afterEach(() => {
  resetDbForTests();
  delete process.env.KIMI_GUARD_HOME;
  delete process.env.KIMI_GUARD_VETO_API_KEY;
  delete process.env.KIMI_GUARD_VETO_BASE_URL;
  if (server) {
    server.close();
    server = null;
    baseUrl = "";
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startFakeLlm(reply: (body: unknown) => { content: string } | { error: string } | 500): Promise<string> {
  return new Promise((resolve) => {
    hits = 0;
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        hits++;
        const body = JSON.parse(data || "{}") as Record<string, unknown>;
        const out = reply(body);
        if (typeof out === "number") {
          res.writeHead(out);
          res.end();
          return;
        }
        if ("error" in out) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(out));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { content: out.content } }] }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address() as { port: number };
      baseUrl = `http://127.0.0.1:${addr.port}/v1`;
      resolve(baseUrl);
    });
  });
}

function cfg(overrides?: Partial<VetoConfig>): VetoConfig {
  return {
    ...structuredClone(defaultConfig.verify.veto),
    enabled: true,
    ...(overrides ?? {}),
  };
}

const baseCtx = {
  sessionId: "vt",
  claims: [{ pattern: "x", snippet: "all tests pass" }],
  goal: "refactor auth",
  recentCommands: ["ls -la"],
  editedFiles: ["a.ts"],
};

describe("castVetoVote (protocol + fail-closed)", () => {
  it("veto=yes accepts the completion", async () => {
    const url = await startFakeLlm(() => ({ content: "VETO: yes" }));
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    const r = await castVetoVote(baseCtx, cfg());
    expect(r.vetoed).toBe(true);
    expect(r.raw).toBe("VETO: yes");
    expect(hits).toBe(1);
  });

  it("veto=no keeps the block standing", async () => {
    const url = await startFakeLlm(() => ({ content: "VETO: no" }));
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    expect((await castVetoVote(baseCtx, cfg())).vetoed).toBe(false);
  });

  it("garbage output is treated as no-veto (fail-closed)", async () => {
    const url = await startFakeLlm(() => ({ content: "I think the agent did a great job and should be allowed!" }));
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    expect((await castVetoVote(baseCtx, cfg())).vetoed).toBe(false);
  });

  it("http 500 → no-veto, block stands", async () => {
    const url = await startFakeLlm(() => ({ error: "boom" }));
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    const r = await castVetoVote(baseCtx, cfg());
    expect(r.vetoed).toBe(false);
    expect(r.error).toContain("500");
  });

  it("session vote budget: after maxCallsPerSession, no further LLM calls", async () => {
    const url = await startFakeLlm(() => ({ content: "VETO: no" }));
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    const c = cfg({ maxCallsPerSession: 1 });
    await castVetoVote(baseCtx, c);
    const r2 = await castVetoVote(baseCtx, c);
    expect(r2.vetoed).toBe(false);
    expect(r2.error).toContain("budget");
    expect(hits).toBe(1);
  });

  it("disabled or missing key → inert, zero network calls", async () => {
    const url = await startFakeLlm(() => ({ content: "VETO: yes" }));
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    expect((await castVetoVote(baseCtx, cfg())).vetoed).toBe(false);
    delete process.env.KIMI_GUARD_VETO_BASE_URL;
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    expect((await castVetoVote(baseCtx, cfg())).vetoed).toBe(false);
    expect(hits).toBe(0);
  });

  it("timeout → no-veto", async () => {
    const url = await startFakeLlm(() => {
      const end = Date.now() + 300;
      while (Date.now() < end) {
        /* block */
      }
      return { content: "VETO: yes" };
    });
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    const r = await castVetoVote(baseCtx, cfg({ timeoutMs: 50 }));
    expect(r.vetoed).toBe(false);
  });
});

describe("vote prompt hygiene", () => {
  it("prompt is compact and forces the exact vote line", async () => {
    let captured = "";
    const url = await startFakeLlm((body) => {
      captured = (body as { messages: Array<{ content: string }> }).messages[0]!.content;
      return { content: "VETO: yes" };
    });
    process.env.KIMI_GUARD_VETO_API_KEY = "test-key";
    process.env.KIMI_GUARD_VETO_BASE_URL = url;
    const ctx = { ...collectVetoContext("vt", structuredClone(defaultConfig)), claims: baseCtx.claims, goal: baseCtx.goal };
    await castVetoVote(ctx, cfg());
    expect(captured).toContain("VETO: yes");
    expect(captured).toContain("VETO: no");
    expect(captured).toContain("all tests pass");
    expect(captured.length).toBeLessThan(1200);
    expect(captured).not.toContain("API");
  });
});
