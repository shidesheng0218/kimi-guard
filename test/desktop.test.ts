import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildNotifyScript, notifyDesktop, notify, postWebhook, type WebhookPayload } from "../src/notify.js";
import { menubarText } from "../src/menubar.js";
import { resetDbForTests, recordBlock } from "../src/store.js";
import { defaultConfig } from "../src/config.js";

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

describe("webhook notifications", () => {
  let server: Server | null = null;
  let received: WebhookPayload[] = [];

  afterEach(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    server = null;
    received = [];
  });

  async function startServer(status = 200): Promise<string> {
    received = [];
    server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        received.push(JSON.parse(data || "{}") as WebhookPayload);
        res.writeHead(status);
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  }

  it("posts the payload and returns true on 2xx", async () => {
    const url = await startServer();
    const ok = await postWebhook(url, { text: "t", content: "t", event: "block", kind: "repeat", tool: "Grep", session: "s1", ts: 1 });
    expect(ok).toBe(true);
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.event).toBe("block");
    expect(got.kind).toBe("repeat");
    expect(got.text).toBe(got.content);
  });

  it("returns false on non-2xx and never throws on unreachable hosts", async () => {
    const url = await startServer(500);
    expect(await postWebhook(url, { text: "t", content: "t", event: "info", ts: 1 })).toBe(false);
    expect(await postWebhook("http://127.0.0.1:1/nope", { text: "t", content: "t", event: "info", ts: 1 })).toBe(false);
  });

  it("notify() fires the webhook when webhookUrl is set, desktop flag irrelevant", async () => {
    const url = await startServer();
    const cfg = structuredClone(defaultConfig);
    cfg.notify.enabled = false;
    cfg.notify.webhookUrl = url;
    notify(cfg, "🛡️ agent-guard", "blocked repeat on Grep", { event: "block", kind: "repeat", tool: "Grep", session: "s1" });
    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000 });
    const got = received[0]!;
    expect(got.text).toContain("blocked repeat on Grep");
    expect(got.event).toBe("block");
  });

  it("notify() without webhookUrl posts nothing and never throws", () => {
    const cfg = structuredClone(defaultConfig);
    expect(() => notify(cfg, "t", "b", { event: "info" })).not.toThrow();
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
