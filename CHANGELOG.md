# Changelog

## 0.8.0 — 2026-09-01

- 🌉 **Claude Code support**: the full hooks-mode guard (loop/churn/explore detection, quota gate, completion gate, kill switch, checkpoints, feedback loop) now works on Claude Code. `agentguard install` auto-detects harnesses and writes managed hook entries into `~/.claude/settings.json` (backup + idempotent + clean uninstall). Warn hints are delivered via `hookSpecificOutput.additionalContext`; blocks use the same exit-2 semantics. Wire-mode supervision (`run`), mid-turn steering and official-API precise metering remain Kimi-exclusive; Claude budget metering counts completed turns (Claude has no per-request hook event and no machine-readable plan API).
- 🏷️ **Renamed to `agentguard`**: the package is now `npm i -g @shidesheng0218/agentguard` (scoped — the bare `agentguard` name was blocked by npm squat protection); `kguard`/`kimi-guard` remain as bin aliases, existing installs keep working. Guard state moves to `~/.agent-guard` (an existing `~/.kimi-guard` keeps being used in place; `$AGENT_GUARD_HOME` and `$KIMI_GUARD_HOME` both honored).
- 🔧 Per-harness tool-name defaults (Claude: Bash/Read/Write/Edit/Glob/Glob/Task) applied before the user config overlay — the `[tools]` taxonomy from 0.6.2 does its job.

## 0.7.0 — 2026-09-01

- 🗳️ **False-positive feedback loop**: every block message now carries its block id (`block #N recorded — if this was a false positive, run: kguard feedback fp N`). New commands: `kguard blocks` (recent blocks with ids), `kguard feedback fp|tp <id>`.
- 📊 **Intervention quality in `kguard status`**: per-detector block counts with FP/confirmed rates, plus calibration hints when a detector's FP rate exceeds 30% (with ≥5 samples) — suggests the exact config key to raise.
- 📤 **`kguard report [--json]`**: anonymized aggregate export (detector block counts, FP rates, budget window levels, session count) — no args, paths, commands or session ids. Source material for public runaway-pattern reports.
- 🗃️ **Additive schema migration (v2→v3)**: the `feedback` column is added without dropping history — block records are calibration data, not disposable state.
- 🏷️ **Hooks path now records the detector kind** on each block (`repeat`, `churn`, `budget`, …) instead of a generic `intervention` label — required for per-detector quality stats. (Wire mode already did this.)

## 0.6.2 — 2026-09-01

- 🧭 **Canonical tool taxonomy**: new `[tools]` config section (`edit` / `read` / `search` / `shell`) — the single place to update if a CLI version renames tools. Replaces six hardcoded lists scattered across analysis, verify, veto and checkpoint (which had already drifted apart). Legacy `[churn] tools` and `[verify] shellTools` keys remain supported.
- 🔭 **Exploration-drift detector**: a trailing streak of read/search calls with no action in between (exploring without implementing) warns at 10, blocks at 15. A proposed action call is never blocked by this detector.
- 🎯 **Precise plan metering** (opt-in): `[budget] precise = true` + `KIMI_API_KEY` polls the official Kimi Coding Plan usage API (`/usages`, `/usage` fallback) and overrides the event-based window estimates with exact used/limit/reset values. TTL-cached (300s), 3s timeout, defensive parsing across known payload shapes; every failure path falls back to event-based estimates. Refreshed on dispatch-gate decisions (hooks + Wire) and `kguard budget`.

## 0.6.1 — 2026-09-01

