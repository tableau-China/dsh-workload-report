# PROGRESS — dsh-workload-report

日期用 `YYYY-MM-DD`；只记录影响后续决策的事实。

## 2026-10-20 看板打开性能：打开零折叠 + 折叠三态 + 耗时指标

### 问题

用户实测：每次打开看板，「时刻分析」状态行都停在「正在计算中……」，感觉一直在算。
根因：`snapshot()` 每次都调用 `scheduleModelFold()`，打开面板会排队甚至启动 `readSession()` 读事件日志；
sync 末尾也会触发折叠（打开面板触发的重扫同样会读日志）。

### 量化（隔离实例，500 个会话；`node test/bench-open.mjs`）

| 场景 | 优化前 | 优化后 | 说明 |
| --- | --- | --- | --- |
| 冷缓存首开 | **448.9 ms** | **25.3 ms** | 聚合首次构建；Intl formatter 按时区缓存 |
| 热缓存再开 | 2.86 ms | 1.12 ms | 同参数快照缓存 TTL 5s → 15s；命中率 5/6 = 83.3% |
| 回填中打开（5 次均值） | 63.5 ms | 3.2 ms | 折叠不再由打开触发；首开 313 → 11.6 ms |
| 打开 5 次触发的读日志次数 | **159 次**（新增 1 会话，refreshMs=0） | **0 次** | 断言锁死 |

真实隔离实例（60 个真实会话副本）：冷开 78.5 → **13 ms**，热开 5.0 → **2–3 ms**；
首次预热折叠仍会读 60 份日志（本机 15.3s），但由定时器发起，打开面板不排队。

### 实现

- `index.js`：`snapshot()` 删除 `scheduleModelFold()`；sync 末尾不再触发折叠。
  触发源收敛到 `apply()` 的定时器：索引就绪后预热一次、12 分钟例行维护、60 秒空闲/转冷检查；
  活会话重折需「距上次事件 ≥ 10 分钟」或「事件增量 > 50」。
- 折叠三态：`modelFold.phase = first-fold | background | idle`；`failedRows` 不参与 phase。
- 指标：`/health` 与 `/snapshot.diagnostics` 暴露 `snapshotMs`、`snapshotCache.{hits,misses,hitRate,ttlMs}`、
  `foldRoundMs`、`foldSessionsRead`、`foldRounds`、`foldScheduled/foldWarmupAt`。
- 缓存：`snapshotCacheMs` 5000 → 15000；活会话事件 / 索引刷新 / 折叠完成立即失效。
- 失败重试：`modelRetryMs` 15 → 30 分钟；失败行只计入「Token 未计入」提示。
- 聚合：`dateKey / hourOf / zoneOffsetMinutes` 按时区缓存 `Intl.DateTimeFormat`（冷开的主要成本）。
- 前端：`hourTokensNote` 按 phase 渲染；background 为灰点小字；只在后台真在跑时 5s 轮询。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**595 项断言，exit 0**（567 → 595，新增 28 项）。
- 三态 DOM：E2E 拦截 snapshot，断言 `data-state=first-fold / background / idle` 与文案，截图
  `test/.artifacts/07-status-first-fold.png` / `08-status-background.png` / `09-status-idle.png`。

## 2026-10-17 发布 0.6.6：报告对齐 + README 重写 + 截图重拍

### 背景

- 0.6.5 已发布到 npm；报告对齐、文档与截图是后续改动，统一收进 **0.6.6**。
- 本轮只做本地提交与验证；**不 push、不发 npm、不打 tag**（由 Lead 执行）。

### 变更

- `package.json`：**0.6.5 → 0.6.6**；`files` 白名单由 `docs/metrics.md` 改为 **`docs`**，
  `docs/report-parity.md` / `docs/ui-conventions.md` 会进 npm 包。
- `CHANGELOG.md`：把「未发布」条目标为 **v0.6.6**，补发布小节（版本、files、README、截图、PROGRESS）。
- `README.md` / `README.zh-CN.md`：按当前真实功能重写，中英章节一一对应；覆盖安装与入口、
  数据来源与原则、8 张 KPI、时刻分析双口径、三层等待判定、配置项、`INDEX_VERSION = 7` 升级注意、
  文档索引与隐私；断言数更新为 **566**，不再保留「6 张 KPI / 533 断言」。
- 截图：用 `.tmp/readme-gen.mjs`（真实客户端组件 + 真实 `aggregate()` / `renderReport()`，无头 Chrome，
  2x DPR）重拍 4 张并覆盖 `assets/`。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**566 项断言，exit 0**。
- `npm pack --dry-run`：包内包含 `docs/report-parity.md`、`docs/ui-conventions.md`。
- 截图尺寸：dashboard **3120×2476**（2x 1560×1238）、report **2480×10476**（2x 1240×5238 fullPage）；
  新旧字节 / md5 见提交回报。
- README 中英章节数 / 键值一一对应（结构一致，非逐字直译）。

## 2026-10-17 报告对齐看板（并入 v0.6.6，修正本轮遗漏）

### 背景（用户的批评）

- 「导出 HTML 报告」`src/report-html.js` 仍是老版本：最近几轮只改了看板 `src/client/*`，
  报告没跟上（缺密度点后的新卡片头、KPI、日历、比例条、轮次第二口径等）。
- 根因不是技术，而是**流程**：之前只把「改看板」当完成，没有把报告列为同一提交的交付物。
  本轮先做差异审计，再把报告拉到一致，最后把「必须同步」写进测试与文档。

### 差异审计（看板 vs 报告）

| 区域 | 看板有 | 报告（修复前） | 处理 |
| --- | --- | --- | --- |
| KPI | 8 张含模型费用 / 最活跃模型；5 列跨列；净活跃 + 含等待用户 | 7 张、无最活跃模型；Token 用缩写；3 列 | 补齐 8 张 / 同栅格 / Token 完整整数 |
| 每日趋势 | 日历（默认）+ 柱状切换；周几累计条；峰值标签；命中区 tooltip | 只有柱；峰值不保证标注；无命中区 | 日历 + 柱状同时静态展示；补峰值/命中区 |
| 时刻分析 | Tokens 默认 + 轮次切换；密度点；三项图例；状态三态；峰值深蓝 | 有密度点/图例/深蓝，但无状态行、无轮次口径 | 状态行复用 `hourTokensNote`；轮次改第二张小图 |
| 模型用量 | treemap 铺满 + 小标题；按日趋势；筛选；明细/费用/链接 | 有 treemap/趋势/明细；小标题在标题下方 | 小标题归位；title 挂 rect；卡片头统一 |
| 表格比例条 | `MetricBarCell`（`barPercent`） | 纯数字 | 报告 `barCell()` 直接 import `barPercent` |
| 卡片说明 | 标题右侧 11px muted | 标题下方 12px | 全部改标题右侧，删除旧 `<p class="hint">` |
| 口径文案 | 净活跃/等待/未计入 N | 有 footer，但时刻状态行缺 running/idle | 状态行 + KPI + footer 三处对齐 |

有意不同：报告不渲染切换/排序/筛选按钮；每日两图同时展示；轮次用第二小图；工作区固定按时长；
模型固定 Token；主要会话前 12 行；固定中文。完整清单见 `docs/report-parity.md`。

### 实现

- `src/report-html.js`：新增 `cardHead()` / `barCell()` / `calendarHeatmap()` / `hourTurnsChart()`；
  KPI 8 张（含 `topModel`）、每日日历 + 柱状、时刻状态行（import `hourTokensNote`）、轮次小图、
  模型小标题与 rect title、表格比例条；所有时长继续走 `formatHours`。
