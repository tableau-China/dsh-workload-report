# 社区发布文案 · dsh-workload-report 2.5.0（8 种界面语言）

> **内部文案库**：给发布/运营复制粘贴用，不是对外文档。
> 每条渠道都给「可直接粘贴的原文 + 字数自检 + 平台注意事项」。方括号 `[ ]` 是需要发布前确认/替换的项。
> 所有事实口径以根目录 `README.md`、`docs/metrics.md`、`docs/i18n.md` 为准；**文案里出现数字前先看第 1 节「事实口径」**。
> 配套材料：渠道与优先级见 [`docs/discoverability.md`](../discoverability.md)（关键词矩阵 / 90 天节奏 / 红线）；8 语言搜索落地页见 `docs/i18n/README.<lang>.md`；市场元数据见 `docs/i18n/marketplace.<lang>.json`。

---

## 0. 发布前检查（按顺序，全过再发帖）

1. **版本已上线**：npm 上 `dsh-workload-report@2.5.0` 已发布、GitHub 有对应 Release/tag；干净环境验证 `dsh plugin add dsh-workload-report` 能装上并出现入口（对应 discoverability.md 的 P0 第 1–3 项）。
2. **8 语言可验收**：`node test/e2e-i18n.mjs` 已跑通（截图产物在 `test/.artifacts/i18n-<lang>.png`）；词典 8 语言无英文占位残留（若译者还没交稿，先不要宣称「8 语言已就绪」，把文案里的 8 语言改成「中英双语」或推迟发布）。
3. **落地页可访问**：博客 <https://vizwise.cn/posts/dsh-workload-report>（UTM 落地页；打不开就先只用 GitHub 链接）；`docs/i18n/README.<lang>.md` 的 8 语言落地页已能打开。
4. **README 与截图是最新**：安装命令、语言表、版本号、截图和文章里写的一致；根目录只有 `README.md`（npm 首页正文用，见 discoverability.md §4.1），`assets/dashboard-calendar.png` 是当前界面。
5. **账号与身份**：用作者本人账号发；HN / Reddit 里明确「I built this / 作者自荐」，第一人称。
6. **真人口吻**：HN / Reddit 至少亲手改掉开头两句——这两个社区对「AI 味/营销味」很敏感。
7. **节奏**：每个渠道只发一次；同一天最多两个平台，别 5 个平台同时刷（完整节奏见 §8.1 与 discoverability.md §6）。

---

## 1. 事实口径（写任何渠道都不得偏离）

**项目**：DSH（DeepSeek Harness）插件 `dsh-workload-report`，MIT 开源。
GitHub：<https://github.com/tableau-China/dsh-workload-report> · npm：`dsh-workload-report` · 博客：<https://vizwise.cn/posts/dsh-workload-report>

**一句话**：把「我的付出」（活跃时长）和 Token 消耗按日期 / 工作区放进同一张图，并导出一份可直接发给客户的自包含 HTML 报告。

### 可以写的事实

- **双视角**：工作量（活跃时长 = 模型时间 + 工具时间，**剔除等待用户**；是累计引擎工作时间，并行会话/子代理会累加，不是墙上时钟）＋ Token（未缓存输入 + 输出 + 缓存读 + 缓存写）。
- **拆解维度**：按日期 / 工作区 / 模型 / 会话；归属日期 = 会话在所选区时区的创建日。
- **看板**：9 项 KPI；日历热力图（周一到周日 × Year-Week，固定展示全部历史）；时刻分析（柱=Token 产出或轮次，点=人类消息密度）；工作区占比（时长 / Token 可切）；模型页签（矩形图、按日趋势、速度 tok/s、TTFT、缓存命中、估算费用）；主要会话与按日期明细（分页）。
- **HTML 报告**：单文件、内联 CSS + 内联 SVG、**无脚本、无外部资源**；明暗两套主题；标题 / 备注可自定义；`anonymize=1` 隐藏工作区名与会话标题；顶部区间筛选是静态高亮（纯视觉、无链接）；**不含 AI 画像**。
- **AI 用户画像**：默认包含、**必须手动点击才调用模型**（打开面板只 probe）；只发送**严格白名单的聚合数字**（56 个字段，至少 30 天窗口），不含对话正文 / 标题 / 路径 / 会话 id / 事件日志；结论必须引用数字；失败自动回落到确定性的本地规则版；结果不进 HTML 报告、也不计入本报告的 Token / 费用统计。
- **多设备同步**：腾讯云 COS / GitHub / Gitea / 共享目录四种后端；**默认关闭**；只同步逐会话聚合行（时间 / 时长 / Token / 模型），不含对话内容、提示词、附件；载荷含绝对 `cwd`，建议用私有桶/私有仓库，或配置 `redactPaths`。
- **8 种界面语言**：English / 中文（简体）/ 日本語 / Español / Français / Deutsch / Русский / Português (Brasil)，跟随 DSH 界面语言实时切换；看板、HTML 报告（`?lang=`）、AI 画像、同步弹窗与服务端错误都本地化。
- **隐私与实现**：只用 DSH 官方接口（投影 / 查询），**不解析 `*.jsonl.zstd`**；默认零外发、无遥测；只注册只读 HTTP 路由；只写自己的索引与画像缓存（可删、可重建）。可选余额 chip 默认关闭（开启后由宿主调官方接口）；AI 画像仅手动触发。
- **质量**：1,738 项离线断言（`node test/verify.mjs`，CI 里跑）＋ 真实浏览器的 8 语言端到端脚本（`test/e2e-i18n.mjs`，打开面板与报告并断言文案来自词典）；i18n 词典一致性检查（键集 / 占位符 / 死键 / 写死文案）。
- **兼容**：DSH 0.2.x（含 alpha 预发布）；Node ≥ 22；从 GitHub/npm 安装无需本地构建（`lib/client.js` 已提交）。

