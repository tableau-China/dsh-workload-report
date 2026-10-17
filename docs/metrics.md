# 指标口径

面向"要给客户看"的场景，口径必须写死，避免同一个数字在不同页面含义不同。

## 数据来源

全部来自 Harness 官方接口，四层取值（先便宜后昂贵）：

| 顺序 | 来源 | 成本 | 说明 |
| --- | --- | --- | --- |
| 1 | `ctx.sessionProjections.snapshot(session, keys)` | 同步、极低 | 活会话最准；并订阅 `session/event` 增量更新 |
| 2 | `ctx.sessionProjectionCache.cachedSnapshot(header, keys)` | 零 I/O | 持久化投影检查点；**仅在检查点与当前会话生命周期身份匹配时有效**（会话格式迁移后旧检查点会被官方拒绝） |
| 3 | 本地索引 `<DSH_HOME>/workload-report/index-v*.json` | 一次磁盘读 | 覆盖第 2 层未命中的会话，`revalidateMs` 到期后重新校验 |
| 4 | `ctx.sessionQuery.observeSession(id, { projectionMode: "all" })` | 冷读日志 | 官方折叠整份日志兜底；结果落盘复用 |

读取的投影键：`sessionStats`（turns / steps / llmMs / toolMs / decodeTokens）、`tokenUsage`（四类 token）、`title`、`sessionListMetadata`（lastPromptAt）。

## 指标定义

| 指标 | 定义 | 注意 |
| --- | --- | --- |
| 官方活跃时长 | 模型推理时间 + 工具执行时间（`llmMs + toolMs`） | **引擎累计工作时间**，并发会话/子代理各自累加，不等于墙钟时长；接口字段 `totals.activeMs` 保留该官方值供核对（`totals.llmMs` / `totals.toolMs` 为净口径，工具时间已扣 `waitMs`） |
| 等待用户 `waitMs` | 被判定为「等人」的工具区间总和（0.6.5，三层判定见下节） | 整段从活跃时长中剔除；不进入小时桶；随索引持久化到行上 |
| 净活跃时长 `netActiveMs` | 官方活跃时长 − 等待用户（`activeMs - waitMs`） | UI / 报告 / 每日 / 时刻 / 工作区 / 日历全部使用净活跃；`netActiveMs + waitMs === activeMs`（±1ms 守恒） |
| 总 Token | `uncachedInput + output + cacheRead + cacheWrite` | 缓存读取通常占绝大多数，计费单价最低，勿按输入价估算 |
| 对话次数 | 至少产生 1 个 step 的会话数 | 零步会话（只打开没交互）单列不计入 |
| 轮次 / 步骤 | `turns` / `steps` 合计 | 来自 sessionStats |
| 活跃天数 | 该范围内出现过会话（或某工作区出现过会话）的自然日数量 | 按会话**创建时间**归属；跨天续聊的活动记在创建那天 |
| 归属日期 | 会话创建时间在所选时区的自然日 | 时区由前端传入（默认浏览器时区） |
| 时刻分析 | 以**轮次（turn）**为最小归属单位：多轮会话逐轮分开，每个轮次的**净**活跃时长（该轮内非等待的模型时间 + 工具时间之和）**整段记到「该轮开始时刻」所在的整点，不跨小时切分**（跨小时的轮次整段归入起始小时）。轮次开始时刻取该轮 `turn/start`，没有则取该轮最早事件时间；模型时间 = `request/header.time → assistant/message.time`（无 header 退化为 stream 首末），工具时间按 `callId` 配对 `tool/call.time → tool/result.time`，**等待用户的工具区间整段剔除、不落任何小时桶**；落桶按 UTC，聚合时按请求时区平移（`row.hours`，严格守恒）。**会话级兜底**：事件没有轮次信息（老会话）时整段记到 `createdAt` 所在整点；未回填 / `modelUsage: off` 退回旧法：`createdAt → lastPromptAt` 的墙钟比例分摊（同样用净活跃） | 与旧摊销法的差别：旧法把会话 activeMs 按墙钟窗口均匀摊到覆盖的每个小时（长窗口摊成假平峰）；新法按「轮次开始时刻」聚合，保留真实高峰与跨小时归属。事件桶按 UTC 持久化（时区无关、可复用）；固定偏移时区平移精确，带夏令时的时区用参考时刻偏移（切换周 ±1h）；未配对/未结束的调用不计；事件累计与「官方 activeMs − waitMs」不等时按比例缩放（行上 `hoursSource` 诊断）。因此 `sum(byHour) === totals.netActiveMs`。0.6.5 起同一份 `byHour` 还带按消息时间落桶的 Token 与人类消息（见下节），卡片默认按 Tokens 画柱 |
| 「全部」区间 | 最早的活跃日 → 今天 | 不写死天数，因此活跃天数分母是真实历史跨度 |
| 日历热力图 | 固定展示「最早活跃日 → 今天」的全部历史，颜色 5 档＝活跃时长（相对最大活跃日） | 不受顶部区间筛选影响；右侧横条为各周几累计活跃时长 |
| 工作区 | `SessionHeader.cwd` 的目录名，可用 `workspaceAliases` 换显示名 | 「未知工作区」不计入"覆盖工作区数" |

