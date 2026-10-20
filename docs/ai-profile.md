# AI 用户画像（可选，默认关闭）

> **铁律**：只发送聚合统计白名单，**绝不发送对话正文、会话标题、文件路径原文**；
> 默认关闭，按需点击生成；任何失败都降级为本地规则版，不向 UI 抛错；旁路调用不计入本插件 Token 报表。

## 1. 开关与配置

默认 `aiProfile.enabled = false`。关闭时 `GET /profile` 直接返回 `{ enabled: false, code: "AI_PROFILE_DISABLED" }`，
**不调用任何 llm 服务**（连 `ctx.get("llm")` 都不发生），前端不渲染画像卡片。

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    aiProfile:
      enabled: false        # 默认关闭；true 才会按需调用模型
      provider: ""          # 空 = 使用宿主 agentDefaultModel.currentSelection()
      model: ""             # 与 provider 成对出现
      maxTokens: 1600       # 4–6 维度 + 2–3 建议，留足输出
      timeoutMs: 60000      # AbortSignal.timeout(timeoutMs)
      cacheTtlMs: 86400000  # 指纹缓存 24h；0 = 不落盘
```

调用参数固定 `temperature: 0.35`；路由优先级：`aiProfile.provider/model`（两者都非空）→ 宿主
`agentDefaultModel.currentSelection()`。调用前用 `llm.listProviders()` / `llm.listModels(provider)` 预检；
空列表即未登录 / 无 key。**不指定 `reasoningEffort`**（部分模型不支持 off）。

**调试入口**：`GET /profile?...&provider=<id>&model=<id>` 只覆盖本次请求的路由，
仅在 `aiProfile.enabled=true` 时生效；不写配置、不需要重启，也**不读 / 不写指纹缓存**。
`origin` 会标记为 `query`，正常路径仍是 `config` / `agentDefaultModel`。

## 2. 发送的数据（白名单，56 个键）

白名单定义在 `src/ai-profile.js` 的 `PROFILE_PAYLOAD_KEYS`，构造后立即断言顶层键集合严格相等；
断言还会递归拒绝私有键（title / cwd / path / sessionId / prompt / content / message / text）、
路径分隔符与超长字符串（`range.timeZone` 例外）。

| 分组 | 键 | 来源 / 说明 |
| --- | --- | --- |
| 区间 | `range` | `{ from, to, days, timeZone }` |
| 总量 | `activeMs` `netActiveMs` `waitMs` `waitShare` | 毫秒；waitShare = wait / (net + wait) |
| 会话 | `sessions` `conversations` `turns` `steps` | 计数；conversations = 有步骤的会话 |
| Token | `tokensTotal` `tokensInput` `tokensOutput` `tokensCacheRead` `tokensCacheWrite` | Token 数 |
| Token 结构 | `inputShare` `outputShare` `cacheReadShare` `cacheWriteShare` `cacheHitRate` | 0–1 占比 |
| 均值 | `avgOutputTokensPerTurn` `avgSessionActiveMs` `avgTurnsPerConversation` `avgStepsPerTurn` | Token / 毫秒 / 轮 / 步 |
| 会话时长 | `durationUnder15mShare` `duration15to60mShare` `duration1to3hShare` `durationOver3hShare` `durationSampleSessions` | 4 桶占比（样本来自 bySession，≤300 行） |
| 时刻 | `activeHours24` | `{ unit: "tokens", values: number[24] }` |
| 时段活跃 | `bandNightActiveShare` `bandMorningActiveShare` `bandForenoonActiveShare` `bandAfternoonActiveShare` `bandEveningActiveShare` | 0–6 / 6–9 / 9–12 / 12–18 / 18–24 的活跃占比 |
| 时段 Token | `bandNightTokenShare` … `bandEveningTokenShare` | 同一分段的 Token 占比 |
| 工作区 | `byWorkspace` `workspaceCount` `topWorkspaceShare` `workspaceSwitchCount` | 前 5 项 `{ name, share }`；切换次数按会话创建时间近似 |
| 模型 | `byModel` `modelCount` `topModelShare` `multiModel` | 前 5 项；modelCount 不受 Top5 截断 |
| 周末 / 夜间 | `weekendShare` `nightShare` | 0–1；night = 22:00–06:00 |
| 趋势 | `trendDays` `trendActivePrevMs` `trendActiveLastMs` `trendActiveDeltaPct` `trendTokensPrev` `trendTokensLast` `trendTokensDeltaPct` | 近 7 天 vs 前 7 天；区间不足 14 天或前 7 天无数据时后 6 个为 `null` |

**不发送**：对话正文、消息内容、会话标题、cwd / 路径原文、会话 id、任何事件日志。
测试会构造带标题与 cwd 的快照，断言序列化后的 payload 不含它们、字符串值不含路径，并断言键集合严格等于白名单。
`byWorkspace.name` / `byModel.name` 只保留显示名最后一段。

## 3. Prompt（结构化 + 数字举证）

系统提示（`systemPrompt(lang)`）明确：

- 你是**资深生产力分析师**，只依据给定数字写画像；禁止编造项目、对话、文件或经历。
- 每条 `insight` **必须引用数字**（如「午后 34%」「单会话 42 m」）；没有数字视为不合格。
- 禁止空泛建议（「注意休息」「保持专注」）；每条建议的 `why` 必须给出数字依据。
- 只输出一个**严格 JSON** 对象；不要 Markdown、不要代码围栏、不要解释。
- 字段：「可用键」清单 + 单位说明（`*Ms` / `*Tokens` / `*Share` / `*Count` / `null`）。

```json
{
  "headline": "一句话画像，≤30字",
  "dimensions": [
    {
      "key": "rhythm|focus|stack|collab|trend",
      "title": "≤8字",
      "insight": "≤60字，必须含数字",
      "evidence": "≤40字，列出引用的数字"
    }
  ],
  "advice": [{ "text": "≤40字", "why": "≤40字，数字依据" }],
  "risk": "≤40字或 null"
}
```

`dimensions` 4–6 条，`advice` 2–3 条；`risk` 只在数字显示确有风险时填写。

## 4. 解析（四条路径）

1. **干净 JSON**：去掉 BOM / 空白后直接 `JSON.parse`；
2. **围栏 / 三引号**：先剥掉 json 代码围栏或三引号包裹再解析；
3. **宽松提取**：前后夹解释文字时，取第一个 `{` 到最后一个 `}` 再解析；
4. **失败降级**：仍失败 → `AI_PARSE_FAILED`，原始输出前 300 字放进 `diagnostic.excerpt`，
   路由降级为本地规则画像。

归一化时统一裁剪长度（headline 30 / title 8 / insight 60 / evidence 40 / advice 40 / risk 40），
并要求 4–6 个合法维度、每条 insight 含数字、2–3 条建议；不满足即降级（不猜）。

## 5. 触发与缓存

- 前端挂载时先 `GET /profile?probe=1`：只回答 `enabled / available / signedIn`，**不生成、不调用模型**。
- 点击「生成画像」才 `GET /profile?...`；再次点击是「重新生成」，带 `force=1`。
- 指纹：白名单对象**稳定 JSON（键排序）**的 SHA-256 前 16 位；新增字段自动参与指纹。
- 缓存文件：与索引同目录，`<索引基名>-ai-<lang>-<指纹>.json`（`PROFILE_CACHE_VERSION = 3`）；
  先写 `.tmp` 再 `rename` 原子替换。
- 指纹 + 语言相同且在 `cacheTtlMs` 内 → 直接返回缓存，**不再调用模型**；`force=1` 跳过读缓存但仍更新缓存。
- 同指纹并发请求共享一次生成（`inflight`），双击不会重复调用。
- 缓存只存生成结果、指纹与本次诊断字段（`route / precheck / diagnostic / costHint`），不存 payload 本身。
- 调试覆盖（`provider=` / `model=`）不读也不写缓存，避免一次试跑污染正常路径。

## 6. 调用与降级

```js
const call = await llm.prepareCall({ provider, model, temperature: 0.35, maxTokens: 1600 }, signal);
for await (const chunk of call.stream({ ...call.config, system, messages, signal })) {
  // text-delta → 累积文本；usage → 记录 input/output；finish.kind === "stop" → 成功
}
```

成功时响应额外带 `costHint: { inputTokens, outputTokens }`（只报本次旁路调用的 token 数，不猜价格）。

超时用 `AbortSignal.timeout(timeoutMs)`，并再挂一个普通 timer 兜底，路由绝不悬挂；
该路由是**旁路调用**，不持有快照 / 报告锁，不阻塞 `/snapshot` 与 `/report.html`。

| code | 触发条件 | 返回 |
| --- | --- | --- |
| `AI_PROFILE_DISABLED` | 配置关闭 | `{ enabled: false }`，零服务调用 |
| `LLM_UNAVAILABLE` | 宿主没有 llm 服务 | 本地规则版 |
| `ACCOUNT_SIGN_IN_REQUIRED` | 无 provider / 无可用模型 | 本地规则版 + 前端「未登录」提示 |
| `MISSING_CREDENTIAL` | provider 未注册 / 缺凭据 | 本地规则版 |
| `AI_TIMEOUT` | 超过 timeoutMs | 本地规则版 |
| `AI_NOT_STOPPED` | finish.kind ≠ stop | 本地规则版 |
| `AI_PARSE_FAILED` | 无 JSON / 维度不足 / 缺数字 / 缺建议 | 本地规则版 + `diagnostic.excerpt` |
| `AI_EMPTY_RESULT` | 模型输出空文本 | 本地规则版 |
| `AI_FAILED` | 其他异常 | 本地规则版 |

本地规则版（`source: "local"`）由纯统计生成**同构结构**：`headline + dimensions(4–6) + advice(2–3) + risk`，
每条 insight 也带数字，降级时与 AI 版观感一致。成功时 `source: "llm"`。
两种结果都记录 `usage: { input, output, total }`、`costHint` 与 `generatedAt`，卡片小字显示。

## 7. 诊断（失败时定位真实原因）

失败时 `/profile` 仍然返回 200 + 本地规则版，但额外带诊断字段：

| 字段 | 内容 |
| --- | --- |
| `diagnostic` | `{ source: "local", code: <映射码>, error: { code, message, stage } }`；`error.code` 是**底层原始码**（如 `PROVIDER_NOT_FOUND`） |
| `diagnostic.excerpt` | 仅解析失败：模型原始输出前 300 字（不含会话数据） |
| `route` | `{ provider, model, origin }`；`origin` = `config` / `agentDefaultModel`，调试覆盖时为 `query` |
| `precheck` | `{ providers: [...], models: [...前 10] }`；分别是 `listProviders()` / `listModels(provider)` 的结果 |

- `diagnostic.error.message` 已脱敏：token / key / secret / bearer 等词与明文密钥替换为 `[redacted]`，
  并压到 **≤300 字符**；只用于排查，不进入 UI 文案。
- `stage` 标记失败阶段（按调用链）：

| stage | 触发点 | 典型 code |
| --- | --- | --- |
| `route` | 路由解析 / provider 未注册 / 没有默认模型 | `MISSING_CREDENTIAL`、`ACCOUNT_SIGN_IN_REQUIRED` |
| `precheck` | `listProviders` 为空 / `listModels` 为空或抛错 | `ACCOUNT_SIGN_IN_REQUIRED`、`LLM_UNAVAILABLE` |
| `prepareCall` | `llm.prepareCall()` 抛错 | 底层原码（如 `PROVIDER_NOT_FOUND`） |
| `stream` | 消费 `stream` 时抛错 | 底层原码 |
| `finish` | 非 `stop` 结束 / 空输出 | `AI_NOT_STOPPED`、`AI_EMPTY_RESULT` |
| `parse` | `parseProfileText()` 失败 | `AI_PARSE_FAILED` |

超时按**卡住时所处阶段**标注（例如卡在 `prepareCall` → `stage=prepareCall`）。

`/health` 的 `diagnostics.aiProfile` 给最近一次生成的快照（字段固定）：

```json
{
  "enabled": true,
  "lastCode": "AI_FAILED",
  "lastStage": "prepareCall",
  "lastError": "upstream [redacted]",
  "lastAt": 1760000000000,
  "route": { "provider": "magpie", "model": "workbuddy-ai/default-model", "origin": "agentDefaultModel" }
}
```

排查示例：

```bash
# 1) 看真实错误（底层 code / message / stage + route / precheck）
curl -s 'http://127.0.0.1:3080/workload-report/v1/profile?days=30&force=1'

