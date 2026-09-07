# Launch content index (v1.4.0)

All drafts refreshed for v1.4.0 (canary / bench / digest / 4 harnesses / GitHub Action).

## Posting order & timing

1. **今天（无需等时机）**
   - claude-plugins-community PR(见下)
   - 上游 issue 回复:`en/upstream-issues.md`（先读原文确认状态）
   - GitHub repo topics(已设)

2. **周二~周四，美国上午 (UTC 13:00-16:00)**
   - Show HN:`en/show-hn.md`（首楼文案带 canary/bench/digest 三个点）

3. **同日国内晚 8-10 点**
   - V2EX 分享创造:`zh/v2ex.md`

4. **周四**
   - Reddit:r/ClaudeAI + r/ChatGPTCoding(`en/reddit.md`)
   - 掘金 / 知乎:`zh/juejin-zhihu.md`

5. **周五**
   - X thread:`en/x-thread.md`
   - awesome list PRs

## Channel rules

- **Show HN**:标题必须 "Show HN:" 开头；demo GIF 放首楼不放标题；不用 "revolutionary" 类词。
- **r/ClaudeAI**:自助工具贴 OK，但要给"今天就能用"的工作流，不是功能清单。
- **V2EX**:分享创造节点；评论区会有直白技术拷问，用数据回答。
- **掘金/知乎**:掘金配图用 watch GIF；知乎用加深分析版。
- **即刻**:短内容 + watch GIF 截图，一两句事故开场即可。

## claude-plugins-community submission

PR 到 https://github.com/anthropics/claude-plugins-community 增加插件条目，正文:

```
Adds agent-guard: a runtime behavior guard for Claude Code — semantic loop
detection, quota gates, completion gate (claim vs evidence), kill switch,
checkpoints, plus a crash-test suite (agentguard bench) and proof-of-life
canary. The plugin's hooks call the agentguard CLI
(npm i -g @shidesheng0218/agentguard); without it the hooks fail-open.
Plugin source: claude-plugin/ in the repo. License: MIT.
```