> **中文文案里的真实示例数字**：「46% 投入 / 30 天里 18 天在场 / 3.7 B Token」来自作者本人博客（`docs/blog.md`，2026-10-11 的真实数据，用于「给客户做月报」场景）。发布前确认作者仍愿意公开这几个数字；不愿意就删掉示例句（掘金正文、知乎第 3 点各一处），不影响其它文案。

### 不要写（红线）

- ❌ 排名 / 「第一」/「唯一」/「最强」/「彻底解决」；竞品贬低。
- ❌ 未经验证的数字：用户数、star 数、下载量、性能对比、准确率。
- ❌ 把估算费用说成「账单 / 发票」；把 AI 画像说成「客观评估」。
- ❌ 「支持所有 AI 工具」（只支持 DSH）、「8 国语言」（是 8 种界面语言）、「无需任何配置」（同步 / 画像都有开关）。
- ❌ 「本地」「隐私」可以说，但要带上前提：默认零外发；AI 画像手动点击会调用模型；同步开启后会把聚合行发到你选的存储。

---

## 2. Show HN

### 标题（二选一；均 ≤80 字符）

- `Show HN: Workload Report – effort and token spend for DeepSeek Harness` —— **70 字符**
- `Show HN: See effort and token spend for DeepSeek Harness, by date and workspace` —— **79 字符**

> 使用说明：保留 `Show HN:` 前缀；不要加感叹号 / emoji；正文里再说明「open source / MIT」。标题里的 `–` 用短横线即可。

### 正文（英文，四段 + 安装块，可整段粘贴）

```text
DeepSeek Harness (DSH) shows statistics for the current session only. I kept hitting two questions: which dates and projects my time actually went to, and what it cost. My sessions are scattered across months, so answering either meant opening several tabs and doing arithmetic.

So I built dsh-workload-report, a local plugin that puts two views on the same picture: effort — active time = model time + tool time, with time spent waiting for me excluded — and token spend (uncached input, output, cache read, cache write). It breaks down by date, workspace, model and session, with a calendar heatmap, a time-of-day chart, workspace share, and model speed (tok/s), TTFT and estimated cost from official public prices.

The part I use most is the export: one self-contained HTML file (inline CSS and SVG, no scripts, no external assets) with light/dark themes and an anonymize=1 option that hides workspace names and session titles. That is what I send when a client asks where the month went. There is also an optional AI profile (included, but it only runs when you click Generate; it sends a strict whitelist of aggregate numbers — never conversations, titles or paths — and falls back to deterministic local rules) and optional multi-device sync (Tencent COS / GitHub / Gitea / a shared folder, off by default, per-session aggregate rows only). The whole UI follows the DSH language: English, Chinese, Japanese, Spanish, French, German, Russian and Brazilian Portuguese.

It uses only official DSH interfaces (no JSONL/zstd parsing), makes zero outbound requests by default, and is MIT licensed. 1,738 offline assertions run in CI, and there is a real-browser E2E script that opens the dashboard and the report in all 8 languages. Limits: costs are estimates, never invoices; very early v0-format sessions may be unreadable and are excluded and counted; the first index build cold-reads history (~2 minutes for 300+ sessions on my machine). Requires DSH 0.2.x and Node 22+.

Install:
dsh plugin add dsh-workload-report
# or straight from GitHub:
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main

Code: https://github.com/tableau-China/dsh-workload-report
Screenshot: https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png
```

