# Reddit drafts

## r/ClaudeAI

**Title:** I built a guard that stops Claude Code from looping the same tool call 70+ times (hooks-based, blocks before it burns your quota)

**Body:**

Tired of watching Claude Code get stuck in a loop? I kept hitting runs where the same `Grep` fired dozens of times until the session died — especially bad in headless/CI runs where nobody presses Ctrl+C.

So I built **agent-guard**: hooks that watch every tool call and intervene with a soft-to-hard ladder:

1. **warn** — a note injected into context ("you've called this 3 times with identical args, the result is already there")
2. **block** — the call is denied with a corrective reason fed back to the model
3. **kill switch** — after N blocks in a session, all tools lock and the agent is ordered to summarize and stop

Detection is semantic, not a dumb counter: repetition fingerprints, A→B→A cycles, "different args, byte-identical output" (the tell-tale of spinning), near-identical outputs via similarity, same-file edit thrashing, and pure read/search streaks (exploring without implementing).

Bonus bits:

- Claim-vs-evidence gate: "all tests pass" in the final message is checked against the actual recorded commands — no evidence, no completion
- Checkpoints on failure/interrupt: a paste-ready research-state brief so a resumed session doesn't re-explore
- `agentguard run --harness claude` supervises headless runs over `claude -p` stream-json: hard turn/time caps, auto-resume with the checkpoint injected, CI-friendly exit codes
- Everything is fail-open and local (SQLite, no daemon, no proxy)

Install: `npm i -g @shidesheng0218/agentguard && agentguard install` (also as a plugin: `/plugin marketplace add shidesheng0218/kimi-guard` → `/plugin install agent-guard@agentguard`)

Repo: https://github.com/shidesheng0218/kimi-guard — feedback on false positives especially welcome (`agentguard feedback fp <id>` calibrates the detectors).

## r/ChatGPTCoding

**Title:** Open-source behavioral guard for coding agents — loops, quota burn, fake "all tests pass" claims (works on Kimi Code, Claude Code, Codex)

**Body:** (reuse the r/ClaudeAI body, swap the Claude-specific bits for "works on Kimi Code CLI, Claude Code and Codex CLI", lead with the 76×-grep story and the quota-gate angle since this sub cares about subscription limits)
