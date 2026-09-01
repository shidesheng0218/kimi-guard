import { callsSince, getMeta, setMeta } from "./store.js";
import type { GuardConfig } from "./config.js";

export const DEFAULT_CLAIM_PATTERNS = [
  /\btests?\b.{0,40}\b(pass(?:ed|ing)?|green)\b/i,
  /\ball\b.{0,24}\btests?\b.{0,24}\bpass/i,
  /\bbuild\b.{0,30}\b(succeed(?:ed)?|passed|ok)\b/i,
  /\bcompil(?:es?|ed)\b.{0,20}\bsuccessfully\b/i,
  /\blint\b.{0,30}\b(clean|passed|no issues)\b/i,
  /\bfixed\b.{0,40}\b(all|every)\b/i,
  /测试(全部|都)?通过/,
  /全部(测试)?通过/,
  /构建成功/,
  /编译通过/,
  /零(错误|警告)/,
  /问题已全部解决/,
];

export const DEFAULT_EVIDENCE_PATTERNS = [
  /\b(test|tests|vitest|jest|mocha|pytest|cargo test|go test|make test)\b/i,
  /\b(npm|pnpm|yarn)\s+(run\s+)?(test|check)\b/i,
  /\b(mvn|gradle|sbt|dotnet\s+test)\b/i,
  /\b(tsc|pyright|mypy|eslint|biome|ruff|flake8|clippy)\b/i,
  /\b(build|compile|lint|check|verify)\b/i,
  /\bmake\b/i,
];

export interface ClaimMatch {
  pattern: string;
  snippet: string;
}

/**
 * Extract completion claims ("tests pass", "构建成功") from agent output text.
 * Deterministic only — no LLM in the loop, no network.
 */
export function findClaims(text: string, cfg: GuardConfig): ClaimMatch[] {
  if (!text) return [];
  const patterns: RegExp[] =
    cfg.verify.claimPatterns.length > 0
      ? cfg.verify.claimPatterns.map((p) => new RegExp(p))
      : DEFAULT_CLAIM_PATTERNS;
  const claims: ClaimMatch[] = [];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) {
      claims.push({
        pattern: String(p),
        snippet: text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + m[0].length + 40).replace(/\s+/g, " ").trim(),
      });
    }
    if (claims.length >= 3) break;
  }
  return claims;
}

/**
 * Did the session run a successful verification command (test/build/lint)
 * recently? Reads only the locally recorded call history — nothing is inferred
 * from the model's own words.
 */
export function hasEvidence(sessionId: string, cfg: GuardConfig, now = Date.now()): boolean {
  const vouched = getMeta(`vouched:${sessionId}`) === "1";
  if (vouched) return true;
  const since = now - cfg.verify.evidenceWindowMinutes * 60_000;
  const patterns: RegExp[] =
    cfg.verify.evidencePatterns.length > 0
      ? cfg.verify.evidencePatterns.map((p) => new RegExp(p))
      : DEFAULT_EVIDENCE_PATTERNS;
  const shellTools = new Set(cfg.verify.shellTools.length > 0 ? cfg.verify.shellTools : ["Shell", "Bash"]);
  const calls = callsSince(sessionId, since, 400);
  for (const r of calls) {
    if (r.status !== "ok") continue;
    if (!shellTools.has(r.tool_name)) continue;
    try {
      const args = JSON.parse(r.args_json) as { command?: string };
      const cmd = args.command ?? "";
      for (const p of patterns) {
        if (p.test(cmd)) return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function vouch(sessionId: string): void {
  setMeta(`vouched:${sessionId}`, "1");
}

export function unvouch(sessionId: string): void {
  setMeta(`vouched:${sessionId}`, "0");
}

/**
 * Did the session land successful file edits recently?
 * Used by the hooks-path Stop gate (which cannot see the model's text).
 */
export function hasRecentEdits(sessionId: string, cfg: GuardConfig, now = Date.now()): boolean {
  const since = now - cfg.verify.evidenceWindowMinutes * 60_000;
  const editTools = new Set(cfg.churn.tools.length > 0 ? cfg.churn.tools : ["WriteFile", "StrReplaceFile", "Edit", "Write", "MultiEdit"]);
  return callsSince(sessionId, since, 400).some(
    (r) => r.status === "ok" && editTools.has(r.tool_name),
  );
}

export const HOOKS_STOP_BLOCK_REASON =
  "[kimi-guard] Blocked (verify): this turn ended after successful file edits with no successful " +
  "verification command (test/build/lint) in the session. Run your verification before claiming " +
  "completion, or state explicitly why it cannot run here.";

export const WIRE_VERIFY_CORRECTIVE =
  "[kimi-guard verification] Your final message claims tests/build pass, but no successful " +
  "verification command was recorded in this session. Actually run the verification now and base " +
  "your claims on real results, then restate the conclusion.";