- 报告仍是自包含 HTML：内联 CSS/SVG、无脚本、外链仅官方计费页。
- 新增 `docs/report-parity.md`：铁律 + 看板→报告逐项对照 + 有意差异 + 同步流程 + 结构断言表。
- `docs/ui-conventions.md`：抬头加「报告同步铁律」，新增第 7 节（组件对应表），检查清单加 3 条。
- `test/verify.mjs`：新增「报告结构对齐」块（密度点、Tokens 默认口径、轮次小图、状态三态、
  标题右侧 11px 说明、日历、峰值/命中区、比例条、模型小标题、KPI、净活跃/等待、自包含）。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**545 → 565 项断言，exit 0**（新增 20 项）。
- 隔离实例 `/report.html?theme=light|dark` 截图：`.tmp/shots/report-light.png` / `report-dark.png`；
  局部 `report-hour-light.png` / `report-hour-dark.png`。
- DOM 量测：`<script` = 0；外链仅 api-docs.deepseek.com / platform.kimi.com / platform.claude.com；
  13 个密度点；峰值柱 fill = `rgb(47, 75, 216)`；7 张卡片 hint 全部在标题右侧、11px、muted；
  时刻状态行 running / idle 均出现；无横向溢出。

### 机制（防止下次再漏）

1. 报告与看板在**同一提交**：任何 `src/client/*` UI 改动都要同步 `src/report-html.js`。
2. `docs/report-parity.md` 是唯一对照清单；状态列必须随改动更新。
3. `test/verify.mjs` 的结构断言是硬门槛：关键标记缺失即 exit 1。
4. `docs/ui-conventions.md` 检查清单第 7–9 条在每次 UI 改动后逐条过。

## 2026-10-17 卡片说明统一到标题右侧（CardHead.hint）

### 背景

- 「每日用量趋势」「时刻分析」的说明原先在标题下方（占一行、挤压图表高度）；「模型 Token 占比」的
  小标题也挂在标题下。用户要求统一放到标题右侧，尽可能简单。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| `CardHead.hint` 固定渲染在标题紧右侧（`.wl-card-head-hint`） | 11px / 第三级文字色 / `nowrap` + 省略号截断 + `title` 全文；禁止再在标题下方加 hint |
| 标题与 hint 为同一 flex 行、`align-items: baseline` | 同基线（实测差 0px）；中间剩余空间即与右上 chips 的弹性间距 |
| 文案只讲"看什么"，每条 ≤ 18 个汉字 | 口径细节留给 tooltip 与报告 footer；时刻卡 hint 随 Tokens / 轮次切换 |
| 骨架屏也走 `CardHead` | 占位与真实卡片的标题/说明位置一致，标题下不再出现 hint |

### 量测（无头 Chrome，zh-CN，1560×1000 / 1180×1000）

| 项 | 1560 | 1180 |
| --- | --- | --- |
| 基线差（h3 vs hint） | 0px | 0px |
| hint 左缘 − 标题左缘 | 86 / 104.4 / 60px | 86 / 104.4 / 60px |
| 字号 / 颜色 | 11px / `rgb(129,133,140)` | 同左 |
| 标题下方 hint 节点 | 0 | 0 |
| chips 换行 / 被挤压 | 否（hint→chips 间距 293.6 / 269.9px） | 否（252.5 / 228.8px） |

- 截图：`.tmp/shots/hint-1560.png`、`.tmp/shots/hint-1180.png`。
- 断言：**535 → 545**，连跑 2 次 exit 0。

## 2026-10-17 UI 一致性（chips / CardHead / tooltip / 状态右对齐）

### 背景

- 用户实测「每日用量趋势」悬停无提示、工作区切换不在右上、模型用量 chips 没有底色、
  时刻卡「Token 未计入」孤零零挂在图例下方，且各卡开关/图例/提示样式各写一套。
- 排查结论：日历格与柱的 `<title>` 在旧构建里确实存在（60/60、7/7），但可见柱命中面积小
  （0 值柱 1px）、日期轴/周标签 0 个 title、旧文案三行且缺 Token/周末；审计另发现模型 treemap /
  趋势图的 title 挂在 `<g>` 上（多数浏览器不弹）。修复为「title 直接挂在形状 + 每列全高命中区」。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 切换控件统一 `ChipGroup` / `Chip`（`src/client/chips.jsx`） | 五处共用；样式只在 `styles.js` 定义一次，禁止变体 class |
| 卡片头统一 `CardHead`（`src/client/card-head.jsx`） | 标题在左、控件右上；模型卡补回标题，卡片内不再重复页面标题 |
| 状态判据抽到 `src/client/hour-status.js` | 只读 `diagnostics`，可单测；组件不写死 running/idle |
| 状态只跟 `modelFold.running` | 排队中的 refold 不显示「正在计算中」，避免活会话水位让提示常驻 |
| 每日柱每列一根透明命中区 | 0 值/1px 柱可 hover；title 不挂 `<g>`，避免浏览器不弹 |

### 已完成

- tooltip：日历格 / 每日柱 / 命中区 / 周几轴 / Year-Week 标签；单行文案 + 周末后缀；模型 treemap、趋势图 title 下移到 rect/命中区。
- chips：顶部范围、每日、时刻、工作区、模型五处共用；工作区开关移到卡片右上；模型 chips 恢复底色与选中态。
- 时刻：legend 行 `space-between`，右侧状态三态；回填期间继续 5 秒轮询。
- 样式：唯一 class 102 → 94；`.wl-legend` 合并；一次性提示类收敛为 `.wl-status` / hint 修饰。
- 文档：`docs/ui-conventions.md`；README 本轮未改，随后在 0.6.6 统一更新。

### 量测（无头 Chrome 1560×1000，zh-CN，7 天区间）

| 项 | 结果 |
| --- | --- |
| 日历格 title | 60/60 直接子 `<title>`；周几轴 7/7；周标签 3/3；周几条 7/7 |
| 每日柱 title | 可见柱 7/7 + 命中区 7/7；日期轴 7/7 |
| 样例 | `2026-08-19 · 活跃 46.2 m · Token 83.01 M`；`2026-09-05 · 活跃 57.8 m · Token 109 M · 周末`；`2026-10-12 · 活跃 20.4 m · Token 10.88 M` |
| chips 盒模型 | 四组均 24px 高 / 999px 圆角 / 0 10px 内边距 / 12px 字；右上间距均 17px（右）、15px（上） |
| chips 颜色 | 选中 `rgb(65,118,230)` + 白字；未选中 `color(srgb .9478 .9624 .9931)` 浅蓝底 + 1px 边框 |
| 状态 running | 「正在计算中……」右缘 826.6 = legend 右缘 826.6；`data-state=running` |
| 状态 idle | 「Token 未计入 5 个会话」右缘 826.6 = legend 右缘 826.6；`data-state=idle` |
| 状态 idle N=0 | 节点数 0（整条不渲染） |

### 测试

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**533 项断言，exit 0**。
- 截图：`.tmp/shots/ui-daily-calendar.png`、`ui-daily-bars.png`、`ui-chips-hour-workspace.png`、
  `ui-chips-model.png`、`ui-hour-status-running.png`、`ui-hour-status-idle.png`。
## 2026-10-17 时刻分析 Tokens 口径 + 人类消息密度点（v0.6.5）

> 版本号统一：此前的等待剔除、formatHours / 比例条 / 删日历提示等条目内容并入本版，
> package.json、README、CHANGELOG、docs 一律以 **0.6.5** 为准。

### 背景

