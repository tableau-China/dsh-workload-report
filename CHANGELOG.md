# CHANGELOG — dsh-workload-report

## 未发布（2026-10-20）— 画像卡右列 + 首开提示 + 30 天窗口

### 问题

- 画像卡与主要会话表在同一列纵向排列，宽屏下右半屏空着；用户不容易把它当成"主要会话"的补充视角。
- 首次打开就直接显示「生成画像」按钮，缺少"只发聚合统计 / 用哪个模型 / 点击才计费"的说明。
- 看板选 7 天时画像也只汇总 7 天，画像样本太薄；且功能默认关闭，多数用户看不到。

### 变更

- **两列布局**：主要会话页改为 `wl-session-layout` grid —— 会话表左约 2fr、画像卡右约 1fr，
  两者是同一行的兄弟；画像卡顶部对齐、保持特别底色；`<=1080px` 回落为上下堆叠（会话在上、画像在下）。
  画像关闭（ProfileCard 返回 null）时 `:has` 不命中，会话表自动占满整行。布局参数集中在 `SESSION_LAYOUT`。
- **首开提示面板**：尚无结果时显示三行提示（只发近 N 天聚合统计 / provider+model（未知显示宿主默认）/
  点击后才调用模型并产生费用）+「生成画像」主按钮；打开面板只做 probe，`llm.prepareCall` 保持 0；
  生成后提示面板消失、显示结果，右上「重新生成」。
- **汇总窗口下限**：新增 `aiProfile.minDays`（默认 30）；`/profile` 的 `days` 抬到
  `max(days, minDays)`，`all` / `from` / `to` 压小窗口时再校正一次；响应新增 `summaryDays`，
  结果卡标注「基于近 N 天汇总」。
- **默认包含**：`AI_PROFILE_DEFAULTS.enabled` 改为 `true`（只有显式 `false` 才隐藏入口），
  但仍保持"只有点击才调用模型"；`minDays` 可配置覆盖。
- **文档**：README 中英、`docs/ai-profile.md`、`docs/ui-conventions.md`、`docs/report-parity.md` 同步
  「默认包含 / 手动触发 / 只发聚合统计 / 窗口至少 30 天 / 旁路调用不计入 Token 报表」。

### 测试

- 离线断言 **996 项**（连跑 2 次 exit 0）：两列几何（画像左边界 > 会话右边界、宽度比 2:1、窄屏堆叠）、
  首开 `prepareCall` = 0 / 点击后 = 1、提示面板三行与 provider/model 占位、生成后提示消失、
  `days=7` 时 payload `>= 30`、`minDays` 覆盖、默认 `enabled=true`、显式 false 隐藏、i18n 逐键对齐无死键。
- 真机截图 `.tmp/shots/profile-layout-notice.png` / `profile-layout-result.png`。

## v0.7.1（2026-10-20）— 画像卡移到会话表之后 + 截断抢救（去掉 maxTokens）

### 问题

- 现场报 `AI_NOT_STOPPED`（「模型未正常结束，已用本地规则」）：画像要求严格 JSON，旧版
  `prepareCall` 固定传 `maxTokens: 1600`，长输出被截断后 `finish.kind=length`、JSON 不完整。
- 画像卡原先在「按日期」页末尾，与「主要会话」表分离；标题只叫「用户画像」。

### 变更

- **布局**：`ProfileCard` 移到「主要会话」页，紧随会话表；同一滚动流，由
  `src/client/session-layout.js` 的 `SESSION_PAGE_SECTIONS = ["sessions", "profile"]` 单一事实源渲染。
- **标题**：zh「AI 用户画像」/ en「AI user profile」，zh/en 同步替换，不留旧键。
- **特别底色**：`.wl-profile-card` 用 `--dsw-alias-bg-layer-2` 叠 6% `--dsw-static-deepseek-500`，
  深色 / 浅色都跟随宿主主题；边框同色 16%。只用 token，不写死色值。
- **移除 `maxTokens`**：默认配置与 `prepareCall` 参数都不再传；配置里即使写了也忽略（代码注释说明原因）。
- **截断抢救**：`finish.kind=length / max-tokens` 或文本明显未收尾时，`repairProfileJson()` 补齐
  未闭合的字符串 / 数组 / 对象括号（必要时回退到上一个逗号边界丢掉半截键值）后再解析；
  成功标记 `truncated: true`，失败才降级 `AI_NOT_STOPPED`。
- **诊断增强**：`diagnostic` 记录 `finish.kind`、`textLength`、`repaired`、`excerpt`（前 300 字）。
- **UI 提示**：`truncated` 时卡片底部小字「输出被截断，已修复采用」（新键 `profile.truncated`）。
- **缓存**：`PROFILE_CACHE_VERSION` 3 → **4**（新增 truncated / diagnostic 字段）。

### 测试

- 离线断言 **942 项**（连跑 2 次 exit 0）：新增 prepareCall 参数不含 maxTokens（spy 捕获）、
  可修复截断 → source=llm + truncated=true、不可修复 → local + AI_NOT_STOPPED + diagnostic 字段、
  DOM 顺序（会话表 → 画像卡）、标题、底色声明与普通卡片不同、i18n 逐键对齐无死键。
- 真机截图 `.tmp/shots/profile-light.png` / `profile-dark.png`，并记录深浅色卡片计算背景。

## v0.7.0（2026-10-20）— AI 画像质量提升：数字举证 + 结构化渲染

### 问题

用户反馈画像「比较简单」：只有 5 条泛泛特征 + 1 条建议，缺乏数据支撑与差异化。根因是
① 发给模型的聚合字段只有 14 个，且没有时段 / 会话结构 / 趋势对比；② prompt 没要求结构化输出与数字举证；
③ `maxTokens` 只有 900，`temperature` 0.4。

### 变更

- **白名单 14 → 56 个键**：新增时段结构（5 段活跃 + Token 占比）、会话结构（会话数、平均会话时长、
  <15m / 15–60m / 1–3h / >3h 四桶、平均轮次 / 步骤）、Token 四分量与占比、平均每轮输出、平均会话时长、
  工作区数 / Top1 占比 / 切换次数、waitShare、近 7 天 vs 前 7 天环比（不足 14 天为 `null`）、
  模型数 / Top1 占比 / 多模型标记。全部从 `present(aggregate(...))` 快照派生，不新增数据源。
- **隐私断言加严**：键集合严格相等之外，递归拒绝 title / cwd / path / sessionId / prompt / content /
  message / text 等私有键、路径分隔符、换行与超长字符串；`byWorkspace.name` / `byModel.name` 只留显示名。
- **Prompt 重写**：资深生产力分析师；每条 insight **必须引用数字**；禁止空泛建议；只输出严格 JSON
  （`headline / dimensions(4–6) / advice(2–3) / risk`），并附「可用键」与单位说明。
  `maxTokens` 900 → **1600**，`temperature` 0.4 → **0.35**，仍不指定 `reasoningEffort`。
- **解析四路径**：干净 JSON → 代码围栏 / 三引号 → 首个 `{` 到最后一个 `}` 宽松提取 → 仍失败才降级
  `AI_PARSE_FAILED`，原始输出前 300 字放进 `diagnostic.excerpt`。维度不足 / 结论缺数字 / 建议不足都视为失败。
- **本地规则同构**：本地版也输出 headline + 4–6 维度 + 2–3 建议 + risk，每条 insight 带数字，
  失败降级时卡片观感与 AI 版一致。
- **前端卡片**：顶部大字 headline；维度列表（标题 + 含数字结论 + 灰色证据小字）；2–3 条建议（带 why）；
  有 risk 时浅色警示条；保留来源徽标 / usage / 生成时间 / 重新生成按钮。新增 `src/profile-view.js`
  做同构归一化与客户端长度兜底。
- **成本与缓存**：响应新增 `costHint: { inputTokens, outputTokens }`（不猜价格）；新增字段自动参与指纹；
  `PROFILE_CACHE_VERSION` 2 → **3**（旧缓存自动失效重算）。
- **版本与文档**：`package.json` 0.6.6 → **0.7.0**；`docs/ai-profile.md` 重写白名单 / prompt / 解析 /
  渲染章节；README 中英同步；截图 `.tmp/shots/profile-ai-light.png` / `profile-ai-dark.png` /
  `profile-local-light.png`。

### 测试

