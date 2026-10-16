# CHANGELOG — dsh-workload-report

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