# 2) 指定 provider/model 试跑（不写配置、不需要重启、不写缓存）
curl -s 'http://127.0.0.1:3080/workload-report/v1/profile?days=30&force=1&provider=deepseek-official&model=deepseek-flash'

# 3) 一条命令看全最近一次结果
curl -s 'http://127.0.0.1:3080/workload-report/v1/health'
```

## 8. 前端状态与渲染结构

| 状态 | 表现 |
| --- | --- |
| 未启用 | 整卡不渲染（probe 到 `enabled:false`） |
| 未登录 | 卡片可见，显示「未登录：请在 DeepSeek 账号中登录（当前使用本地规则版）」，**不做跳转** |
| 生成中 | 按钮禁用，显示「生成中…」 |
| AI 生成 | 徽标「AI 生成」+ headline / dimensions / advice / risk + usage / 时间 |
| 本地规则版 | 徽标「本地规则版」+ 对应 code 原因 + 同样的结构 + 时间 |

卡片结构（`src/client/profile-card.jsx` + `src/profile-view.js`）：

1. 顶部大字 `headline`（18px / 650）；
2. 维度列表：标题（≤8 字）+ 结论（≤60 字，含数字）+ 一行灰色证据小字（≤40 字）；
3. 有 `risk` 时显示浅色警示条（左侧琥珀色描边）；
4. 建议 2–3 条，每条带灰色 `why` 小字；
5. 来源徽标、usage / costHint、生成时间、重新生成按钮保留。

`profileSections()` 对 AI / 本地 / 旧 `traits` 缓存做同构归一化，并在客户端再裁剪一次长度。

## 9. 报告与 Token 口径

- **静态 HTML 报告不展示画像**（见 `docs/report-parity.md` 的「有意不同」）：导出文件面向客户 / 打印，
  不应夹带 AI 对个人的判断；报告继续保持无脚本、自包含。
- AI 调用是**旁路辅助调用**，不写入任何会话事件，因此**不计入本插件的 Token / 费用报表**；
  卡片上单独显示这次调用的 input/output tokens（`usage` / `costHint`）与生成时间。

## 10. 验证

`test/verify.mjs` 覆盖：

- payload 顶层 56 键严格等于白名单、子结构白名单、标题 / 路径 / 私有键不外发；
- 时段 / 会话时长 / Token 结构 / 工作区 / 等待 / 趋势 / 模型字段的派生值与守恒；
- 趋势 14 天窗口的环比、不足 14 天时为 `null`；
- 本地规则与 AI 同构：headline / 4–6 维度 / 2–3 建议 / risk，每条 insight 含数字且长度受限；
- 解析四路径（干净 JSON / 围栏 / 宽松提取 / 失败降级 + `diagnostic.excerpt`），以及缺数字 / 维度不足 / 建议不足；
- prompt 含「引用数字」「可用键」与完整 schema；`maxTokens=1600`、`temperature=0.35`、不指定 `reasoningEffort`；
- 前端渲染结构（headline / dimensions / evidence / advice / risk / 来源徽标 / usage / 重生成）与样式；
- 默认关闭零服务调用、指纹缓存、`force=1`、五种失败降级、诊断脱敏与 `/health.aiProfile`；
- i18n zh/en 逐键对齐、无死键。
