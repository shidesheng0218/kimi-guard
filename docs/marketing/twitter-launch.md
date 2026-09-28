# Twitter/X 发布素材包（v1.9.0）— 复制即发

写法原则：像人在抱怨，不像产品在宣讲。每条 ≤280 字符（已按 Twitter 计权验证：中日文按 2 计）。

---

## 0. 账号 Bio（发布前先改好）

```
made agent-guard 🛡️ because my agent grepped itself into bankruptcy. it blocks runaway AI agent loops before your quota dies. MIT, zero daemon.
```

---

## 1. 英文主 Thread（7 条，一口气发完）

**Tweet 1/7**:

```
last month my agent grepped the same pattern 76 times in a row. headless CI run, nobody home. it ate my entire 5-hour quota before I woke up.

so I did what any reasonable person does: built a guard instead of just setting a step limit 🧵
```

**Tweet 2/7**（配图：`assets/social-post/twitter-card.png`）:

```
here's what a block looks like:

'you've called Grep 3 times with identical arguments. the results are already in your context — use them.'

that's it. no wall, no ban. the model reads why it's blocked and usually stops. a block with a reason beats a silent denial.
```

**Tweet 3/7**:

```
it also catches the subtler spins: A→B→A→B cycles, outputs that come back byte-identical no matter how you shuffle the args, same file edited 10 times without converging.

favorite: 'all tests pass' gets checked against your actual command history. no test run → no claim.
```

**Tweet 4/7**:

```
new in v1.9: stall detection. loops are loud, silence is worse — a hung API call produces zero events, invisible to every loop detector.

now: agent quiet for 10 min while nothing's running → slack ping. your 30-minute build never trips it.
```

**Tweet 5/7**:

```
everything ships to one webhook: blocks, kill-switch trips, stalls, and a weekly "here's what i saved you" digest.

built for CI runners where no desktop exists — which is exactly where runaway agents do their best damage.
```

**Tweet 6/7**（配 GIF：`assets/demo-watch.gif`）:

```
the part i care about most: proving it DOESN'T block normal work. agentguard bench scores a false-positive suite (reading code, converging edits, polling) right next to the crash tests.

competitors ship fuzzy detection off by default. mine is on. because it's tested.
```

**Tweet 7/7**:

```
zero daemon, zero proxy, local sqlite, fail-open — if the guard breaks, your agent keeps working. works on Kimi Code, Claude Code, Codex, Gemini CLI.

npm i -g @shidesheng0218/agentguard
github.com/shidesheng0218/kimi-guard
```

---

## 2. 中文版（发完英文后 quote-tweet 挂在 7/7 下）

```
我的 agent 曾在无人值守的 CI 里把同一条 grep 连跑 76 次,烧穿 5 小时配额,打开电脑它还在跑。

一怒之下写了个熔断器:重复调用第 4 次直接拦,理由喂回给模型,大多数循环到这就停了。静默挂死也会 webhook 告警。

支持 Kimi/Claude Code/Codex/Gemini,开源:
github.com/shidesheng0218/kimi-guard
```

---

## 3. 预置 FAQ 回复（评论区直接粘贴，微调后用）

**Q: "How is this different from loopguard / transcript watchers?"**

```
those tail the transcript file, which is written AFTER the call runs. so they alert you about the fire. agent-guard is the sprinkler: blocks call #4 before it executes.
```

**Q: "TokenFuse / cost caps already do this?"**

```
different layer. it meters $$ at the API boundary — sees the bill, not the behavior. we see tool semantics: we know grep×3 is a spin, not progress. they compose.
```

**Q: "Won't Anthropic/OpenAI just build this in?"**

```
their issue tracker already has 1,170 'loop'-titled reports, so maybe. until then: one config guards 4 CLIs, and it's deterministic — no LLM judging your agent's calls.
```

**Q: "Doesn't it false-positive on legit work?"**

```
fair worry — that's why the repo ships a public false-positive suite scored next to the crash tests. fuzzy detection stays ON by default here, because it's tested.
```

**Q: "Windows?"**

```
CI matrix runs Ubuntu + Windows, Node 22/24. macOS gets desktop notifications; Linux/CI use the webhook.
```

---

## 4. 素材对照表

| 素材 | 路径 | 用于 | 状态 |
|---|---|---|---|
| 事故拦截卡（主图） | `assets/social-post/twitter-card.png` | Tweet 2 | ✅ 1100×400，131KB |
| TUI 实时拦制动图 | `assets/demo-watch.gif` | Tweet 6 | ✅ 195KB |
| Banner（账号头图） | `assets/banner.svg` → 需导出 PNG | 个人主页 | 需自行导出 |

## 5. 发布后 48 小时提醒

- 前 2 小时守评论区，10 分钟内回每条
- 明天发 quote-tweet 自引：bench 双轴记分截图 + "how we prove no false positives"
- 长效：搜 `claude code loop` / `agent stuck` 的求助推，真诚回复，链接只放主页
- 成功标准：72h npm 周下载 >400（基线 209），7d 内出现第一个陌生 issue