- 离线断言 **906 项**（连跑 2 次 exit 0）：白名单 56 键严格相等、新增字段守恒与趋势 null 语义、
  隐私键 / 路径不外发、本地画像同构与长度上限、解析四路径 + 三种拒绝、prompt 约束、前端渲染结构与样式、
  指纹缓存、`costHint`、五种失败降级、诊断脱敏、`/health.aiProfile` 字段固定。
- 运行实例当前仍是旧版（`traits`），未重启 DSH；本轮生成路径以 verify 的 llm 桩为准（usage 12/34）。

## 未发布（2026-10-20）— AI 画像诊断增强：保留真实错误 + 路由可见

### 问题

用户开启 `aiProfile.enabled=true` 后，`GET /profile` 返回 `enabled:true, source:local, code:AI_FAILED, usage 全 0`，
但通用码 `AI_FAILED` 吞掉了真实原因；宿主默认模型被覆盖为自定义网关（provider 可能不在 `listProviders()` 里），
从响应无法判断失败发生在路由、预检还是 `prepareCall`。

### 变更

- **失败诊断**：`/profile` 失败响应新增 `diagnostic: { source, code, error: { code, message, stage } }`。
  `diagnostic.code` 仍是稳定映射码；`diagnostic.error.code` **保留底层原始码**（如 `PROVIDER_NOT_FOUND`），
  message 脱敏（token / key / secret / bearer 与明文密钥 → `[redacted]`）并压到 **≤300 字符**。
- **路由可见**：新增 `route: { provider, model, origin }`（`config` / `agentDefaultModel` / `listProviders`，
  调试覆盖为 `query`）与 `precheck: { providers, models(前 10) }`；listProviders / listModels 失败时给空数组。
- **失败阶段**：`stage` = `route` / `precheck` / `prepareCall` / `stream` / `finish` / `parse`。
- **/health**：`diagnostics.aiProfile = { enabled, lastCode, lastStage, lastError, lastAt, route }`，
  与最近一次 `/profile` 生成同源。
- **调试入口**：`/profile?provider=&model=` 仅覆盖本次请求，仅 `enabled=true` 生效；不写配置、不需要重启，
  也不读 / 不写指纹缓存；文档标注为调试入口。
- **行为不变**：仍然失败即降级本地规则版（3–5 条特征 + 1 条建议）；缓存格式升到 `PROFILE_CACHE_VERSION = 2`
  （新增诊断字段，旧缓存自动失效重算）。
- **文档**：`docs/ai-profile.md` 新增「诊断」章节（stage 表 + 三条排查命令）；README 中英同步。

### 测试

- 离线断言 **680 → 731**（连跑 2 次 exit 0）：底层 code 保留、stage=prepareCall、route / precheck、
  脱敏（无 key / token 字样）与 300 字符截断、provider/model 查询覆盖（且不写缓存）、
  默认路径仍 3–5 条 + 1 建议、现场场景（默认 provider 不在 listProviders）、`/health.aiProfile` 字段固定。

## 未发布（2026-10-20）— AI 用户画像：默认关闭 + 白名单 + 本地降级

### 变更

- **AI 用户画像（可选，默认关闭）**：按日期页新增 `ProfileCard`（复用 `CardHead`，右上「生成画像 / 重新生成」）。
  只有点击才生成；生成中按钮禁用；状态含未启用（整卡不渲染）/ 未登录（给「去登录」文案，不跳转）/
  AI 生成 / 本地规则版。特征 3–5 条 + 建议 1 条，每条 ≤40 字符。
- **白名单 payload**：`src/ai-profile.js` 的 `PROFILE_PAYLOAD_KEYS` 严格 14 个键，构造后断言键集合相等；
  只发区间、活跃 / 等待、对话 / 轮次 / 步骤、Token、缓存命中率、24 小时 Token、工作区前 5（名称 + 占比）、
  模型前 5（名称 + 占比）、周末与夜间占比。**不发**对话正文、标题、cwd / 路径、会话 id、事件日志。
- **缓存**：白名单稳定 JSON 的 SHA-256 前 16 位；与索引同目录、原子写；指纹 + 语言相同直接返回，
  第二次请求不再调用模型；`force=1` 重新生成。
- **降级**：llm 缺失 / 未登录 / 超时 / 非 stop / 空输出 / 解析失败 → 本地规则版，返回稳定 `code`，
  不向 UI 抛错；`AbortSignal.timeout(timeoutMs)` 覆盖预检 + 调用，路由不悬挂。
- **旁路与报告**：AI 调用不写入任何会话事件，**不计入本插件 Token 报表**；卡片单独显示 usage 与生成时间。
  静态 HTML 报告**不展示**画像（见 `docs/report-parity.md` 的「有意不同」）。
- **文档**：新增 `docs/ai-profile.md`；README 中英新增「AI 用户画像」章节、配置、API 与隐私说明；
  `index.js` 顶部注释改为「默认零外发；可选功能（余额 / AI 画像）开启后才会请求」。

### 测试

- 离线断言 **595 → 680**（连跑 2 次 exit 0）：白名单键集合 / 标题与路径不外发 / 指纹稳定 /
  本地规则 3–5 条 + 1 条建议 / 解析器 / 默认关闭零服务调用 / 缓存命中不重复调用 /
  `LLM_UNAVAILABLE`、`ACCOUNT_SIGN_IN_REQUIRED`、`AI_PARSE_FAILED`、`AI_NOT_STOPPED`、`AI_TIMEOUT` 降级 /
  默认模型回落 / i18n 对齐与无死键 / 报告不含画像。
- `INDEX_VERSION` 保持 7（画像缓存独立，不改索引行结构）。

## 未发布（2026-10-20）— 打开性能：零折叠 + 三态状态 + 耗时指标

### 变更

- **打开面板不再触发模型折叠**：`snapshot()` / `sync()` 都不调用 `scheduleModelFold()`；改由索引就绪预热、
  12 分钟例行维护、60 秒空闲/转冷检查驱动。打开 5 次面板读日志次数：159 → 0。
- **折叠 phase 三态**：`first-fold`（本轮含从未折过的会话）显示「正在计算中……」；
  `background`（已有数据的重折/重试）只显示灰点「后台更新中」；`idle` 且 N>0 显示「Token 未计入 N 个会话」。
  失败行 `failedRows` 永不参与状态判断，重试降到 30 分钟一次。
- **活会话节流**：距上次事件 ≥ 10 分钟才按空闲重折，事件增量仍以 50 为阈值。
- **缓存**：快照缓存 TTL 5s → 15s（同参数同 query），活会话事件 / 索引刷新 / 折叠完成立即失效；
  客户端 SWR 保留，首屏先渲染上次结果。
- **指标**：`/health` 与 `/snapshot.diagnostics` 新增 `snapshotMs`、`snapshotCache`（命中/未命中/命中率/TTL）、
  `foldRoundMs`、`foldSessionsRead`、`foldRounds` 等；新增 `test/bench-open.mjs`（`pnpm bench:open`）。
- **聚合性能**：`Intl.DateTimeFormat` 按时区缓存，500 会话冷开 449 → 25 ms；热开 2.86 → 1.12 ms。

### 测试

- 离线断言 **567 → 595**（连跑 2 次 exit 0）：打开零折叠、缓存命中率/TTL、折叠三态、失败重试窗口、
  指标字段、background 样式；E2E 新增三态 DOM 断言与截图。

## v0.6.6（2026-10-17）— 报告对齐看板 + report-parity 机制 + 文档/截图更新

### 变更

- **每日用量趋势 tooltip 逐元素补齐**：日历每格、每日柱、周几累计条、周几轴、Year-Week 标签都有
  直接挂在形状/文字上的原生 `<title>`（不挂 `<g>`）；柱状图每列新增全高透明命中区
  （`data-kind="active-bar-hit"`），0 值/1px 柱也能稳定 hover。文案统一为单行
  `日期 · 活跃 x · Token y[ · 周末]`，周末由本地日期判定。
- **chips 组件化**：新增 `src/client/chips.jsx` 的 `ChipGroup` / `Chip`，顶部时间范围、
  每日用量、时刻分析、工作区占比、模型用量五处共用；默认态为 7% 强调色 + `bg-layer-2` 的浅底 +
  `border-l2` 边框，选中态为 `static-deepseek-500` 实底 + 白字；尺寸/圆角/间距只在
  `styles.js` 定义一次。删除 `wl-chip-active` / `wl-chips-inline` 等变体。
- **工作区占比切换移到右上角**：`按时长 / 按 Token` 与「时刻分析」的 chips 同位置、同样式；
  `WorkspacePie` 改为受控（metric 由卡片状态传入），不再在图形内部渲染开关。
