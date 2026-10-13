# PROGRESS — dsh-workload-report

日期用 `YYYY-MM-DD`；只记录影响后续决策的事实。

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

**踩坑（重要）**：DSH 的 client-modules 扫描是**增量**的，插件 bundle 只在 Loader 扫描（启动 / 装插件）或 HMR `rebuilt()` 时读盘
（源码注释："Versioned code is immutable"）；`node build.mjs` 改了 `lib/client.js` 后，**已在运行的实例仍发旧 bundle**。
所以：① 验证新 UI 用同构量测（直接 bundle src，不经过实例）；② 对运行中实例跑 E2E 前必须重启，否则测的是旧代码。

## 待办

- [x] 安装进真实 web profile（2026-10-10 由用户执行 `dsh plugin --profile web add link:$PWD`）。
- [ ] 可选：把「按工作区」做成季度/月度对比；把导出接入 PNG（现在用浏览器截图即可）。
- [ ] 可选：接入模型维度（需要读 `request/header` 事件，成本高于投影读取，暂不做）。
