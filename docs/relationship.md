# agent-guard ↔ kimi-boost: boundary and coexistence

Contract: `coexistence-contract-1` (keep in sync with `kimi-boost/docs/relationship.md`)

agent-guard and **kimi-boost** are independent tools that solve different
problems:

- **agent-guard = runtime behavior guard.**
  It watches tool calls while the agent runs: repetition, cycles, no-information
  gain, edit churn, exploration drift, quota gates, completion claims,
  checkpoints/resume, stall detection and the kill switch.
- **kimi-boost = install-time guardrails and engineering conventions.**
  It installs skills, reviewer agents, slash commands, MCP servers and static
  tool-call rules (dangerous commands, trunk protection, secrets, credential
  reads, lockfiles, guard self-protection).

Neither tool requires the other. Install either one and it works alone.

## Which one do I need?

| What you want | Install |
|---|---|
| Stack conventions, skills/agents/commands, static guardrails, config updates | kimi-boost |
| Stop runaway loops, quota burn, false completion, or run unattended CI | agent-guard |
| Both | Install in any order; each writes only its own managed block |

## Coexistence contract

C1. Each tool writes and removes only its own managed entries. agent-guard owns
    the `# >>> kimi-guard managed >>>` block and `agentguard`/`kguard` hook
    commands; kimi-boost owns the `# >>> kimi-boost managed >>>` block and
    commands under `~/.kimi-boost/hooks/`.
C2. Installing or uninstalling either tool must not damage the other's hooks or
    configuration.
C3. No shared files, databases, state files, npm dependencies, or cross-install
    commands.
C4. Doctor/status detection of the other tool is read-only.
C5. Both tools fail open. The other tool being absent, damaged, or old is never
    an error.
C6. Install order is irrelevant.
C7. The same hook event may carry both tools' entries. Each decides
    independently; there is no deduplication or coordination between them.
C8. Public documentation states the split, and this contract version appears in
    both repositories.

## What coexistence looks like

```
~/.kimi-code/config.toml
  # >>> kimi-boost managed >>>      ← presets, skills, static guards
  # <<< kimi-boost managed <<<
  # >>> kimi-guard managed >>> ...  ← runtime guard hooks
  # <<< kimi-guard <<<
```

`agentguard doctor` reports `coexistence: kimi-boost detected` when the
install-time tool is wired, and stays silent when it is not. `kimi-boost doctor`
does the same in reverse. Both report "installed (hooks not detected)" when the
other tool's home exists but no hooks are wired.

## Release-time manual checklist

Run this only in a throwaway environment. Every path below is redirected with
environment variables; never run it against your real HOME.

```bash
export TMP=$(mktemp -d)
export HOME="$TMP/home"; mkdir -p "$HOME"
export KIMI_CODE_HOME="$HOME/.kimi-code"
export KIMI_BOOST_HOME="$HOME/.kimi-boost"
export AGENT_GUARD_HOME="$HOME/.agent-guard"

# 1. Install both from local builds (no global install)
node ../kimi-boost/dist/cli.js install core
node ../kimi-guard/dist/cli.js install --harness kimi

# 2. Both doctors: exactly one coexistence ok line, no "hook has no script path"
node ../kimi-boost/dist/cli.js doctor
node ../kimi-guard/dist/cli.js doctor

# 3a. boost blocks a direct push to main (expect exit 2)
printf '%s' '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"session_id":"t"}' \
  | node "$KIMI_BOOST_HOME/hooks/core/protect-main.mjs"; echo "exit=$?"

# 3b. agent-guard blocks a synthetic repeat (expect the 4th call blocked)
node ../kimi-guard/dist/cli.js canary

# 4. Uninstall agent-guard; boost's block must remain
node ../kimi-guard/dist/cli.js uninstall
grep -q 'kimi-boost managed' "$KIMI_CODE_HOME/config.toml" && echo "boost block intact"

# 5. Reinstall agent-guard, remove boost; agent-guard's block must remain
node ../kimi-guard/dist/cli.js install --harness kimi
node ../kimi-boost/dist/cli.js remove core
grep -q 'kimi-guard managed' "$KIMI_CODE_HOME/config.toml" && echo "guard block intact"
```

Pass criteria: step 2 prints exactly one coexistence line per doctor; step 3
prints `exit=2` and a block; steps 4 and 5 print `intact`.