> 字数：正文约 350 词（HN 无硬上限，但越短越好；如果能压到 250 词以内更好）。

### HN 不要做的事

- **不要要求 upvote**，不要发「欢迎投票 / 求支持」，不要找朋友多账号投票——HN 会识别并可能直接沉帖。
- 不要「删帖重发」；同一 URL 不要一周内重复提交（真的被 flag 且无评论，至少隔一天再考虑）。
- 不要发纯 landing page / npm 页面；必须是能被使用的东西（GitHub 仓库最稳）。
- 不要用营销腔 / AI 生成腔；作者要留在评论区回答实现细节（口径、隐私、为什么不用 xx）。
- 不要标题党（「I built X and it changed everything」这类会被反感）。
- 发布后 24 小时守评论区；HN 上一条认真回复比十个 upvote 值钱。

---

## 3. Reddit

### 3.1 r/LocalLLaMA

**标题（英文，≤300 字符）**

- `I built a local-first workload + token report for DeepSeek Harness (open source)` —— **80 字符**

**正文（英文，可直接粘贴）**

```text
I run DeepSeek Harness locally for coding work. It shows stats for the current session, but after a few months I couldn't answer two questions I actually care about: which dates and workspaces my time went to, and what the token spend was for each. So I built an open-source plugin for it.

What it does, briefly:
- Two views on the same picture: effort (active time = model time + tool time, time waiting for me excluded) and token spend (uncached input, output, cache read, cache write).
- Breakdown by date / workspace / model / session: calendar heatmap, time-of-day chart, workspace share, model speed (tok/s), TTFT, estimated cost from official public prices.
- One-click self-contained HTML report (inline CSS/SVG, no scripts, no external assets). Light/dark themes, and anonymize=1 hides workspace names and session titles — that's what I send to clients.
- Optional AI profile: included but only runs when you click Generate; it sends a strict whitelist of aggregate numbers (never conversations, titles or paths), always at least a 30-day window, and falls back to deterministic local rules. It is not included in the exported report.
- Optional multi-device sync (Tencent COS / GitHub / Gitea / shared folder), off by default, aggregate rows only.

Privacy / limits: only official DSH interfaces, no JSONL or zstd parsing, zero outbound requests by default. Costs are estimates (models without an official price show "-"), very old v0-format sessions may be unreadable and are excluded and counted, and the first index build cold-reads history.

One thing I'd genuinely like feedback on: is "active time = model + tool time − waiting for user" the right way to count effort? Concurrent sessions and subagents add up by design (cumulative engine work, not wall clock). Happy to change the convention if there's a better one.

Screenshot: https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png
Install: dsh plugin add dsh-workload-report
Repo: https://github.com/tableau-China/dsh-workload-report (MIT, DSH 0.2.x, Node 22+)
```

> 字数：正文约 300 词。

**r/LocalLLaMA 规则提醒**

- 该版对自我推广很敏感：发之前先在版里正常参与几天讨论；帖子定位是「分享 + 求反馈」，不是广告。
- 遵守版规里的 self-promotion 条款（通常要求非推广内容占多数、不要多账号、不要私信拉人）；发布前重新看一眼 sidebar / wiki 的最新规则与 flair 要求。
- 标题不要全大写、不要 emoji、不要 "best/fastest"；正文别只贴链接。
- 强调与本地模型社区的相关性：数据全本地、DSH 本地运行、聚合统计不出机器（除非你主动开同步/画像）；避免谈「云端服务」。
- 不要贴带 UTM 的链接（多数版规不欢迎、也会降低可信度）；用 GitHub 原链。

### 3.2 r/DeepSeek

**标题（英文 ≤300 字符）**

- `Open-source dashboard for DeepSeek Harness: effort + tokens, client-ready HTML report, 8 languages` —— **98 字符**

**正文（英文，可粘贴）**

