# Claude plugin directory submission (v1.4.0)

**重要**：claude-plugins-community **不接受 PR**（会直接关闭）。投稿只能走官方表单：
https://clau.de/plugin-directory-submission

以下答案直接粘贴。表单字段以实际页面为准微调。

---

**Plugin name:** agent-guard

**Marketplace / repo URL:** https://github.com/shidesheng0218/kimi-guard

(自建市场：仓库根有 `.claude-plugin/marketplace.json`，插件在 `claude-plugin/` 子目录)

**Short description (for the directory listing):**

Runtime behavior guard for Claude Code — catches runaway agent loops (semantic repeat/cycle/no-gain detection), quota gates, completion-claim verification, kill switch, checkpoints, plus a crash-test suite and a proof-of-life canary.

**Long description:**

agent-guard is a hooks-based runtime guard. It watches every tool call and intervenes with a ladder: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop. Detection is semantic (repetition fingerprints, A→B→A cycles, byte-identical/near-identical outputs, edit churn, exploration drift) — not a dumb step counter.

Extras: `agentguard run --harness claude` supervises headless `claude -p` runs with hard caps, a completion gate checks "all tests pass" claims against recorded command history, `agentguard bench` crash-tests the guard itself, and `agentguard canary` proves the guard is wired in 10 seconds. Everything is fail-open (guard errors never break the agent), local-only (SQLite, no network, no telemetry).

**Install instructions for users:**

```
npm i -g @shidesheng0218/agentguard
agentguard install --harness claude
agentguard canary   # proof-of-life in 10 seconds
```

或插件渠道（自建市场已可用）：

```
/plugin marketplace add shidesheng0218/kimi-guard
/plugin install agent-guard@agentguard
```

**Dependencies:** Node ≥ 22.13 and the `agentguard` CLI (the plugin's hooks call it; without it hooks fail-open and do nothing harmful). No API keys required; no network calls; no data leaves the machine.

**Security notes for review:**

- The plugin ships only `hooks/hooks.json` entries calling a CLI the user installs themselves; no bundled binaries, no post-install scripts.
- All enforcement is local: state in `~/.agent-guard/state.db` (SQLite). No telemetry, no external endpoints. The only optional network call is a user-configured LLM veto vote (off by default, requires the user's own API key).
- Fail-open by design: any error in the hook exits 0 and never blocks the user's work.

**License:** MIT

**Author:** shidesheng0218 (same author as kimi-boost)
