# 报告对齐清单（看板 → HTML 报告）

> **铁律：任何看板 UI 改动必须在同一提交内同步 `src/report-html.js` 与本文档，
> 并在 `test/verify.mjs` 补一条结构断言。只改 `src/client/*` 视为未完成。**
>
> 报告的硬约束：**自包含 HTML**（内联 CSS + 内联 SVG、无脚本、除官方计费链接外无外链）。
> 为此报告不复制看板的切换交互，而是固定默认口径 + 用第二张小图 / 表格列表达第二口径。

- 生成入口：`renderReport(snapshot, options)`（`src/report-html.js`），宿主路由 `/workload-report/v1/report.html`。
- 数据源：与看板同一个 `present(aggregate(...))` 快照（`snapshot.byDay / byHour / calendar / byModel / modelDaily / pricing / topModel / diagnostics`）。
- 最近审计：2026-10-17（v0.6.6）。此前报告漏掉 0.6.5 的时刻图 / 卡片头 / 比例条等改动，本清单即为防再漏的基线。

## 1. 逐项对照

状态：`✓` = 看板与报告一致；`✗` = 报告缺失（必须补）；`—` = 有意不同（见第 2 节）。

### 1.1 KPI

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| KPI 数量与顺序 | 8 张：活跃 / Token / 模型费用 / 活跃天数 / 对话 / 轮次步骤 / 缓存 / 最活跃模型 | 同 8 张、同顺序 | ✓ |
| 活跃时长口径 | 净活跃 `netActiveMs`，副标题「模型 · 工具 · 等待」 | 同净活跃 + 同副标题 | ✓ |
| 总 Token | 完整整数，副标题用 K/M/B 缩写 | 同完整整数 + 同副标题 | ✓ |
| 模型费用 | 标签「模型费用」；副标题「N/M 个模型有官方价 · as-of」；无价显示 — | 同标签 / 同副标题 / 同 — 规则 | ✓ |
| 最活跃模型 | `snapshot.topModel`，默认请求数口径，副标题「请求占比 X%」 | 同数据 + 同口径 + 同副标题 | ✓ |
| 栅格 | 5 列，Token / 模型费用各跨 2 列；1080 / 720 断点降列 | 5 列 + 同样跨列 + 同样断点 | ✓ |
| 数值字号 / 标签字号 | 20px / 11px | 20px / 11px | ✓ |

### 1.2 每日用量趋势（看板）/ 每日用量趋势 + 模型 Token 占比（报告）

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 日历热力图 | 默认视图；周一～周日 × Year-Week，5 级色阶 | 静态渲染；同一数据源 `snapshot.calendar` | ✓ |
| 日历交互 | 每格 / 周几轴 / 周标签 / 周几条都有直接 `<title>` | 同 tooltip 文案：「日期 · 活跃 x · Token y[ · 周末]」 | ✓ |
| 周几累计条 | 日历右侧 7 根横向条 + 数值 | 同位置、同算法、同 tooltip | ✓ |
| 日历 / 柱状切换 | `ChipGroup` 两态 | 不做切换（静态报告无交互） | — |
| **卡片归属** | 「每日用量趋势」与「模型 Token 占比」是**两张独立卡片** | 同：`daily-plus-model` 容器内两张 `.card`，不共用一个卡片容器 | ✓ |
| **模型 Token 占比** | 首页右卡：紧凑环形图（Token 口径） | 右侧独立卡片，`sharePie` 同几何（外 74 / 内 50 / viewBox 160） | ✓ |
| **列宽对齐** | 两卡同宽 | `daily-plus-model` 与下方 `two-col` 均为 `1fr 1fr`：每日趋势 = 时刻分析宽，模型占比 = 工作区占比宽，左右两列对齐成竖线 | ✓ |
| **顶部区间筛选器** | `ChipGroup` + `<button>` 可切区间 | **纯视觉**：`<span class="range-chip">` 四档，当前档实底高亮；无脚本、无链接、无指针手型 | —（有意不同） |
| 每日柱状图 | 单序列活跃时长、周末 amber、峰值标数值 | **不再渲染**（报告右侧改为模型环形图，见 CHANGELOG v1.0.2） | — |
| 时长格式 | `formatHours`（1 位小数，去 .0） | 同 `formatHours` | ✓ |