- **模型用量 chips 统一底色**：`按 Token / 按请求数 / 按模型耗时` 改用同一套 chip，
  默认浅底 + 边框、选中强调色实底 + 白字；清除筛选也用同组件。
- **卡片说明统一到标题右侧**：`CardHead.hint` 从"标题下方段落"改为**标题紧右侧的小字**
  （11px、muted、单行不换行，放不下省略号截断并用 `title` 保留全文；与右上 chips 之间是弹性间距，
  不挤压 chips）。每日用量趋势 / 时刻分析 / 模型 Token 占比 / 模型用量四处改用；工作区占比与骨架屏
  不再在标题下挂 hint。说明只讲"看什么"，每条 ≤ 18 个汉字（zh/en 逐键对齐、无死键）。
- **卡片头统一**：新增 `src/client/card-head.jsx` 的 `CardHead`（左标题 + 右侧说明、右上控件），
  每日用量 / 模型 Token 占比 / 时刻分析 / 工作区占比 / 模型用量五处共用；模型卡补回卡片标题。
- **时刻分析状态移到 legend 行右侧**：`Token 未计入 N 个会话` 紧跟「峰值」图例项之后、整体右对齐
  （`justify-content: space-between`）；状态判据集中到 `src/client/hour-status.js`：
  `modelFold.running` → 「正在计算中……」；空闲且 `hourTokensSource.missing > 0` → 「Token 未计入 N 个会话」；
  空闲且 N=0 → 整条不渲染。回填/重折期间继续每 5 秒轮询。
- **样式收敛**：唯一样式 class 102 → 94；`.wl-legend` 两处定义合并为一处；
  `wl-hour-note / wl-fold-error / wl-model-note / wl-model-links / wl-model-raw` 收敛到
  `.wl-status` 与 `.wl-hint-spaced / .wl-hint-block`；删除 8 条无用样式。
- **文档**：新增 `docs/ui-conventions.md`（铁律、共享组件清单、卡片头/图例/状态结构、tooltip 规则）。
- **报告补齐看板改动（本轮遗漏修正）**：`src/report-html.js` 新增 KPI「最活跃模型」、8 张 KPI / 5 列栅格、
  每日日历热力图 + 柱状图（峰值标签 / 命中区 / 1 位小数）、时刻状态行（回填中 / 未计入 N）、轮次第二小图、
  标题右侧 11px 说明、表格比例条（直接 import `barPercent`）、模型小标题与 rect tooltip；
  仍是自包含 HTML（无脚本、外链仅官方计费页）。新增 `docs/report-parity.md` 对照清单，
  `docs/ui-conventions.md` 增加「报告同步铁律」与检查项。

### 测试

- 离线断言 **535 → 545 → 566**（连跑 2 次 exit 0）：新增 chip 组件与复用点、CardHead 结构与 hint 位置、
  `hourTokensNote` 三态、tooltip 逐元素、样式收敛与 UI 约定文档断言；报告结构对齐块新增 20 项
  （密度点 / Tokens 默认口径 / 轮次小图 / 状态三态 / 标题右侧说明 / 日历 / 峰值 / 比例条 / 模型小标题 /
  KPI / 净活跃 / 自包含）；另加「报告不含余额 / 余额接口」隐私断言；i18n 死键扫描扩展到全部客户端模块。
- 无头 Chrome 1560 / 1180 量测：三处 hint 均为 11px / `rgb(129,133,140)`，与标题基线差 0px、
  相对标题左边距 60 / 86 / 104px；标题下方 hint 节点 0；chips 未换行、未被挤压。

### 发布（0.6.6）

- `package.json` 版本 **0.6.5 → 0.6.6**；`files` 白名单由 `docs/metrics.md` 改为 **`docs`**，`docs/report-parity.md` / `docs/ui-conventions.md` 等文档随 npm 包发布。
- **README 中英双语按当前真实功能重写**：8 张 KPI、数据来源与原则、功能清单、三层等待判定、时刻分析两种口径、配置项、`INDEX_VERSION = 7` 升级注意、文档索引与隐私；不再保留旧版「6 张 KPI / 533 断言」等过期表述。
- **4 张截图按当前 UI 重拍**（2x DPR）：`assets/dashboard-calendar.png` / `dashboard-workspace.png` / `report-light.png` / `report-dark.png`；报告与看板同口径（8 KPI、日历、密度点、比例条）。
- `PROGRESS.md` 追加本轮发布记录。

## v0.6.5（2026-10-17）— 时刻分析 Token 口径 + 人类消息密度；等待剔除、时长/比例条并入

### 变更

- **时刻分析默认按 Token 产出**：折叠事件时把每条 `assistant/message` 的 usage（与 `row.tokens` 同一定义：
  未命中输入 + 输出 + 缓存读 + 缓存写）按**消息时间**归到 **UTC 小时桶** → `row.hourTokens[24]`；
  `user/message` 同样按时间计数 → `row.hourHumanMsgs[24]`。聚合时用 `localHoursFromUtc` 平移到请求时区，
  `byHour` 新增 `tokensTotal`（来自 hourTokens）与 `humanMsgs`；`starts` 保留给「轮次」measure。
- **守恒**：`sum(hourTokens) === row.tokensTotal`（整数目标用最大余数法回正，不产生小数 Token，±0）；
  读不出事件的会话（v0 老日志 / 未回填 / `modelUsage: off`）没有 `hourTokens`，时间图**不计入 Token**，
  卡片与报告标注「Token 未计入 N 个会话」；`hourTokensSource { events, scaled, missing }` 进快照与
  `/snapshot.diagnostics`（与 `hourSource` 同源）。
- **索引**：`INDEX_VERSION` 6 → 7（新增 `hourTokens` / `hourHumanMsgs`；v6 行没有这两个字段，
  不换代会把时间图 Token 显示成全 0 且无法补折）。字段随行持久化，行换代时由 `carryModelFields` 搬运。
- **看板时刻卡片**：删掉标题下的小标题（`hour.sub` 键与渲染一并删除）；新增 `Tokens`（默认）/ `轮次` chips，
  柱高按当前 measure，**只在最大柱上标数值**；顶部圆点＝人类消息密度（`--dsw-static-amber-500` 一类 token，
  `r = 3.4 + ratio×5.0`，上沿恒留 14px，图表顶部预留 64px，最大圆不被裁）；
  tooltip 为 `0:00–0:59 · Token x · 轮次 n · 人类消息 m`；图例只说明颜色：`Token 产出` / `人类消息密度` / `峰值`。
- **报告**：`src/report-html.js` 的时刻图同步（默认 Tokens + 密度点 + 峰值数值 + 同款图例与未计入提示）。
- **文档**：README（中英）断言数与口径、`docs/metrics.md` 的时刻 Token / 人类消息定义同步；版本号统一为 0.6.5。

### 视觉修正（2026-10-17）

- **峰值柱改深蓝，不再与人类消息点撞色**：看板峰值柱与「峰值」图例改用 `--dsw-static-blue-600`
  （宿主计算值 `#2563eb`），人类消息点保持 `--dsw-static-amber-500`（`#f59e0b`）；报告是自包含文件，
  色板单独用预览稿深蓝 `#2f4bd8`，同样与 amber 点分离。
- **时刻卡比例**：卡片改纵向 flex（`.wl-hour-card`），图表区 `flex: 1 1 auto`、`min-height: 240px`；
  柱形区从顶部 64px 撑到底部 16px，不再写死 116px。同排工作区饼图卡随行拉伸时圆环垂直居中。
  1560×1000 下卡片 637×354、柱区 160px（占卡片 45.3%）；1180×900 下 596×354，比例一致。
- **断言**：502 → 503（新增「峰值柱/图例蓝 token、人类消息点 amber token、报告同色」断言），连跑 2 次 exit 0。

### 并入：等待用户剔除（净活跃口径）

- **问题**：「活跃时长」= `llmMs + toolMs`，而 `toolMs` 是 `tool/call → tool/result` 的墙钟间隔。
  用户用 `ask_user_question` 让 AI 等他回答，**一等 3 小时**，这 3 小时被整段算成活跃时长 → 严重虚高。
- **三层等待判定**（单次工具区间 ≥ `waitMinMs` 且满足任一条件时，整段计为 `waitMs`）：
  1. 工具名在 `waitTools` 白名单（默认 `ask_user_question` / `exit_plan_mode`，可扩展）；
  2. `tool/call → tool/result` 之间夹着 `user/message`（人类输入夹层，任意工具适用）；
  3. 短于 `waitMinMs`（默认 60s）的交互不剔除，避免碎片化。
