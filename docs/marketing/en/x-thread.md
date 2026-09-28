# X thread draft (v1.9.0)

1/ My coding agent ran the same grep 76 times in a headless CI run and burned my 5-hour quota. Nothing stopped it.

So I built the thing that does: agent-guard 🛡️ (open source)

2/ It's a behavior guard, not a permission checker. It catches the *patterns* of a stuck agent: repeated identical calls, A→B→A cycles, identical outputs from different args, file edit thrashing, read-only exploration streaks.

3/ Intervention is a ladder, not a brick wall: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop. Fail-open by design: if the guard itself breaks, the agent keeps working.

4/ The sneaky failure mode: not loops — *silence*. A hung API call produces zero events, so every loop detector is blind to it. v1.9 adds a stall watchdog: silent for N minutes while no tool is running → webhook alert. A 30-minute build never triggers it.

5/ Everything POSTs to your Slack/Discord webhook now — blocks, kill-switch trips, stalls, the weekly "what the guard saved you" digest. Built for CI runners and headless boxes where no desktop exists.

6/ Proving it works takes 10 seconds: `agentguard canary` fires synthetic repeats through the real hook pipeline and shows the block, with the exact reason the model sees. Plus a public false-positive suite — it proves the guard never blocks normal work, not just that it catches loops.

7/ Works on Kimi Code, Claude Code, Codex and Gemini CLI via their hooks. Also a GitHub Action for CI. Zero daemon, zero proxy, local SQLite only.

npm i -g @shidesheng0218/agentguard
github.com/shidesheng0218/kimi-guard
