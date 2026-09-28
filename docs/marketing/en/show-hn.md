# Show HN draft (v1.9.0)

**Title:** Show HN: Agent-Guard – pre-execution behavior guard for coding agents (blocks loops before they burn quota, alerts when the agent goes silent)

**Link:** https://github.com/shidesheng0218/kimi-guard

**First comment (post immediately after submitting):**

Author here. The origin story: a Kimi Code agent ran the same grep 76 times in a row during an unattended CI run and burned an entire 5-hour quota window. Nobody was there to press Ctrl+C. (Upstream issue MoonshotAI/kimi-cli#2142 documents the same failure at 112× for other users.)

The tooling landscape for this has quietly split into two layers, and knowing which layer a tool sits in tells you what it can do:

- **LLM-call layer** (TokenFuse, Helicone): proxies that meter and cap spend. They see the bill rising but not *why* — HTTP traffic has no tool semantics.
- **Tool-call layer** (agent-guard): hooks inside the agent CLI that see *what the agent is actually doing* and stop a call before it executes. Post-hoc transcript watchers (e.g. ruslanlap/loopguard) sit near here too, but only alert after the fact — the transcript is written after execution, so the loop has already burned its tokens when the ping arrives.

Agent-Guard is the tool-call layer. It intervenes with a ladder, not a wall:

1. **warn** — a note injected into the model's context
2. **block** — the call is denied with a corrective reason fed back to the model
3. **kill switch** — after N blocks, all tools lock and the agent is ordered to summarize and stop

Detection is semantic: repeated fingerprints, A→B→A cycles, identical outputs from different args, near-identical outputs (trigram similarity), same-file edit thrashing, no-progress stretches, read-only exploration streaks. New in 1.9: a **stall watchdog** — the failure mode every tool-call detector is blind to, because a stalled agent produces *no events at all*. Supervised runs alert when the agent has been silent for N minutes while no tool is in flight (a 30-minute build never alerts; a hung API call does).

Things I think make it worth a look:

- **Proof-of-life in 10 seconds**: `agentguard canary` fires synthetic repeated calls through the real hook pipeline and shows the block, with the exact reason the model receives. The hardest problem in guard tooling is "is it even doing anything?" — this answers it.
- **A public false-positive suite**: `agentguard bench` runs pathological scenarios (loop storm, fake "all tests pass" claims) AND normal-behavior scenarios (reading a codebase, converging edits, polling) — scoring both "catches what it should" and "never blocks what it shouldn't". The suite caught two real false positives on day one. Competitors ship fuzzy detection off-by-default; ours is on, because we can prove it doesn't misfire.
- **Headless alerts**: blocks, kill-switch trips and stalls POST to any webhook (Slack/Discord-style payload) — the channel that works on CI runners and servers where no desktop exists. `digest --notify` sends the weekly "what the guard saved you" summary to the same place.
- **Flight recorder**: `agentguard incident` turns any recorded run into a shareable post-mortem — failure mode, the full reason the model received at each block, timeline, estimated requests saved.

Works on Kimi Code, Claude Code, Codex and Gemini CLI. Zero daemon, zero proxy, fail-open (if the guard itself errors, the agent keeps working), local SQLite only. Deterministic — the only LLM in the loop is an optional single-vote veto for false positives, budget-capped and fail-closed. 221 tests; the crash-test suite runs in CI on Ubuntu + Windows.

Demo GIF (canary → colored doctor → live watch catching a block): https://raw.githubusercontent.com/shidesheng0218/kimi-guard/main/assets/demo.gif?v=1.3.0

Honest question for the thread: if you run agents unattended, what's your current tripwire — and has a post-hoc alert ever actually saved you, or do you only ever learn from the bill?
