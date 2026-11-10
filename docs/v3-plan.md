# V3 版本规划（草案 · 待确认）

> 日期：2026-11-10 ｜ 基线：v2.5.1 ｜ 状态：**调研完成，方向待用户确认**
> 调研范围：DSH 生态同类插件、AI 编码助手用量分析、LLM 可观测性/成本 FinOps、时间追踪与报告交付类产品。
> 本文只做规划，不改代码。所有「事实」均标注了出处；外部来源见 [§8 来源](#8-来源)。
>
> **更新（2026-11-10 晚）**：导出 HTML 报告链路已按本文「阶段 0」优先单独修复，版本提为 **2.5.2（待发布）** ——
> 入口恢复、报告对齐 9 KPI / 三列 bar / 8 语言、导出跟随设备筛选。下方 §2.2、阶段 0、§7 的相关条目已同步标注为已完成。
>
> **更新（2026-11-10 夜）**：8 张等宽 KPI + 跟随日期筛选的 sparkline + 日历标题总结条已在 **2.6.0（待发布）** 落地（详见 CHANGELOG）。
> 同轮**移除 HTML 报告功能**（路由 / 渲染器 / 导出按钮 / 词典键），后续改做单页 PNG 快照；本文 §3/§4 的「报告交付」相关条目已失效，仅作历史记录。

---

## 0. 结论先行

**V3 一句话定位：从「看得见的用量看板」升级为「可交付、可复盘的周期性工作凭证」。**

V2 已经把「跨会话统计」做扎实了（9 KPI、日历热力图、时段分析、模型 11 列明细、速度/TTFT、多设备同步、8 语言）。继续加图表是边际收益递减，而且 DSH 生态里这个品类已经很挤。V3 应该补的是**三个真实缺口**：

| 缺口 | 表现 | V3 对应 |
| --- | --- | --- |
| **交付链路断了** | 「导出 HTML 报告」按钮自 v2.1.0 起被隐藏，但 README / npm / 可发现性手册仍把它当首要卖点 | P0 修复 + 把导出升级为「报告工作台」 |
| **没有时间维度的比较** | 只有绝对值和区间筛选，没有「比上月多/少多少」 | P0 周期对比（本期 vs 上期） |
| **只有数据，没有结论** | 报告是一屏表格 + 图，客户/自己都要自己找重点 | P0 报告内「变化摘要 + 异常标记」；P2 叙事型复盘 |

三根支柱：**① Report（可交付）② Review（可复盘）③ Signals（可信的轻提示）**。

**明确不做**：团队/权限/SSO、云托管与公开分享链接、定时邮件推送、Slack/Webhook 告警、硬预算拦截、跨组织基准、AI/人工代码行归因、多宿主日志聚合、错误率/失败重试统计（官方事件无此字段）。

**P0 第一件事不是新功能，是修一致性**：导出入口恢复与报告对齐**已在 v2.5.2 单独完成**（见下方「更新」）；V3 阶段 0 剩余的是分发落地与剩余文档漂移清理。

> **⚠️ 前置条件（比 V3 更紧急）**：截至 2026-11-10，v2.5.0 / v2.5.1 仍标记「待发布」，远端 `main` 停在 v1.0.5，npm 最新为 2.4.1，0★，awesome-dsh-plugin PR 未提（`CHANGELOG.md:8`、`docs/discoverability.md:11-14`）。V3 的规划假设「V2 已对外可用」；若分发未落地，应先执行 `docs/discoverability.md` 的 P0 清单（推送 / npm 发布 / Release / PR，均需用户确认），否则 V3 功能做出来也传不到用户手里。见 [§5 阶段 0](#5-里程碑与节奏建议)。

---

## 1. 为什么 V3 不能只是「再加几张图」

### 1.1 品类已是红海

`docs/discoverability.md:51-53` 已经判断过：要**避开「token usage / 费用面板」红海**，主打差异化词「workload / effort report + 客户可直接看的 HTML 报告 + 8 语言 + 多设备」。DSH 生态内同赛道插件至少十几个（见 §3.1），功能高度重叠：热力图、按模型/日拆分、峰谷定价、缓存命中率、余额卡片几乎人人都有。

### 1.2 我们真正的护城河

| 护城河 | 依据 |
| --- | --- |
| **口径可信** | 只用官方接口、不解析存储格式、不编造数字、无官方价显示 `—`、净活跃与等待守恒（`docs/metrics.md`）；成本标「估算，非账单」 |
| **可交付给客户** | 8 语言、口径可解释；**分享快照（PNG）规划中** —— HTML 报告已在 2.6.0 移除 |
| **看板与报告同源** | 同一份 `present(aggregate(...))` 快照 + 结构断言，数字不会两处打架 |
| **本地优先 / 零外呼** | 只读路由、默认无外发、AI 画像手动触发且只传 56 个聚合字段 |
| **多设备 + 8 语言** | 现成的差异化，竞品多为单语言单机 |

**V3 应该加固这五条，而不是去补「别人也有的图」。**

### 1.3 用户反馈指向的不是新图表

从 PROGRESS / CHANGELOG 可查的历次用户反馈：打开慢与破碎感（v1.0.4）、3 小时等人被算成活跃导致虚高（`docs/metrics.md:53`）、5 处 UI 细节（v1.0.2）、报告卡片拥挤与「筛选器只要打印样式」（`PROGRESS.md:1150`）、两台机器路径模板不一致（v2.0.6）、模型名/费用显示不准（v2.5.1）、AI 画像「比较简单」（`PROGRESS.md:307`）、导出入口被隐藏（v2.1.0）。**几乎全是「口径、一致性、可信度、细节」，没有「再加一个维度」**。这支持 V3 少加图、多补交付与解释；AI 画像偏简单则指向 P2 的「可讲述」方向。

另有一个过程性教训：路径模板、画像卡位置/配色、KPI 数量、版本号位置、同步弹窗都经历过 3–5 轮反复调整（`CHANGELOG.md:466`、`PROGRESS.md:125`）。**V3 动 UI 之前应先定一份「交互冻结清单」**，避免把返工当迭代。

---

## 2. 现状基线（v2.5.1，已核实）

### 2.1 能力矩阵

| 组 | 已具备 |
| --- | --- |
| 数据维度 | 日期、工作区、模型、供应商、会话、轮次/步骤、Token 四类、净活跃/等待、24 小时桶、速度 tok/s、TTFT、缓存命中率、思考强度、设备 |
| 图表 | 9 KPI、日历热力图/柱状、时段分析（Token/轮次 + 人类消息密度点）、工作区环形、模型 treemap + 按日堆叠、三列 bar、表格比例条、Tableau 10 色板 |
| 筛选交互 | 7/30/90/全部统一区间、`from`/`to`、时区、scope（all/main/subagent）、设备筛选、模型页内点选筛选、排序/分页 |
| 导出 | `/export.json`、`/snapshot`（HTML 报告与 `/report.html` 已在 2.6.0 移除） |
| 智能化 | AI 用户画像（独立页签、手动触发、56 字段白名单、指纹缓存、失败回退本地规则），**不进静态报告** |
| 同步 | COS / GitHub / Gitea / local 四传输、设备身份、按设备筛选、拉取缓存持久化、自动频率、GUI 配置 + 凭据库 |
| 隐私/性能 | 零外呼默认、只读路由、打开面板 0 次 `readSession`、冷开 ~25ms、快照 SWR、四层官方取值 + 索引落盘 |
| i18n / 工程 | 8 语言单一词典源（366 键）+ 校验、离线断言、CI 产物一致性、多语言分发资产 |

### 2.2 已核实的缺口与遗留项（V3 的输入）

| 项 | 位置 | 说明 |
| --- | --- | --- |
| ~~导出入口被隐藏~~（**v2.5.2 已修复**） | `src/client/index.jsx:37` | 2.1.0–2.5.1 期间 `EXPORT_ENTRY_VISIBLE = false`（`CHANGELOG.md:450`）；现已置 `true`，并补上 `?machine=` 透传与报告内容对齐 |
| **文档承诺与实现不一致** | `README.md:3`、`README.md:84`、`README.md:304`、`package.json:4`、`docs/discoverability.md:52` | 仍把「one-click HTML report」当首要卖点 |
| **roadmap 过时** | `docs/roadmap.md:9,21` | 仍写「0.4.0 进行中」；「按模型筛选」暂缓理由「依赖模型维度落地」早已不成立（0.4.0 已上线） |
| 其它文档漂移 | `docs/models.md:4`、`docs/ui-conventions.md:26`、`docs/sync.md:320` | 分别仍写「多机同步暂缓」（2.0.0 已完成）、画像卡在「主要会话页右列」（实为独立顶层页签）、`sync.sources` 未实现项 |
| 周期对比 / PNG 导出 | `PROGRESS.md:1044` | 明确列为待办：「把『按工作区』做成季度/月度对比；把导出接入 PNG」 |
| 按模型筛选 / 模型 × 时间热力图 / 按机器维度 | `docs/models.md:137` | 0.4.1 计划项，全局按模型筛选一直未做 |
| 模型费用 KPI | `CHANGELOG.md:64` | 2.3.0 下线且**明确不恢复**（价目覆盖不足会失真）→ V3 不要把它捡回来 |
| 逐供应商速度 | `src/aggregate.js:795`、`docs/metrics.md:158` | 暂不提供 |
| 预聚合 | `docs/preaggregation.md:3-5,89` | 结论「当前不做」，触发条件：snapshot p95 > 200ms / 会话 > 5000 / buildMs > 10s |
| 遗留缺陷 | `PROGRESS.md:150`、`CHANGELOG.md:139` | 首页环形图上下居中基线 E2E 失败仍挂；服务端日志仍中文、旧缓存无 code 回落中文、俄语无复数规则 |
| 已知数据边界 | `docs/metrics.md:89-92`、`PROGRESS.md:1066` | 老 v0 会话 `readSession` 抛 `unsupported descriptor version 2`，排除并单独计数；`listEvents()` 无正文，只有 `readSession()` 有完整事件 |

### 2.3 铁律（V3 所有设计必须先过这一关）

1. **看板 UI 改动必须在同一提交补 `test/verify.mjs` 结构断言**（报告已移除，不再有 parity 同步义务）。
2. 报告**自包含**：内联 CSS/SVG、**0 个 `<script>`**、除官方计费页外**0 外链**。
3. 只用宿主官方接口；不解析 `*.jsonl.zstd`、不读内部投影缓存文件（`PROGRESS.md:812`）。
4. **不编造数字**：缺数据显 `—`、无官方价不估、不可读会话单列计数，守恒关系有回归断言。
5. 默认零外呼；任何联网能力必须显式开关且默认关闭。
6. 8 语言单一词典源，`npm run check:i18n` 全绿；新增键 8 语言同步；复用 `ChipGroup` / `CardHead` / `MetricBarCell` 与宿主主题 token（`docs/ui-conventions.md:3`）。
7. 打开面板不触发 `readSession`；索引换代（`INDEX_VERSION`）要付全量冷读代价（1–2 分钟），能不换就不换。
8. 对外推送 / 发布 / PR **先确认再执行**（`docs/discoverability.md:161`）。

### 2.4 数据层可行性（决定哪些功能能进 V3）

**官方接口**：`sessionQuery.listSessions` / `observeSession(id,{projectionMode:"all"})` / `readSession`、`sessionProjectionCache.cachedSnapshot`、`sessionProjections.snapshot`（`index.js:81`、`docs/metrics.md:7-16`）。投影键 `sessionStats / tokenUsage / title / sessionListMetadata`。

**现有原始字段**：投影 → `turns / steps / llmMs / toolMs / decodeMs / decodeTokens / ttftMs / ttftSteps`、四类 token、`lastPromptAt`、`title`；SessionHeader → `id / createdAt / cwd / origin / delegationDepth / updatedAt`；事件日志 → `assistant/message`（`source.{provider,model}`、`usage` 四类、`stream[]`、`time`）、`user/message`、`request/header.config.reasoningEffort`、`tool/call` + `tool/result`（`callId`）、`turn/start`、`step/start`、`turn/end`（`docs/models.md:10`、`src/models.js:283`）。

| 判断 | 内容 |
| --- | --- |
| **只需组合现有字段即可实现（无需新数据源、无需换索引）** | 按模型筛选、逐供应商速度、思考强度/成本效率、工具耗时排行、等待工具分布、**环比/周期对比**、会话时长分桶、多模型切换、客户/标签分组（配置层） |
| **官方数据里根本没有，不要写进路线图** | 代码产出 / commit / diff / 文件变更（`tool/result` 正文刻意不折、无结构化 diff）；prompt/对话正文/附件（隐私红线）；**失败重试次数与错误率 / Top 错误签名**（无 `error`/`finish` 状态字段，只有「其它 = 排队/重试/空转」残差估计，`docs/metrics.md:139`）；同一路由下换了哪把 key（日志只有 provider 路由 id）；**墙钟真实工时**（`activeMs` 是引擎累计、非墙钟，`docs/metrics.md:22`）；v0 会话与缺 usage/decode 的请求 |

> 这条直接否掉了「照搬 dsh-cap-profile 的错误率画像」和「照搬 Claude Code Analytics 的产出归因」。

---

## 3. 竞品：有哪些功能值得借鉴

### 3.1 DSH 生态内同类插件（最直接的可比对象）

来源：[awesome-dsh-plugin 列表](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)、npm / GitHub 项目页（2026-11-10 检索）。

| 插件 | 值得注意的功能 | 我们 | 可借鉴判断 |
| --- | --- | --- | --- |
| [dsh-all-usage](https://www.npmjs.com/package/dsh-all-usage) | 工作区 × 供应商 × 模型**组合筛选**、单条请求日志检查、**CSV 导出**、价格状态「未计价」、明确声明「本地统计 ≠ 供应商账单」、分片账本只重写脏分片 | 部分 | **高**：组合筛选 + CSV + 「口径声明」几乎零成本 |
| [dsh-work-report（Neural Ledger）](https://www.npmjs.com/package/dsh-work-report) | 线性回归**预测未来 7 天/月度估算/预算超支告警**、**一键日/周/月 Markdown 报告**（per-turn demand → outcome 叙事 + subagent 明细）、自动 insights（最烧 token 的会话等） | 无 | **高**：周/月报与叙事；预测需谨慎（§3.3） |
| [dsh-cap-profile](https://github.com/Ansonfishing/dsh-cap-profile) | 逐模型工具使用、错误率、Top 错误签名、时间过滤、多模型对比 | 无 | **低**：错误率部分官方事件无字段（§2.4），只借鉴「多模型对比」形态 |
| [@rongyi7/dsh-stats（DSH Usage）](https://www.npmjs.com/package/@rongyi7/dsh-stats) | 按项目看 Token/开发时间/预估费用、账户余额与订阅额度、独立浮层不占会话输入区 | 部分 | 中：余额 chip 我们已有（默认关） |
| [@mzzsfy/dsh-usage-dash](https://socket.dev/npm/package/@mzzsfy/dsh-usage-dash) | 天/小时/分钟**三粒度**、26 周热力图、缓存命中/速度/TTFT 曲线、分时段定价规则 | 部分 | 低：粒度细化要换代索引，成本高 |
| [4AM-Forever/dsh-token-usage](https://github.com/4AM-Forever/dsh-token-usage) | 账户全量费用卡片、**可搜索会话明细**、**侧边栏今日 badge** | 部分 | 中：badge 依赖宿主 slot |
| [dsh-tool-cost-hint](https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint) | 「不告诉你花了多少钱，只告诉你每个工具往上下文里塞了多少东西」 | 无 | 中：独特视角，但偏离主线 |
| [Hjay1101/dsh-plugin-token-usage](https://github.com/Hjay1101/dsh-plugin-token-usage) | 日/周/月粒度热力图、hover 今日 badge、read-only fully local | 部分 | 低 |
| dsh-cost-tracker / dsh-token-stat / dsh-session-report | 设置面板、Agent 工具、HTTP API、数据目录可在线改、会话级成本卡 | 部分 | 低 |
| [WakaTime 2025 wrapped](https://wakatime.com/blog/69-get-ready-for-your-yearly-wrapped-code-stats) | **按 Client 筛选 dashboard**、Claude Code / Copilot 的 AI 编码时长检测、年度 Wrapped | 无 | **高**：客户维度 + 年度叙事 |

### 3.2 通用产品（三路调研归纳后的结论）

**A. 报告交付 /「给客户看」**
1. **保存的报告（Saved Reports）**：命名 + 锁定日期范围 + 一键重生成，是 [Toggl](https://community.toggl.com/t/saved-reports/60) / [Clockify](https://clockify.me/help/reports/scheduled-reports) 的标准形态，也是我们最低成本、最高价值的升级。
2. **只读快照语义**：生成时间、署名/品牌位、匿名化说明写成报告的一部分；[GitHub Wrapped](https://github.com/moinulmoin/github-wrapped) 证明「可分享链接 + 下载 PNG」有吸引力，但我们只能交付文件，不能托管链接。
3. **导出格式补齐**：竞品普遍给 CSV / NDJSON / JSON / API（[ccusage](https://ccusage.com/guide/) 甚至有 MCP server）；[dsh-work-report](https://www.npmjs.com/package/dsh-work-report) 给 Markdown 日/周/月报。我们已有 `export.json`，补 CSV 与 Markdown 很轻。

**B. 周期复盘与对比**
4. **环比/同比箭头应列 V3 首位**：[Helicone 成本周报](https://docs.helicone.ai/guides/cookbooks/cost-tracking) 含 week-over-week 与优化建议；[LinearB](https://linearb.io/platform/dora-metrics) 证明基准有价值，但我们**只能做自身历史对比**，不能做跨组织基准。现有 `aggregate` 已支持 `from`/`to`（`src/aggregate.js:374`），实现成本低于直觉。
5. **会话级单位经济**：[Helicone Sessions](https://docs.helicone.ai/guides/cookbooks/cost-tracking) 把会话当作成本归因基础单元；ccusage session 视图、Cline 按成本排序任务同理。我们有 Top 会话，缺成本排序与每轮成本。
6. **目标 / 连续天数 / 达成率**：[WakaTime Goals](https://wakatime.com/goals) 已验证，纯本地计算、零外呼。我们有「活跃天数」，加目标线与 streak 即可。

**C. 成本与效率信号**
7. **把「缓存读占比」从数字变成建议**：[Helicone 提示缓存](https://docs.helicone.ai/gateway/concepts/prompt-caching) 与 [Claude Code `/usage`](https://code.claude.com/docs/en/costs.md) 对「占比 ≥10%」给优化建议。我们已有该 KPI，缺确定性解读文案（只提示、不编金额）。
8. **异常标记而非告警**：[LangWatch `spend_spike`](https://langwatch.ai/docs/ai-governance/anomaly-rules)、[Devin Coach](https://docs.devin.ai/admin/billing/usage)、[Augment 预算](https://docs.augmentcode.com/analytics/credit-dashboard-and-quotas) 的思路可本地化改写为「以前 30 天中位数为基线，在生成报告时标注突增/超长等待/异常高耗会话」——**不推送、不外呼**。
9. **自定义标签/客户分摊**：[LiteLLM](https://www.litellm.ai/features) / [PromptLayer](https://docs.promptlayer.com/features/search-and-analytics/analytics) 按 key/用户/自定义 metadata 分摊成本；WakaTime 按 Client 筛选。对自由职业者是刚需（一个客户 = 多个工作区）。
10. **口径诚实是卖点**：[dsh-all-usage](https://www.npmjs.com/package/dsh-all-usage) 明确写「本地统计不是供应商账单镜像、失败请求可能仍留 usage、价格来自公开目录需覆盖」。[ActivityWatch](https://activitywatch.net/blog/activitywatch-vs-rescuetime/) 的本地优先 + 全量导出 + 本地 REST API 与我们一致，应写进报告作可信度声明。

**D. 产出归因（价值高，但受限最重）**
11. [Claude Code Analytics](https://code.claude.com/docs/en/analytics) 把会话活动 ↔ 合并 PR 匹配并标 `claude-code-assisted`，[GitHub Copilot impact](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics)、[Sourcegraph `% Code Written by Cody`](https://sourcegraph.com/docs/analytics.md)、WakaTime AI/人工行占比都是「产出代理指标」。这些**需要 GitHub 集成或逐行 diff 归因**，与「只用官方接口 / 零外呼」冲突，V3 不做；若要碰，只能是可关闭的「本地 git 提交数」可选归因，并明确标注为额外数据源。
12. 「节省时间」是**可配置假设**（Sourcegraph：2 分钟/补全 × 次数），不是实测。我们的「不编造数字」原则下，若引入必须默认关闭、显式公式、系数可改。

### 3.3 明确不借鉴（与红线冲突，或成本远大于收益）

| 功能 | 出处 | 不做的理由 |
| --- | --- | --- |
| 定时邮件周报 / 订阅 | Clockify、WakaTime、Helicone | 需 SMTP 外呼 + 常驻调度；只能做手动一键生成 |
| Slack / Email / Webhook 告警、多渠道 | [Helicone Alerts](https://docs.helicone.ai/features/alerts)、LiteLLM、LangWatch | 全部外呼；且 LangWatch 仅 `spend_spike` 真正生效，其余为 preview |
| 公开分享链接 / 客户门户 / 白标托管 | Toggl、Clockify | 「链接」= 上传数据到公网；只交付文件 |
| 硬预算上限 / 限流拦截 | LiteLLM Budgets、[Helicone Rate Limits](https://docs.helicone.ai/features/advanced-usage/custom-rate-limits)、Augment Enforce | 插件只读宿主接口，无法拦截请求，只能事后提醒 |
| 跨组织 / 行业基准 | LinearB、Swarmia | 需外部数据集，与「不编造数字、全本地」直接冲突 |
| 团队 / 成员 / 权限 / SSO | [Clockify 团队报表](https://clockify.me/help/getting-started/get-started-with-team-reports)、Langfuse、Claude Enterprise Analytics | 目标用户是自由职业者/工作室，单机本地，无账号体系 |
| 多宿主 / 20+ CLI 数据源统一 | ccusage 20+ 源 | 跨宿主日志不在本地，且违反「只用宿主官方接口」 |
| 错误率 / 失败重试 / Top 错误签名 | dsh-cap-profile、LiteLLM alerting | **官方事件无 `error`/`finish` 字段**（§2.4），做了就是编数字 |
| 分钟级粒度、逐供应商速度、模型 × 时间热力图 | @mzzsfy/dsh-usage-dash、`docs/models.md:137` | 需 `INDEX_VERSION` 换代 + 全量冷读 1–2 分钟，收益有限 |

---

## 4. V3 功能清单与优先级

评分口径：**价值**（对「给客户看 / 月度复盘」的贡献）、**成本**（是否要换代索引 / 碰铁律 / 8 语言工作量）、**风险**（口径失真、外呼、文档漂移）。

### 阶段 0 — V3 之前（分发与一致性，需用户确认的对外动作）

| # | 事项 | 依据 |
| --- | --- | --- |
| 0.1 | 发布 v2.5.x（npm）、`git push origin main`、GitHub Release、awesome-dsh-plugin PR | `docs/discoverability.md:11-14,105-113`；当前远端停在 v1.0.5、npm 停在 2.4.1 |
| 0.2 | ✅ **已完成（v2.5.2）**：恢复导出入口 + 报告对齐 + README / CHANGELOG / parity 同步；发版时再更新 marketplace ×8 语言元数据 | `src/client/index.jsx:37`、`CHANGELOG.md` |
| 0.3 | 清理文档漂移（roadmap / models.md:4 / ui-conventions.md:26 / sync.md:320）与遗留 E2E 失败 | §2.2 |

### P0 — 3.0.0「交付可信」（建议全部进第一个版本）

| # | 功能 | 借鉴来源 | 价值 | 成本 | 关键约束 |
| --- | --- | --- | --- | --- | --- |
| 1 | **报告工作台 / 保存的报告**：命名、锁定区间、一键重生成、报告历史列表（本地文件，不上云） | Toggl Saved Reports、Clockify | 高 | 中 | 本地文件 + 只读快照语义；不引入托管 |
| 2 | **周期对比**：本期 vs 上期（等长窗口）的 9 KPI 环比箭头、按工作区/模型的增减排行、报告内「变化摘要」 | Helicone 周报、LinearB、`PROGRESS.md:1044` | 高 | 中 | `aggregate` 已支持 `from`/`to`（`src/aggregate.js:374`），**不需要换索引**；分母用真实跨度，口径写进 `metrics.md` |
| 3 | **报告可信度增强**：生成时间、署名/品牌位、匿名化说明、口径声明（本地统计 ≠ 官方账单）、异常标记 | dsh-all-usage、LangWatch、Wrapped | 高 | 低 | 仍 0 script / 外链仅官方计费页；品牌位用现有 `title`/`note` 扩展 |
| 4 | **导出格式补齐**：CSV（日明细/会话明细/模型明细）+ Markdown 周/月报（手动一键，纯本地） | ccusage、dsh-work-report、Clockify | 中高 | 低 | Markdown 只做聚合统计 + 可复算数字，不写 AI 判断（沿用「画像不进报告」原则） |
| 5 | **交互冻结清单 + 质量债**：冻结路径模板/画像卡/KPI/版本号四处交互；修环形图居中基线失败、服务端中文日志、俄语复数 | 内部（`PROGRESS.md:150`、`CHANGELOG.md:139`） | 中 | 低 | 先冻结再动 UI；避免把返工当迭代 |

> P0 全部**不需要 `INDEX_VERSION` 换代**，这是把它们放第一批的核心原因。

### P1 — 3.1.0「可复盘」

| # | 功能 | 借鉴来源 | 价值 | 成本 | 说明 |
| --- | --- | --- | --- | --- | --- |
| 6 | **全局组合筛选**：工作区 × 模型/供应商 × 自定义日期 + 保存视图 | dsh-all-usage、[Langfuse 自定义仪表盘](https://langfuse.com/changelog/2025-05-21-custom-dashboards) | 高 | 中 | 顺带完成 `docs/roadmap.md:21` 的「按模型筛选」；报告仍固定口径，筛选只影响看板 |
| 7 | **客户 / 标签分组**：workspace → client 的本地映射，按客户汇总时间/Token/成本 | LiteLLM tags、WakaTime Client filter | 高 | 中 | 复用 `workspaceAliases` 思路扩展为 `workspaceTags`；元数据只落本地 |
| 8 | **目标与连续天数**：周/月目标线、达成率、活跃 streak、月度达成卡 | WakaTime Goals、RescueTime | 中高 | 低 | 纯本地计算；默认关闭，不推送 |
| 9 | **信号卡（报告内标记，不告警）**：异常高耗会话、环比突增、缓存未命中、超长等待 | Claude `/usage`、LangWatch、Devin Coach | 中高 | 中 | 基线 = 前 30 天中位数；只给确定性文案，不编金额、不联网 |
| 10 | **逐会话 / 逐轮单位经济**：Top 会话按成本排序、每轮成本、会话效率 | Helicone Sessions、ccusage | 中 | 中 | **不恢复「模型费用」KPI**（`CHANGELOG.md:64`） |

### P2 — 3.2.0「可讲述」（视 P0/P1 反馈再定）

| # | 功能 | 备注 |
| --- | --- | --- |
| 11 | **叙事型月度/年度复盘**（Wrapped 风格静态 HTML，分节数字卡 + 可下载 PNG） | 仍自包含无脚本；借鉴 [gh-wrapped](https://github.com/joshbeckman/gh-wrapped) / [github-wrapped](https://github.com/moinulmoin/github-wrapped) / WakaTime Wrapped；`PROGRESS.md:1044` 的 PNG 待办在此兑现；顺带回应「AI 画像比较简单」 |
| 12 | **趋势外推**（未来 7 天 / 月度估算 / 自设预算线） | 借鉴 dsh-work-report 的线性回归，但**必须标注「预测·非实测」、默认关闭、可关闭**；与「不编造数字」有张力，需用户拍板 |
| 13 | **工具耗时排行 / 等待工具分布 / 思考强度分布** | 官方事件已有 `tool/call` + `tool/result`（`callId`）、`request/header.config.reasoningEffort`（`src/models.js:283`），只需组合现有字段。**不做错误率/失败重试**（§2.4） |
| 14 | 分钟/小时粒度、逐供应商速度、侧边栏 badge、会话底栏回合成本 | 需索引换代或宿主 slot 支持，成本最高，放最后 |

---

## 5. 里程碑与节奏（建议）

| 阶段 | 主题 | 内容 | 索引换代 | 主要风险 |
| --- | --- | --- | --- | --- |
| **0（V3 之前）** | 分发与一致性 | 0.1–0.3：发布 2.5.x、push、Release、awesome PR、恢复导出入口、修文档漂移 | 否 | 全是对外动作，**必须先确认** |
| **3.0.0** | 交付可信 | P0 全部 + 更新 `docs/roadmap.md` / `docs/metrics.md`（环比口径） | **否** | 8 语言文案 + 断言同步 |
| **3.1.0** | 可复盘 | P1 的 6–10，含 `workspaceTags` 配置与全局筛选 | 可能（若标签落索引行） | 换代冷读 1–2 分钟、筛选与快照缓存的一致性 |
| **3.2.0** | 可讲述 | P2 的 11–13；14 视接口验证结果 | 视实现 | 预测类数字的口径争议、静态报告复杂度上升 |

每个版本必须同步的清单（沿用现有发布纪律）：`package.json` 版本 → README 中英 + `docs/i18n/*.md` ×8 → `docs/distribution/marketplace.*.json` → CHANGELOG 对照表 → `docs/roadmap.md` → `test/verify.mjs` 断言 + 8 语言 i18n 校验 → `node build.mjs` 产物一致性 → 真实浏览器 e2e（8 语言）。

---

## 6. 验收指标（怎么算 V3 成功）

1. 阶段 0 完成：npm / GitHub / awesome 列表上的版本与功能描述与代码一致。
2. 导出入口在 8 语言下可见且 e2e 覆盖；「宣传的功能」与「界面上能点的功能」一一对应，零漂移。
3. 报告仍满足：`script = 0`、非官方计费页外链 `= 0`、看板/报告数字同源（parity 断言通过）。
4. 环比数字可手工复算，口径写进 `docs/metrics.md`，守恒关系（净活跃 + 等待 = 活跃）不被新指标破坏。
5. 性能不退化：打开面板 0 次 `readSession`、冷开 ~25ms / 热开 ~1ms、snapshot < 50ms（基线见 `PROGRESS.md:1077`）。
6. 8 语言 `npm run check:i18n` 全绿；新增文案无硬编码；遗留的环形图居中 E2E 失败清零。
7. 3.0.0 不触发 `INDEX_VERSION` 换代，老用户升级不重扫历史。

---

## 7. 待用户确认的取舍（请先拍板这 6 个）

| # | 问题 | 选项 | 我的建议 |
| --- | --- | --- | --- |
| 1 | ~~**导出入口**：恢复按钮，还是正式下线并改定位？~~ | — | **已按 A 执行（v2.5.2）**：入口恢复、报告对齐、设备筛选透传；无需再确认 |
| 2 | **V3 主线** | A 报告交付（推荐） / B 复盘分析 / C 团队与计费 | **A 为主、B 为辅**。C 与本地单机定位冲突；A 直接服务「给客户看」，且是唯一没被同类插件吃透的差异化 |
| 3 | **是否允许「预测/估算」类数字** | A 完全不做 / B 默认关闭 + 显式标注「预测·非实测」/ C 默认开启 | **B**。竞品都在做，但我们的护城河是「不编造数字」；只允许可关闭、可复算、有公式的外推 |
| 4 | **是否引入本地 git 产出归因**（commit/PR/改动文件数） | A 不做（推荐） / B 可选开关 + 明确标注为额外数据源 | **A**。`只用官方接口`是硬约束，git 读取会破例；收益也不确定（AI 会话 ↔ commit 无法可靠匹配） |
| 5 | **发版节奏** | A 3.0.0 一次大版本（推荐） / B 2.6 / 2.7 小步快跑 | **A**。P0 五项是完整的一组「交付闭环」，拆开发反而要反复改 8 语言与 parity 断言 |
| 6 | **是否先落地 V2 分发，再启动 V3？** | A 先分发（推荐） / B 直接做 V3 | **A**。2.5.x 代码已完成但对外仍是 2.4.1 / v1.0.5，是唯一「做了等于没做」的短板；阶段 0 只需确认，开发量极小 |

---

## 8. 来源

**内部**：`README.md`、`package.json`、`CHANGELOG.md`、`PROGRESS.md`、`docs/metrics.md`、`docs/models.md`、`docs/roadmap.md`、`docs/preaggregation.md`、`docs/discoverability.md`、`docs/ui-conventions.md`、`src/client/index.jsx`、`src/aggregate.js`、`src/models.js`、`index.js`。

**DSH 生态（2026-11-10 检索）**：[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) · [dsh-all-usage](https://www.npmjs.com/package/dsh-all-usage) · [dsh-work-report](https://www.npmjs.com/package/dsh-work-report) · [dsh-cap-profile](https://github.com/Ansonfishing/dsh-cap-profile) · [@rongyi7/dsh-stats](https://www.npmjs.com/package/@rongyi7/dsh-stats) · [@mzzsfy/dsh-usage-dash](https://socket.dev/npm/package/@mzzsfy/dsh-usage-dash) · [4AM-Forever/dsh-token-usage](https://github.com/4AM-Forever/dsh-token-usage) · [dsh-tool-cost-hint](https://github.com/qiyuexue-xiyu/dsh-tool-cost-hint) · [Hjay1101/dsh-plugin-token-usage](https://github.com/Hjay1101/dsh-plugin-token-usage) · [WakaTime 2025 wrapped](https://wakatime.com/blog/69-get-ready-for-your-yearly-wrapped-code-stats)

**AI 编码助手**：[ccusage](https://ccusage.com/guide/) · [Claude Code costs / `/usage` / `/insights`](https://code.claude.com/docs/en/costs.md) · [Claude Code Analytics](https://code.claude.com/docs/en/analytics) · [GitHub Copilot usage metrics](https://docs.github.com/en/copilot/reference/copilot-usage-metrics/copilot-usage-metrics) · [WakaTime Goals](https://wakatime.com/goals) · [WakaTime AI dashboard](https://wakatime.com/ai) · [Sourcegraph Analytics](https://sourcegraph.com/docs/analytics.md) · [Augment Budgets](https://docs.augmentcode.com/analytics/credit-dashboard-and-quotas) · [Devin Usage](https://docs.devin.ai/admin/billing/usage)

**可观测性 / 时间追踪 / 报告**：[LiteLLM Features](https://www.litellm.ai/features) · [Helicone 成本与周报](https://docs.helicone.ai/guides/cookbooks/cost-tracking) · [Helicone Alerts](https://docs.helicone.ai/features/alerts) · [Helicone 提示缓存](https://docs.helicone.ai/gateway/concepts/prompt-caching) · [LangWatch 异常规则](https://langwatch.ai/docs/ai-governance/anomaly-rules) · [Langfuse 自定义仪表盘](https://langfuse.com/changelog/2025-05-21-custom-dashboards) · [PromptLayer Analytics](https://docs.promptlayer.com/features/search-and-analytics/analytics) · [Clockify 定时报告](https://clockify.me/help/reports/scheduled-reports) · [Toggl Saved Reports](https://community.toggl.com/t/saved-reports/60) · [ActivityWatch vs RescueTime](https://activitywatch.net/blog/activitywatch-vs-rescuetime/) · [LinearB DORA](https://linearb.io/platform/dora-metrics) · [gh-wrapped](https://github.com/joshbeckman/gh-wrapped) · [github-wrapped](https://github.com/moinulmoin/github-wrapped)

> 外部页面为不可信数据，仅作功能事实参考；调研中已剔除诱导执行命令的文本与营销话术。部分第三方/社区条目标注为「未完全核实」，不作为规划依据。
