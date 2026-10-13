# 模型用量分析（设计 · 目标版本 0.4.0）

> **状态：已在 0.4.0 实现**（归并规则、treemap + 按日趋势联动、最活跃模型 KPI、官方峰谷价费用估算）。
> 多机同步仍暂缓（见 [roadmap.md](./roadmap.md)）。

## 一、为什么能做（数据链路已实测）

DSH 里**模型与 token 都在事件日志**里，官方有读取接口，不需要解析日志格式：

| 数据 | 位置（实测字段） |
| --- | --- |
| 模型 | `assistant/message` → `data.message.source.{provider, model}`（如 `deepseek-official / deepseek-v4-flash`） |
| 用量 | 同事件 → `data.usage.{inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalTokens}` |
| 思考强度 | `request/header` → `data.header.config.reasoningEffort`（实测 `max`） |
| 每步耗时 | `assistant/message.data.stream[]` 的时间戳窗口（事件本身无 `durationMs`） |
| **读取接口** | `ctx.sessionQuery.readSession(id)` → `SessionLogSnapshot`（完整事件日志，官方导出同款；校验与格式迁移由 seam 负责） |

现有投影**不带模型维度**，这点已确认：`sessionStats` 只有轮次/步骤/墙钟，`tokenUsage` 只有 4 个总量。
（`listEvents()` 只返回 `{seq,type,time,surface}`，**无正文**，所以必须用 `readSession`。）

## 二、数据模型

索引行新增（`INDEX_VERSION: 2 → 3`，旧索引自动重建）：

```json
{
  "id": "session-…",
  "models": {
    "deepseek-official/deepseek-v4-flash": {
      "requests": 41, "turns": 6,
      "input": 214000, "output": 31000, "cacheRead": 5800000, "cacheWrite": 0,
      "llmMs": 41200,                       // 按 stream 窗口占比分摊会话 llmMs（守恒）
      "efforts": { "max": 39, "high": 2 },  // 思考强度分布
      "firstAt": 1791041077201, "lastAt": 1791180000000
    }
  },
  "modelFoldSeq": 4476,                      // 折到哪个 seq（增量水位）
  "modelFoldAt": 1791180000000
}
```

**采集策略**

1. **首次回填**：`readSession(id)` → 只折 `assistant/message` + `request/header`（忽略 `tool/result` 正文，体积最大头）
2. **增量**：记录 `modelFoldSeq`；会话增长时只处理新增事件（live 会话可直接订阅 `session/event`，避免整份重读）
3. **成本控制**：并发 4（可配）；`modelFoldMaxEvents` 超限的巨型会话跳过并计入 `diagnostics`；`modelUsage: off` 完全关闭
4. **渐进**：模型维度后台回填，看板先出总量，模型区显示"回填中 x/y"

## 三、指标与口径（将写入 docs/metrics.md）

| 指标 | 口径 |
| --- | --- |
| **请求数** | 一条 `assistant/message` = 一次模型请求 = 一个 step |
| **模型归属** | `source.provider/model`；同一会话可含多个模型 |
| **Token 四类** | 输入 / 输出 / 缓存读 / 缓存写，取自事件 `usage`（与官方 `tokenUsage` 投影同源） |
| **缓存命中率** | `cacheRead / (cacheRead + input)` |
| **每模型耗时** | 各模型 `stream` 窗口时长占比 → 分摊会话 `llmMs`；**各模型之和 = 会话 llmMs（守恒，容差 1ms）** |
| **思考强度** | `request/header.config.reasoningEffort` 的分布 |
| **费用（可选）** | 用户在配置里填单价（`modelPricing`）后估算；**不联网、非官方口径**，报告脚注标注"按自填单价估算" |

## 四、视图设计

**看板**

1. **KPI 第 7 张：主力模型**（如 `V4 Flash · 92%`，可配置隐藏）
2. **模型占比环形图**：与现有"工作区占比"共用组件，切换维度（工作区 / 模型）
3. **按日模型堆叠柱**：某天主要用哪个模型（时间 × 模型，Top 5 + 其他）
4. **模型明细表**：模型 · 请求 · 输入 · 输出 · 缓存读 · **命中率** · 耗时 · 占比 ·（可选）费用
5. **模型 × 工作区交叉**：哪个项目在用哪个模型（Top N）
6. 报告 HTML 新增「模型用量」一节（表格 + 环形图 + 口径脚注）

**筛选**：本期先做展示；按模型筛选放 0.4.1（与 roadmap 里的设备筛选一起做）

## 五、配置

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    modelUsage: auto            # auto | off（默认 auto）
    modelFoldConcurrency: 4     # 回填并发
    modelAliases:               # 展示名（同 workspaceAliases 的用法）
      "deepseek-official/deepseek-v4-flash": V4 Flash
      "deepseek-official/deepseek-v4-pro": V4 Pro
    modelPricing:               # 可选：费用估算（单位：每 100 万 token）
      deepseek-v4-flash: { input: 0.5, output: 2, cacheRead: 0.05, currency: CNY }