## 时刻分析：Token 与人类消息（0.6.5）

看板时刻卡片默认 measure = **Tokens**，可切「轮次」；导出报告固定 Tokens。三种字段同源于 `byHour`：

| 字段 | 口径 |
| --- | --- |
| `byHour.tokensTotal` | 该小时所有 `assistant/message` 的 usage 之和（未命中输入 + 输出 + 缓存读 + 缓存写，与 `row.tokens` 同定义），按**消息时间**落 UTC 小时；聚合时按请求时区平移 |
| `byHour.humanMsgs` | 该小时 `user/message` 的条数（图表顶部密度点；点半径 = 3.4 + ratio×5.0，上沿恒留 14px） |
| `byHour.starts` | 该小时开始的会话数（「轮次」measure 取它） |
| `row.hourTokens` | 24 个 UTC Token 桶，随索引持久化；**按官方 `row.tokensTotal` 回正**（整数目标用最大余数法，`Σ === tokensTotal`，±0） |
| `row.hourHumanMsgs` | 24 个 UTC 人类消息计数，随索引持久化 |
| `hourTokensSource` | `{ events, scaled, missing }`：事件 / 事件缩放 / 读不出事件。`missing` 的会话有 Token 但时间图不计入，界面写「Token 未计入 N 个会话」 |

读不出事件（v0 老日志 / 未回填 / `modelUsage: off`）的会话不伪造小时分布；总量仍包含它们。
索引版本 `INDEX_VERSION` 6 → 7 专门为此换代（v6 行没有 `hourTokens`）。

## 等待用户（0.6.5）

交互工具（例如 `ask_user_question`、`exit_plan_mode`）在等人回答时，`tool/call → tool/result` 的整段墙钟会被官方 `toolMs` 计入活跃时长。用户实测一次 **3 小时**的等待被整段算成活跃，导致「活跃时长」严重虚高。因此 0.6.5 把等待拆出来单列。

### 三层判定

一个工具区间（`tool/call.time → tool/result.time`）满足以下条件时，**整段**计为等待用户（`waitMs`）：

| 层 | 规则 | 说明 |
| --- | --- | --- |
| 1 | 工具名在 `waitTools` 白名单（默认 `["ask_user_question", "exit_plan_mode"]`） | 交互工具本身就是「等人类」，不需要额外信号；可扩展 |
| 2 | 调用期间（call 与 result 之间）夹着 `user/message` | 人类输入夹层；不依赖工具名，任何工具都适用 |
| 3 | 单次区间 ≥ `waitMinMs`（默认 60000ms） | 统一门槛：短交互不剔除，避免把 30 秒的确认切成一堆碎片 |

- **长任务豁免**：没有 `user/message` 且不在白名单的长工具（编译、跑批）**照常算工作**，不误伤。
- 只有「白名单」或「人类输入夹层」还不够，必须同时过第 3 层门槛。
- 悬空调用（只有 call、没有 result）仍不计，也就不会产生等待。

