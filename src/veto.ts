import { callsSince, getMeta, setMeta } from "./store.js";
import type { GuardConfig } from "./config.js";
import type { ClaimMatch } from "./verify.js";

export interface VetoConfig {
  enabled: boolean;
  model: string;
  baseUrl: string;
  maxCallsPerSession: number;
  timeoutMs: number;
}

export interface VetoContext {
  sessionId: string;
  claims: ClaimMatch[];
  goal: string;
  recentCommands: string[];
  editedFiles: string[];
}

export function vetoKeyConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.KIMI_GUARD_VETO_API_KEY?.trim());
}

export function vetoBaseUrls(cfg: VetoConfig, env: NodeJS.ProcessEnv = process.env): { baseUrl: string; model: string } {
  return {
    baseUrl: env.KIMI_GUARD_VETO_BASE_URL?.trim() || cfg.baseUrl,
    model: env.KIMI_GUARD_VETO_MODEL?.trim() || cfg.model,
  };
}

/**
 * Collect the evidence context for the vote — deterministic data only.
 */
export function collectVetoContext(sessionId: string, cfg: GuardConfig, now = Date.now()): VetoContext {
  const since = now - cfg.verify.evidenceWindowMinutes * 60_000;
  const calls = callsSince(sessionId, since, 400);
  const recentCommands: string[] = [];
  const editedFiles: string[] = [];
  for (const r of calls.slice(-40)) {
    if (r.tool_name === "Shell" || r.tool_name === "Bash") {
      try {
        const args = JSON.parse(r.args_json) as { command?: string };
        if (args.command) recentCommands.push(args.command.slice(0, 120));
      } catch {
        /* skip */
      }
    }
    if (r.file_path && editedFiles.length < 10) editedFiles.push(r.file_path);
  }
  return { sessionId, claims: [], goal: "", recentCommands: recentCommands.slice(-5), editedFiles };
}

const PROMPT_HEADER =
  "You are a false-positive detector for an AI-agent guardrail. An agent just finished its turn " +
  "claiming completion, but the session's recorded command history contains NO successful " +
  "verification command (test/build/lint). Decide whether blocking would be a FALSE POSITIVE — " +
  "i.e. the agent has a legitimate reason why verification cannot run in this session.\n" +
  "Rules: base your vote ONLY on the facts below. A claim that verification is unnecessary or " +
  "happens elsewhere is NOT by itself a reason to veto. Answer with EXACTLY one line:\n" +
  "VETO: yes  (false positive — allow the completion)\n" +
  "VETO: no   (block stands — the agent must actually run verification)\n" +
  "Do not write anything else.\n\n" +
  "Facts:\n";

export function buildVetoPrompt(ctx: VetoContext): string {
  const lines: string[] = [];
  lines.push(`- user goal: ${ctx.goal.slice(0, 300) || "(unknown)"}`);
  lines.push(`- claims made by the agent:`);
  for (const c of ctx.claims.slice(0, 3)) lines.push(`  "${c.snippet}"`);
  lines.push(`- recent commands the agent ran: ${ctx.recentCommands.length > 0 ? ctx.recentCommands.join(" ; ") : "(none)"}`);
  lines.push(`- files the agent edited: ${ctx.editedFiles.length > 0 ? ctx.editedFiles.join(", ") : "(none)"}`);
  lines.push("- recorded successful verification commands in session history: none");
  return PROMPT_HEADER + lines.join("\n");
}

export interface VoteResult {
  vetoed: boolean;
  raw?: string;
  error?: string;
}

/**
 * One cheap LLM vote to suppress a false positive. The LLM never authors a
 * critique — it only votes. Any failure (timeout, HTTP error, unparseable
 * output, exhausted session budget) resolves to vetoed=false, i.e. the
 * deterministic block stands (fail-closed for the veto).
 */
export async function castVetoVote(
  ctx: VetoContext,
  cfg: VetoConfig,
  env: NodeJS.ProcessEnv = process.env,
): Promise<VoteResult> {
  if (!cfg.enabled || !vetoKeyConfigured(env)) return { vetoed: false, error: "veto disabled" };

  const calls = Number(getMeta(`veto_calls:${ctx.sessionId}`) ?? "0");
  if (calls >= cfg.maxCallsPerSession) return { vetoed: false, error: "session vote budget exhausted" };
  setMeta(`veto_calls:${ctx.sessionId}`, String(calls + 1));

  const { baseUrl, model } = vetoBaseUrls(cfg, env);
  const key = env.KIMI_GUARD_VETO_API_KEY!.trim();
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: buildVetoPrompt(ctx) }],
        max_tokens: 8,
        temperature: 0,
        stream: false,
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
    if (!res.ok) return { vetoed: false, error: `http ${res.status}` };
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content ?? "").trim();
    return { vetoed: /^VETO:\s*yes\b/i.test(raw), raw };
  } catch (err) {
    return { vetoed: false, error: (err as Error).message };
  }
}