- 时刻分析原先的柱高是「以轮次开始时刻计的净活跃时长」，用户要的是设计稿里的 **Token 产出**口径与顶部**人类消息密度**点。
- Token 只在投影里有总量，没有「按小时」分布；需要从事件日志的 `assistant/message` usage 按消息时间落桶，并严格守恒到官方总量。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 小时 Token = 每条 `assistant/message` 的 usage（输入 + 输出 + 缓存读 + 缓存写）按**消息时间**归 UTC 桶 | 与 `row.tokens` 同一定义；不按轮次起点（一条跨小时消息会落在它自己的小时） |
| `row.hourTokens` / `row.hourHumanMsgs` 随索引持久化，聚合用 `localHoursFromUtc` 平移 | 折叠在后台、不带查询时区；UTC 是唯一可持久化的稳定表示 |
| 守恒 `Σ hourTokens === row.tokensTotal`，整数目标用最大余数法 | 官方 Token 与事件累计不等（未闭合步 / crash 补写）时按比例回正，且不产生小数 Token |
| 读不出事件 → 无 `hourTokens`，`hourTokensSource.missing` 计数 | 不伪造分布；卡片与报告写「Token 未计入 N 个会话」，总量仍含该会话 |
| `byHour.tokensTotal` 取自 hourTokens，`starts` 留给「轮次」measure | 同一份 byHour 支持 Tokens / 轮次切换；旧 `tokens`（会话开始小时）字段保留兼容 |
| `INDEX_VERSION` 6 → 7 | v6 行没有新字段，不换代会把时间图 Token 显示成全 0 且无法补折 |
| 圆点几何抽到 `src/hour-scale.js` | 看板 DOM 与报告 SVG 共用半径 / 上沿 / 顶部空间；纯函数可直接断言 |

### 已完成

- `src/models.js`：`foldSessionHours` 新增 `hourTokens` / `hourHumanMsgs` / `hourTokensSource`，`sessionTokens` 作为守恒目标；
  `foldSessionModels` 透传并返回。
- `src/hour-scale.js`（新）：measure 取值 / 最大值 / 柱高百分比、`r = 3.4 + ratio×5.0`、上沿 14px、
  顶部预留 64px、`scaleTokenBuckets`（最大余数法）。
- `src/aggregate.js`：`distributeEventTokens()` 落小时 Token；`byHour` 增加 `tokensTotal` / `humanMsgs`；
  新增 `hourTokensSource { events, scaled, missing }`。
- `index.js`：`MODEL_ROW_FIELDS` 搬运新字段；折叠传 `sessionTokens: tokensTotal(row.tokens)`；
  `INDEX_VERSION` 6 → 7；`/snapshot.diagnostics` 带 `hourTokensSource`。
- 客户端：`HourChart` 默认 Tokens / 可切轮次、只在最大柱标值、顶部密度点、图例三项；卡片删除 `hour.sub` 小标题；
  `hour.tip` 改为一行 `小时 · Token · 轮次 · 人类消息`；缺失会话在卡片底部标注。
- 报告：`hourChart()` 改 Tokens + 密度点 + 峰值数值 + 同款图例 + 未计入提示。
- 文档：README（中英）断言数 / 口径、`docs/metrics.md` 的时刻 Token 与人类消息定义；版本统一 0.6.5。

### 视觉修正（2026-10-17）

> 用户看 `.tmp/shots/hour-card.png` 指出两处与设计稿不一致：峰值柱/「峰值」图例用了 amber（与人类消息点撞色）、
> 柱偏矮且顶部留白过多。复核结论：截图不是缩放，1560×1000 下卡片就是 637×314。

| 决策 | 取舍 |
| --- | --- |
| 峰值柱与「峰值」图例改用 `--dsw-static-blue-600`（`#2563eb`） | 宿主 token；比普通柱的 deepseek-400→600 更深，且与 amber 点（`#f59e0b`）明显分离 |
| 报告色板新增 `peak: "#2f4bd8"` | 报告是自包含 HTML，用不了宿主 token；取预览稿深蓝，人类消息点仍用 `weekend` amber |
| `.wl-hour-card` 纵向 flex，图表区 `flex:1 1 auto` + `min-height:240px` | 让柱区吃掉 header/legend 之外的高度；不再写死 196px |
| 柱形区 `top:64px` / `bottom:16px` | 顶部 64px 固定给密度点与峰值数值，柱高随卡片伸缩 |
| 同排 `.wl-pie-card` 拉伸时 `pie-wrap` 弹性居中 | 时刻卡变高后右侧饼图不留在顶部、下方留大片空白 |

- 量测（真实客户端 + 宿主 token + 无头 Chrome，1560×1000 / 1180×900）：
  卡片 637×354 / 596×354；图表区 240px（67.9%）；峰值柱 160px（45.3%）；顶部预留 64px；
  卡片顶到柱顶 122px（含 58px 标题区）；峰值柱 `#2563eb`、人类消息点 `#f59e0b`。
- 截图：`.tmp/shots/hour-card.png`、`hour-card-1180.png`、`hour-card-dark.png`、`hour-row-1560.png`。

### 测试

- 离线断言 **415 → 503**（连跑 2 次 exit 0）：跨小时 Token 归桶、`Σ hourTokens === tokensTotal`、缩放整数守恒、
  humanMsgs 计数与时区平移、measure 切换取数、未回填 / 读不出不计入并标注、圆点几何与图例文案、
  报告同步、宿主 `/snapshot.diagnostics.hourTokensSource`；新增峰值柱蓝 / 人类消息点 amber 的 token 分离断言。
- 同构量测（无头 Chrome 1560×1000，真实客户端组件 + 真实快照）：默认 Tokens、chips 切换生效、
  最大圆直径 16.8px 且上沿留白 14px、图例无括号解释、卡片无小标题、缺失提示可见。

## 2026-10-17 小时统一 1 位小数 / 日期明细比例条（v0.6.5 · 并入）

### 背景

- 页面里小时出现两种精度（`1.63 h` 与 `1.6 h`），来源是 `formatDuration`（小时 2 位）与 `formatKpiDuration`（1 位）各写一套。
- 「按日期明细」只有纯数字，缺少「主要会话」表里的浅色比例条。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| `formatHours(ms)` 以 1 小时为分钟 / 小时分界 | 既有报告断言「20 m」与短时长可读性优先；≥1h 固定 1 位小数（1.63 → 1.6），<1min 用秒 |
| 比例条拆成 `MetricBarCell` + `bar-width.js` | 两表共用一份宽度逻辑与 `.wl-bar-cell` 样式；纯函数可在离线断言里直接量测 |
| 日期明细用 Token 合计列替代步骤列 | 保持 8 列、窄屏不溢出；步骤仍在主要会话 / 工作区表 |
| 删除 `cal.hint` 键与渲染 | 需求明确；`chart.hint` 仍用于骨架屏，不留下空标签 |

### 已完成

- `src/format.js`：新增 `formatHours`；删除 `formatDuration` / `formatKpiDuration` 两套旧精度。
- `src/client/index.jsx` / `src/report-html.js`：所有时长展示改走 `formatHours`，无各自的 `/ 3600000` 或 `toFixed`。
- `src/client/bar-cell.jsx` / `bar-width.js`：新增通用比例条；主要会话四列 + 日期明细四列（对话 / 轮次 / 活跃 / Token）共用。
- `src/client/locales.js` / `index.jsx`：删除「全历史；右侧＝各周几累计」；每日用量趋势卡片头不再渲染提示段落。
- 文档：README（中英）/ release 断言数 384 → 415；package 版本随后统一为 0.6.5。

### 测试

- 离线断言 384 → 415（连跑 2 次 exit 0）：格式化边界与三处一致、两表共用组件、bar 宽度比例、删除提示键。


## 2026-10-17 等待用户剔除 / 净活跃口径（v0.6.5 · 并入）

### 背景