```text
DSH only shows statistics for the current session, which makes "where did my month go" and "what did this project cost" hard to answer. I built dsh-workload-report, an open-source plugin that adds the cross-session view:

- Active time (model + tool time, waiting for you excluded) and tokens (input / output / cache read / cache write) side by side.
- By date / workspace / model / session: calendar heatmap, time-of-day analysis, workspace share, model tok/s, TTFT and estimated cost.
- A self-contained HTML report (no scripts, no external assets) you can send straight to a client; anonymize=1 hides workspace names and titles.
- Optional AI profile (manual trigger, aggregate stats only) and optional multi-device sync (COS / GitHub / Gitea / shared folder), both off until you turn them on.
- UI follows the DSH interface language: EN / 中文 / 日本語 / ES / FR / DE / RU / PT-BR.

Official DSH interfaces only, zero outbound requests by default, MIT. 1,738 offline assertions in CI plus a real-browser E2E that opens the dashboard and report in all 8 languages.

Screenshot: https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png
Install: dsh plugin add dsh-workload-report
Repo: https://github.com/tableau-China/dsh-workload-report
```

**正文（中文变体，可替代英文发；r/DeepSeek 允许中文）**

```text
DSH 只显示当前会话的统计，跨项目、跨月份「时间花在哪、这个项目花了多少」就很难答。我写了个开源插件 dsh-workload-report，补上跨会话视角：

- 活跃时长（模型时间 + 工具时间，剔除等待用户）和 Token（输入 / 输出 / 缓存读 / 缓存写）双视角并排；
- 按日期 / 工作区 / 模型 / 会话拆解：日历热力图、时刻分析、工作区占比、模型 tok/s、TTFT、估算费用；
- 一键导出自包含 HTML 报告（无脚本、无外部资源），可直接发客户；anonymize=1 隐藏工作区名和会话标题；
- 可选 AI 用户画像（手动触发、只发聚合统计）与多设备同步（COS / GitHub / Gitea / 共享目录），默认都关；
- 界面跟随 DSH 语言：中 / 英 / 日 / 西 / 法 / 德 / 俄 / 巴葡。

只读 DSH 官方接口，默认零外发，MIT。CI 里跑 1,738 项离线断言；另有真实浏览器 8 语言 E2E 脚本。

截图：https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png
安装：dsh plugin add dsh-workload-report
仓库：https://github.com/tableau-China/dsh-workload-report
```

**Reddit 通用注意**

- 两个版不要同一天发、不要复制同一段正文：先 r/LocalLLaMA，隔 2–3 天再 r/DeepSeek，并改写开头。
- 不要在同一天把同一链接 crosspost 到多个版；版规一般允许 crosspost，但观感像刷屏。
- 回复评论比发帖重要：对「为什么不直接用 xx」「这算不算 self-promo」要诚实回答，承认限制。
- 不要在正文里要求 upvote / 求 star；不要用短链。

---

## 4. X / Twitter thread

> 发布方式：3 条串（thread），第一条不放链接（避免限流），第三条放 GitHub。发完自己引用一条补充博客链接。建议配图：`assets/dashboard-calendar.png` + 报告截图（4 图模式）。

**第 1 条（244 字符 / ≤280）**

```text
Your coding agent shows the current session. Your bill shows tokens. Nothing shows the work in between.

So I built a local DSH plugin that puts effort and token spend on one picture — by date, workspace and hour. Open source, 8 UI languages. 🧵
```

**第 2 条（271 字符 / ≤280）**

```text
What it shows:
• active time (model + tool time, waiting for you excluded)
• tokens (input / output / cache read / cache write)
• calendar heatmap, time-of-day, workspace share
• model speed + TTFT + estimated cost
• a self-contained HTML report you can email to a client
```

**第 3 条（249 字符 / ≤280）**

```text
Install: `dsh plugin add dsh-workload-report`
Optional: multi-device sync (COS / GitHub / Gitea / shared folder, off by default), AI profile (manual trigger, aggregates only).

Code + screenshots: https://github.com/tableau-China/dsh-workload-report
```

**X 注意**

- 字数按「原始字符数」统计（URL 在 X 里会被算成 23 字符，所以实际计数只会更小；三条都留了余量）。emoji 按字符计，`🧵` 已计入。
- 第一条不要放链接；不要把三条合并成一条长推。
- 不要在推文里写「please RT / 求转发」；不要 @ 大 V 求曝光。
- 发布后把第一条置顶一两天；对评论里的技术问题用引用推回复。

---

## 5. dev.to / Medium（长文）

### 标题（英文，二选一）

