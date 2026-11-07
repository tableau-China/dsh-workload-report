# 博客文章（英文版草稿，可直接发布到 vizwise.cn/en 或 dev.to）

> 用途：给搜索引擎/社区提供长文入口，覆盖「DeepSeek Harness token usage / AI coding workload / client report」等长尾词。
> 发布时：加 canonical + 与中文原文互相 `hreflang`；文内链接回 GitHub / npm；标题二选一。
> 作者署名与发布时间按实际填。配图：`assets/dashboard-calendar.png`、`assets/report-light.png`。

---

## 标题（二选一）

1. **How I finally answered "what did you actually do with AI?" — a workload report for DeepSeek Harness**
2. **Tracking AI coding workload, not just token spend: a DeepSeek Harness plugin with a client-ready report**

**Meta description（≤155 chars）**
A DeepSeek Harness plugin that shows active time and token usage by date and workspace — plus a self-contained HTML report you can send to a client. 8 languages, local-first.

---

## Intro

Every month I hit the same two questions: *"What have you been working on?"* and *"How much did all this AI cost?"*

The first one I answered vaguely. The second one I had no real number for — not because the data doesn't exist, but because it's scattered across hundreds of sessions. DeepSeek Harness (DSH) shows a stats line for the **current** session; it doesn't give you the cross-session, cross-project, cross-month picture.

So I built **dsh-workload-report**: a DSH plugin that puts **effort** and **token spend** on the same screen, by date, by workspace, by model — and can export a **self-contained HTML report** you can hand to a client.

It's open source (MIT), published on npm, and local-first: no account, no telemetry, read-only local API.

## Token dashboards answer "how much". This answers "where did it go?"

Most AI-usage tools stop at tokens and cost. That's useful, but it's only half the story — especially if you're freelancing or running a small team. The question you actually need to answer is: **which project consumed the effort, and can I prove it?**

So the dashboard tracks both axes:

- **Active time** — model time + tool execution time, with *waiting for the user* excluded (a tool call that sits there waiting for your answer isn't work). This is cumulative engine work, not wall-clock time.
- **Tokens** — uncached input + output + cache read + cache write, matching the official numbers.

Both are broken down by **date**, **workspace**, **model** and **session**. You get a GitHub-style **calendar heatmap**, **time-of-day analysis** (when are you actually productive?), a **workspace share** donut, and a **model usage** tab with speed (tok/s), TTFT, provider, cache-hit rate and estimated cost.

That's the difference between saying *"I was busy"* and saying *"this project took 46% of my effort, I was active 18 of the last 30 days, and it consumed 3.7 B tokens."*

## The report is the feature I use most

**Export HTML report** produces one file: inline CSS, inline SVG, no scripts, no external assets. It opens anywhere, prints cleanly, and looks the same as the dashboard.

- Nine KPIs, calendar heatmap, model token share, time-of-day chart, workspace share, daily detail and workspace tables.
- The **metric definitions are in the footer**, so whoever receives the report can check the numbers instead of trusting them.
- `anonymize=1` hides workspace names and session titles; `title` and `note` let you brand it.
- Only official pricing pages are linked — no scripts, no tracking.

I use it for monthly reviews and client updates. It also solved the "how do I explain AI cost" conversation: the report shows effort and consumption side by side.

## Optional: an AI profile, and multi-device sync

Two features are included but off/manual by design:

- **AI user profile** — click *Generate* and the model writes a short profile (headline, 4–6 numeric dimensions, 2–3 advice items, risk) from **aggregate statistics only**. The whitelist is strict: no conversation text, no titles, no paths. If the model is unavailable, a deterministic local-rules version is used instead. Opening the panel never calls a model.
- **Multi-device sync** — if you use a laptop and a desktop, the optional sync merges per-session aggregate rows through **Tencent COS, GitHub, Gitea or a shared folder** (iCloud / Syncthing / NAS). It's off by default and syncs numbers only — no content, titles or attachments.

## Eight interface languages

The whole UI follows the **DSH interface language**: English, Chinese, Japanese, Spanish, French, German, Russian and Brazilian Portuguese. The dashboard, the exported report, the AI profile and the sync dialogs all switch live when you change the DSH language — there's no separate plugin setting. (Translation parity is enforced by an automated check across all 8 dictionaries.)

## Privacy: local by default

The plugin registers **read-only** local HTTP routes and uses only official DSH interfaces. It writes only its own index/cache. The two network-capable features are the optional balance chip (off by default) and the AI profile (only after you click Generate, aggregate data only). The exported report is a local file.

## Install

```bash
# npm
dsh plugin add dsh-workload-report

# or from GitHub
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

In **DSH Desktop**: Settings → Plugins → search `dsh-workload-report`. Restart after installing; the entry appears at the bottom of the sidebar.

Requirements: DSH 0.2.x (verified on 0.2.1-alpha.2 and 0.2.2-rc.1), Node.js ≥ 22.

## Under the hood (short version)

- Session identity from `sessionQuery.listSessions()`; statistics from the official projections (`sessionProjections`, `sessionProjectionCache`), cold-reading only when needed. The plugin never parses `*.jsonl.zstd` or internal cache files — formats change, official seams don't.
- 1,738 offline assertions plus real-browser E2E across 8 languages, including a report-vs-dashboard parity check.
- The client bundle is committed, so installing from GitHub/npm needs no local build.

## Links

- GitHub: https://github.com/tableau-China/dsh-workload-report
- npm: https://www.npmjs.com/package/dsh-workload-report
- The Chinese original of this post: https://vizwise.cn/posts/dsh-workload-report
- Metric definitions: `docs/metrics.md` · Change log: `CHANGELOG.md`

---

## 中文原博客的「2.5.0 更新」追加段（贴到 vizwise.cn 原文末尾）

> **2026-11 更新**：插件已升级到 2.5.0，并做了三件和「被更多人看到」有关的事：
> ① 界面接入 DSH 内置的 **8 种语言**（中 / 英 / 日 / 西 / 法 / 德 / 俄 / 巴西葡），看板、导出报告、AI 画像、同步弹窗全部跟随 DSH 语言；
> ② 安装改为优先推荐 npm：`dsh plugin add dsh-workload-report`（桌面端可在「设置 → 插件」里搜索安装）；
> ③ 增加英文及其它语言的项目说明页，方便非中文用户搜索到它。
> 文中的「六张 KPI」已更新为 9 张（模型耗时占比、平均每次输出、输出速度等），完整功能见 README。
