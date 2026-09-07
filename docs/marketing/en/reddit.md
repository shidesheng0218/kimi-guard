# Reddit drafts (v1.4.0)

## r/ClaudeAI

**Title:** I built a behavioral guard for Claude Code (hooks) — it catches runaway loops, verifies "all tests pass" claims, and shows you what it saved you

**Body:**

Two failure modes kept biting me with Claude Code (and other agents): the same tool call looping dozens of times until the session died, and final messages claiming "all tests pass" without any test ever being run. Both are invisible until you check the bill.

So I built **agent-guard** — hooks that watch every tool call and intervene with a ladder:

1. **warn** — context note injected ("you've called this 3 times with identical args")
2. **block** — denied with a corrective reason the model sees
3. **kill switch** — after N blocks, everything locks and the agent must summarize and stop

Detection is semantic, not a dumb counter: repetition fingerprints, A→B→A cycles, byte-identical or near-identical outputs across different args, same-file edit thrashing, read-only exploration streaks.

Stuff I wish existed earlier:

- **Completion gate**: "all tests pass" claims are checked against the actual recorded command history. No evidence → corrective round.
- **Canary**: `agentguard canary` proves the guard is wired in 10 seconds — fires synthetic repeats through the real hook path and shows the block.
- **Headless supervision**: `agentguard run --harness claude` drives `claude -p` with hard turn/time caps, checkpoint auto-resume, and a kill switch. Built for CI.
- **Weekly digest**: tells you what the guard stopped and roughly how many requests it saved you — because a good guard is invisible, and invisibility is how you forget you have it.

Also installable as a plugin: `/plugin marketplace add shidesheng0218/kimi-guard` → `/plugin install agent-guard@agentguard`.

Repo: https://github.com/shidesheng0218/kimi-guard — false-positive reports welcome (`agentguard feedback fp <id>`, the feedback calibrates the detectors).

## r/ChatGPTCoding

**Title:** Open-source behavioral guard for coding agents (Codex / Claude / Kimi / Gemini) — loops, quota burn, fake "all tests pass" claims

**Body:** (same core as r/ClaudeAI version; lead with: "Codex's own hooks cover Bash/apply_patch/local tools, so agent-guard now guards Codex too — plus Claude Code, Kimi and Gemini. The quota gate understands subscription windows, not just USD billing.")