- **长任务豁免**：没有 `user/message` 且不在白名单的长工具（编译 / 跑批）照常算工作，不误伤。
- **折叠**：`foldSessionHours` / `foldSessionModels` 在同一趟 events 里累计 `waitMs`；小时桶只累计非等待区间
  （保持「按轮次整段归起始小时」语义不变，只剔除等待）。`row.waitMs` 随索引持久化，行换代由 `carryModelFields` 搬运。
- **聚合**：`totals.waitMs`、`totals.netActiveMs = activeMs - waitMs`；`totals.activeMs` 仍保留官方值供核对，
  `totals.llmMs / toolMs` 为净口径（`toolMs` 已扣等待，故 `llmMs + toolMs === netActiveMs`）。
  `byDay / byWorkspace / byHour / calendar / bySession` 的 `activeMs` 一律为净活跃；`byWorkspace` 另带 `waitMs`。
  守恒：`netActiveMs + waitMs === activeMs`（±1ms），`sum(byHour) === totals.netActiveMs`。
- **配置**：`excludeWait: true`（默认开）/ `waitTools` / `waitMinMs`；`excludeWait: false` 时不做任何等待判定，
  `waitMs = 0`、`netActiveMs === activeMs`，小时桶与 0.6.0 完全一致（有回归断言）。
- **展示**：KPI「活跃时长」显示净活跃，副标题追加「含等待用户 {wait}」；工作区视图 foot 单列等待；
  报告 KPI / 每日柱同样用净活跃，footer 写明新口径与守恒关系。
- **文档**：`docs/metrics.md` 增补 `waitMs`（三层判定）、`netActiveMs`、"官方 activeMs 保留用于核对"。

### 并入：小时统一 1 位小数、日期明细比例条、删除日历提示

- **时长格式统一**：新增 `formatHours(ms)` 作为全站唯一换算入口——不足 1 小时用分钟（不足 1 分钟用秒），
  ≥1 小时固定保留 1 位小数并去掉 `.0`（`1.63 h → "1.6 h"`、`20 min → "20 m"`）。
  看板 KPI / 图例 / tooltip / 工作区 / 会话表与导出报告全部改走它；删除 `formatDuration` / `formatKpiDuration`。
- **按日期明细加比例条**：新增通用组件 `MetricBarCell`（`src/client/bar-cell.jsx`，宽度纯函数在 `bar-width.js`），
  「主要会话」四列与「按日期明细」四列共用同一份实现；日期明细用 Token 合计列替代步骤列，仍保持 8 列。
- **删除日历提示**：移除「全历史；右侧＝各周几累计」文案键与渲染（zh/en 字典同步删除，无死键、无空标签）。
- 日期明细表加横向滚动容器；条形数值窄屏省略号截断，title 保留全文。

### 测试

- 离线断言 **326 → 384 → 415 → 503**（连跑 2 次 exit 0）：
  · 小时 Token：跨小时消息按**消息时间**落桶（不按轮次起点）、`Σ hourTokens === row.tokensTotal`、
    官方合计与事件不等时 `events-scaled` 且整数守恒、聚合 `Σ byHour.tokensTotal === totals.tokensTotal`；
  · 人类消息：逐小时计数与总数、时区平移；
  · 未计入：v0 读不出 / 未回填 / hourTokens 全 0 时 `hourTokensSource.missing` 计数、byHour 不计入、界面与报告标注；
  · measure：默认 tokens、切 turns 取 `starts`、柱高归一与最小 3%、峰值数值格式；
  · 几何：`r = 3.4 + ratio×5.0`、最大圆上沿 14px、顶部 64px 容得下最大圆；
  · 等待剔除 ①–⑦（白名单 / user/message 夹层 / 短交互 / 长任务豁免 / 净活跃守恒 / `excludeWait:false` 回归）。
- 同构量测（无头 Chrome 1560×1000，真实客户端组件 + 真实快照）：默认 measure = Tokens、chips 切换生效、
  最大圆直径 16.8px 且上沿留白 14px、图例无括号解释、卡片无小标题、缺失提示可见；报告同款图例 + 密度点。

## v0.6.0（2026-10-16）— 时刻分析改按轮次（turn）落桶（不分摊、不切分）

### 变更

- **时刻分析（0–23）改为以「轮次（turn）」为最小归属单位**：多轮会话逐轮分开，每个轮次的活跃时长
  （该轮内模型时间 + 工具时间之和）**整段记到「该轮开始时刻」所在的整点，不跨小时切分**
  （跨小时的轮次整段归入起始小时）。轮次开始时刻取该轮 `turn/start`，没有则取该轮最早事件时间。
- **会话级兜底**：事件没有轮次信息（老会话）时整段记到 `createdAt` 所在整点；事件里完全无可用区间仍返回 `null`，交给聚合层走旧法摊销。
- **守恒与诊断不变**：事件累计 ≠ 官方 `sessionStats.activeMs` 时按比例回正，保留 `hoursSource: 'events' | 'events-scaled' | 'apportioned'`。
- **索引**：`INDEX_VERSION` 4 → 5（旧索引的跨小时切分桶自动重建）。
- **文档**：`docs/metrics.md` 口径改为「每小时柱高 = 以轮次开始时刻计的活跃时长」，并说明与旧摊销法的差别。

### 并入：时区错位复核（证伪，未改源码）

> 下列复核在本次口径调整前完成，结论（平移方向正确、无整体偏移）仍成立；
> 其中 ⑧ 的期望已按新口径改为「整段归起始小时」。

#### 结论

- 用户实测「上海 13:00–14:00 的会话被算到 14:00–15:00（整体晚一小时）」**未能复现，予以证伪**：
  - 纯函数逐桶核对：上海 13:00–14:00 只落 13 点 60min；13:50–14:20 → 13 点 10min + 14 点 20min（旧切分口径；v0.6.0 起整段 30min 归 13 点）；
    23:30–00:30 → 23 点 30min + 次日 0 点 30min（旧切分口径；v0.6.0 起整段 60min 归 23 点）。
  - 真实日志独立核对：对 6 个当日会话，用 `Intl` 直接按上海小时统计，与 `foldSessionHours → localHoursFromUtc` 的分布**逐桶完全一致**（最大占比差 0.00%）。
  - 客户端 `HourChart` 逐柱核对：第 i 根柱的标签与 tooltip 小时都是 i，峰位＝填充最高的柱。
- 结论：`localHoursFromUtc` 的 `+offset` 方向、跨小时切分、`% 24` 跨天处理均正确，**不改源码**。

#### 测试

- 离线断言 **308 → 326**（+18）：新增 ⑦ 整点 / ⑧ 跨小时整段归起始 / ⑨ 跨天三个时区回归用例（含逐桶期望值、`byHour[i].hour === i` 契约、逐桶守恒），
  以及「多轮分开 / 跨小时整段归起始 / 会话级兜底 / 两时区各自守恒且无 +1h 偏移」四组新口径用例。
- E2E 断言 **61 → 63**（+2）：新增「时刻柱与 0–23 标签逐柱对齐（标签与 tooltip 都为 i）」「高亮柱＝最高填充柱」。

#### 说明

- 复核时正在运行的 Web GUI 仍是旧进程（写 `index-v3.json`）；重启后才会走 v0.5.1 的事件时间戳落桶。

## v0.5.1（2026-10-16）— 时刻分析改按事件真实时间戳

### 变更

- **时刻分析（0–23）** 从「按 `[createdAt, lastPromptAt]` 墙钟窗口均匀摊销」改为**按事件真实时间戳落桶**：
  - 模型时间 = `request/header.time → assistant/message.time`（无 header 退化为该 message 的 stream 首末时间戳）；
  - 工具时间 = 按 `callId` 配对 `tool/call.time → tool/result.time`；**未配对 / 未结束的调用不计**；
  - 区间跨小时按边界切分；落桶用 **UTC 小时**（折叠在后台、无查询时区，结果要持久化复用；聚合时再按请求时区平移）。
- **守恒**：`sum(hours)` 恰等于事件累计；若与官方 activeMs（`llmMs + toolMs`）不等（未闭合步 / crash 恢复补写），
  按比例缩放到官方 activeMs，行上记 `hoursSource: 'events' | 'events-scaled' | 'apportioned'`。聚合时再按当前 activeMs 回正一次，
  保证 `sum(byHour[i].activeMs) === totals.activeMs`（±1ms）。