- 用户实测：用 `ask_user_question` 等回答 3 小时，这 3 小时被整段算成「活跃时长」（`toolMs` 是 call→result 墙钟），严重虚高。
- 目标：交互等待从活跃中剔除，但编译/跑批这类**没有人类输入**的长任务仍照常算工作。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 等待判定 = 单次区间 ≥ `waitMinMs` 且（白名单 或 夹着 `user/message`） | 白名单保证交互工具无 human 消息也能识别；human 夹层覆盖任意工具；统一阈值避免 30s 确认被切碎（断言 ④） |
| 长任务豁免 = 不满足上面任一信号就照常算工作 | 编译/跑批没有 user/message，不会被误伤（断言 ③） |
| 等待在**行级**剔除，而不是聚合后再减 | `byDay/byWorkspace/byHour/calendar/bySession` 的 `activeMs` 天然是净活跃；totals 另留官方 `activeMs` + `netActiveMs`，`llmMs/toolMs` 为净口径 |
| 小时桶缩放目标改为「官方 activeMs − waitMs」 | 保持 `sum(hours) === 净活跃`；事件桶与官方口径不等仍走 `events-scaled` |
| `INDEX_VERSION` 5 → 6 | v5 的 `hours` 把等待算成工作，语义作废；不换代会把旧桶当净活跃分布复用 |
| `excludeWait:false` 作为回归开关 | 置 false 时完全不判定等待，`waitMs=0`，小时桶与 0.6.0 逐桶一致 |

### 已完成

- `src/models.js`：新增 `DEFAULT_WAIT_TOOLS` / `DEFAULT_WAIT_MIN_MS`；`foldSessionHours` 在同一趟 events 里识别等待
  （白名单 / user/message 夹层 / 阈值），`waitMs` 整段剔除且不进小时桶；`foldSessionModels` 透传并返回 `waitMs`。
- `src/aggregate.js`：新增 `netActiveMs(row)`；桶的 `activeMs` 统一为净活跃并累计 `waitMs`；totals 保留官方
  `activeMs` 并新增 `waitMs` / `netActiveMs`；旧法摊销与事件桶回正都改用净活跃；占比/均值/每活跃小时输出改用净活跃。
- `index.js`：DEFAULTS 增加 `excludeWait` / `waitTools` / `waitMinMs`；折叠传参并写回 `row.waitMs`；
  `MODEL_ROW_FIELDS` 增加 `waitMs`；`INDEX_VERSION` 5 → 6（注释写明原因）。
- 客户端：KPI 活跃显示净活跃，副标题「含等待用户 {wait}」；工作区 foot 单列等待（zh/en 新键）。
- 报告：KPI / 每日柱 / 时刻图用净活跃，footer 写明净活跃 + 等待 = 官方 activeMs。
- 文档：`docs/metrics.md` 新增「等待用户（0.6.5）」章节；README（中英）/ release 断言数 326 → 384。

### 测试

- 离线断言 326 → 384（连跑 2 次 exit 0）：等待剔除 ①–⑦ + 白名单扩展 + 宿主配置端到端（true/false）+ 报告/i18n 展示。

## 2026-10-16 时刻分析改按轮次落桶（v0.6.0）

### 背景

- 用户要求以**轮次（turn）**为最小归属单位：多轮会话逐轮分开，每轮活跃时长整段记到该轮开始时刻所在整点，不分摊、不跨小时切分。
- 旧的「事件区间跨小时切分」把一轮 13:50–14:20 拆成 13 点 10min + 14 点 20min，与用户预期不符。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 轮次开始时刻取 `turn/start`，缺省取该轮最早事件时间 | 真实事件里有 `turn/start`；没有时退化为最早事件，仍可判定 |
| 事件没有 `data.turn`（`request/header`、`user/message`、老格式）归入会话级伪轮次，起点用 `sessionStartMs = createdAt` | 满足「会话级兜底记 createdAt 小时」；`request/header` 本身不产生活跃，只用来配模型区间 |
| 模型区间归 `assistant/message` 所在轮次，工具区间归 `tool/call` 所在轮次 | 区间与轮次天然同轮；跨轮悬空调用仍不计 |
| 事件里无可用区间 → `hours = null` | 未回填 / `modelUsage: off` 仍走旧 `distributeHours()` 摊销，全局守恒 |
| 落桶仍为 UTC，聚合时按请求时区平移 | 保持可持久化、时区无关；新增断言锁住「上海 13:00 → 13 桶」无 +1h 偏移 |

### 已完成

- `src/models.js`：`foldSessionHours()` 重写为轮次聚合（`turnKeyOf` / `SESSION_TURN_KEY` / `utcHourOf`），`foldSessionModels()` 透传 `sessionStartMs`。
- `index.js`：折叠时传 `sessionStartMs: target.createdAt`；`INDEX_VERSION` 4 → 5。
- `docs/metrics.md`：口径改为「每小时柱高 = 以轮次开始时刻计的活跃时长（不分摊、不切分）」并写明与旧摊销法的差别。
- 离线断言 308 → 326（多轮分开 / 跨小时整段归起始 / 会话级兜底 / 两时区无偏移 / 缩放与旧法兜底守恒）。
- 真实日志核对：某会话 5777 事件，逐轮聚合 raw = 710.3min，`sum(hours) === target`，11 个非空桶。
## 2026-10-16 时刻分析时区错位复核（证伪，未改源码）

### 背景

- 用户报「Asia/Shanghai 下 13:00–14:00 的会话被算到 14:00–15:00（整体晚一小时）」。怀疑 `foldSessionHours`（UTC 落桶）与
  `localHoursFromUtc`（平移）方向/取模写错，或跨小时切分、客户端柱/标签错位。

### 结论：未能复现

| 核对方式 | 结果 |
| --- | --- |
| 纯函数逐桶：上海 13:00–14:00（UTC 05:00–06:00） | 只落 13 点 60min，12/14 点 0 |
| 纯函数逐桶：上海 13:50–14:20（UTC 05:50–06:20） | 13 点 10min + 14 点 20min（旧切分口径，已在 v0.6.0 改为整段 30min 归 13 点） |
| 纯函数逐桶：上海 23:30–00:30（UTC 15:30–16:30） | 23 点 30min + 次日 0 点 30min（旧切分口径，已在 v0.6.0 改为整段 60min 归 23 点） |
| 真实日志独立核对（6 个当日会话，`Intl` 直算 vs 折叠+平移） | 逐桶完全一致，最大占比差 0.00%，峰位相同 |
| 客户端 `HourChart` | 第 i 根柱的标签与 tooltip 都是 i（标签取 `hour.hour`，服务端保证 `byHour[i].hour === i`） |

- 结论：平移方向是 `h*60 + offset`（上海 +480 → 正确晚 8 小时）；跨小时在 UTC 边界逐段切分；跨天用归一化取模。**无需改源码**。
- 附带发现：复核时正在运行的 GUI 仍在跑旧内存镜像（写 `index-v3.json`，旧摊销法），需重启才会走 v0.5.1 事件时间戳。

### 已完成

- 离线断言 308 → 321：⑦ 整点 / ⑧ 跨小时 / ⑨ 跨天三个时区回归用例（逐桶期望值 + `byHour[i].hour === i` + 守恒）。**该批已并入 v0.6.0 的新口径，最终 326 项。**
- E2E 断言 61 → 63：时刻柱与 0–23 标签逐柱对齐、高亮柱＝最高填充柱。

## 2026-10-16 时刻分析改按事件时间戳（v0.5.1）

### 背景

- 旧法把每个会话的 `activeMs = llmMs + toolMs` 按 `[createdAt, lastPromptAt]` 墙钟窗口均匀摊销到 30 分钟切片再归小时：
  新环境下少数超长会话会把少量活跃时长摊平到十几小时（**假平峰**）；`lastPromptAt` 缺失时窗口退化成 1ms →
  全部砸在创建小时（**假尖峰**）。引擎时间本就不等于墙钟时间，这是近似值。