### 1.3 时刻分析

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 默认口径 | `useState("tokens")`，Tokens 默认 | 固定 Tokens 口径，卡头写明「Tokens 口径」 | ✓ |
| 主图 | 24 根柱＝该小时 Token 产出；0 值 1px | 同 24 根柱 / 0 值 1px / 直接 `<title>` | ✓ |
| 人类消息密度点 | 顶部 24 个圆点，半径 3.4 + ratio×5.0，上沿 14px | 同 `hourDotRadius` / `HOUR_DOT_TOP` / `data-kind="hour-dot"` | ✓ |
| 峰值柱 | 深蓝 `#2f4bd8`（`--dsw-static-blue-600`） | 同 `peak: "#2f4bd8"` + `isPeak ? palette.peak : palette.input` | ✓ |
| 图例三项 | Token 产出 / 人类消息密度 / 峰值 | 同三项、同色块语义 | ✓ |
| 状态行 | 右侧：回填中「正在计算中……」；空闲「Token 未计入 N 个会话」；N=0 不渲染 | 复用 `hourTokensNote`，同三态 / 同文案 / 同右对齐 | ✓ |
| Tokens / 轮次切换 | `ChipGroup` 两态 | 不做切换；轮次用主图下方第二张小图 | — |
| 轮次第二口径 | 切换后同一张图换 measure | 静态小图「轮次（该小时开始的会话数）」，`data-kind="hour-turns-bar"` | ✓（有意不同形态） |

### 1.4 工作区

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 占比环形图 | 默认按时长；可切按 Token | 固定按时长；卡头注明「Token 占比见下表」 | — |
| 环形几何 | `sectorPath`，外 74 / 内 50，背景色 1.6 描边 | 同 `sectorPath` / 同几何 / 同描边 | ✓ |
| 工作区条形 | 我的付出 / Token 消耗，两条同口径；活跃 N/M 天、轮次、步骤；最近使用；平均每次对话、等待用户 | 同左右两块 / 同占比 / 同小字；脚注补平均每次对话与等待用户 | ✓ |
| 工作区表 | 10 列（活跃天数 / 会话 / 对话 / 轮次 / 步骤 / 活跃 / Token / 两个占比） | 同 10 列 | ✓ |

### 1.5 表格比例条

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 宽度规则 | `MetricBarCell` → `barPercent(value, max)`，夹紧 0–100 | 直接 import `barPercent`，同一规则 | ✓ |
| 视觉 | 浅色圆角底 + 20% 左右语义色填充 + 数值压在条上 | 内联 `.bar-cell` / `.bar-cell-fill` / `.bar-cell-value`，同高 20px / 圆角 5px | ✓ |
| 语义色 | turns / steps / activeMs / conversations / output / tokens | 同 6 种语义色（浅色 / 深色各一套） | ✓ |
| 适用表 | 按日期明细、主要会话 | 同两张表 | ✓ |
| 按日期明细列 | 日期 / 对话 / 轮次 / 活跃 / Token 合计 / 输入 / 输出 / 缓存，最近 31 天 | 同 8 列 / 同顺序 / 同 31 天上限 | ✓ |
| 主要会话 | 40 行、可排序、轮次/步骤/活跃/输出四列比例条 | 前 12 行（可配置 `sessions`）、无排序、同样四列比例条 | —（打印用途） |

