# Launch content index

All drafts are ready to post after review. Posting order and timing:

1. **Now (v0.8.1 already live)**: upstream issue replies (`en/upstream-issues.md`), claude-plugins-community PR (see below)
2. **On v0.9.0 release**: Show HN → Reddit → X (same day, US morning), V2EX + 掘金 (China evening)

Channel rules worth knowing:
- **Show HN**: title must start with "Show HN:"; post the demo GIF link in the first comment, not the title. No hype words ("revolutionary", "game-changing").
- **r/ClaudeAI**: self-promotion is fine if it's a tool people can use; include a real workflow, not a feature list.
- **V2EX**: post in 分享创造; expect blunt technical questions; answer with data.
- **掘金/知乎**: 掘金 likes screenshots/GIF; 知乎 likes depth (use the competitor analysis as the article body).

## claude-plugins-community submission

Prepare a PR to https://github.com/anthropics/claude-plugins-community adding our plugin entry.
Fork → add marketplace entry pointing at `shidesheng0218/kimi-guard` (self-hosted marketplace at repo root) → PR body:

```
Adds agent-guard: a runtime behavior guard for Claude Code (loop detection,
quota gates, completion gate, kill switch, checkpoints). The plugin's hooks call
the agentguard CLI (npm i -g @shidesheng0218/agentguard); without it the hooks
fail-open. Plugin source: claude-plugin/ in the repo. License: MIT.
```
