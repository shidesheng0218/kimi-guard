# Upstream issue replies (MoonshotAI/kimi-cli)

Tone: helpful community member, not advertiser. Lead with the technical observation, offer the tool as optional relief. Never imply official affiliation. Review each issue's latest state before posting — if it's already fixed, say thanks and skip the plug.

## #2142 — "Agent loops on same shell command"

> I hit this exact pattern in a headless run — same `grep` 76× in a row, burned a full 5h quota window before I noticed. The root cause from what I can tell: the model re-issues the same call because the previous result isn't salient enough, and a mechanical step counter can't tell "same call, same result" from progress.
>
> Until a fix lands upstream, I built a hook-based guard that catches it: fingerprints `(tool, args)` pairs, blocks the Nth identical call with the reason fed back to the model ("the previous results are already in context — use them"), and detects the related "different args, identical output" spin (which is what this issue's Case B looks like from the outside). It's fail-open, so it can't make things worse: https://github.com/shidesheng0218/kimi-guard
>
> Happy to share the analyzer design (pure functions, could slot into the CLI itself) if the maintainers are interested.

## #2368 — (parallel dispatch / quota exhaustion)

> Same quota wall here. One mitigation that works today: a hooks-based budget gate that meters requests against the plan's 5h/weekly windows and blocks subagent dispatch before the window is gone (with a burn-rate projection warning before it blocks). https://github.com/shidesheng0218/kimi-guard

## #2578 — (check the issue body before posting; draft)

> If this bites you in unattended runs: I built a guard that adds hard step/time caps, a kill switch, and failure checkpoints to Kimi Code via its hook system: https://github.com/shidesheng0218/kimi-guard — the checkpoint briefs (`agentguard resume`) are paste-ready context for a resumed session.

## Template for the *first* comment on each issue (read the issue fully first!)

- Acknowledge the reporter's pain with a specific detail from their post
- Add one piece of technical insight (why the failure happens mechanically)
- Offer the tool as relief, MIT, one line, no feature list
- Offer to upstream the design