- `Your coding agent only shows the current session — so I built a workload report for DeepSeek Harness`
- `Effort vs. tokens: a cross-session workload report for DeepSeek Harness`

Medium 可用：`Where did the AI-assisted month actually go? Building a workload report for DeepSeek Harness`

### 5 段式大纲（每段 1–2 句要点）

1. **The gap（问题）**：DSH 只给当前会话统计；真正被问到的是「这个月时间花在哪些日期/项目、花了多少 Token」——数据散在几百个会话里，看板和账单都回答不了。
2. **Definitions first（口径先行）**：先定义活跃时长（模型 + 工具，剔除等待用户）、Token 四段构成、区间规则（终点今天、起点取窗口与首个活跃日的较大值）、费用为公开价估算——口径统一是可信的前提。
3. **A tour（看板导览）**：日历热力图 / 时刻分析 / 工作区占比 / 模型页签各回答什么问题，各配一张截图；强调「付出和 Token 在同一张图上」。
4. **The report you can send（报告）**：单文件、内联 CSS/SVG、无脚本外链、明暗主题、`anonymize=1`；静态区间筛选只做视觉高亮；为什么不把 AI 画像放进报告。
5. **Privacy, sync, languages（隐私/同步/多语言）**：只读官方接口、默认零外发、画像手动触发只发聚合、同步默认关闭；8 种界面语言；安装命令、MIT、限制（估算费用、旧会话、首次建索引耗时）。

### 发布注意

- dev.to 发布时设置 **canonical_url = 博客原文**（`https://vizwise.cn/posts/dsh-workload-report`），避免和博客重复内容互相稀释；Medium 用 import 或同样标注 canonical。
- 文章标签建议：`dsh`, `deepseek`, `productivity`, `opensource`, `tooling`（dev.to 最多 4 个，按平台限制选）。
- 配图用仓库里的 dashboard / report 截图；开头不要放 GitHub 链接（结尾放）。
- 结尾 CTA 克制：欢迎反馈 / issue，不要「求 star / 求赞」。

---

## 6. 中文社区

### 6.1 掘金

**标题（50 字符）**

- `我给 DeepSeek Harness 写了个「工作量报告」：把付出和 Token 消耗放进同一张图`

**摘要（146 字符，发布时填到摘要框）**

- `DSH 只显示当前会话的统计，跨项目、跨月份的「我到底在忙什么、花了多少」没有答案。这个开源插件把活跃时长（模型+工具时间，剔除等待用户）和 Token 消耗按日期 / 工作区 / 模型 / 会话摊开，并能导出一份可匿名化的自包含 HTML 报告。2.5.0 起跟随 DSH 8 种界面语言。`

**正文开头（可直接粘贴）**

```text
用 AI 写代码的第 N 个月，我最怕两个问题：「你最近在忙什么？」和「这东西到底花了多少？」

不是没数据，而是数据散在几百个会话里：Harness 只给我看当前这一个会话的统计行。于是我把 DSH 的会话数据用官方接口聚合起来，写了个开源插件 dsh-workload-report。

它做两件事：把**工作量**和 **Token 消耗**放进同一张图。

工作量看「活跃时长」——模型时间 + 工具时间，剔除等待用户的时间。这个口径是我最在意的：等我去复制粘贴的时间，不该算作引擎的工作。Token 则是未缓存输入 + 输出 + 缓存读 + 缓存写四段，四个分项在详情里都能核对。按日期 / 工作区 / 模型 / 会话四个维度摊开：日历热力图看哪几天在真的干活、时刻分析看一天里什么时候状态最好、工作区占比回答「时间花在哪个项目」。

对我最有用的是导出：一键生成一份自包含 HTML 报告（内联 CSS 与 SVG，无脚本、无外链），给客户时加 anonymize=1，工作区名和会话标题会匿名化——「最近很忙」终于能换成具体数字。

举个例子：给一个长期项目做月报时，我可以直接写「这个项目占了我 46% 的投入、30 天里有 18 天在场、消耗了 3.7 B Token」——三个数来自同一份报告，不用再一个个翻会话。

2.5.0 起看板、报告、AI 画像和同步弹窗全部跟随 DSH 的 8 种界面语言（中 / 英 / 日 / 西 / 法 / 德 / 俄 / 巴葡），语言切换实时生效。
```

