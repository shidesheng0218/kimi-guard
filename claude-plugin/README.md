# agent-guard — Claude Code plugin

Runtime behavior guard hooks for Claude Code. This plugin is a thin install
shim: the enforcement engine is the `agentguard` CLI.

## Install

```sh
npm i -g @shidesheng0218/agentguard   # the guard engine (hooks fail-open without it)
```

Then in Claude Code:

```
/plugin marketplace add shidesheng0218/kimi-guard
/plugin install agent-guard@agentguard
```

Or let the CLI install the same hook entries directly into `~/.claude/settings.json`:

```sh
agentguard install --harness claude
```

## What you get

Semantic loop detection (repeat / cycle / no-gain / churn / no-progress /
exploration drift), quota gates, a completion gate (claim vs evidence),
kill switch, and checkpoints — all fail-open: if the CLI is missing or errors,
Claude Code keeps working untouched.

Docs: https://github.com/shidesheng0218/kimi-guard
