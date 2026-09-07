# X thread draft (v1.4.0)

1/ My coding agent ran the same grep 76 times in a headless CI run and burned my 5-hour quota. Nothing stopped it.

So I built the thing that does: agent-guard 🛡️ (open source)

2/ It's a behavior guard, not a permission checker. It catches the *patterns* of a stuck agent: repeated identical calls, A→B→A cycles, identical outputs from different args, file edit thrashing, read-only exploration streaks.

3/ Intervention is a ladder, not a brick wall: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop. Fail-open by design: if the guard itself breaks, the agent keeps working.

4/ The best part? Proving it works takes 10 seconds.

`agentguard canary` fires synthetic repeats through the real hook pipeline and shows the 4th being blocked, with the exact reason the model sees.

5/ It also has a crash-test suite (`agentguard bench`), a flight recorder (`agentguard replay`), a live TUI (`agentguard watch`), and a weekly digest that tells you how many requests it saved you.

6/ Works on Kimi Code, Claude Code, Codex and Gemini CLI via their hooks. Also a GitHub Action for CI. Zero daemon, zero proxy, local SQLite only.

npm i -g @shidesheng0218/agentguard
github.com/shidesheng0218/kimi-guard