### 关键决策

| 问题 | 结论 |
| --- | --- |
| 事件桶用哪个时区 | **UTC**。折叠（`runModelFold`）在后台运行、不携带查询时区，结果还要写 `index-v4.json` 跨查询/重启复用；UTC 是唯一时区无关的稳定表示。聚合时 `localHoursFromUtc()` 按请求时区平移：固定偏移（Asia/Shanghai、UTC）精确；带夏令时的时区用参考时刻偏移，切换周可能有 ±1h 误差（已在注释/文档写明） |
| 事件累计与官方 activeMs 不一致 | 整体按比例缩放到官方 activeMs（`hoursSource: 'events-scaled'`），保证 `sum(hours) === row.activeMs`（±1ms）；聚合时再按当前 activeMs 回正一次，覆盖"折叠后活会话续聊"的漂移 |
| 未配对 / 未结束的工具调用 | **不计**（悬空调用没有可信的结束时间，宁可少算）；已在 `foldSessionHours` 注释写明 |
| 未回填 / `modelUsage: off` | 退回旧 `distributeHours()` 摊销；快照 `hourSource` 区分 `events` / `scaled` / `apportioned`，两条来源不混算 |

### 已完成

- `src/models.js`：新增 `foldSessionHours()`；`foldSessionModels()` 在同一份 events 上顺带返回 `hours / hoursSource`。
- `src/aggregate.js`：新增 `localHoursFromUtc()` / `zoneOffsetMinutes()`；`byHour` 优先事件桶、回退摊销；`hourSource` 诊断；
  `starts` 从 `distributeHours` 上提到聚合循环统一记（避免两条来源重复计数）。
- `index.js`：`INDEX_VERSION` 3 → 4；`hours / hoursSource` 随行持久化并随行换代搬运；`/snapshot` 的 `diagnostics.hourSource`。
- 离线断言 267 → 308（连跑 2 次 exit 0）。

## 2026-10-15 余额 chip（v0.5.0，默认关闭）

### 铁律补充

- **默认零外发**：余额显示默认关闭；关闭时宿主一次 `deepseekAccount` 调用都不发（`BalanceTracker.ensure` 在 `enabled !== true` 时直接返回）。
- **可选依赖必须用 `ctx.get`，不能写进 `inject`**：cordis v4（`@deepseek-ai/cordis@4.0.5-alpha.2`）的 `inject` 只有"必需依赖"语义——
  `Fiber._refresh()` 要求 `Object.keys(this.inject)` 里每个服务都有实现，否则 fiber 停在 PENDING；`ctx.deepseekAccount` 未 inject 还会抛
  `cannot get property "deepseekAccount" without inject`。`ctx.get(name)` 是 `ReflectService.get` 的混入方法（注释原文
  "Read a service from the store without the inject requirement"），也是官方插件 `dsh-session-log-export` 用 `ctx.get("feedbackUi")` 的同款写法。
  因此 `index.js` 不声明该服务，用 `ctx.get("deepseekAccount")` 取；老版 DSH 返回 undefined → chip 显示「当前 DSH 不支持」。

### 已完成

- 宿主：`DEFAULTS.balance = { enabled: false, refreshMs: 300000 }`；`BalanceTracker`（可选服务 / 8s 超时 `withTimeout` / refreshMs 缓存 /
  并发合并 / try-catch）；快照加 `balance` 字段；新增只读 `GET /balance`（不触发索引）。
- 客户端：`src/client/balance.js` 的纯函数 `balanceChip()` 统一决定四种状态；`BalanceChip` 注册到
  `conversation.session.header.actions`（顶部工具栏动作区）；`useBalance` 每 5 分钟打一次本机 `/balance`。
- i18n `balance.*` 6 键；样式全部用宿主 token；金额格式化 `formatMoney` 上提到 `src/format.js`。
- 离线断言 215 → 267（连跑 2 次 exit 0）。

### 关键决策

| 问题 | 结论 |
| --- | --- |
| 为什么默认关闭 | 出网会把"本机在用 DSH 且有登录态"暴露给 platform.deepseek.com；插件其余部分完全本地，不能因为一个装饰性 chip 破坏声明，故默认关闭、显式 `balance.enabled: true` 才开 |
| chip 数据从哪来 | 专门加 `/balance` 轻量路由：工具栏常驻，不能为余额去拉整份 `/snapshot`（会触发索引同步/聚合） |
| 未登录 / 失败怎么显示 | 未登录「未登录」+ 充值链接；失败「—」+ 充值链接（不弹错）；链接来自本地 `getState()`，不依赖余额查询成功 |
| 报告要不要带余额 | 不带。报告要能外发，余额是私密信息；且报告的自包含断言只允许官方计费外链 |

## 2026-10-10 初版（v0.1.0）

### 铁律（本项目的硬约束）

1. **只用官方接口读数据**：`ctx.sessionQuery.listSessions()` + `ctx.sessionProjectionCache.cachedSnapshot()` + `ctx.sessionProjections.snapshot()`。
   不解析 `~/.dsh/sessions/**/session*.jsonl.zstd`，不直接读 `storages/session_projcache/sessions/*.json` 文件格式（那是内部实现）。
2. **零 I/O 建索引**：`cachedSnapshot` 从持久化检查点的内存表同步读取，全部会话实测建索引 ~250ms；不要退回逐会话冷读日志。
3. **报告必须自包含**：内联 CSS + 内联 SVG，无外链、无脚本，才能直接发客户/打印。
4. 客户端插槽的 `inject.hooks` 只接受 **store 形状（getSnapshot/subscribe）的可观察源**，不是 React hook 函数。

### 已完成

- 宿主半部 `index.js`：官方投影建索引 + `session/event` 增量更新 + 4 条只读路由（snapshot / export.json / report.html / health）。
- 聚合核心 `src/aggregate.js`（纯函数，宿主/报告/测试/客户端共用）+ 展示格式化 `src/format.js`。
- 自包含报告 `src/report-html.js`：KPI、每日堆叠柱 + 活跃时长折线、工作区排行、主要会话，全部内联 SVG。
- 客户端 `src/client/index.jsx`：`sidebar.footer.action` 入口 + `shell.overlay` 全屏看板，主题 token 自动适配深浅色，中英文文案。
- 离线验证 75 项断言（`test/verify.mjs`）；真实浏览器 E2E 19 项断言 + 6 张截图（`test/e2e-ui.mjs`）。

### 关键决策与坑

| 问题 | 结论 |
| --- | --- |
| 数据从哪来 | 官方投影（sessionStats / tokenUsage / title）。tokenUsage 是 `{uncachedInput, output, cacheRead, cacheWrite}`，缓存读取占绝大多数 token，展示时单列 |
| 子代理识别 | `SessionHeader.origin === "subagent"` 或 `delegationDepth > 0`；投影缓存文件里没有 origin，所以**不能**靠读缓存文件判断 |
| 客户端入口契约 | 包 `package.json` 需要 `dsh.client = { platform: "web", inject: [...] }` 且 `exports["./client"]` 指向 `lib/client.js`；bundle 必须 `window.__ModuleLoader__.load({id, factory})` |
| 插槽 hooks 坑 | `ctx.slots.register(..., C)` 的 `inject()` 返回 `{ hooks: { panel: fn } }` 时，渲染器把 `fn` 当 store 用 → `fn.getSnapshot is not a function`，插槽直接崩溃（控制台 `slot entry crashed`）。改用「传普通对象 + 组件内 `useSyncExternalStore`」 |
| 长区间截断 | `enumerateDays` 有 400 天上限，曾导致 `days=3650`（全部）时近 7 天变成 2017 年的空白日。现改为：区间 ≤180 天补齐空白日，>180 天只收录有活动的日子；`range.days` 表示区间跨度而非列表长度 |
| esbuild / puppeteer 解析 | 沙箱里没有 pnpm 与全局 dsh，且不便联网安装：`build.mjs` 与 E2E 都按「本目录 → 同级 同级插件项目 → ~/.dsh/profiles/web」顺序解析依赖 |
| E2E 遮罩 | 测试实例首次打开会有官方 `Preview Notice` 模态（`[class*="_mask_"]`）挡住侧边栏点击，E2E 必须先点 Continue；这不是插件问题 |