> 掘金注意：开头别放外链（容易被限流）；文末再放 GitHub / npm / 博客链接；标签选「AI」「效率工具」「开源」；标题别用「神器」「封神」这类词。博客原文可以附在文末作为「原文链接」，避免被判重复内容。

### 6.2 V2EX

**标题（40 字符）**

- `[分享] 给 DSH 写了个开源工作量报告插件：活跃时长 + Token 双视角`

**正文（可直接粘贴；建议发在「分享创造」节点）**

```text
作者自荐。DSH 只给当前会话的统计，跨项目、跨月看不到「我到底在忙什么、花了多少」。我写了 dsh-workload-report：活跃时长（模型时间 + 工具时间 − 等待用户）与 Token 消耗（未缓存输入 / 输出 / 缓存读 / 缓存写）双视角，按日期 / 工作区 / 模型 / 会话拆；日历热力图、时刻分析、工作区占比、模型 tok/s 与估算费用；能导出自包含 HTML 报告（无脚本无外链，anonymize=1 可匿名化）。

实现上只读 DSH 官方投影 / 查询接口，不解析 jsonl，默认零外发；多设备同步可选（COS / GitHub / Gitea / 共享目录，默认关闭）；2.5.0 跟随 DSH 8 种界面语言。

限制也直说：早期 v0 格式会话可能读不到（界面会提示数量）；费用按官方公开价估算，没价只显示「—」；历史首次建索引要冷读，300+ 会话约 2 分钟。

安装：dsh plugin add dsh-workload-report
仓库：https://github.com/tableau-China/dsh-workload-report

欢迎拍砖，尤其是口径（活跃时长剔除等待、按会话创建日归属）这部分。
```

> V2EX 注意：技术社区口吻，别写推广腔；标题别带「求 star」；正文给出实现取舍和限制更容易有讨论；一个节点发一次就够，不要多版重复。

### 6.3 知乎

**问题式标题（39 字符）**

- `如何统计自己用 AI 编程的真实工作量（时长 / Token / 项目投入）？`

**回答骨架（按 5 点组织，开头可直接用）**

```text
先给结论：不要只看 Token，也不要只看「感觉」。我用自己写的开源插件把两件事放在一起看——活跃时长（模型 + 工具时间，剔除等待用户）和 Token 消耗，按日期 / 工作区 / 模型 / 会话拆开。下面按「口径 → 看什么 → 给谁看 → 隐私 → 限制」说。

1. 口径先定清楚：活跃时长 = 模型时间 + 工具时间 − 等待用户；Token = 未缓存输入 + 输出 + 缓存读 + 缓存写；区间终点是今天、起点取「窗口起点」与「首个活跃日」的较大值。口径统一，数字才能跨天、跨项目比较。
2. 看板回答什么：日历热力图（哪几天在真的干活）、时刻分析（一天里什么时候状态最好）、工作区占比（时间花在哪个项目）、模型页签（哪个模型吃 Token、tok/s、估算费用）。
3. 给客户 / 月度复盘：一键导出自包含 HTML 报告（无脚本、无外链、可明暗主题），anonymize=1 匿名化工作区名和会话标题；报告口径与看板一致，可以打印成 PDF。比如月报里能直接写「这个项目占 46% 的投入、30 天里 18 天在场、3.7 B Token」——三个数字来自同一份报告。
4. 数据与隐私：只读 DSH 官方接口，不解析日志；默认零外发；AI 画像默认包含但必须手动点击，只发聚合数字，失败回落本地规则；多设备同步默认关闭。
5. 限制：费用是估算不是账单；极早期 v0 会话可能读不到（会提示数量）；首次建索引要冷读历史会话。开源 MIT，DSH 0.2.x + Node 22+。
```

> 知乎注意：以「经验分享」口吻回答，先讲问题再讲工具，链接放文末自然带出；不要放二维码 / 私信引流；避免「效率神器」类表述。

### 6.4 小红书

**标题（18 字符，≤20）**

- `用 AI 写代码，终于看清时间花哪了`

**短文案（178 字符，可粘贴）**

```text
用 AI 写代码久了，有个问题一直答不上来：最近到底在忙什么、时间花哪了？

把 DSH 的会话统计摊开算了一遍，做了个开源插件：活跃时长（模型+工具时间，剔除等人）+ Token 消耗，按日期 / 工作区 / 模型 / 会话看；能导出一份不用装软件、直接发客户的自包含 HTML 报告；8 种界面语言。

只看官方接口，默认不联网。全开源，装完重启即用。
```

