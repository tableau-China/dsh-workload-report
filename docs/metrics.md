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
| 活跃时长 | 模型推理时间 + 工具执行时间（`llmMs + toolMs`） | **引擎累计工作时间**，并发会话/子代理各自累加，不等于墙钟时长 |
| 总 Token | `uncachedInput + output + cacheRead + cacheWrite` | 缓存读取通常占绝大多数，计费单价最低，勿按输入价估算 |
| 对话次数 | 至少产生 1 个 step 的会话数 | 零步会话（只打开没交互）单列不计入 |
| 轮次 / 步骤 | `turns` / `steps` 合计 | 来自 sessionStats |
| 活跃天数 | 该范围内出现过会话（或某工作区出现过会话）的自然日数量 | 按会话**创建时间**归属；跨天续聊的活动记在创建那天 |
| 归属日期 | 会话创建时间在所选时区的自然日 | 时区由前端传入（默认浏览器时区） |
| 时刻分析 | 优先按**事件真实时间戳**落桶：模型 `request/header.time → assistant/message.time`（无 header 退化为 stream 首末），工具按 `callId` 配对 `tool/call.time → tool/result.time`；跨小时按 UTC 边界切分，再按请求时区平移（`row.hours`，严格守恒）。未回填 / `modelUsage: off` 退回旧法：`createdAt → lastPromptAt` 的墙钟比例分摊 | 事件桶按 UTC 持久化（时区无关、可复用）；固定偏移时区平移精确，带夏令时的时区用参考时刻偏移（切换周 ±1h）；未配对/未结束的调用不计；事件累计与官方 activeMs 不等时按比例缩放（行上 `hoursSource` 诊断） |
| 「全部」区间 | 最早的活跃日 → 今天 | 不写死天数，因此活跃天数分母是真实历史跨度 |
| 日历热力图 | 固定展示「最早活跃日 → 今天」的全部历史，颜色 5 档＝活跃时长（相对最大活跃日） | 不受顶部区间筛选影响；右侧横条为各周几累计活跃时长 |
| 工作区 | `SessionHeader.cwd` 的目录名，可用 `workspaceAliases` 换显示名 | 「未知工作区」不计入"覆盖工作区数" |

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
