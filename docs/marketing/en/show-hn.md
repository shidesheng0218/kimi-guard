# Show HN draft

**Title:** Show HN: Agent-Guard – a behavioral guard for coding agents (loop detection, quota gates, kill switch)

**Link:** https://github.com/shidesheng0218/kimi-guard

**First comment (post immediately after submitting):**

Hi HN — author here. I built this after a Kimi Code agent ran the same grep 76 times in a row during an unattended CI run and burned my entire 5-hour quota window (upstream issue MoonshotAI/kimi-cli#2142 documents this failure mode; the comments there show 112× repeats too).

What it does that I couldn't find anywhere else:

- Detects *semantic* loop patterns, not just step counts: exact/near-duplicate call fingerprints, A→B→A cycles, byte-identical outputs across different args, same-file edit churn, read-only exploration streaks, near-identical output similarity (trigram Jaccard)
- Warns the model first (context injection), blocks with a corrective reason, and after N blocks a kill switch orders the agent to summarize and stop
- Quota gates that understand subscription windows (5h/weekly), with burn-rate projection — blocks subagent dispatch before the window is gone
- Deterministic completion gate: "all tests pass" claims are checked against the recorded command history; unbacked claims trigger a corrective round (optional single-vote LLM veto for false positives, fail-closed)
- Checkpoints: on failure/interrupt it captures a research-state brief (files touched, commands run, failed calls) so a resumed session skips re-exploration
- `agentguard run` supervises headless runs: Kimi via its Wire protocol (mid-turn steering), Claude Code via `claude -p` stream-json

Works on Kimi Code CLI, Claude Code, and Codex CLI via their hook systems. Zero daemon, zero proxy, fail-open (if the guard itself errors, the agent keeps working). Local SQLite only.

Demo GIF (real terminal session): https://raw.githubusercontent.com/shidesheng0218/kimi-guard/main/assets/demo.gif?v=0.8.1

The thing I'm most curious about: what false-positive rate are people willing to tolerate from a guard like this? v0.7 added a feedback loop (`agentguard feedback fp <id>`) that calibrates thresholds from real usage — early data welcome.