### 环境备忘（沙箱内）

- `dsh` 不在 PATH：用 `npx 缓存里的 .bin/dsh`。
- `ps` 被沙箱拦（`Operation not permitted`）；探测服务用 `curl` 而不是 ps。
- 真实 GUI 打不开调试：web 服务要 `?token=...` 才发 cookie，`curl -c jar` 后再访问。
- 写入范围：会话工作区（`~/WorkBuddy/ds_Harness`）可写；`~/.dsh` 与 `~/dsh_mac` 在沙箱外，需授权。

## 2026-10-10 装机后的两个真实缺陷（都已修）

真实 profile 一装就暴露了两个在 小规模 E2E 子集里看不见的问题：

### 1. tokenUsage 的 wire 形状 ≠ 持久化 state 形状（致命）

| 来源 | 形状 |
| --- | --- |
| 官方 wire view（`cachedSnapshot` / `projections.snapshot`） | `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`（**直接就是 bucket**） |
| 持久化检查点文件里的 `val`（state） | `{ totals: {...}, last: {...} }` |

`dsh-token-meter` 的投影定义写着 `wire.view = (state) => state.totals`。原先只读 `values.tokenUsage.totals`，
于是**所有走官方接口拿到的 token 全是 0**（时长却正常，因为 sessionStats 两种形状字段名一致，掩盖了问题）。
修法：两种形状都认（`usage.totals ?? usage`），并加回归断言。

### 2. 投影检查点会被格式迁移"作废"

本机多数历史会话里只有一部分 `cachedSnapshot` 命中——官方按"会话生命周期身份"（formatVersion/createdAt/cwd/isSeeded）
校验，v3→v4 迁移后的旧检查点被拒（这是设计，不是 bug）。修法：加官方冷读兜底
（`sessionQuery.observeSession(id, { projectionMode: "all" })`）+ 本地索引持久化，实测大部分靠冷读补齐，少数 v0 老会话
当前版本无法迁移（`subagent/descriptor ... unsupported descriptor version 2`）→ 明确列为"读取失败"并在看板上写明。

### 3. 顺带修掉的体验问题

- 首次全量冷读 全部会话 ≈ 2 分钟：改成**非阻塞 + 渐进式**（边解析边可查，`indexing: true` + 前端每 5s 自动重拉），
  并把并发从 4 提到 8；结果落盘 `index-v2.json`，重启走复用（实测重扫 <1s）。
- `indexing` 语义修正：只在"首次建索引未完成"时为真，后续增量重扫不再打扰用户。

### 装进真实 profile 的观察

- `dsh plugin --profile web add link:$PWD` 会**自动把包追加进 `dsh.profile.bundles`**（不用手改）。
- 新加的 bundle 会被 Loader **热加载**（宿主半部立即生效，实测 `/workload-report/v1/health` 直接 200）；
  但**改插件源码文件不会热替换已加载的模块**——要重启 Web profile 才生效；客户端半部需要刷新浏览器页面。

## 2026-10-10 追加：活跃天数 + inject 声明

- 「按工作区」加第二条 bar（活跃天数）：数据在 `aggregate()` 里用「工作区 → 自然日集合」算，属于展示层派生，
  索引文件不用改（行里已有 `createdAt`），所以升级后重启是快的、不用重跑冷读。
- 天数 bar 的宽度用**工作区之间相对值**（可比较），文字给「N 天 / 区间 M 天」做绝对参考——直接按区间天数画会在「全部」档小到看不见。
- `ctx.sessionProjections` / `ctx.sessions` 漏声明 → cordis 抛错被 catch，实时路径静默失效（`live` 恒 0，`/health.lastError` 里能看到）。
  **教训：cordis 的服务必须声明才能访问**；已加静态断言防止复发。

## 2026-10-10 追加：工作区行改"左付出 / 右消耗"

目标来自用户：**既要知道 Token 消耗，也要给客户讲清楚自己的付出**。三条设计决策值得记下来：

| 决策 | 取舍 |
| --- | --- |
| 左「付出」用**活跃时长**做主角，天数做小字 | 客户对"小时"最有共识；天数是支撑证据（持续性），单独占一条 bar 会让一行出现三条 bar，反而看不清 |
| 右「消耗」用**总 Token**，小字给"输出 / 缓存读取" | 输出 token 才是"产出内容量"，缓存读取是成本项；两者混在一根 bar 里会误导 |
| 两条 bar 都用**占全部的比例**（不是相对最大值） | 与旁边印的 % 同口径，bar 长度和数字说的是同一件事；代价是小项目 bar 很短（但数字仍在） |
| 行首右「最近使用 MM-DD」、行尾「会话 · 对话 · 平均每次对话时长」 | 客户视角的"最近还在推进""平均每次谈多久" |

**几何回归**：E2E 用 `getBoundingClientRect` 断言"左块右边界 ≤ 右块左边界 且两中线同高"——排版需求也能被自动测住。

## 2026-10-11 首页信息架构（v0.2.0）

用户要四件事：日历图（默认）+ 可切柱状图、时刻分析、工作区饼图、明细折叠；另外 KPI 要整数、活跃天数提前。

| 决策 | 取舍 |
| --- | --- |
| 时刻分析用 `sessionListMetadata.lastPromptAt` 界定活跃窗口 | 投影里只有会话级聚合值，没有逐事件时间戳；用 [开始, 最后提问] 做窗口 + 墙钟比例分摊，是唯一"零日志读"的可行口径。**切片严格覆盖 [start,end)，保证分摊总和与总时长相等**（测试断言守恒） |
| 日历的纵轴用周一为首（ISO 周） | 与"周计划"直觉一致；横轴 Year-Week，跨年时自动标出 `2026W01` 这类完整标签 |
| 日历颜色按区间内**相对最大值**分 5 档 | 绝对刻度在"全部"档会全是一个颜色；相对刻度保证任何区间都有对比度 |
| 明细改 `<details>` 折叠 | 明细是"要精确数字时才看"的内容，默认展开会把两张新图挤出首屏 |
| 总 Token 用整数、缩写只留小字 | 客户/博客需要可核对的真实数字；缩写放在备注里兼顾可读 |

**踩坑**：分摊循环最初写成 `while (cursor <= end)` + `min(cursor+slice, end+1)`，切片比例之和 = span+1 → 总量多出 5.5ms；
改成半开区间 `[start, end)` 后严格守恒（测试里加了守恒断言，以后回归会被抓住）。

## 2026-10-11 第二轮：排版与区间口径（v0.2.1）

| 需求 | 实现要点 |
| --- | --- |
| 工作区不逐行显示标签 | 每行两块指标只留数值/bar/小字；标签上移到列表顶部**一次**（`.wl-metrics-head`，与 1fr/1fr 网格对齐） |
| 「全部」不写死 10 年 | 客户端发 `all=1`，宿主用 `min(createdAt)` 当起点、今天当终点；`range.days` 随之为真实跨度 |
| 日历固定全历史 | 宿主新增 `calendar` 段（只受 scope 影响、不受 from/to 影响），客户端日历只读它；柱状图仍读受筛选的 `byDay` |
| 周几累计条 | 与日历同一张 SVG，紧贴最后一列右侧；每条带 `data-kind="weekday-bar"` 便于断言 |