- **聚合**：`byHour` 有 `row.hours` 就用它，未回填 / `modelUsage: off` 才退回旧 `distributeHours()` 摊销；
  快照新增 `hourSource: { events, scaled, apportioned }`（并进 `/snapshot` 的 `diagnostics`）。
- **索引**：`INDEX_VERSION` 3 → 4（旧索引自动重建）；`hours` / `hoursSource` 随行持久化，行换代时与 `models` 一起搬运。

### 修复

- 新环境下少数超长会话不再把少量活跃时长摊平到十几小时（**假平峰**）；
  `lastPromptAt` 缺失时也不再全部砸在创建小时（**假尖峰**）。

### 测试

- 离线断言 **267 → 308**（连跑 2 次 exit 0）：新增「时刻分析（事件时间戳，新口径）」一节——
  单会话跨 3 小时逐小时精确（50 / 80 / 20min）、`00:50–01:10` 跨边界各 10min、`sum(hours) === llmMs + toolMs`、
  同一批事件在 `Asia/Shanghai` 与 `UTC` 下落桶不同且各自守恒、创建于 10 小时前仅 20min 活跃不被摊平（对比旧法峰值 ≈2min）、
  未回填仍走旧法且总数守恒、`events-scaled` 缩放路径、宿主 `/snapshot` 顶层 `hourSource` 与 `diagnostics.hourSource` 同源。

## v0.5.0（2026-10-15）— 顶部工具栏余额 chip（默认关闭）

### 新增

- **可选余额 chip（默认关闭）**：顶部工具栏（会话头部动作区）新增一个紧凑余额 chip。
  - 配置 `balance: { enabled: false, refreshMs: 300000 }` 加进 `DEFAULTS`；关闭时**一次服务调用都不发**（界面完全不渲染）。
  - 开启后宿主调用官方 `ctx.deepseekAccount`：`getBalance()` 会让宿主访问 `platform.deepseek.com`，
    结果按 `refreshMs` 缓存，带 8s 超时与 try/catch——失败只写 `balance.error`，不影响快照。
  - `topUpUrl` / `usageUrl` 来自服务的本地 `getState().links`，未登录也给。
  - 快照新增 `balance` 字段：`{ enabled, supported, loggedIn, currency, amount, bonus, updatedAt, topUpUrl, usageUrl, error }`；
    新增轻量只读路由 `GET {apiPath}/balance`（不触发索引同步）。
  - 四种界面状态：已登录「余额 ¥12.34」+ 副文本「赠送 ¥5.00」；未登录「未登录」+ 充值链接；
    请求失败「—」+ 充值链接（不弹错）；服务不存在「当前 DSH 不支持」；未启用完全不渲染。
- **可选依赖而非必需注入**：`deepseekAccount` **不写进 `inject`**，改用 `ctx.get("deepseekAccount")`（cordis ReflectService 的
  "without the inject requirement" 取法）。老版 DSH 没有该服务时插件照常加载、sync/快照照常完成，
  不会出现 `cannot get property "deepseekAccount" without inject`，也不会让 fiber 挂起等待。
- i18n 新增 `balance.*` 6 键（zh/en 逐键对齐，文案短）；金额格式化 `formatMoney` 提到 `src/format.js`（`formatCost` 保留为别名）。

### 文档 / 隐私原则

- README（中英）隐私章节明确：**启用余额显示会让宿主服务访问 `platform.deepseek.com`**，默认关闭、按 refreshMs 缓存、
  失败只在 chip 上显示「—」，余额**绝不写入**导出的 HTML 报告。
- 只读接口表补 `GET {apiPath}/balance`；配置示例补 `balance:`（含 `enabled` / `refreshMs`）。

### 测试

- 离线断言 215 → 267（连跑 2 次 exit 0）：新增「余额显示（默认关闭 / 可选依赖）」一节——
  默认关闭时用 spy 断言 `getBalance` / `getState` 调用次数均为 0、已登录 ready（金额/赠送/链接 + refreshMs 缓存 + `refresh=1` 强制）、
  未登录 `null`、`getBalance` 抛错（error 入快照且快照 200）、**服务不存在时插件仍完成 apply/sync/快照**（supported=false）；
  新增 chip 同构量测（五种状态文案，未启用返回 null）。

## v0.4.1（2026-10-13）— 模型回填常驻缺陷 + 报告对齐看板

### UI / 图表打磨（同版本内）

- **KPI**：新增第 3 张「模型费用」（按官方峰谷价估算，无官方价的模型不计入，卡上标覆盖度）；Tokens 卡跨 2 列放下完整整数、
  步骤数字小 2px 不换行；时长单位全站改小写 `h/m/s`，KPI 时间保留一位小数（`223.2 h`）。
- **每日用量趋势**：柱状图只保留「活跃时长」单序列（去折线），**周末柱用强调色**、峰值柱标数值；日期轴字号 9；
  图表上下充满容器；**日历热力图只允许横向滚动**（`.wl-cal-scroll` 显式 `overflow-y:hidden` + `> svg{display:block}`，
  消除"另一轴被计算成 auto"带来的 7px 纵向溢出），日历填满卡片（填充率 190/190）。首页该卡删除底部 legend 并降低高度。
- **tooltip 全覆盖**：每日柱 / 时刻柱 / 日历 / 工作区环形 / 首页模型环形 / treemap / 会话四列条形图全部有提示
  （日期或名称 + 数值）；**时刻分析**由"固定在容器顶部的浮动层"改为每列原生 `title`，提示跟随鼠标。
- **模型用量独立页签**：从首页大卡拆出，页签顺序改为「按日期 → 模型用量 → 按工作区 → 主要会话」；首页只留一个
  **模型 Token 占比环形图**（与工作区环形图同几何/同描边）；页签内 treemap 铺满容器并加小标题，去掉重复标题。
- **按工作区**：删除重复标题与「左＝付出 · 右＝消耗；bar＝占全部比例」备注（`ws.hint` 键一并删除）。
- **可读性**：模型页的读日志失败提示改为「{count} 个早期会话（旧格式）无法读取，未计入模型统计」并移到卡片底部，
  不再暴露原始英文异常（完整诊断仍在 `/health`）；工具栏删除「复制 JSON」。
- **缓动**：客户端快照内存缓存（stale-while-revalidate，重开面板先用旧值秒开）+ 宿主 5s 同参快照缓存（sync / 模型回填 /
  `patchLive` 后失效）；默认区间改**近 7 天**；打开即渲染骨架布局，只有数值位显示「加载中」。


### 修复

- **「模型维度正在回填…」常驻不消失、重启后模型区没数据（最高优先）**。三个叠在一起的根因：
  1. `modelFoldTargets()` 把"已折过、但 `asOfSeq > modelFoldSeq`"也算成待折——活会话每来一个事件 `asOfSeq` 就 +1，
     于是 pending 永远 > 0，界面永远停在回填提示，而 `scheduleModelFold` 还有 15 分钟节流。实测修复前连续轮询 6 次：
     `done` 从 130 涨到 194 / 204，`pending` **恒为 204**。
  2. **折叠结果在行换代时被丢掉**：`models` 挂在行对象上，而 `liveRow()` / `cachedRow()` / `coldRow()` 每次都用投影**新建一行**
     （不含模型维度）；`settle()` 与 `patchLive()` 都是直接换行，于是每次同步（30s / refresh）与每个 `session/event`
     都会把折好的 `models` 冲掉；执行中的折叠还会把结果写回"已经被换掉的旧行"。实测 336 行的索引里只有 132 行带 `models`，
     而回填计数已经 `folded = 274`；近 7 天区间 `byModel` 为 **0**（看板模型区与报告模型一节因此都是空的）。
  3. `readSession()` 对 v0 旧格式会话抛错（`subagent/descriptor 0 uses unsupported descriptor version 2`，本机 54 个），
     这些行永远折不出来 → 只要它们还在 pending 里，提示就永远不会消失。
- **修法**：`modelFoldQueue()` 分三档——**pending**（从未折过，界面提示只看它）/ **refold**（已折过：水位前进超过
  `modelRefoldDelta`＝50 或会话已非 live）/ **failed**（失败行，过 `modelRetryMs` 再试）；`carryModelFields()` 在行换代时把
  `models` / `modelFoldSeq` / `modelFoldAt` / `modelFoldSkipped` / `modelFoldError(At)` 整组搬过去；折叠结果写回**当前**行；
  失败记在行上（重启也不重复试），`lastError` / `lastErrorAt` / `failedRows` 暴露到 `/health`、`/snapshot.diagnostics.modelFold`
  与界面（短句 + `title` 全文）；`saveToDisk()` 串行化（sync 与回填并发写同一个 `.tmp` 会 rename ENOENT）。