### 1.6 模型用量

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 卡片头 | `CardHead`：标题 + 右侧说明「左＝占比面积 · 右＝按日趋势」 | 同标题 / 同说明 / 同位置 | ✓ |
| treemap | 铺满容器；Top 8 + others；小标题「模型占比 · 面积 = Token」 | 同布局算法 / `width="100%"` + `height:auto` 铺满 / 同小标题 | ✓ |
| treemap tooltip | 挂在 rect 上的 `<title>`（不挂 `g`） | 同（rect 自带 title） | ✓ |
| 按日趋势 | 堆叠柱，前 6 个模型；每段 rect + 整列命中区都有 `<title>`；小标题「按日模型趋势」 | 同堆叠 / 同前 6 / 同 title 挂法 / 同小标题 | ✓ |
| 口径切换 | 按 Token / 按请求 / 按模型耗时 | 固定按 Token | — |
| 模型筛选 | 点击 treemap / 表名只看该模型（多选） | 不做筛选 | — |
| 明细表 | 模型 / 占比 / 请求 / 输入 / 输出 / 缓存读 / 缓存命中 / 费用(估算) | 同 8 列 | ✓ |
| 费用说明 | as-of、覆盖度、合计、仅 DeepSeek 有官方价 | 同信息 | ✓ |
| 官方计费链接 | 页面底部 | 报告模型卡 + footer，均为官方计费页 | ✓ |

### 1.7 卡片头、文案、自包含

| 功能点 | 看板 | 报告 | 状态 |
| --- | --- | --- | --- |
| 卡片说明位置 | `CardHead.hint`：标题紧右侧 | `.card-head-text` 内 `h2` + `.card-hint` | ✓ |
| 说明字号 / 颜色 | 11px、第三级文字色、单行省略 + `title` | 11px、muted、同省略 + `title` | ✓ |
| 标题下方 hint | 禁止 | 已无 `<p class="hint">` | ✓ |
| 等待剔除口径 | KPI 副标题 + 工作区等待 | KPI 副标题 + 工作区脚注 + footer | ✓ |
| Token 口径 | KPI 副标题 / 时刻卡 / 模型卡 | KPI 副标题 + 时刻卡 + 模型卡 + footer | ✓ |
| 未计入 N 个会话 | 时刻图状态行 | 同状态行 | ✓ |
| 脚本 / 外链 | 宿主应用 | `<script` = 0；无 `<link` / `src=`；外链仅官方计费页 | ✓ |
| 语言 | zh / en 逐键对齐 | 固定中文（导出快照） | — |
| 主题 | 跟随宿主 | `?theme=light｜dark`，自带同色板 | ✓ |
| AI 用户画像 | 导航最右侧的独立顶层页签（蓝底强调），默认包含、点击生成 | 不展示 | —（见第 2 节） |

## 2. 有意不同（不强行对齐）

| 项 | 看板 | 报告 | 原因 |
| --- | --- | --- | --- |
| 所有切换控件 | 日历/柱状、Tokens/轮次、时长/Token、模型三口径 | 一律不渲染 chips，不伪造按钮 | 报告无脚本、要能直接发文件 / 打印 |
| 每日趋势 | 日历 / 柱状二选一显示 | 固定日历；右侧为模型 Token 占比环形图 | 静态报告没有切换入口，日历信息量最大；模型占比是客户最关心的成本视角 |
| 时刻第二口径 | 同一张图切 measure | 主图固定 Tokens + 下方轮次小图 | 满足「不假装有切换」且保留轮次信息 |
| 工作区占比 | 时长 / Token 可切 | 固定时长；Token 占比在下方表格 | 避免两张环形图重复占版面 |
| 模型口径 / 筛选 | 三口径 + 点击筛选 | 固定 Token、无筛选 | 静态排版的交互没有意义 |
| 主要会话行数 / 排序 | 40 行、表头排序 | 前 12 行（`sessions` 可调）、无排序 | 报告面向打印与分享，保持短 |
| 语言 | zh / en | 固定中文 | 导出文件不跟随宿主语言，避免同一次导出因语言漂移 |
| 报告标题 / 备注 | 无 | `?title=` / `?note=` | 导出场景需要署名 |
| AI 用户画像 | 卡片：标题 + 生成按钮 + 特征 / 建议 + usage | **不展示** | ① 报告面向客户 / 打印，不应夹带 AI 对个人的判断；② 报告必须无脚本，画像需要点击触发与模型调用；③ 画像按需生成，静态导出不应隐式联网。报告保持自包含，画像只在看板查看。 |

