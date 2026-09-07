# Show HN draft (v1.4.0)

**Title:** Show HN: Agent-Guard – a behavioral guard for coding agents, with a crash-test suite and a flight recorder

**Link:** https://github.com/shidesheng0218/kimi-guard

**First comment (post immediately after submitting):**

Author here. The origin story: a Kimi Code agent ran the same grep 76 times in a row during an unattended CI run and burned an entire 5-hour quota window. Nobody was there to press Ctrl+C. (Upstream issue MoonshotAI/kimi-cli#2142 documents the same failure at 112× for other users.)

Agent-Guard watches every tool call and intervenes with a ladder, not a wall:

1. **warn** — a note injected into the model's context
2. **block** — the call is denied with a corrective reason fed back to the model
3. **kill switch** — after N blocks, all tools lock and the agent is ordered to summarize and stop

Detection is semantic: repeated fingerprints, A→B→A cycles, identical outputs from different args, near-identical outputs (trigram similarity), same-file edit thrashing, no-progress stretches, read-only exploration streaks.

Three things that I think make it worth a look:

- **Proof-of-life in 10 seconds**: `agentguard canary` fires synthetic repeated calls through the real hook pipeline and shows the 4th being blocked, with the exact reason the model receives. The hardest problem in guard tooling is "is it even doing anything?" — this answers it.
- **Crash-test suite**: `agentguard bench` runs scripted pathological scenarios (loop storm, fake "all tests pass" claims, context pressure) against the guard and scores them. The guard's own crash tests run in CI.
- **Weekly digest**: interventions are invisible by design, so `agentguard digest` tells you every week what the guard stopped and how many requests it saved (documented heuristic). `digest --notify` puts it on your desktop via your own scheduler.

Works on Kimi Code, Claude Code, Codex and Gemini CLI via their hook systems. Zero daemon, zero proxy, fail-open (if the guard itself errors, the agent keeps working), local SQLite only. Deterministic — the only LLM in the loop is an optional single-vote veto for false positives, budget-capped and fail-closed.

Demo GIF (canary → colored doctor → live watch catching a block): https://raw.githubusercontent.com/shidesheng0218/kimi-guard/main/assets/demo.gif?v=1.3.0

Honest question for the thread: how would you want a guard like this to tell you it saved you money, without spamming you? Right now it's a weekly digest + a menu-bar % — curious what people prefer.
