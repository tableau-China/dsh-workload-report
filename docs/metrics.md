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
| 时刻分析 | 会话活跃窗口 = `createdAt → sessionListMetadata.lastPromptAt`；把该会话引擎时长按**墙钟重叠比例**分摊到覆盖的小时（半小时切片，严格守恒） | 近似口径：引擎时间 ≠ 墙钟时间，跨天续聊的长窗口会被摊薄 |
| 「全部」区间 | 最早的活跃日 → 今天 | 不写死天数，因此活跃天数分母是真实历史跨度 |
| 日历热力图 | 固定展示「最早活跃日 → 今天」的全部历史，颜色 5 档＝活跃时长（相对最大活跃日） | 不受顶部区间筛选影响；右侧横条为各周几累计活跃时长 |
| 工作区 | `SessionHeader.cwd` 的目录名，可用 `workspaceAliases` 换显示名 | 「未知工作区」不计入"覆盖工作区数" |

## 已知限制

- 极早期的 v0 格式会话，当前 Harness 版本可能无法迁移/读取（冷读会失败）；这类会话不计入统计，界面会写明数量。
- 首次建索引需要冷读历史会话（本机实测约 2 分钟，并发 8），期间接口返回逐步填充的数据并带 `indexing: true`。
