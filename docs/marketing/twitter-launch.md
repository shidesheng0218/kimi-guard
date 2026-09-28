# Twitter/X 发布素材包（v1.9.0）— 复制即发

每条都 ≤280 字符，无 Premium 也能发。配图见各条标注。

---

## 0. 账号 Bio（发布前先改好）

```
Building agent-guard 🛡️ — stops runaway AI coding agents before they burn your quota. Pre-execution interception, zero daemon. MIT.
```

---

## 1. 英文主 Thread（7 条，一口气发完）

**Tweet 1/7**（配图：`assets/social-post/twitter-card.png`）:

```
My coding agent ran the same grep 76 times in a headless CI run and burned my entire 5-hour quota. Nothing stopped it.

So I built the thing that does: agent-guard 🛡️ open source 🧵
```

**Tweet 2/7**:

```
It's a behavior guard, not a permission checker. It catches the *patterns* of a stuck agent: repeated identical calls, A→B→A cycles, identical outputs from different args, file edit thrashing, exploration streaks.
```

**Tweet 3/7**:

```
Intervention is a ladder, not a brick wall: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop.

Fail-open by design: if the guard itself breaks, the agent keeps working.
```

**Tweet 4/7**:

```
The sneaky failure mode: not loops — *silence*. A hung API call produces zero events, so every loop detector is blind to it.

v1.9 adds a stall watchdog: silent for N min while no tool runs → webhook alert. A 30-min build never triggers it.
```

**Tweet 5/7**:

```
Everything POSTs to your Slack/Discord webhook now — blocks, kill-switch trips, stalls, and the weekly "what the guard saved you" digest.

Built for CI runners and headless boxes where no desktop exists.
```

**Tweet 6/7**（配图/GIF：`assets/demo-watch.gif`）:

```
Proving it works takes 10s: agentguard canary fires synthetic repeats through the real hook pipeline and shows the block — with the exact reason the model sees.

Plus a public false-positive suite proving the guard never blocks normal work.
```

**Tweet 7/7**:

```
Works on Kimi Code, Claude Code, Codex, Gemini CLI via their hooks. GitHub Action for CI. Zero daemon, zero proxy, local SQLite only.

npm i -g @shidesheng0218/agentguard
github.com/shidesheng0218/kimi-guard
```

---

## 2. 中文版（发完英文 thread 后，quote-tweet 挂在 7/7 下面）

```
中文版：给 AI 编程 Agent 装的行为熔断器 🛡️

同一命令连跑 76 次、烧穿 5 小时配额的事故——执行前就拦住，而不是事后告警。

13 个检测器 + 停滞看门狗 + Slack/Discord webhook 告警，支持 Kimi Code / Claude Code / Codex / Gemini CLI。开源 MIT：

npm i -g @shidesheng0218/agentguard
```

---

## 3. 预置 FAQ 回复（评论区直接粘贴，微调后用）

**Q: "How is this different from loopguard / X?"**

```
Transcript watchers (e.g. ruslanlap/loopguard) tail the session file — written AFTER execution — so they can only alert once the tokens are burned. agent-guard blocks the call BEFORE it runs (exit 2 + corrective reason).
```

**Q: "TokenFuse / cost caps already do this?"**

```
Different layer, complementary: TokenFuse proxies LLM calls and enforces $-caps (sees the bill, not the behavior). agent-guard sees tool semantics — it knows "grep ×3 same args" is a loop, not progress. Serious setups can run both.
```

**Q: "Won't Anthropic/OpenAI just build this in?"**

```
Maybe eventually — their issue trackers are full of these reports (1,170 "loop"-titled issues in claude-code alone). Until then this guards all 4 CLIs with one config, and it's fail-open + deterministic (no LLM judge in the loop).
```

**Q: "Doesn't it false-positive on legit work?"**

```
That's the part I'm most proud of: agentguard bench ships a false-positive suite (reading codebases, converging edits, polling) scored alongside crash tests — dual-axis 100/100. Fuzzy detection is ON by default because we can prove it doesn't misfire.
```

**Q: "Windows/WSL?"**

```
CI matrix runs Ubuntu + Windows on Node 22/24. macOS gets desktop notifications; Linux/CI use the webhook channel.
```

---

## 4. 素材对照表

| 素材 | 路径 | 用于 | 状态 |
|---|---|---|---|
| 事故拦截卡（主图） | `assets/social-post/twitter-card.png` | Tweet 1 | ✅ 1100×400，131KB |
| TUI 实时拦制动图 | `assets/demo-watch.gif` | Tweet 6 | ✅ 195KB |
| Banner（账号头图） | `assets/banner.svg` → 需导出 PNG | 个人主页 | 需自行导出（sips 不支持 svg，可用浏览器截图） |

## 5. 发布后 48 小时提醒

- 前 2 小时守评论区，10 分钟内回每条
- 明天发 quote-tweet 自引：bench 双轴记分截图 + "how we prove no false positives"
- 长效：搜 `claude code loop` / `agent stuck` 的求助推，真诚回复，链接只放主页
- 成功标准：72h npm 周下载 >400（基线 209），7d 内出现第一个陌生 issue