**又是"测试写法"教训**：E2E 里"切换前后日历格子数"一开始用了两个不同选择器（含/不含 7 条周几条），
造成 66→59 的假失败。断言必须用同一个选择器测同一个量。

**真修复**：非首次重扫的渐进换表会造成请求读到残缺数据 → 改为原子替换（首次仍渐进，避免 2 分钟空白）。

## 2026-10-11 发布前收尾（v0.3.0）

- 单位统一 `H/M/S`：单位不再进翻译表；`formatDuration` 一处改动，看板与报告同时生效。
- 长备注压短 + 删死键：字典从 95 键降到 92 键，最长文案从 100+ 字降到 40 字内。
- **踩坑**：用 `String.replace(pattern, replacement)` 批量改文案时，replacement 里的 `## 待办` 会被当成"匹配内容"展开，
  把测试文件写坏过一次；另外同一条正则连用两次去改中英两段，第二次把中文覆盖成了英文。**改 i18n 用函数式替换或 split/join**。
- 新增 i18n 常驻断言（键集一致 / 引用存在 / 无死键 / 无超长），字体单位与文案长度也进了 E2E。

## 2026-10-13 第三轮：每日趋势单序列 / 图表铺满 / 骨架屏（v0.4.0 内）

| 需求 | 实现要点 |
| --- | --- |
| 柱状图只保留活跃时长 | 柱高 = `day.activeMs`（0 值日留 1px：柱 rect 数恒等于天数，且悬停提示覆盖每一天）；折线同系列同值，点上标 `formatDuration`（9px，`ceil(30 / 步长)` 隔点标注） |
| 去掉底部空白带 | 旧实现 viewBox 固定 1080×240，容器更高时等比缩放 → 图形上下留白。改为 ResizeObserver 量容器像素、viewBox = 容器尺寸（实测 xStretch = 1），字号即屏幕真实字号 |
| 打开即见布局 | 内存缓存未命中渲染 `SkeletonBody`（KPI 卡 / 图表容器 / 表格框），数值位「加载中…」；缓存命中仍走"旧值 + 后台刷新" |
| 默认近 7 天 | 客户端 `RANGES` 默认 `range.7` + 宿主 `DEFAULTS.defaultDays: 7`；README 配置示例同步 |
| 快照缓存竞态 | `patchLive()` 写行后 `snapshotCache = undefined`，与 sync / 模型回填后的失效处理一致 |

**踩坑**：同构量测的假 locale 若 `getSnapshot: () => ({ ... })` 每次返回新对象，React `useSyncExternalStore` 判定快照不稳定 → 无限重渲染（`Maximum update depth exceeded`）；假 ctx 必须返回同一个快照对象。
**量测**：`.tmp/iso-harness.mjs`（临时、已 gitignore）用假 ctx + 假 fetch 把**真实客户端组件**交给无头 Chrome，无需 DSH 实例；
读数：7 天 7 柱 / 30 天 30 柱、`otherRects = 0`（单序列）、数值标签两两 0 重叠、图底到图例 3.5px、日历与柱状容器高度差 0。

## 2026-10-13 第四轮：模型用量独立页签 + 首页模型环形图 + 柱状图去折线（v0.4.0 内）

| 需求 | 实现要点 |
| --- | --- |
| 模型用量拆独立页签 | 页签数组改为 `["byDay", "model", "byWorkspace", "bySession"]`（文案走 `tab.*` 动态族，新键 `tab.model`）；`ModelSection` 原样搬到该页签，首页不再渲染 treemap / 明细表 / 计费链接；骨架屏右列同步换成模型环形图占位 |
| 首页模型占比环形图 | **复用 `WorkspacePie`**（新增固定口径 `metric` 与 `ariaLabel` 两个可选 prop；固定口径时不渲染切换 chips），不复制第二套画法；数据 `data.byModel` → `{label, tokensTotal}`，固定 Token 占比 |
| 每日趋势去折线 + 周末异色 | 删 polyline 与 points；`day.date` 补 `T00:00:00` 本地解析取星期，0/6 用 `--dsw-static-amber-500`，柱上带 `data-date` / `data-weekend` 便于断言；数值仍 9px 标在柱顶（`data-kind="bar-label"`）；`chart.hint` 文案同步去掉「折线」 |

**量测**：`.tmp/iso-ui.mjs`（临时、已 gitignore）——真实客户端组件 + 真实 aggregate 快照 + 无头 Chrome 1560×1000，
23 项断言全过：页签顺序、7/30 天柱数 = 天数且 `polyline=0`、周末 / 工作日各 1 种 fill、首页环形图扇区 ≥1 且无 `circle`、
描边 = `--dsw-alias-bg-base` 1.6、首页无 treemap / 模型明细表、模型页签内容齐全。

**E2E 复核（真实实例，1560×1000）**：77 项通过，唯一失败是宿主 `conversation.session` 插槽自身的
`TypeError: text.replace is not a function`（本插件只注册 `sidebar.footer.action` 与 `shell.overlay`，与它无关）。
顺带修掉三个**测试自身**的老毛病：① KPI 跨列的断言查了 `gridColumnEnd`，而 `grid-column: span 2` 的计算值落在
`gridColumnStart`（end 是 `auto`）→ 一直误报；② 工作区右栏是 Token，却按 `h/m/s` 断言 → 永远不可能通过；
③ 换区间会先出骨架屏，固定 `sleep` 后点「柱状图」chip 会静默落空 → 改为等骨架结束 + 等 chip / 等 SVG。

**踩坑（重要）**：DSH 的 client-modules 扫描是**增量**的，bundle 字节在 Loader 扫描或 HMR `rebuilt()` 时读盘
（源码注释："Versioned code is immutable"）。实测本机那个运行中的 e2e 实例（`dsh web` + link 本插件）在我
`node build.mjs` 之后**能**取到新 bundle（`window.__DSH_BOOT__` 的 rev 对应新文件，取回的 bundle 含新文案、无 `polyline`），
所以对运行实例跑 E2E 可信；但没有 HMR 监听 / rev 未变时仍需重启。要做与实例无关的 UI 回归，用同构量测更稳。

## 2026-10-13 第五轮：模型回填常驻缺陷 + 报告对齐看板（v0.4.1）

### 根因（三个叠在一起，缺一条都复现不出完整症状）

| # | 现象 | 根因 | 证据（修复前，隔离实例 /tmp/dsh-workload-e2e） |
| --- | --- | --- | --- |
| 1 | 「模型维度正在回填…」常驻不消失 | `modelFoldTargets()` = `models === undefined \|\| asOfSeq > modelFoldSeq`；活会话每个事件 `asOfSeq` +1 → 永远 pending；`scheduleModelFold` 还有 15 分钟节流 | 轮询 6 次：`done` 130→194（/204），`pending` **恒为 204** |
| 2 | 重启 / 刷新后模型区没数据 | 折叠结果挂在行对象上，而 `liveRow/cachedRow/coldRow` 每次都新建行；`settle()` 与 `patchLive()` 直接换行；执行中的折叠还把结果写回**已被换掉的旧行** | 索引 336 行只有 132 行带 `models`，而 `folded` 已 274；`days=7` 的 `byModel = 0` |
| 3 | 一部分会话永远折不出来 | `readSession()` 对 v0 旧格式会话抛 `unsupported descriptor version 2`（本机 54 个） | `/health.modelFold.lastError` 原文；这些行把 pending 顶在 > 0 |

**关键量测（修复前 /health 的 modelFold）**：

```json
{ "running": false, "done": 204, "total": 204, "folded": 150, "skipped": 0,
  "lastAt": 1791886111864,
  "lastError": "failed to read stored session \"571902d6-…\": subagent/descriptor 0 uses unsupported descriptor version 2; …",
  "pending": 204 }
```
对应 `/snapshot?days=7`：`byModel = 0`、`topModel = null`（默认区间就是没数据）。