- **重启不重折全部**：`models` 随索引落盘、重启读回。实测重启后 `/health.modelFold.done = 0`（一次 `readSession` 都没发生）、
  `pending = 0`、`byModel` 仍有数据。
- **首页「模型 Token 占比」环形图上下居中**：卡片被上一行等高拉伸时，图形区在卡内垂直居中。实测上下留白各 60.3px，**差 0**（卡高 344 / 图形 160）。
- **模型用量页签**：删掉卡片里重复的「模型用量」标题（页签已表达，`model.title` 随之成为死键并删除）；treemap 加小标题
  「模型占比 · 面积 = Token」（`model.treemapTitle`）；treemap 改用量容器**真实像素**做 viewBox（原来 `preserveAspectRatio`
  等比缩放会在左右留出大片空白）。实测容器 582×210，矩形到四边留白 **0 / 0 / 0 / 0**（目标 ≤ 8px）。
- **导出报告与看板对齐**：补齐「模型用量」一节（treemap + 按日趋势 + 明细 + 官方计费链接——之前**不是**没写 `modelSection`，
  而是 `snapshot.byModel` 为空导致整节不渲染，即问题 2 的同一个根因）；KPI 增加第三张「模型费用(估算)」；
  每日趋势改单序列活跃时长（**去折线 + 周六/周日异色**，与看板柱状图一致），treemap 用 `height:auto` 铺满容器；
  报告仍**自包含**（无脚本、无外链资源，外链仅官方计费页）。
- **删除「复制 JSON」按钮**（工具栏只留 刷新 / 导出 / 关闭）与 i18n 死键 `action.copy` / `action.copied`（zh / en 各 2 个）。
- **诊断口径统一**：`/health.diagnostics` 与 `/snapshot.diagnostics` 都走 `diagnosticsFor()`；新增 `syncing`（后台重扫事实，
  与给用户看的 `indexing` 区分）与 `modelPending` / `modelStale` / `modelFailed`。

### 测试

- 离线断言 **184 → 215**（连跑 2 次 exit 0）：新增「模型折叠生命周期」一节——首次回填 pending 归零、失败行单独计入
  `failedRows` 且不改写 pending、重扫（行被投影重建）不丢模型、活会话水位 +1 不触发重折、会话转冷后水位前进只进重折队列、
  重启实例零次重读且模型数据与失败原因都还在；报告断言收紧为「外链只有官方计费页」「无脚本 / 无外链资源」。
- 真实隔离实例 E2E 全过（新增：回填提示消失且模型区有数据、treemap 铺满容器、环形图居中、工具栏无复制按钮、
  报告含模型一节 + 模型费用 KPI + 无折线 + 周末异色 + 自包含）。

### 报告 vs 看板差异（本轮补齐后）

| 维度 | 看板 | 报告 |
| --- | --- | --- |
| KPI | 8 张（含「最活跃模型」） | 7 张（含「模型费用(估算)」；「最活跃模型」仅看板） |
| 每日趋势 | 单序列活跃时长、周末异色、柱顶标值 | 同左 |
| 模型用量 | 独立页签，treemap 可切口径并点选联动 | 模型一节：treemap + 按日趋势 + 明细 + 官方链接（静态、无交互） |
| 环形图 | 模型占比 + 工作区占比 | 工作区占比（模型占比由 treemap 表达） |
| 时刻分析 / 工作区排行 / 按日期明细 | 同构 | 同构 |
| 日历热力图 | 有（全历史） | 无（报告按区间枚举，纯静态） |
| 主要会话 | 40 行、四列可点表头排序 | Top 12（`sessions` 可调），不可排序（报告不引脚本） |
| 交互 | 页签 / 区间 / 范围 / 筛选 | 无（自包含，可打印 / 发客户） |

## v0.4.0（2026-10-13）— 模型用量分析

- **模型维度**：新增 `src/models.js`，用官方 `ctx.sessionQuery.readSession()` 读事件日志（不自己解析日志格式），
  折叠 `assistant/message` 的模型与 token、`request/header` 的思考强度；索引版本 `2 → 3`，带事件水位、增量折叠与落盘复用。
- **模型归并**：`deepseek-flash` / `deepseek-v4-flash` / `…-vision-exp` 合并显示为 `deepseek-v4-flash`
  （依据：官方定价页注 1 写明前两者是同一模型的新旧名）；明细可展开看原始组成；`modelGroups` 可自定义。
- **看板**：模型 **treemap**（面积=占比，可切 Token/请求数/模型耗时）+ **按日模型趋势**；
  **点击 treemap 或模型名即可只看该模型**（多选、可清除，选中态明显）；新增**模型明细表**（请求/输入/输出/缓存读/命中率/费用）。
- **KPI 新增第 7 张「最活跃模型」**（默认按请求数口径，可配 tokens / activeMs）。
- **KPI 新增第 8 张「模型费用」**（插在活跃天数前，取快照 `pricing.totalCost`）：只统计有官方单价的模型，
  没有官方价时显示 `—`；副标题给出 `{covered}/{total} 个模型有官方价 · as-of …`。栅格改 **5 列**（Tokens / 模型费用各跨 2 列），
  8 张卡正好 2 行排满，值不换行、不溢出。
- **费用估算**：内置 DeepSeek 官方**峰谷价**（as-of 2026-10-13；峰时 01:00–04:00 与 06:00–10:00 UTC 周一至周五，谷价半价），
  按每条请求时间逐条判定峰谷计费；没有官方价的模型显示 `—` **不编数字**；页面与报告底部给出**官方计费链接**；运行时不联网。
- **报告**：新增「模型用量」一节（treemap + 趋势 + 明细 + 口径与官方链接）。
- **开关与保护**：`modelUsage: off` 时行为与 0.4.0 之前一致；`modelFoldMaxEvents` 跳过巨型会话并计入诊断；
  回填渐进进行（先出总量，模型区随后补齐，界面显示进度）。
- **修复「每日用量趋势」卡底部溢出**（实测反馈：底部边线与下一行容器重叠）：卡片不再写 `height: 100%`
  （content-box 下会把卡撑出 padding 高度、越出栅格行 30px），改为 head(auto) → body(`flex: 1 1 244px; min-height: 0`) → legend(auto)，
  legend 行高归一；两卡仍等高，日历/柱状图容器等高，任何内容都不溢出卡片。
- **每日用量趋势改单序列**：去掉 Token 三系列堆叠柱，柱高＝活跃时长（`day.activeMs`），折线同系列并在点上标数值
  （9px；点数多时按 `ceil(30 / 步长)` 隔点标注，实测 30 天 13 个标签、0 重叠）；图例只剩「活跃时长」，
  删掉因此变成死键的 `legend.cache` / `legend.input` / `legend.output`（zh / en 各 3 个，字典 123 → 120 键）。
- **图表铺满容器（去掉底部空白带）**：改由 ResizeObserver 量容器像素、viewBox 直接用容器尺寸（不再等比缩放），
  日期轴 10 → 9px、`padding.bottom` 30 → 20、图例上边距 6 → 4px；实测图形底边到图例 3.5px（目标 ≤ 8px），
  日历 / 柱状两种模式的容器与卡片高度差均为 0。
- **打开即见布局（骨架屏）**：内存缓存未命中时立即渲染完整卡片骨架（KPI 卡 / 图表容器 / 表格框），
  只有数值位显示「加载中…」，数据到达后原地填充（不再整屏一行"加载中"）；缓存命中仍走"先渲染旧值再后台刷新"。
- **默认区间改近 7 天**：客户端 `RANGES` 默认与宿主 `DEFAULTS.defaultDays` 一起改成 7（README 配置示例同步）。
- **修复快照缓存竞态**：`patchLive()` 成功写入活会话行后立即 `snapshotCache = undefined`（与 sync / 模型回填后的失效一致），
  修掉"活会话事件增量更新后 5s 内快照仍返回旧值"的偶发失败。
- **模型用量改独立页签**：页签顺序改为「按日期 → 模型用量 → 按工作区 → 主要会话」；原首页右侧的模型大卡
  （treemap + 按日模型趋势 + 明细表 + 费用与官方计费链接）整体搬到「模型用量」页签，标签走 i18n 新键 `tab.model`。
