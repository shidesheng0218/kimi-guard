# Porting the analyzer core to other harnesses

kimi-guard's loop/budget/checkpoint engines were designed so the **decision core is harness-agnostic**. This document is the checklist for building an adapter for another agent harness (Codex CLI, Gemini CLI, custom agents) without forking the analysis layer.

> **Status:** the Claude Code adapter shipped in v0.8 (see `src/harness/claude.ts` + `--harness claude`) — the checklist below was validated against it. Remaining targets: Codex CLI, Gemini CLI.

## What is portable today

| Module | Harness coupling | Notes |
|---|---|---|
| `src/analysis.ts` | **none** | Pure functions over `CallRow[]` + `GuardConfig`. Repeat / cycle / no-gain / churn / no-progress / near-repeat analyzers. |
| `src/policy.ts` | **none** | Findings → allow / warn / block / kill-switch. |
| `src/events.ts` | minimal | `fingerprint` / `hashOutput` are generic; `normalizeCall` expects Kimi-ish hook payloads — an adapter maps its harness's events into `CallRow` instead. |
| `src/meter.ts` | budget semantics are Kimi-specific | The window math (5h/weekly, reserve, burn-rate) is generic; presets are Kimi plans. Swap presets for USD budgets on other harnesses. |
| `src/checkpoint.ts` | minimal | Reads `CallRow[]` from the store; the brief format is harness-neutral. |
| `src/store.ts` | **none** | SQLite via `node:sqlite`; schema is harness-neutral. |

## What an adapter must provide

1. **Event capture** — a way to observe tool calls (name + args + output + status + timestamp) and write them into `store.recordCall()`.
   - Claude Code: ✅ shipped in v0.8 — `PreToolUse`/`PostToolUse`/`PostToolUseFailure` payloads (`tool_name`, `tool_input`, `tool_response`) flow through the existing normalization layer unchanged.
   - Codex CLI: hooks cover shell commands; native file tools are NOT intercepted (documented limitation) — evidence-dependent detectors (churn, no-progress) degrade accordingly. This is an inherent ceiling of any hooks-based adapter, not a kimi-guard gap.
2. **Decision transport** — how a block reaches the harness.
   - Claude Code: `PreToolUse` hook, exit code 2 + stderr (identical semantics to Kimi's hooks).
   - Warn hints: Claude Code supports stdout context injection on hook success — same mechanism as kimi-guard.
3. **Steering equivalent** — the strongest lever. Kimi has native `steer`; Claude Code has queued messages/plan-mode interruptions but no first-class mid-turn injection API. Map warn-level findings to whatever your harness offers; without one, warns degrade to the block path only.
4. **Metering source** — token/request accounting. Kimi: `StatusUpdate.token_usage` over Wire. Claude Code: transcript JSONL usage fields (undocumented format — degrade silently per fail-open).

## Non-goals for ports

- Wire-mode supervision (`HookRequest` + `steer` + `cancel`) is Kimi-specific and is the reason kimi-guard can do mid-turn steering. Other harnesses get the hook-based subset: loop detection, budget gates (USD presets), Stop-time verification gate, checkpointing.
- Security/authorization guards remain out of scope (see README "Ecosystem fit").