```

## 六、验收标准

1. **守恒**：各模型 token 之和 = 会话 token 总量；各模型 `llmMs` 之和 = 会话 `llmMs`（容差 1ms）
2. **请求数** = 会话 steps 数（同一口径）
3. **多模型会话**：一个会话里换过模型时，两个模型各自正确计账（构造用例断言）
4. **筛选联动**：范围 / scope（main/subagent）变化时，模型维度同步变化
5. **关闭开关**：`modelUsage: off` 时行为与 0.3.6 完全一致（回归断言）
6. **大会话保护**：超 `modelFoldMaxEvents` 的会话被跳过并出现在 `diagnostics`，不影响其它会话
7. **缓存命中率**：与 `cacheRead / (cacheRead + input)` 的定义一致（边界：两者皆 0 时为 `—`）
8. 离线断言新增：事件折叠（含多模型、缺 usage、畸形 usage）、守恒、别名、费用估算；
   E2E 新增：模型环形图存在、维度切换、明细表列完整

## 七、性能预期（本机实测数据推算）

- 单会话最大日志：压缩 6.1MB → 解压 17.8MB / 4,476 事件（其中 `tool/result` 占体积大头，我们不折它）
- 313 会话首轮回填：预计 **2–6 分钟**（并发 4，只折两类事件），之后增量
- 索引体积增量：约 200 B × 模型数 × 会话数（可忽略）

## 八、风险与对策

| 风险 | 对策 |
| --- | --- |
| 巨型会话读入内存 | 事件数上限 + 跳过并记录诊断；必要时改为流式读（`session.snapshotEvents(from,to)` 分批） |
| 事件结构随版本变化 | 全部读取走官方 seam（`readSession`）；字段缺失时该会话退化为"只有总量"，不报错 |
| 回填期数据不完整 | 界面显示回填进度；总量口径不受影响 |
| 费用口径误读 | 默认不显示费用；启用后报告脚注标明"自填单价估算，非官方计费" |

## 九、版本计划

| 版本 | 内容 |
| --- | --- |
| **0.4.0** | 本设计的全部内容（模型维度、图表、报告、口径、测试） |
| 0.4.1 | 按模型筛选、模型 × 时间热力图、按机器维度（若多机同步启动） |
| roadmap | 多机同步（[sync.md](./sync.md)，暂缓）、COS/S3 传输、设备筛选 |

---

## 修订 v2（2026-10-13 定稿，用户决策）

### 修订 1：模型归并（内置默认规则）

`deepseek-flash` 与 `deepseek-v4-flash` **合并显示为 `deepseek-v4-flash`**。

> 官方依据（[DeepSeek 定价页](https://api-docs.deepseek.com/quick_start/pricing/) 注 1 原文）：
> *"Use `deepseek-flash` as the model name. The legacy names **deepseek-v4-flash** and deepseek-v4-flash-vision-exp are still accepted…"*
> —— 两者是同一模型（DeepSeek-V4.1-Flash）的新旧名称，合并不会混淆口径。

- 实现为**内置默认分组规则**（不是只靠展示别名）；明细行可展开看原始 provider/model 组成；
- 另留 `modelGroups` 配置，用户可自定义其它合并（如把同系列的小版本并到一起）。

### 修订 2：费用估算 = 官方价目 + 官方链接（不联网抓取）

**结论：DeepSeek 官方计费标准可稳定获取，且能精确到时段的峰谷价。**

| 每 100 万 tokens | deepseek-flash（含 legacy `deepseek-v4-flash`） | deepseek-v4-pro |
| --- | --- | --- |
| 输入（缓存命中）谷时 / 峰时 | $0.003 / $0.006（¥0.02 / ¥0.04） | $0.022 / $0.044（¥0.15 / ¥0.30） |
| 输入（缓存未命中）谷时 / 峰时 | $0.15 / $0.30（¥1 / ¥2） | $0.66 / $1.32（¥4.5 / ¥9.0） |
| 输出 谷时 / 峰时 | $0.60 / $1.20（¥4 / ¥8） | $1.98 / $3.96（¥13.5 / ¥27.0） |

- **峰时** = 01:00–04:00 与 06:00–10:00 UTC（周一至周五，中国法定节假日除外）；**其余时间为谷时**（含周末与节假日整天）；谷价 = 峰价一半。（官方原文，见同页注 2）
- 因此按每条 `assistant/message` 的 `time` 判定峰/谷 → **逐请求计费**，无需近似。
- 内置默认价标注 **as-of 2026-10-13** 与来源链接；用户可覆盖（`pricing.overrides`）。
- **非 DeepSeek 模型（Kimi / Claude 等）默认留空**：Kimi 价格页为前端渲染、Claude 定价页当前区域受限，均**无法可靠获取** → 界面显示 `—`，只给官方链接（不编造数字）。
- 页面与导出报告底部固定给出官方计费链接清单 + "价格可能变动，以官方页面为准"：

| 提供方 | 官方计费页 |
| --- | --- |
| DeepSeek | https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ |
| Kimi（Moonshot） | https://platform.kimi.com/docs/pricing/chat |
| Anthropic Claude | https://platform.claude.com/docs/en/about-claude/pricing |

- **仍然不联网**：单价是内置常量 + 用户配置，插件运行时不发任何外发请求。

### 修订 3：模型占比用 treemap（不用 pie）

- **左侧 = 模型 treemap**：面积 = 占比，默认按 token 总量，可切换「请求数 / 活跃耗时」；
- **右侧 = 按日模型趋势**（堆叠柱）；
- **点击左侧某个模型 → 右侧趋势筛选为该模型**（再次点击取消，可多选，选中态明显）；
- **工作区环形图保留不变**（本次只改模型维度的图表形态）。

### 修订 4：KPI 卡新增「最活跃模型」

- 第 7 张 KPI：主标题 = 模型展示名，副标题 = 占比；
- 默认口径 **requests（= step 数）**，可配 `activeModelMetric: requests | tokens | activeMs`；
- tooltip / 口径说明写明定义；中英 i18n 键齐全，无死键。