- **首页改「模型 Token 占比」环形图**：占原模型卡的位置，**固定 Token 口径**（不切换）；直接复用工作区环形图的
  `WorkspacePie`（同几何 viewBox 160 / 外 74 / 内 50、同主题色板、同主题背景色 1.6 描边、「其他」用 `others`），
  副标题一句口径（Token 来自事件日志、归并规则同明细）；空数据时区分「模型维度回填中」与「无数据」。
- **每日趋势去折线**：删掉 polyline，只留柱；数值从折线点挪到**柱顶**（仍 9px、按 `ceil(30 / 步长)` 隔点标注避免叠字）；
  **周六 / 周日柱换强调色**（`--dsw-static-amber-500`），工作日保持主色，图例补「周末」（`legend.weekend`）；
  星期由 `day.date` 按本地时区解析（`new Date(day.date + "T00:00:00")`，不会整体偏一天）；日历模式（CalendarHeatmap）不动。
- **测试**：离线断言 124 → 184（归并/折叠/缺失字段/守恒/峰谷计费/覆盖单价/报告与路由）；
  E2E 增加 treemap、联动筛选、KPI 第 8 张、KPI 栅格 2 行排满、每日趋势卡几何（等高/legend/不重叠）、官方链接等断言。
- **本轮验证**：离线断言 184 行全过（连跑 2 次、exit 0）；同构量测 `.tmp/iso-ui.mjs`（1560×1000，真实客户端组件 + 真实快照）
  23 项全过（页签顺序 / 柱数 = 天数且 `polyline=0` / 周末柱异色且判定与日期一致 / 首页环形图几何、描边、无 `circle` /
  首页无 treemap 与模型明细表）；真实实例 E2E 77 项通过，唯一失败是宿主 `conversation.session` 插槽自身的
  `TypeError: text.replace is not a function`（与本插件无关）；E2E 断言同步到新交互（模型页签、无折线、周末两色），
  并顺手修掉三处**测试自身**的老毛病（KPI 跨列查 `gridColumnStart`、工作区右栏 Token 不该按 h/m/s 断言、换区间先等骨架屏再点 chip）。

## v0.3.6（2026-10-11）— 英文首页与检索元数据

- **README 语言互换**：英文版升为 `README.md`（npm 首页固定渲染该文件），中文版改为 `README.zh-CN.md`，
  两侧顶部保留语言切换。理由：npm 包页是外部搜索的主要落地页，英文可被更广的检索与读者覆盖；
  同类 DSH 插件的实测数据也表明**语言不是 npm 站内排序因子**（排序看名称/关键词匹配、下载量、维护活跃度）。
- `description` 改为**英文优先**（它参与检索并显示在搜索结果里），并扩充英文 keywords：
  新增 `dsh-plugin`、`deepseek`、`usage-stats`、`time-tracking`、`calendar-heatmap`、`productivity`、`cost-tracking`、`worklog`。
  （`dsh-plugin` 是社区插件市场检索用的约定关键词。）
- 英文 README 首屏补充定位说明：**不只是成本，更是"付出"**——活跃天数、时段、项目归属，可直接对客户展示。
- 记录多机合并方案（[docs/sync.md](./docs/sync.md)，目标 0.4.0）。

## v0.3.5（2026-10-11）— 发布流程自动化

- 新增 [.github/workflows/release.yml](./.github/workflows/release.yml)：推送 `v*` tag 即自动**暂存**到 npm
  （`npm stage publish`，用 `NPM_TOKEN` 密钥，无需 OTP），再由本人在本地用一次 OTP 批准发布
  （`npm stage approve <id> --otp=…`）。
  说明：npm 现要求每次发布都有交互式 2FA —— 直连 `npm publish` 即使带 token 也会报 `EOTP`；
  账号级 Trusted Publisher 设置页当时无法打开，故未采用 OIDC。
  workflow 内置四道闸：tag ↔ package.json 版本一致、入库 `lib/client.js` 与源码一致、124 项离线断言、版本未被发布过。
- 新增 [docs/release.md](./docs/release.md)：一次性配置（2FA + Trusted Publisher）、日常发版步骤、本地应急发布、
  发布后校验清单，以及本次踩过的坑（403 / 0.0.0-stage 占位 / 镜像源 / README 坏图）。
- 背景：0.3.4 首次发布时因账号未开 2FA 报 `E403`，开启后经浏览器授权以 202 异步受理完成发布；
  此版本把该流程固化，避免重复踩坑。

## v0.3.4（2026-10-11）— npm 首发

- **发布到 npm**（本版本为 npm 首发，`dsh plugin --profile web add dsh-workload-report` 从此可用）。
  背景：此前 README 把 npm 列为可用方式但实际从未发布（`registry.npmjs.org` 当时返回 404，不是同步延迟），
  已在本次一并订正 —— 现在说明与实际一致。
- **README 图片改为绝对链接**：此前用相对路径 `assets/*.png`，而 `assets/` 不在 npm tarball 里，npm 页面上会显示 4 张坏图。
- `package.json` 的 `files` 精确化：`docs/metrics.md`（口径文档）进包，`docs/blog.md`（博客文章）不进包。
- 恢复 npm 徽章与「方式三：npm」安装说明。

## v0.3.3（2026-10-11）— 发布脚本移出插件

- `scripts/publish-emdash.mjs` **移出本仓库**：它是"发文章"的通用工具，不属于这个插件。
  现在以用户级技能形式固化：`~/.dsh/skills/publish-blog/`（`SKILL.md` + `scripts/publish.mjs` + `references/{emdash,wordpress}.md`），
  一份 Markdown 可发布到 **EmDash** 与 **WordPress**，跨项目复用；并在全局 `AGENTS.md` 里登记了入口与凭据约定。
- 文章原文仍在本仓库的 [docs/blog.md](./docs/blog.md)，发布说明见技能。

## v0.3.2（2026-10-11）— 博客发布脚本

- 新增 [`scripts/publish-emdash.mjs`](./scripts/publish-emdash.mjs)：把 `docs/blog.md` 发布到 EmDash 站点（Markdown → Portable Text，
  支持标题/段落/引用/列表/**代码块/表格**/图片/加粗/行内代码/链接），自动上传图片到媒体库、设置特色图并发布。
  用法：`EMDASH_TOKEN=… node scripts/publish-emdash.mjs --site https://vizwise.cn`（`--dry-run` 只转换不发布）。
- 文章已在 vizwise.cn 发布：https://vizwise.cn/posts/dsh-workload-report
- `docs/blog.md` 的作者卡片加 `<!-- publish:skip -->` 标记（站点自带署名，避免正文重复）。

## v0.3.1（2026-10-11）— 文档与署名

- 新增**完整英文 README**（[README.en.md](./README.en.md)），中文 README 顶部提供语言切换。
- 博客文章更名为 [docs/blog.md](./docs/blog.md)（原 `docs/blog-introducing-dsh-workload-report.md`），文首加入作者信息与头像。
- 署名修正：LICENSE 版权人与 `package.json` 的 `author` 统一为 **XILEJUN**（https://github.com/tableau-China）。
- 修正 README 中过期的测试数量（离线 124 项 / E2E 61 项），并补上文章入口。
- README 的内联英文段改为指向 `README.en.md`，避免两处英文说明不同步。

## v0.3.0（2026-10-11）— 首个公开发布

**发布物料**

- LICENSE(MIT)、GitHub Actions CI（构建 + 119 项离线断言 + 校验入库的 `lib/client.js` 与源码一致）。
- `docs/metrics.md`：把全部指标口径（活跃时长 / Token / 对话 / 活跃天数 / 时刻分摊 / 全部档 / 日历）写成可引用的文档。
- README 重写为对外版本（中英双语、截图、三种安装方式、配置、接口、隐私、开发、兼容性）。
- 发布元数据：repository / homepage / bugs / keywords / engines / publishConfig。
- `build.mjs` 与 E2E 的依赖解析通用化（`pnpm add -D esbuild puppeteer-core`，或 `ESBUILD_PATH` / `WL_PUPPETEER_DIR`）；
  仓库内不含任何个人路径、用户名或私有项目名。

**文案与单位（为降低多语言维护量）**

- 界面时长单位统一为 **H / M / S**（与 Token 的 K/M/B 一致，语言无关），中英文共用一份格式；界面不再出现「小时」。
- 长备注压短（最长从 100+ 字降到 40 字内）：日历、时刻分析、工作区、饼图的说明只留一句，详细口径交给 `docs/metrics.md`。
- 删除 3 个死键、合并重复说明；新增 5 条 i18n 断言（中英键集一致、引用键必须存在、无死键、无超长文案）。

**测试**