**标签（选 6–8 个）**：`#AI编程` `#效率工具` `#开源` `#DeepSeek` `#程序员日常` `#时间管理` `#数据可视化`

**配图建议**：3–4 张竖版 / 方版：①看板首页截图（日历热力图）②按工作区截图 ③导出的 HTML 报告（深色主题）④安装命令小图。统一加克制标题字（不要大字报）。

> 小红书注意：正文不能放可点击外链，别硬塞 GitHub 地址（放主页/评论区引导）；emoji 控制在 1–2 个；避免「神器」「封神」「99% 的人不知道」这类词；数据只写我们验证过的。

### 6.5 少数派

**标题（36 字符）**

- `把 AI 编程的付出和 Token 消耗放进同一张图：DSH 工作量报告`

**投稿摘要（132 字符）**

- `DSH 只显示当前会话的统计；这份开源插件补上了跨会话、跨项目、跨时间的视角：活跃时长（模型+工具，剔除等待）与 Token 消耗双视角，按日期 / 工作区 / 模型 / 会话拆解，能导出可直接发给客户的自包含 HTML 报告，并跟随 DSH 的 8 种界面语言。`

> 少数派注意：走 Matrix / 效率栏目投稿；附 3–4 张截图与仓库链接；说明是原创首发 + 作者身份；审稿周期较长（数天），提前投。不要一稿多投到同平台其它栏目。

---

## 7. 一句话定位 & 可复用卖点短语

### 一句话定位

- 中文（39 字符 / ≤60）：`把「我的付出」和 Token 消耗按日期、工作区放进同一张图的 DSH 插件。`
- English（54 字符 / ≤60）：`DSH plugin: see effort and token spend on one picture.`

### 10 条可复用卖点短语（中英对照）

| # | 中文 | English |
| --- | --- | --- |
| 1 | 双视角：活跃时长 + Token 消耗 | Two views: active time and token spend |
| 2 | 按日期 / 工作区 / 模型 / 会话拆解 | By date, workspace, model and session |
| 3 | 日历热力图 + 时刻分析 | Calendar heatmap and time-of-day analysis |
| 4 | 9 项 KPI，口径全站统一 | Nine KPIs with one shared definition |
| 5 | 自包含 HTML 报告，可直接发客户 | A self-contained HTML report for clients |
| 6 | `anonymize=1` 隐藏工作区名与会话标题 | `anonymize=1` hides workspace names and titles |
| 7 | AI 画像：默认包含、手动触发、只发聚合统计 | AI profile: included, manual, aggregates only |
| 8 | 多设备同步：COS / GitHub / Gitea / 共享目录，默认关闭 | Multi-device sync: COS, GitHub, Gitea, shared folder — off by default |
| 9 | 8 种界面语言，跟随 DSH 实时切换 | Eight UI languages, following DSH live |
| 10 | 只用官方接口，默认零外发 | Official interfaces only, zero outbound by default |

> 备用短语：`工作量，不只是账单`（Effort, not just a bill）；`估算费用，不是发票`（Estimated cost, never an invoice）；`一条命令安装`（One command to install）。

---

## 8. 发布节奏、链接与 UTM、禁止事项

### 8.1 建议节奏（7 天）

| 时间 | 渠道 | 备注 |
| --- | --- | --- |
| Day 0 | npm + GitHub Release + 博客 | 先验证干净环境安装；博客作为 UTM 落地页 |
| Day 1 | Show HN | 周二/周三发布；按 discoverability.md 的「UTC 上午」窗口，实操按**美东工作日早间 8:00–11:00**（≈北京 20:00–23:00 夏令时，冬令时顺延 1 小时）落点最好——HN 前几小时靠北美早间流量与作者回复。发布后 24h 守评论 |
| Day 1 | X thread | HN 发出后 1–2 小时；第一条不放链接 |
| Day 2 | r/LocalLLaMA | 美东工作日 9–12 点（夏令时 ≈ 北京 21:00–24:00，冬令时 22:00–次日 01:00）；先参与过讨论再发 |
| Day 3 | dev.to（canonical 到博客） | 可同时走 Medium（import） |
| Day 4 | r/DeepSeek + 掘金 | 两个渠道的标题/正文要改写，不要复制 |
| Day 5 | V2EX | 「分享创造」节点 |
| Day 6 | 知乎 + 小红书 | 小红书晚上 19:00–22:00 流量更好；正文不放链接 |
| Day 7 | 少数派投稿 | 审稿周期长，建议更早投 |

