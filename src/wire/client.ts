import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { version } from "../version.js";
import {
  WIRE_PROTOCOL_VERSION,
  type InitializeResult,
  type JsonRpcMessage,
  type JsonRpcResponse,
} from "./protocol.js";

export interface WireClientOptions {
  /** command to spawn, default ["kimi", "--wire"] */
  command?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** hook event subscriptions, negotiated during initialize */
  hooks?: Array<{ id: string; event: string; matcher?: string; timeout?: number }>;
  /** agent → client event notifications */
  onEvent?: (type: string, payload: Record<string, unknown>) => void;
  /** agent → client requests (ApprovalRequest / ToolCallRequest / QuestionRequest / HookRequest) */
  onRequest?: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  onStderr?: (line: string) => void;
  onRawLine?: (direction: "in" | "out", line: string) => void;
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class WireClient {
  private proc: ChildProcess | null = null;
  private pending = new Map<string, Pending>();
  private nextId = 0;
  private closed = false;
  private readonly opts: WireClientOptions;

  constructor(opts: WireClientOptions) {
    this.opts = opts;
  }

  get running(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  async start(): Promise<InitializeResult | null> {
    const command = this.opts.command ?? ["kimi", "--wire"];
    this.proc = spawn(command[0]!, command.slice(1), {
      cwd: this.opts.cwd,
      env: { ...process.env, ...this.opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const rl = readline.createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => this.handleLine(line));

    const stderr = readline.createInterface({ input: this.proc.stderr! });
    stderr.on("line", (line) => this.opts.onStderr?.(line));

    const exited = new Promise<never>((_, reject) => {
      this.proc!.once("exit", (code) => {
        this.closed = true;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error(`wire process exited (code ${code})`));
        }
        this.pending.clear();
        reject(new Error(`wire process exited unexpectedly (code ${code})`));
      });
    });
    exited.catch(() => {});

    return await this.initialize();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    this.opts.onRawLine?.("in", trimmed);
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return;
    }
    if ("id" in msg && msg.id !== undefined && ("result" in msg || "error" in msg)) {
      const pending = this.pending.get(msg.id as string);
      if (!pending) return;
      this.pending.delete(msg.id as string);
      clearTimeout(pending.timer);
      const resp = msg as JsonRpcResponse;
      if (resp.error) pending.reject(new Error(`wire error ${resp.error.code}: ${resp.error.message}`));
      else pending.resolve(resp.result);
      return;
    }
    if ("method" in msg) {
      if (msg.method === "event") {
        const params = msg.params as { type: string; payload: Record<string, unknown> } | undefined;
        if (params) this.opts.onEvent?.(params.type, params.payload ?? {});
        return;
      }
      if (msg.method === "request") {
        void this.handleServerRequest(msg as unknown as { id: string; params: { type: string; payload: Record<string, unknown> } });
        return;
      }
    }
  }

  private async handleServerRequest(msg: { id: string; params: { type: string; payload: Record<string, unknown> } }): Promise<void> {
    let result: unknown;
    try {
      result = (await this.opts.onRequest?.(msg.params.type, msg.params.payload)) ?? {};
    } catch (err) {
      result = { error: (err as Error).message };
    }
    this.write({ jsonrpc: "2.0", id: msg.id, result });
  }

  private write(msg: JsonRpcMessage | JsonRpcResponse): void {
    if (!this.proc?.stdin || this.closed) return;
    const line = JSON.stringify(msg);
    this.opts.onRawLine?.("out", line);
    this.proc.stdin.write(line + "\n");
  }

  private id(): string {
    this.nextId++;
    return `kguard-${this.nextId}-${randomUUID().slice(0, 8)}`;
  }

  async request<T>(method: string, params: unknown, timeoutMs = this.opts.requestTimeoutMs ?? 600_000): Promise<T> {
    const id = this.id();
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`wire request timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    });
    this.write({ jsonrpc: "2.0", method, id, params });
    return promise;
  }

  private async initialize(): Promise<InitializeResult | null> {
    try {
      return await this.request<InitializeResult>(
        "initialize",
        {
          protocol_version: WIRE_PROTOCOL_VERSION,
          client: { name: "agent-guard", version },
          capabilities: { supports_question: false },
          hooks: this.opts.hooks ?? [],
        },
        30_000,
      );
    } catch (err) {
      if ((err as Error).message.includes("-32601")) return null;
      throw err;
    }
  }

  prompt(userInput: string, timeoutMs?: number): Promise<{ status: string; steps?: number }> {
    return this.request("prompt", { user_input: userInput }, timeoutMs);
  }

  steer(userInput: string): Promise<{ status: string }> {
    return this.request("steer", { user_input: userInput }, 30_000);
  }

  cancel(): Promise<unknown> {
    return this.request("cancel", {}, 30_000);
  }

  stop(): void {
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("client stopped"));
    }
    this.pending.clear();
    this.proc?.kill("SIGTERM");
    setTimeout(() => this.proc?.kill("SIGKILL"), 3000).unref();
  }
}