**修复后（同一实例，重启两次）**：

```json
{ "running": false, "done": 204, "total": 204, "folded": 150, "skipped": 0, "failed": 54,
  "pending": 0, "refold": 0, "failedRows": 54,
  "lastAt": 1791886511558, "lastErrorAt": 1791886699495,
  "lastError": "failed to read stored session \"f3f0af01-…\": subagent/descriptor 0 uses unsupported descriptor version 2; …" }
```
`days=7`：`byModel = 3`、`totalCost = ¥77.16`；**再重启一次**：`done = 0`（一次 `readSession` 都没发生）、`pending = 0`、`byModel = 3`。

### 修法

- `modelFoldQueue()` 三档：**pending**（从未折过，界面「回填中」只看它）/ **refold**（已折过且 `asOfSeq - modelFoldSeq > 50`，
  或会话已非 live）/ **failed**（失败行，过 `modelRetryMs` 再试）。失败**不算 pending** —— 否则 v0 老会话会让提示永远挂着。
- `carryModelFields()`：行换代时把 `models / modelFoldSeq / modelFoldAt / modelFoldSkipped / modelFoldError(At)` 整组搬到新行；
  折叠结果写回 `this.rows.get(id)`（**当前**行），不再写回抓到的旧行。
- 诊断：`modelFold.pending / refold / failedRows / lastError / lastErrorAt` 进 `/health` 与 `/snapshot`；界面在模型页签显示
  失败短句（`title` 放全文，`.wl-fold-error` 用 `--dsw-alias-label-error` token）；轮询条件从"仅 indexing"扩到"indexing 或 pending > 0"，
  折完自动停。运行级 `lastError` 为空时回退到**最近一条行级失败**，所以重启后不用再试一次就能看到原因。
- `saveToDisk()` 串行化（sync 与回填并发写同一个 `.tmp` 会 rename ENOENT）；`/health.diagnostics` 与 `/snapshot.diagnostics`
  统一走 `diagnosticsFor()`，新增 `syncing`（后台重扫事实，与给用户的 `indexing` 区分）。

### 量测（真实隔离实例 1560×1000；脚本 `.tmp/measure-final.mjs`，已 gitignore）

| 项 | 目标 | 实测 |
| --- | --- | --- |
| 首页模型环形图上下留白 | 差 ≤ 2px | 上 60.3 / 下 60.3 → **差 0**（卡高 344，图形 160） |
| 模型页签 treemap 到容器 | 左右 ≤ 8px | 容器 582×210，左/右/上/下 **0/0/0/0** |
| 卡片重复标题 | 无 | `.wl-card h3` = `[]`（只剩 h4 小标题 `Model share · area = tokens`） |
| 回填提示 | 折完即消失 | `[data-kind="model-folding"] = null` |
| 失败提示 | 可见 | `54 sessions failed to read logs: …`（`title` 全文） |
| 报告 treemap | 铺满 | 339 = 父容器 339，左右留白 0 |
| 报告内容 | 模型一节 + 模型费用 KPI + 无折线 + 周末异色 | sections 含「模型用量」；KPI 第 3 张「模型费用(估算)」；`polyline = 0`；周末柱 29 根 |
| 报告自包含 | 无脚本 / 仅官方外链 | `script = 0`、`style = 1`（内联）、6 条外链全是官方计费页 |
| 工具栏 | 无「复制 JSON」 | `["Refresh", "Export HTML report", "✕"]` |

E2E（`test/e2e-ui.mjs`，真实实例）全过；离线断言 184 → **215**（连跑 2 次 exit 0）。

### 环境坑（沙箱内）

- 隔离实例的 `dsh` 不在 PATH：`DSH_BIN=/Users/xilejun/.npm/_npx/b5c6312874079fe8/node_modules/.bin/dsh`（`test/e2e-boot.sh` 只剩这个变量要手动给）。
- `ps` 被沙箱拦：找实例进程用 `lsof -nP -iTCP:3299 -sTCP:LISTEN -t` 再 `kill`。
- puppeteer-core 不在本仓库：`WL_PUPPETEER_DIR=/Users/xilejun/WorkBuddy/ds_Harness/tableau-twb-viewer/node_modules`。
- 面板语言可能是**英文**（本实例就是）：E2E 里凡断言文案的地方都要中英都认，本轮踩过一次。
- 需要"重启后仍带模型数据"的证据时，用 `E2E_KEEP=1` 复用同一个 `E2E_HOME`（索引文件在 `$E2E_HOME/workload-report/index-v4.json`）。

## 待办

- [x] 安装进真实 web profile（2026-10-10 由用户执行 `dsh plugin --profile web add link:$PWD`）。
- [x] 模型维度已在 0.4.0 接入、0.4.1 修掉回填常驻缺陷（读 `readSession` 事件日志，见 docs/models.md）。
- [ ] 可选：把「按工作区」做成季度/月度对比；把导出接入 PNG（现在用浏览器截图即可）。
- [x] 2026-10-17：把「最活跃模型」搬进报告；8 张 KPI 在 5 列栅格正好排满（见 `docs/report-parity.md`）。

## 2026-10-13 v0.4.1 发布

### 本轮新增能力

- **模型维度（0.4.0 起）**：`src/models.js` 从官方 `ctx.sessionQuery.readSession()` 的事件日志折叠模型与 token
  （不解析 zstd/JSONL），归并 `deepseek-flash` → `deepseek-v4-flash`（官方定价页注 1：同一模型的新旧名）；
  索引 `INDEX_VERSION = 3`，行内带 `models` / `modelFoldSeq`，**结果随索引落盘、重启不重折**。
- **费用估算**：内置 DeepSeek 官方**峰谷价**（as-of 2026-10-13；峰时 01:00–04:00 与 06:00–10:00 UTC 周一至周五，谷价半价），
  按每条 `assistant/message` 的时间逐条判峰谷计费；无官方价的模型显示 `—` 不猜；页面与报告底部给官方计费链接；**运行时不联网**。
- **多机同步暂缓**：方案保留在 `docs/sync.md`，列入 `docs/roadmap.md` 后期。

### 关键决策与坑（避免重复踩）

1. **行换代必须搬运模型字段**：`liveRow/cachedRow/coldRow` 每次都新建行，模型折叠结果若不随行搬运就会被每次同步/事件冲掉
   （曾导致"折叠计数涨、界面却为空"）。用 `carryModelFields()` 统一搬运，折叠结果写回**当前**行。
2. **pending 只认"从未折过"**：活会话 `asOfSeq` 持续增长，把它计入 pending 会让提示永不消失；已折过的只在
   `asOfSeq - modelFoldSeq > 50` 或会话已非 live 时重折；失败行单独计数并暴露 `/health`。
3. **`overflow-x: auto` 会把另一轴计算成 `auto`**：日历需要横向滚动时，必须显式 `overflow-y: hidden`，
   并给内联 SVG `display: block`（去掉基线间隙），否则出现 7px 纵向滚动条。
4. **官方接口边界**：`listEvents()` 无事件正文；只有 `readSession()` 能拿完整事件；v0 旧格式会话 `readSession()` 会抛错，
   只能界面说明 + 单独计数，不是本插件可修的问题。
5. **i18n 静态校验**：新增/删除键必须 zh/en 同步，否则 verify 的死键/对齐断言会红。

### 发布

- GitHub：推 `main`（CI 跑构建 + 产物一致性 + 离线断言）。
- npm：`npm stage publish` 暂存 → 本人在本地用一次 OTP `npm stage approve`（npm 现要求交互式 2FA，token 不能替代）。