### 8.2 链接与 UTM 建议

- **落地页优先用博客**（有统计）：`https://vizwise.cn/posts/dsh-workload-report`
  统一 campaign：`utm_campaign=i18n-launch`（或 `v2.5.0-launch`）。
- 各渠道 `utm_source` 建议：`hn`、`reddit_localllama`、`reddit_deepseek`、`x`、`devto`、`medium`、`juejin`、`v2ex`、`zhihu`、`xiaohongshu`、`sspai`。
  示例：`https://vizwise.cn/posts/dsh-workload-report?utm_source=juejin&utm_medium=social&utm_campaign=i18n-launch`
- **HN / Reddit 不放 UTM**（社区反感、易被当推广）；直接放 GitHub 原链。
- **GitHub 与 npm 不提供 UTM 统计**：归因看 GitHub → Insights → Traffic（referrers / popular content）、npm 的周下载量、博客后台来源；每条帖子发布后记录「渠道 / 链接 / 首日数据」，第二天对比。
- 小红书正文不可放可点击外链；知乎 / 掘金外链过多可能限流；V2EX 可放 GitHub 原链。

### 8.3 禁止事项（红线，发帖前逐条过）

- ❌ 刷 star / 下载 / 多账号投票 / 互赞；任何形式「求 upvote / 求 star / 求转发」。
- ❌ 同一内容同一天多平台复制粘贴；同一平台重复发帖；跨版刷屏。
- ❌ 夸大：排名、「第一」「唯一」「最强」「彻底解决」；编造用户数 / 性能 / 对比数据；贬低其它工具。
- ❌ 把估算费用说成账单 / 发票；把 AI 画像说成「客观评估」；把 8 种界面语言说成「8 个国家」。
- ❌ 未经许可使用他人截图 / 数据；泄露自己的 API key、私有仓库、客户项目名或真实会话标题。
- ❌ 在 HN / Reddit 用明显 AI 生成腔的营销长文（会被识别为推广并 flag）。
- ❌ 发布前没确认 npm / GitHub 安装可用（会浪费一波流量，且评论区会翻车）。

### 8.4 发布后 48 小时

- **守评论**：HN / Reddit 24 小时内回复；中文社区 48 小时内。
- **把高频问题回填文档**：口径类问题 → README FAQ；安装类 → README 排错段；当天提 issue 的给 label 并公开回复。
- **记录数据**：渠道 / 标题 / 链接 / 首日 UV·star·下载 / 评论主题；按效果决定第二批（可评估：日 / 德 / 俄语社区、Mastodon、LinkedIn、Product Hunt、GitHub Discussions）。
- **不删差评、不硬刚**：对比类问题统一回答「定位不同 + 承认限制 + 欢迎提 issue」。

---

## 9. 字数自检表（发布前复制原句核对）

| 内容 | 当前字符数 | 平台限制 | 结论 |
| --- | --- | --- | --- |
| Show HN 标题 A | 70 | ≤80 | ✅ |
| Show HN 标题 B | 79 | ≤80 | ✅ |
| r/LocalLLaMA 标题 | 80 | ≤300 | ✅ |
| r/DeepSeek 标题 | 98 | ≤300 | ✅ |
| X 第 1 条 | 244 | ≤280 | ✅ |
| X 第 2 条 | 271 | ≤280 | ✅ |
| X 第 3 条 | 249 | ≤280 | ✅ |
| 一句话定位（中） | 39 | ≤60 | ✅ |
| 一句话定位（英） | 54 | ≤60 | ✅ |
| 掘金标题 | 50 | 无硬上限，建议 ≤60 | ✅ |
| 掘金摘要 | 146 | 无硬上限 | ✅ |
| V2EX 标题 | 40 | 无硬上限，建议 ≤60 | ✅ |
| 知乎问题标题 | 39 | 建议 ≤50 | ✅ |
| 小红书标题 | 18 | ≤20 | ✅ |
| 小红书正文 | 178 | ≤1000 | ✅ |
| 少数派标题 | 36 | 无硬上限 | ✅ |
| 少数派投稿摘要 | 132 | 无硬上限 | ✅ |

> 计数口径：按 Unicode 字符数（`Array.from(text).length`），中英混排、emoji 都按 1 个字符计；X 官方展示的计数会把 URL 折算为 23 字符，所以上面的 3 条推文实际只会更短。
