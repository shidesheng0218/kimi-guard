# X thread draft

1/ My coding agent ran the same grep 76 times in a row during a CI run and ate my entire 5h quota. Nothing stopped it. So I built the thing that does: agent-guard 🛡️ (open source)

2/ It's a behavior guard, not a permission checker. It catches the *patterns* of a stuck agent: repeated identical calls, A→B→A cycles, identical outputs from different queries, file edit thrashing, "exploring forever, never writing".

3/ Intervention is a ladder, not a brick wall: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop. If the guard itself breaks, the agent keeps working (fail-open by design).

4/ My favorite part: the completion gate. Agent says "all tests pass"? Check the recorded command history. No evidence → corrective round. Claims must be earned.

5/ Headless/CI mode: `agentguard run` supervises the whole run — hard caps, kill switch, auto-resume with a checkpoint of everything it already learned. Exit code 2 when it intervened. Perfect for cron.

6/ Works on Kimi Code CLI, Claude Code and Codex CLI via their hook systems. Zero daemon, zero proxy, local SQLite only.

npm i -g @shidesheng0218/agentguard
https://github.com/shidesheng0218/kimi-guard