## 3. 同步流程（改看板时照做）

1. 改 `src/client/*` 的 UI / 文案 / 交互。
2. 问自己：这个改动在静态报告里应该怎么呈现？
   - 纯交互（切换、排序、点击筛选）→ 在本文档「有意不同」登记，并确认默认口径。
   - 视觉 / 文案 / 新数据 → **同一提交**改 `src/report-html.js`。
3. 在 `test/verify.mjs` 的「报告结构对齐」块补标记断言；标记必须是稳定选择器 / 固定文案，不依赖随机数据。
4. 跑 `node build.mjs && node test/verify.mjs` 连跑 2 次，exit 0；再按第 5 节截图复核。
5. 更新本文档的状态列与 `PROGRESS.md`。

## 4. 结构断言（test/verify.mjs）

| 断言 | 标记 |
| --- | --- |
| 密度点 | `data-kind="hour-dot"` |
| Tokens 默认口径 | 文案「Tokens 口径」+「Token 产出」 |
| 轮次第二小图 | 「轮次（该小时开始的会话数）」+ `aria-label="时刻分析：轮次"` |
| 状态行（回填 / 空闲） | `data-kind="hour-tokens-missing"` + `data-state="running"｜"idle"` + 对应文案 |
| 标题右侧说明 | `class="card-head"` > `card-head-text` > `h2` + `card-hint`；无 `class="hint"` |
| 说明字号 / 颜色 | `.card-hint` 11px + muted |
| 日历 | `data-kind="calendar-cell"` + `data-kind="weekday-bar"` |
| 模型 Token 占比环形图 | `aria-label="模型 Token 占比"` + 圆心「总 Token」，且**不在**「每日用量趋势」卡片内 |
| 工作区占比环形图 | `aria-label="工作区占比"` + 圆心「总活跃时长」 |
| 两卡独立 | 容器 `daily-plus-model`（无 `daily-pair`）；`/\.daily-plus-model > \.card/` |
| 表格比例条 | `data-bar-cell` + `.bar-cell-fill` 的 `width:…%` |
| 模型小标题 | 「模型占比 · 面积 = Token」+「按日模型趋势」 |
| KPI | 「模型费用」+「最活跃模型」+「请求占比」 |
| 区间筛选器 | `class="range-filter"` + 四档文案 + 恰好一个 `data-active="true"`；块内无 `<a>` / `<button>` |
| 口径 | 「等待 」+「净活跃」（**不再**出现「含等待用户」） |
| 自包含 | 无 `<script` / `<link` / `src=`；外链只允许官方计费域名 |
| 报告不含画像 | 无「用户画像」/「本地规则版」/ `data-kind="ai-profile"`（有意不同） |

## 5. 复核命令与截图

```bash
export ESBUILD_PATH=/Users/xilejun/WorkBuddy/ds_Harness/tableau-twb-viewer/node_modules/esbuild/lib/main.js
export PATH=/Users/xilejun/.n/bin:/usr/local/bin:/usr/bin:/bin
node build.mjs && node test/verify.mjs
```

截图（隔离 e2e 实例 `test/e2e-boot.sh`，1240 宽，全页）：

- `.tmp/shots/report-light.png`
- `.tmp/shots/report-dark.png`
- 局部：`.tmp/shots/report-hour-light.png` / `report-hour-dark.png`

复核点：时刻图顶部有密度点、峰值柱深蓝、说明在标题右侧 11px muted、所有时长 1 位小数、
表格比例条宽度来自 `barPercent`、`<script` 为 0、外链仅官方计费页。