- `verify.mjs` **124 项**；`e2e-ui.mjs` **61 项**（新增：KPI/工作区/周几条单位、界面无「小时」、备注长度上限）。

## v0.2.1（2026-10-11）— 排版与区间口径

**调整**

- 工作区列表：**删掉每行的「我的付出 / Token 消耗」标签**，改为列表顶部一次性列头（顶部说明已经讲过）。
- 「全部」档不再写死 3650 天：区间＝**最早的活跃日 → 今天**，所以「活跃天数」分母是真实历史跨度（如 `23/59 天`）。
- 「每日用量趋势」的**日历图固定展示全部历史**（不受顶部筛选影响），并在最后一列右侧紧贴 7 条「周几累计活跃时长」横条，
  无标题、与日历同一张 SVG，用来一眼看出周几更忙；柱状图仍按所选区间。

**修复**

- **同步竞态**：非首次增量重扫时原先会把行表换成空表再渐进填充，导致同步期间到达的请求读到"只有部分会话"的残缺数据
  （表现为日历格子数抖动）。现在只有**首次建索引**渐进换表（避免长时间空白），之后的增量重扫**原子替换**。
- 默认 `refreshMs` 2000 → **30000**：实时性由 `session/event` 增量保证，没必要每 2 秒重扫全部会话。
- `<title>` 从周几条的兄弟节点移进 `<rect>` 内部（否则 DOM 上取不到 tooltip）。

**测试**

- `verify.mjs` 119 项（新增：全部档起点/终点/跨度、日历数据源与 scope）。
- `e2e-ui.mjs` 56 项（新增：切到近 7 天日历格子数不变、周几条紧贴最后一列、行内无标签、全部档分母 < 400）。

## v0.2.0（2026-10-11）— 首页信息架构重做

**新增**

- **日历热力图**（默认视图）：纵轴周一～周日、横轴 Year-Week、颜色 5 档＝活跃时长，跟随顶部区间筛选；与柱状图一键切换。
- **时刻分析**：0–23 点柱状图，柱高＝该时段分摊到的活跃时长，最活跃时段高亮；口径＝会话活跃窗口（开始 → 最后一次提问）按墙钟比例分摊（半小时切片、严格守恒）。
- **工作区占比环形图**：Top 6 + 其他，可在「按时长 / 按 Token」之间切换。
- 上面两张图**水平并排**，位于「每日用量趋势」下方。
- 报告 HTML 同步新增「时刻分析」+「工作区占比」两栏。

**调整**

- KPI：**总 Token 显示完整整数**（如 2,690,929,214），K/M/B 只用于备注小字；卡片顺序改为 活跃时长 → 总 Token → **活跃天数** → 对话次数 → 轮次/步骤 → 缓存占比。
- 「按日期明细」默认**折叠**（点击展开，最多 31 天）。
- 聚合新增 `byHour`（24 桶）与每会话 `lastPromptAt`；`PROJECTION_KEYS` 增加 `sessionListMetadata`。

**测试**

- `verify.mjs` 109 项（新增时刻分摊守恒、lastPromptAt 解析）。
- `e2e-ui.mjs` 49 项（新增：KPI 顺序/整数、日历默认与切换、并排几何校验、24 小时柱与高亮、环形图扇区与切换、明细默认折叠）。

## v0.1.3（2026-10-10）— 面向"给客户讲付出"的排版

**变更**

- 「按工作区」每行改成**左右并排两块**（原来是上下两行）：
  - 左「我的付出」：活跃时长（大字）+ 时长占比；bar；小字「活跃 N/M 天 · 轮次 · 步骤」
  - 右「Token 消耗」：总 Token（大字）+ Token 占比；bar；小字「输出 · 缓存读取」
  - 行首右侧显示「最近使用 MM-DD」，行尾一行「会话 · 对话 · 平均每次对话时长」
- 两条 bar 统一按**占全部的比例**绘制（与旁边的 % 同口径），跨工作区、左右两块都可直接比。
- 报告 HTML 同步改成同样布局，工作区表格新增「Token 占比」列。
- 天数从"单独一条 bar"改为左块的支撑信息（仍有独立列），避免一行里出现三条 bar 的拥挤。

**测试**

- `verify.mjs` 102 项；`e2e-ui.mjs` 33 项 —— 新增**几何断言**：左块右边界 ≤ 右块左边界、两块中线在同一水平线，
  即"确实是左右并排而不是上下两行"。

## v0.1.2（2026-10-10）

**新增**

- 「按工作区」每个工作区在**时长 bar 之后**多一条**独立的活跃天数 bar**（绿色），文字形如 `18 天 / 区间 30 天`；
  工作区表格新增「活跃天数」列（第 2 列）。报告 HTML 同步跟上（表格列 + 天数 bar，色板里的绿色系列）。
- 口径：活跃天数 = 该工作区在区间内出现过会话的自然日数量（按会话创建时间归属，时区可切）。

**修复**

- **宿主服务未声明**：`ctx.sessionProjections` / `ctx.sessions` 没写进插件 `inject`，cordis 抛
  `cannot get property "sessionProjections" without inject`，被 catch 后表现为"实时路径静默失效"（`live` 恒为 0）。
  现在 5 个服务全部声明；并新增**静态回归断言**：扫描 `index.js` 里访问的每个 `ctx.X`，必须在 `inject` 里。

**测试**

- `verify.mjs` 97 项；`e2e-ui.mjs` 26 项（新增：每个工作区都有天数 bar、文案形如「N 天 / 区间 M 天」、表格含活跃天数列）。

## v0.1.1（2026-10-10）— 装机后修复

**修复**

- **Token 全为 0**：官方 wire view 的 `tokenUsage` 直接是 bucket，持久化 state 才是 `{ totals }`；原先只认后者。
  现在两种形状都识别（`usage.totals ?? usage`）。
- **历史会话不计数**：投影检查点在会话格式迁移后会被官方拒绝（313 个里 126 个命中）。
  新增官方冷读兜底 `sessionQuery.observeSession(..., { projectionMode: "all" }) `，实测补齐 133 个；
  剩下 54 个 v0 老会话当前版本无法迁移，作为"读取失败"明确报出并在看板写明，不再静默当 0。
- 长区间（「全部」）的每日明细被 400 天上限截断，导致"近 7 天"显示成 2017 年的空白日；现在：
  区间 ≤180 天补齐空白日，>180 天只列有活动的日子；`range.days` 表示区间跨度。

**改进**

- 建索引改为**非阻塞 + 渐进式**：接口立即返回已解析的数据并带 `indexing` 标记，看板显示「正在补齐历史会话数据…」并每 5 秒自动重拉。
- 索引持久化到 `<DSH_HOME>/workload-report/index-v2.json`（原子写），重启直接复用；`revalidateMs`（默认 12h）到期后重新校验。
- 冷读并发默认 8；`/health` 增加 `indexing` 与实时计数。

**测试**

- `test/verify.mjs` 88 项断言（新增 wire/state 两种 token 形状、冷读兜底、dispose、索引复用不重复冷读）。
- `test/e2e-ui.mjs` 22 项断言（新增「总 Token」KPI 非零、报告页 Token 非零——正是能拦住本次回归的断言）。

## v0.1.0（2026-10-10）

首次发布。

**新增**

- 侧边栏底部「工作量报告」入口 + 全屏看板：6 张 KPI（活跃时长 / 总 Token / 对话次数 / 轮次·步骤 / 活跃天数 / 缓存读取占比）。
- 三个视图：按日期（堆叠柱 + 活跃时长折线 + 明细表）、按工作区（排行条 + 明细表）、主要会话。
- 区间切换（近 7 / 30 / 90 天 / 全部）与范围切换（全部 / 仅主会话 / 仅子代理）。
- 自包含 HTML 报告导出（`/report.html`）：浅色/深色、自定义标题与备注、`anonymize=1` 匿名化。
- 只读接口：`/snapshot`、`/export.json`、`/report.html`、`/health`。
- 中英文文案，跟随 Harness 语言与主题。

**测试**

- `test/verify.mjs`：75 项断言（聚合口径、时区归属、长区间不截断、HTML 转义、宿主路由 200/404/405、活会话增量）。
- `test/e2e-ui.mjs`：真实浏览器 19 项断言 + 6 张截图（看板三视图、报告浅色/深色）。

**已知限制**

- 活跃时长是引擎累计时间（并发会累加），不是墙钟时长。
- 会话按创建时间归属到某一天；跨天续聊不会拆分。
- 不显示模型维度（避免逐会话冷读日志）。