- 🚦 **Wire budget gate fixed**: the Wire supervisor never recorded `turn`/`subagent` events, so the quota gate read zero usage and could not fire in `kguard run`. `TurnBegin` now counts as one request (same as `TurnStarted` in hooks mode); the first event from a subagent counts as its dispatch.
- 🔍 **Fingerprint whitespace semantics fixed**: the whitespace-sensitive tool list was a dead branch — whitespace was collapsed for all tools. Shell/WriteFile/Grep etc. now preserve whitespace (a differently-indented write is NOT a duplicate); other tools keep whitespace-tolerant matching.
- 🔔 **Repeat warn stage**: identical-call repetition now warns at `warnAt` (default 2) before blocking at `maxRepeats`, matching the other detectors' warn→block progression. New `repeat.exemptPatterns` (regexes over JSON-serialized args) exempts polling-style calls like `git status`.
- 💓 **Guard liveness / schema-drift detection**: every hook event records `last_hook_ts`; payloads that fail normalization increment `normalize_misses`. `kguard status` shows last hook activity; `kguard doctor` warns on normalization misses and on "hooks installed but silent for 24h+ while a kimi process runs" — the guard can no longer die silently.
- ⏱️ **Rolling budget windows**: `resetsInMs` is now anchored to the oldest event inside the window instead of epoch-aligned modulo arithmetic; burn-rate projection uses the corrected window. Also fixed: the 5h window undercounted subagent dispatches (it only counted the last hour's) — the dangerous direction for a guard.
- 🛠️ **Configurable shell tool names**: `verify.shellTools` (default `["Shell", "Bash"]`) — evidence detection, veto context and checkpoint briefs no longer hardcode tool names, so an upstream tool rename can't silently disable the completion gate.
- 📚 **Docs**: removed an unverifiable tool attribution ("histori") from detector naming; the cross-ecosystem landscape in both READMEs now cites only surveyed, verifiable projects.

## 0.6.0 — 2026-09-01

- 🧾 **Completion gate**: deterministic claim-vs-evidence verification. Completion claims ("tests pass" / "测试全部通过") are matched against the locally recorded command history; an unbacked claim triggers a corrective round (Wire mode) or blocks the turn end (hooks path, opt-in `blockOnNoEvidence`).
- 🗳️ **Optional LLM veto vote** (self-critic style): one cheap model vote to suppress false positives. Strict `VETO: yes|no` protocol, per-session vote budget (3), fail-closed on any error, key via `KIMI_GUARD_VETO_API_KEY` only.
- 🧠 **Thinking-dominance detection**: flags pure-reasoning turns (≥20k think chars, ≤10% action) and feeds an "act more, think less" note into the next resume.
- 🔁 **Near-duplicate (fuzzy) loop matching**: punctuation/case/spacing/order-only argument differences collapse to one signature (warn 6 / block 10).
- 🩺 **doctor security-layer probe**: detects security presets (kimi-boost etc.) in the kimi config and points you there if absent.
- 📚 [docs/PORTING.md](docs/PORTING.md): reusable-core checklist for cross-harness adapters.

## 0.5.0

- 🐢 **No-progress stretch detector**: long run of calls with no successful edit landing (warn 15 / block 25). A proposed edit call is never blocked by this detector.
- 🎯 **Goal anchoring**: re-injects the original task every N prompts (hooks) / steps (Wire) and always after compaction.
- 🧯 **Context-fill gate** (Wire): steers a wrap-up warning when `StatusUpdate.context_usage` crosses the threshold. `PreCompact` now auto-captures a checkpoint.

## 0.4.0

- 🎮 **`kguard run` — supervised Wire runs**: in-process supervision over the official Wire protocol (JSON-RPC 2.0) — hook decisions via `HookRequest` (no exit codes), mid-turn steering on warn findings, exact per-step token metering from `StatusUpdate.token_usage`, retry observability (`StepRetry`), hard step/time caps via `cancel`, kill switch, approval policy for headless runs, auto-resume with checkpoint injection, run report + raw wire log.
- 📦 Fake Wire server test harness; 9 integration scenarios.

## 0.3.0

- 🔄 **Cycle detection** (period 1–3 oscillation loops, any tool).
- 📉 **No-information-gain detection**: different arguments, byte-identical normalized output.
- ✏️ **Edit-churn detection** (same-file thrashing).
- ⚙️ **Policy engine**: findings → observe / warn (context hint via stdout) / block (exit 2) + **kill switch** (N interventions → block all tools, order summarize-and-stop).
- 🚦 **Quota metering + gates**: Kimi Coding Plan windows (5h/weekly, tier presets), burn-rate projection, subagent dispatch gating, `kguard budget`.
- 💾 **Checkpoint/resume v0**: observed research-state briefs, auto-capture on StopFailure/Interrupt/SessionEnd, `kguard checkpoint` / `kguard resume`.

## 0.2.0

- 🔁 Repeat-call circuit breaker with whitespace-tolerant fingerprinting; failures participate in no-gain hashing.
- 🚦 Subagent dispatch guard.
- 🔇 Normalization layer tolerant to hook payload schema variants.
- 🩺 doctor / status / probe.

## 0.1.0

- Initial skeleton: hooks installer (idempotent managed block, backup, coexists with kimi-boost), SQLite state via `node:sqlite`, `kguard hook` entrypoint with fail-open guarantee.
