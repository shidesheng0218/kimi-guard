<div align="center">

# 🛡️ kimi-guard

**An orchestration guard layer for [Kimi Code CLI](https://github.com/MoonshotAI/kimi-code) — stop runaway agent loops before they burn your quota.**

`npm i -g kimi-guard && kguard install` → done.

[![npm](https://img.shields.io/npm/v/kimi-guard?style=flat-square)](https://www.npmjs.com/package/kimi-guard)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](/LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/shidesheng0218/kimi-guard/ci.yml?style=flat-square&label=CI)](/.github/workflows/ci.yml)

**[English](README.md) · [中文文档](docs/README.zh-CN.md)**

</div>

---

## Why

Kimi Code CLI is a great open-source coding agent, but its subagent system has known reliability gaps (see issues [#2142](https://github.com/MoonshotAI/kimi-cli/issues/2142), [#2368](https://github.com/MoonshotAI/kimi-cli/issues/2368), [#2578](https://github.com/MoonshotAI/kimi-cli/issues/2578)):

- The model repeats the **exact same tool call** dozens of times (76×, 112× observed in the wild), silently burning tokens — fatal for headless/CI runs where nobody presses Ctrl+C.
- All subagents share **one API key**, so a burst of parallel dispatches exhausts TPM/RPM and everything hangs.
- A mid-batch quota error leaves **half-written workspaces** that poison the whole run.

kimi-guard is a local, zero-daemon guard that sits on the CLI's official [hooks system](https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html) and enforces hard caps — no source forking, no proxy, no account access.

## Features

kimi-guard is not a preset pack — it is a **runtime behavior analysis and enforcement engine**. Every tool call flows through a normalization layer, a set of pure analyzers, and a policy engine that maps findings to actions (observe / warn / block / full stop).

| Guard | Signal it detects | Action |
|---|---|---|
| 🔁 **Repetition** | same `(tool, args)` signature re-run N times (whitespace-tolerant fingerprinting) | block |
| 🔄 **Cycle detection** | oscillating loops: `A→B→A→B…` up to period-3, regardless of tool | block |
| 📉 **No-information-gain** | different arguments, byte-identical output — the model is spinning without new data (the real root cause of upstream [#2142](https://github.com/MoonshotAI/kimi-cli/issues/2142) Case B) | warn → block |
| ✏️ **Edit churn** | the same file edited over and over without converging ("thrashing") | warn → block |
| 🐢 **No-progress stretch** | long run of tool calls with no successful edit landing — motion without progress | warn → block |
| 🎯 **Goal anchor** | re-injects the original task verbatim every N prompts/steps and always after compaction — the two moments a long session drifts off-target | context injection |
| 🚦 **Quota gate** | request accounting against Kimi Coding Plan windows (5h/weekly) with burn-rate projection; dispatches are blocked before the window is exhausted | warn → block |
| 🔌 **Kill switch** | after N interventions in a session, block ALL tools and order the model to summarize and end its turn — the fuse for unattended/CI runs | full stop |
| 🧯 **Context-fill gate** | when the context window crosses the threshold (Wire mode reads `StatusUpdate.context_usage`), steers a wrap-up warning before compaction hits | mid-turn steer |
| 🧾 **Completion gate** | deterministic claim-vs-evidence check: "tests pass" claims are matched against the locally recorded command history — an unbacked claim triggers a corrective round (Wire) or blocks the turn end (hooks, opt-in). Optionally an **LLM veto vote** (self-critic style: the LLM only votes to suppress false positives, never authors a critique) | verify round / block / veto |
| 🧠 **Thinking dominance** | flags turns that burned ≥20k chars of pure reasoning with ≤10% visible action — fed back as "act more, think less" on the next resume | flag + resume note |
| 🔁 **Near-duplicate matching** | fuzzy loop detection: arguments differing only in punctuation, case, spacing or order still collapse to one signature | warn → block |
| 💾 **Checkpoint / resume** | auto-captures an observed "research state" brief (files touched, commands, searches, failed calls) on failure/interrupt/session-end; `kguard resume` prints a paste-ready context block so a resumed session skips re-exploration | recovery |
| 🎮 **`kguard run` (Wire supervisor)** | spawns the agent in Wire mode (JSON-RPC) and supervises it *in-process*: hook decisions with zero exit-code overhead, **mid-turn steering** on warn findings, **exact per-step token metering** from `StatusUpdate`, retry observability (`StepRetry` status codes), approval policy for headless runs, hard step/time caps with `cancel`, auto-resume with checkpoint injection, and a full run report + raw wire log | CI / unattended runs |

Warn-level findings are injected into the model's context (official hooks stdout mechanism) so the agent can correct itself *before* a block becomes necessary. Blocks feed a structured reason back to the model (official exit-code-2 mechanism).

Everything is **fail-open**: if kimi-guard itself errors, the agent keeps working. It is a safety net, not a single point of failure.

## Install

```sh
npm i -g kimi-guard
kguard install        # writes a managed [[hooks]] block into ~/.kimi-code/config.toml
kguard doctor         # verify
```

Requires Node >= 22.13. Restart Kimi Code CLI (or `/reload`) after installing.

<details>
<summary>What <code>kguard install</code> writes to config.toml</summary>

```toml
# >>> kimi-guard managed >>> DO NOT EDIT
[[hooks]]
event = "PreToolUse"
command = "kguard hook PreToolUse"
timeout = 5

[[hooks]]
event = "PostToolUse"
command = "kguard hook PostToolUse"
timeout = 5

[[hooks]]
event = "PostToolUseFailure"
command = "kguard hook PostToolUseFailure"
timeout = 5

# + observation hooks: TurnStarted, SubagentStart, StopFailure, Interrupt, SessionEnd
# (these feed the budget metering and auto-checkpointing engines)
# <<< kimi-guard <<<
```

- Analyzers decide *which* tools to watch internally — the hooks observe everything, so the watch lists stay configurable without reinstalling.
- A backup (`config.toml.kimi-guard.bak`) is created before the first install. `kguard uninstall` removes the block cleanly. The block coexists with other tools' managed blocks (e.g. kimi-boost).
- **Legacy compatibility**: if your CLI version rejects unknown hook events (older kimi-cli builds), run `kguard install --compat` to write only the 3 universally supported events. You keep loop guarding; you lose auto-checkpointing and event-based metering.

</details>

## Commands

```sh
kguard install          # add hook rules to the Kimi config (idempotent)
kguard uninstall        # remove the managed hook block
kguard status           # calls, interventions, sessions, budget windows
kguard budget           # quota metering snapshot: windows, burn rate, projection
kguard checkpoint       # capture a research-state checkpoint now
kguard resume           # print a paste-ready context block from the latest checkpoint
kguard run -- <prompt>  # supervised headless run in Wire mode (see below)
kguard doctor           # verify node/state db/config/PATH/probe
kguard probe on|off|show [−n N]   # capture raw hook payloads
kguard config init|show|get <key> # manage ~/.kimi-guard/config.toml
kguard hook <event>     # (used by the CLI, reads JSON from stdin)
```

### `kguard run` — supervised headless runs

This is the tool for CI, cron jobs and unattended agents — the exact scenario where a
repeating tool call burns the full timeout (upstream issue #2142 was a headless run).

```sh
kguard run "refactor the auth module and make tests pass" \
  --max-steps 100 --max-minutes 20 --auto-resume 1 --json
```

What the supervisor does in-process (no shell hooks, no exit codes):

- subscribes to `PreToolUse` over the Wire protocol and returns `allow/block` decisions — the same analyzers, zero-latency
- **steers** the agent mid-turn (`steer`) when a warn-level pattern appears, before a hard block is needed
- meters **exact token usage per step** from `StatusUpdate.token_usage`
- observes retry storms (`StepRetry` with status codes → 429 visibility)
- enforces hard caps: `--max-steps` (cancel via official `cancel` method), `--max-minutes`
- **kill switch**: after N blocks it cancels the turn and checkpoints
- approval policy: default rejects with feedback (headless-safe), `--yolo` approves
- writes a run report (`report.json`) + raw wire log (`wire.jsonl`) under `~/.kimi-guard/runs/`
- exit code 0 on clean finish, 2 on any intervention-triggered end — CI-friendly

## Configuration

`~/.kimi-guard/config.toml` (see `kguard config init`; full annotated template included):

```toml
[repeat]                # exact/near-duplicate repetition
maxRepeats = 3
windowMinutes = 30

[cycle]                 # A->B->A->B oscillation detection
enabled = true

[noGain]                # different args, identical output
warnAt = 3
blockAt = 4

[churn]                 # same-file edit thrashing
warnAt = 5
blockAt = 10

[noProgress]            # long stretch of calls with no landed edit
warnAt = 15
blockAt = 25

[anchor]                # goal anchoring (anti-drift)
everyNPrompts = 5
maxChars = 1000

[context]
warnPercent = 85        # steer a wrap-up warning when the context is this full

[nearRepeat]            # fuzzy near-duplicates (punctuation/case/order differences)
warnAt = 6
blockAt = 10

[verify]                # completion-claim gate
enabled = true
blockOnNoEvidence = false  # hooks path: block Stop when edits landed but nothing was verified
evidenceWindowMinutes = 60

[verify.veto]           # optional false-positive suppression vote (off by default, zero deps when off)
enabled = false         # requires KIMI_GUARD_VETO_API_KEY in the environment (any OpenAI-compatible endpoint)
model = "kimi-k3"       # use a cheap fast model — the vote costs a few hundred tokens
maxCallsPerSession = 3  # the model cannot retry its way out of the gate

[thinking]              # thinking-dominance detection (Wire mode)
minThinkChars = 20000
maxTextRatio = 0.1

[policy]
killSwitch = true       # after maxBlocksPerSession interventions, block ALL tools
maxBlocksPerSession = 5

[budget]                # request accounting for Kimi Coding Plans
plan = "tier1"          # tier1: 1024/week | tier2: 2048 | tier3: 7168 (200 per 5h)
reservePercent = 10     # headroom the agent is never allowed to eat
subagentWeight = 5      # ~requests each dispatched subagent costs
```

## How it works

```
Kimi Code CLI ──hook event──▶ kguard hook <event> (JSON on stdin)
                                  │
                    ┌─────────────▼──────────────┐
                    │  normalization layer        │  schema-variant tolerant payload
                    │  (src/events.ts)            │  → canonical call record + output hash
                    └─────────────┬──────────────┘
                    ┌─────────────▼──────────────┐
                    │  analyzers (pure functions) │  repetition · cycles · no-gain · churn
                    │  (src/analysis.ts)          │  + budget gate (src/meter.ts)
                    └─────────────┬──────────────┘
                    ┌─────────────▼──────────────┐
                    │  policy engine              │  findings → allow / warn / block
                    │  (src/policy.ts)            │  + kill switch
                    └─────────────┬──────────────┘
                                  │
              allow (exit 0) · warn (exit 0 + context hint) · block (exit 2 + reason)
                                  │
                       ~/.kimi-guard/state.db (SQLite via node:sqlite)
                       checkpoints/<session>/<ts>.md
```

- `PreToolUse` **exit 2** is the official blocking mechanism: the CLI feeds stderr back to the model as a correction.
- `PreToolUse` **stdout** on warn is appended to the model context — a soft nudge before a hard block.
- `TurnStarted`/`SubagentStart`/`StopFailure`/`Interrupt`/`SessionEnd` hooks feed the metering and checkpoint engines.

## Roadmap

- [ ] **v0.7** — per-agent model routing (needs upstream `model` field on subagent dispatch, [#2533](https://github.com/MoonshotAI/kimi-cli/issues/2533)); git-worktree partial-work isolation for parallel agents
- [ ] exact plan-usage windows once Kimi exposes a plan-usage API (current windows are event-based approximations, biased conservative)
- [ ] cross-harness adapters — see [docs/PORTING.md](docs/PORTING.md) for the reusable-core checklist

## Ecosystem fit

The agent-runtime tooling space is crowded, and pretending every tool competes with every other one helps nobody. kimi-guard occupies one specific layer — here is the honest map:

```
┌────────────────────────────────────────────────────────────────┐
│  your agent (Kimi Code CLI)                                    │
│                                                                │
│  built-in loop_control      step/attempt caps + compaction     │
│  ├─ mechanical counter — stops the loop, explains nothing       │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  kimi-guard (this project) — the enforcement layer       │  │
│  │  semantic loop detection · quota gates · steering ·      │  │
│  │  checkpoints · goal anchoring — the agent cannot bypass  │  │
│  └──────────────────────────────────────────────────────────┘  │
│                                                                │
│  kimi-session-orchestrator  voluntary orchestration layer      │
│  ├─ MCP tools the AGENT chooses to call (grade_step, retire)   │
│  ├─ great when the agent cooperates; has no veto power         │
│                                                                │
│  kimi-boost                  security preset installer         │
│  ├─ dangerous-command guards, branch protection, skills       │
│  ├─ WHAT the agent may do (security) — different axis from    │
│  │  kimi-guard's HOW it behaves (runtime loops/budget)        │
│                                                                │
│  cli-agent-runner            lifecycle supervisor              │
│  ├─ 7×24 restart loops, log-level anomaly detection           │
│  ├─ between-rounds layer — complements our within-round layer │
│                                                                │
│  ccusage / kimi-code-usage    read-only usage monitors         │
│  ├─ tell you what happened AFTER — never block anything       │
└────────────────────────────────────────────────────────────────┘
```

**Three lines of positioning:**

1. **Monitors are plentiful, voluntary orchestrators exist — but a non-bypassable enforcement layer, kimi-guard is the first in the Kimi ecosystem.** (ccusage-family tools are read-only; kimi-session-orchestrator relies on the agent choosing to call it; kimi-guard intercepts.)
2. **Mid-turn steering is an intervention outside the hook-lifecycle boundary — direct analogs (histori, LoopGuard, multi-runtime governance suites) cannot do it or only brute-force-pause the process. We do it natively over the official Wire protocol.**
3. **The budget model understands Kimi's subscription semantics: 5h/weekly request windows, reserved headroom, burn-rate projection — USD-billing competitors don't reconcile against plan-based users.**

**What we deliberately do NOT do** (so you know where to look):

- Security scanning / destructive-command guards → use **kimi-boost** presets (different axis: authorization vs behavior). `kguard doctor` detects whether a security layer is present and points you there if not.
- Completion verification exists in kimi-guard as a **deterministic claim-vs-evidence gate** (no LLM in the loop), with an *opt-in* single-vote LLM veto for false positives (`VETO: yes|no` protocol, per-session budget cap, fail-closed on any error). For richer semantic verification (refute-by-default judges, LLM grading), see kimi-session-orchestrator's `grade_step` or the refute-by-default pattern in multi-runtime governance suites.
- Multi-runtime portability (Claude Code / Codex / Gemini) → by design, our leverage is Kimi's Wire protocol. The analyzer core (`src/analysis.ts`) is pure functions and reusable if you want to build adapters
- Daemon-style process supervision (SIGSTOP/SIGCONT, systemd) → **cli-agent-runner** owns that layer; ours is semantic in-harness intervention

Related Kimi-ecosystem projects worth knowing: [kimi-session-orchestrator](https://github.com/FirenzeClaw/kimi-session-orchestrator) (multi-session orchestration), [oh-my-kimi](https://github.com/xz1220/oh-my-kimi) (skill/hook presets), [cli-agent-runner](https://github.com/wan9yu/cli-agent-runner) (lifecycle supervision with a kimi preset), [kimi-code-usage](https://github.com/Golden0Voyager/kimi-code-usage) (read-only usage reporting).

## Compatibility

- Works with Kimi Code CLI hooks (Beta). Hook payloads are parsed defensively; run `kguard probe on` + `kguard doctor` to see the exact fields your CLI version sends.
- Config detection: `$KIMI_CONFIG_PATH` → `~/.kimi-code/config.toml` → `~/.kimi/config.toml`.

## License

MIT
