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
      maxTokens: 900
      timeoutMs: 60000      # AbortSignal.timeout(timeoutMs)
      cacheTtlMs: 86400000  # 指纹缓存 24h；0 = 不落盘
```

路由优先级：`aiProfile.provider/model`（两者都非空）→ 宿主 `agentDefaultModel.currentSelection()`。
调用前用 `llm.listProviders()` / `llm.listModels(provider)` 预检；空列表即未登录 / 无 key。
**不指定 `reasoningEffort`**（部分模型不支持 off）。

**调试入口**：`GET /profile?...&provider=<id>&model=<id>` 只覆盖本次请求的路由，
仅在 `aiProfile.enabled=true` 时生效；不写配置、不需要重启，也**不读 / 不写指纹缓存**。
`origin` 会标记为 `query`，正常路径仍是 `config` / `agentDefaultModel`。

## 2. 发送的数据（白名单）

白名单定义在 `src/ai-profile.js` 的 `PROFILE_PAYLOAD_KEYS`，构造后立即断言顶层键集合严格相等。

| 键 | 来源 | 说明 |
| --- | --- | --- |
| `range` | `snapshot.range` | 只含 `from / to / days / timeZone` |
| `activeMs` | `totals.netActiveMs` | 净活跃（不含等待） |
| `netActiveMs` | `totals.netActiveMs` | 同上，保留同名口径 |
| `waitMs` | `totals.waitMs` | 等待用户 |
| `conversations` | `totals.conversations` | 对话次数 |
| `turns` | `totals.turns` | 轮次 |
| `steps` | `totals.steps` | 步骤 |
| `tokensTotal` | `totals.tokensTotal` | 总 Token |
| `cacheHitRate` | `derived.cacheHitRate` | 0–1 |
| `activeHours24` | `byHour[].tokensTotal` | `{ unit: "tokens", values: number[24] }`，**Token 口径** |
| `byWorkspace` | `byWorkspace` 前 5 | `{ name, share }`；name 只取显示名最后一段（不含完整路径） |
| `byModel` | `byModel` 前 5 | `{ name, share }`；模型显示名 + Token 占比 |
| `weekendShare` | `byDay[].activeMs` | 周六 / 周日活跃时长占比 |
| `nightShare` | `byHour[].activeMs` | 22:00–06:00 活跃时长占比 |

**不发送**：对话正文、消息内容、会话标题、cwd / 路径原文、会话 id、任何事件日志。
测试会构造带标题与 cwd 的快照，断言序列化后的 payload 不含它们，并断言键集合严格等于白名单。

## 3. 触发与缓存

- 前端挂载时先 `GET /profile?probe=1`：只回答 `enabled / available / signedIn`，**不生成、不调用模型**。
- 点击「生成画像」才 `GET /profile?...`；再次点击是「重新生成」，带 `force=1`。
- 指纹：白名单对象**稳定 JSON（键排序）**的 SHA-256 前 16 位。
- 缓存文件：与索引同目录，`<索引基名>-ai-<lang>-<指纹>.json`（`PROFILE_CACHE_VERSION = 2`）；
  先写 `.tmp` 再 `rename` 原子替换。
- 指纹 + 语言相同且在 `cacheTtlMs` 内 → 直接返回缓存，**不再调用模型**；`force=1` 跳过读缓存但仍更新缓存。
- 同指纹并发请求共享一次生成（`inflight`），双击不会重复调用。
- 缓存只存生成结果、指纹与本次诊断字段（`route / precheck / diagnostic`），不存 payload 本身。
- 调试覆盖（`provider=` / `model=`）不读也不写缓存，避免一次试跑污染正常路径。

## 4. 调用与降级

```js
const call = await llm.prepareCall({ provider, model, temperature: 0.4, maxTokens }, signal);
for await (const chunk of call.stream({ ...call.config, system, messages, signal })) {
  // text-delta → 累积文本；usage → 记录 input/output；finish.kind === "stop" → 成功
}
```

超时用 `AbortSignal.timeout(timeoutMs)`，并再挂一个普通 timer 兜底，路由绝不悬挂；
该路由是**旁路调用**，不持有快照 / 报告锁，不阻塞 `/snapshot` 与 `/report.html`。

| code | 触发条件 | 返回 |
| --- | --- | --- |
| `AI_PROFILE_DISABLED` | 配置关闭 | `{ enabled: false }`，零服务调用 |
| `LLM_UNAVAILABLE` | 宿主没有 llm 服务 | 本地规则版 |
| `ACCOUNT_SIGN_IN_REQUIRED` | 无 provider / 无可用模型 | 本地规则版 + 前端「去登录」提示 |
| `MISSING_CREDENTIAL` | provider 未注册 / 缺凭据 | 本地规则版 |
| `AI_TIMEOUT` | 超过 timeoutMs | 本地规则版 |
| `AI_NOT_STOPPED` | finish.kind ≠ stop | 本地规则版 |
| `AI_PARSE_FAILED` | 无 JSON / 特征少于 3 条 / 缺建议 | 本地规则版 |
| `AI_EMPTY_RESULT` | 模型输出空文本 | 本地规则版 |
| `AI_FAILED` | 其他异常 | 本地规则版 |

本地规则版（`source: "local"`）由纯统计生成 **3–5 条特征 + 1 条建议**，每条 ≤40 字符，
覆盖工作节奏 / 任务偏好 / 技术栈倾向 / 协作模式，不联网。成功时 `source: "llm"`。
两种结果都记录 `usage: { input, output, total }` 与 `generatedAt`，卡片小字显示。

## 5. 诊断（失败时定位真实原因）

失败时 `/profile` 仍然返回 200 + 本地规则版，但额外带三个诊断字段：

| 字段 | 内容 |
| --- | --- |
| `diagnostic` | `{ source: "local", code: <映射码>, error: { code, message, stage } }`；`error.code` 是**底层原始码**（如 `PROVIDER_NOT_FOUND`），不会被 `AI_FAILED` 吞掉 |
| `route` | `{ provider, model, origin }`；`origin` = `config` / `agentDefaultModel` / `listProviders`，调试覆盖时为 `query` |
| `precheck` | `{ providers: [...], models: [...前 10] }`；分别是 `listProviders()` / `listModels(provider)` 的结果，失败时为空数组 |

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

## 6. 前端状态

| 状态 | 表现 |
| --- | --- |
| 未启用 | 整卡不渲染（probe 到 `enabled:false`） |
| 未登录 | 卡片可见，显示「未登录：请在 DeepSeek 账号中登录（当前使用本地规则版）」，**不做跳转** |
| 生成中 | 按钮禁用，显示「生成中…」 |
| AI 生成 | 徽标「AI 生成」+ 特征 / 建议 + usage / 时间 |
| 本地规则版 | 徽标「本地规则版」+ 对应 code 原因 + 特征 / 建议 + 时间 |

卡片结构复用 `CardHead`（标题 + 右侧 hint + 右上按钮）和 `.wl-hint` / `.wl-status`，不另造卡片头。

## 7. 报告与 Token 口径

- **静态 HTML 报告不展示画像**（见 `docs/report-parity.md` 的「有意不同」）：导出文件面向客户 / 打印，
  不应夹带 AI 对个人的判断；报告继续保持无脚本、自包含。
- AI 调用是**旁路辅助调用**，不写入任何会话事件，因此**不计入本插件的 Token / 费用报表**；
  卡片上单独显示这次调用的 input/output tokens 与生成时间。

## 8. 验证

`test/verify.mjs` 覆盖：

- payload 顶层 / 子结构白名单、标题与路径不外发；
- 指纹稳定、统计变化后指纹变化；
- 本地规则 3–5 条 + 1 条建议、每条 ≤40 字符，中英各一套；
- 解析器接受代码围栏、拒绝少于 3 条 / 非 JSON；
- 默认关闭零服务调用（`ctx.get` 与 `prepareCall` 都为 0）；
- 缓存命中第二次模型调用次数仍为 1，`force=1` 才 +1；
- `LLM_UNAVAILABLE` / `ACCOUNT_SIGN_IN_REQUIRED` / `AI_PARSE_FAILED` / `AI_NOT_STOPPED` / `AI_TIMEOUT` 五条降级；
- 默认模型回落（`agentDefaultModel.currentSelection()`）与 `route.origin`；
- 失败诊断：底层 code 保留（`PROVIDER_NOT_FOUND`）、`stage=prepareCall`、`route` / `precheck` 可见；
- 脱敏：message 不含 key / token 字样与明文密钥，且 ≤300 字符；
- 调试覆盖：`provider=` / `model=` 真正传给 `prepareCall`，且不写缓存；
- 现场场景：默认 provider 不在 `listProviders` 里时，`route` 仍显示 magpie、`precheck` 暴露已注册列表；
- `/health.diagnostics.aiProfile` 字段固定且与最近一次生成同源；
- i18n zh/en 逐键对齐、无死键。