### 配置

```yaml
excludeWait: true                 # 默认开；false = 完全回到 0.6.0 行为（不判定等待）
waitTools: [ask_user_question, exit_plan_mode]
waitMinMs: 60000
```

`excludeWait: false` 时不做任何等待判定，`waitMs = 0`，`netActiveMs === activeMs`，小时桶与 0.6.0 完全一致（有回归断言）。

### 数据与守恒

- 行上新增 `waitMs`（随索引持久化，索引版本 `INDEX_VERSION` 5 → 6；0.6.5 再 6 → 7 增加 `hourTokens` / `hourHumanMsgs`；行换代时由 `carryModelFields` 搬运）。
- 快照 `totals`：`activeMs`（官方值，供核对）、`waitMs`、`netActiveMs = activeMs - waitMs`；`llmMs` / `toolMs` 为净口径（`toolMs` 已扣 `waitMs`，因此 `llmMs + toolMs === netActiveMs`）。
- `byDay` / `byWorkspace` / `byHour` / `calendar` / `bySession` 的 `activeMs` 都是**净活跃**（在 row 级剔除等待，不是事后减）；
  `byWorkspace` 另带 `waitMs` 供工作区视图展示。
- 守恒：`netActiveMs + waitMs === activeMs`（±1ms）；`sum(byHour) === totals.netActiveMs`
  （未回填行走旧法摊销时同样按 `row.activeMs - row.waitMs` 计算）。
- 展示：KPI「活跃时长」显示净活跃，副标题追加「含等待用户 {wait}」；工作区视图与报告 footer 单列等待。

## 已知限制

- 极早期的 v0 格式会话，当前 Harness 版本可能无法迁移/读取（冷读会失败）；这类会话不计入统计，界面会写明数量。
- 首次建索引需要冷读历史会话（本机实测约 2 分钟，并发 8），期间接口返回逐步填充的数据并带 `indexing: true`。

## 模型维度（0.4.0）

| 指标 | 口径 |
| --- | --- |
| 模型归属 | 事件 `assistant/message` 的 `data.message.source.{provider, model}`；同会话可含多个模型 |
| **归并** | `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp` 合并显示为 **`deepseek-v4-flash`**（官方定价页注 1：前者的 legacy 名）；明细可展开看原始组成；可用 `modelGroups` 自定义 |
| 请求数 | 一条 `assistant/message` = 一次请求 = 一个 step |
| Token | 事件 `data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`；缺 usage 的请求只计请求、不计 token（不猜） |
| 缓存命中率 | `cacheRead / (cacheRead + input)`；两者皆 0 时显示 `—` |
| 模型耗时 | 各模型 `stream` 时间窗口占比 → 分摊会话 `sessionStats.llmMs`；**各模型之和 = 会话模型时间（守恒）** |
| 思考强度 | `request/header` 的 `data.header.config.reasoningEffort` 分布 |
| 未标注模型 | 缺 provider/model 的请求归入 `(未标注模型)` 桶 |

### 费用估算（可选，默认显示）

- **单价来源**：内置官方公开价（**as-of 2026-10-13**），DeepSeek 分**峰/谷**两档：
  峰时 = **01:00–04:00 与 06:00–10:00 UTC，周一至周五**；其余时间（含周末）为谷时，谷价 = 峰价一半。
  中国法定节假日无法离线判定 → 按峰价计入（**略微高估**）。
- 每条 `assistant/message` 按其 `time` 判定峰/谷 → 逐请求计费，非近似。
- 官方单价（每 100 万 tokens，CNY）：flash 缓存命中 0.02/0.04、未命中 1/2、输出 4/8；pro 0.15/0.30、4.5/9、13.5/27（谷/峰）。
- **没有官方价的模型显示 `—`，不编造数字**（Kimi 价格页为前端渲染、Claude 定价页区域受限，均无法可靠获取）。
- 页面与报告底部固定给出官方计费链接；**插件运行时不联网**，单价为内置常量 + 用户可覆盖（`pricing.overrides`）。
