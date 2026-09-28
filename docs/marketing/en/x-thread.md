# X thread draft (v1.9.0)

1/ My coding agent ran the same grep 76 times in a headless CI run and burned my 5-hour quota. Nothing stopped it.

So I built the thing that does: agent-guard 🛡️ (open source)

2/ It's a behavior guard, not a permission checker. It catches the *patterns* of a stuck agent: repeated identical calls, A→B→A cycles, identical outputs from different args, file edit thrashing, read-only exploration streaks.

3/ Intervention is a ladder, not a brick wall: warn in context → block with a corrective reason → kill switch that orders the agent to summarize and stop. Fail-open by design: if the guard itself breaks, the agent keeps working.

4/ The sneaky failure mode: not loops — *silence*. A hung API call produces zero events, so every loop detector is blind to it. v1.9 adds a stall watchdog: silent for N minutes while no tool is running → webhook alert. A 30-minute build never triggers it.

5/ Everything POSTs to your Slack/Discord webhook now — blocks, kill-switch trips, stalls, the weekly "what the guard saved you" digest. Built for CI runners and headless boxes where no desktop exists.

6/ Proving it works takes 10 seconds: `agentguard canary` fires synthetic repeats through the real hook pipeline and shows the block, with the exact reason the model sees. Plus a public false-positive suite — it proves the guard never blocks normal work, not just that it catches loops.

7/ Works on Kimi Code, Claude Code, Codex and Gemini CLI via their hooks. Also a GitHub Action for CI. Zero daemon, zero proxy, local SQLite only.

npm i -g @shidesheng0218/agentguard
github.com/shidesheng0218/kimi-guard

---

# 发布执行清单

## 发布前（一次性账号准备）

- [ ] 头像 + Banner（用 assets/banner.svg 或 social-post 的 01-cover.png）
- [ ] Bio 一句话：`Building agent-guard 🛡️ — stops runaway AI coding agents before they burn your quota. Pre-execution interception, zero daemon. MIT.`
- [ ] 置顶推文 = 本条 thread 发布后的链接
- [ ] 素材就位：tweet 2 附 `assets/replay-incident.png`（事故报告截图，具体 > logo）；tweet 6/7 之间可补 `assets/demo-watch.gif`（TUI 实时拦截动图）。Twitter 重视频/图片，纯文字 thread 触达差一截

## 发布时机

- 最佳窗口：**美东周二~周四上午 9–12 点 = 北京时间晚上 21 点–凌晨 0 点**
- 备选：欧洲上午 = 北京 14–17 点
- 避开：周末、美股财报日、大型发布会当天（被大新闻淹没）

## 发布动作

- 一口气发完整个 thread（不要隔天发，thread 完整读完后转发率高）
- 第 1 条必须带 repo 链接 + 配图——多数人只看第 1 条就决定点不点
- 标签最多 2 个：`#ClaudeCode` `#AIagents`，不要堆
- 不要 @ 大厂官号（会被判 spam）；如果 Anthropic 员工回复，认真回

## 发布后 48 小时（决定成败的部分）

- **前 2 小时守在评论区**：每条回复 10 分钟内回，算法按早期互动加权
- 预置答案：有人问"和 X 有什么区别"（答：ruslanlap/loopguard 是转录监视只能事后告警，TokenFuse 是 LLM 代理管钱不管行为——我们是工具调用层执行前拦截，互补）
- 第二天发一条 quote-tweet 自引：放 bench 误报套件的截图，讲"我们怎么证明不误伤"（工程师吃这套）
- **回复党策略**（比发帖更长效）：搜 `claude code loop` / `agent stuck` / `codex burn`，在别人的求助推下面真诚回复 + 自然带一句"I built an open-source guard for exactly this"，不贴链接链接放个人主页
- 把本条 thread 置顶至少 2 周

## 观察指标

- 24h：impressions、profile visits、repo 链接点击
- 72h：npm 周下载是否突破 209 基线（翻倍 = 这条 thread 有效）
- 7d：GitHub star 增量、有没有人开 issue / 提 feedback（真实用户信号）
