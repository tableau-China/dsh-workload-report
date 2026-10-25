# UI 约定 — dsh-workload-report

> **铁律**：看板里所有切换控件统一用 `ChipGroup`，所有指标条形统一用 `MetricBarCell`，
> 所有卡片头统一用 `CardHead`。**新增 UI 必须复用这些组件；不得另造样式或变体 class。**
>
> 颜色只用宿主主题 token（`--dsw-alias-*` / `--dsw-static-*`），不写死色值；zh/en 文案逐键对齐，不留死键。
>
> **报告同步铁律：任何看板 UI 改动必须在同一提交内同步 `src/report-html.js` 与
> `docs/report-parity.md`，并在 `test/verify.mjs` 补结构断言。只改 `src/client/*` 视为未完成。**
> 静态报告的自包含约束（内联 CSS/SVG、无脚本、除官方计费链接外无外链）不可破坏。

> **面板高度固定（2.0.0）**：看板浮层 `.wl-panel` 固定 `height: 92vh`，内容区
> `.wl-body` 用 `flex: 1 1 auto; min-height: 0` 在面板内部滚动。四个页签（按日期 / 模型用量 /
> 按工作区 / 主要会话）内容长短不同，若让面板随内容收缩，切页签时外框高度会跳；
> 固定高度让四个页签的初始高度一致（内容短的页签底部留白，内容长的在内部滚动）。

## 1. 共享组件清单

| 组件 | 文件 | 用途 | 使用位置 |
| --- | --- | --- | --- |
| `ChipGroup` / `Chip` | `src/client/chips.jsx` | 切换控件（浅底 + 边框；选中主题强调色实底 + 白字） | 顶部时间范围、每日用量、时刻分析、工作区占比、模型用量 |
| `CardHead` | `src/client/card-head.jsx` | 卡片头：左标题 + 紧右侧小字说明（hint），右上控件 | 每日用量趋势、模型 Token 占比、时刻分析、工作区占比、模型用量 |
| `MetricBarCell` | `src/client/bar-cell.jsx`（宽度纯函数 `src/client/bar-width.js`） | 表格内的指标比例条 | 主要会话、按日期明细 |
| `hourTokensNote` | `src/client/hour-status.js` | 时刻图 legend 右侧状态文案判据 | 时刻分析（running / idle / 隐藏三态） |
| `sectorPath` | `src/sector-path.js` | 环形图扇区几何（看板与 HTML 报告共用） | 工作区 / 模型环形图、报告 |
| `ProfileCard` | `src/client/profile-card.jsx` | AI 用户画像卡片（CardHead + `.wl-hint` / `.wl-status`，不另造卡片头） | 主要会话页右列（与会话表同一 grid 行；<=1080px 堆叠） |

## 2. 切换控件：只有 `ChipGroup` + `Chip`

```jsx
<CardHead title={t("chart.daily")}>
  <ChipGroup label={t("chart.daily")}>
    <Chip active={mode === "calendar"} onClick={() => setMode("calendar")}>{t("daily.calendar")}</Chip>
    <Chip active={mode === "bar"} onClick={() => setMode("bar")}>{t("daily.bar")}</Chip>
  </ChipGroup>
</CardHead>
```

固定样式（`src/client/styles.js` 的 `.wl-chips` / `.wl-chip`，只定义一次）：

| 状态 | 背景 | 边框 | 文字 |
| --- | --- | --- | --- |
| 默认 | 7% `--dsw-static-deepseek-500` + `--dsw-alias-bg-layer-2`（浅蓝底） | 1px `--dsw-alias-border-l2` | `--dsw-alias-label-secondary` |
| 选中 | `--dsw-static-deepseek-500` | 同色 | `--dsw-alias-label-primary-inverted`（白字） |

尺寸：高 24px、圆角 999px、组内间距 6px、字号 12px。**不要**新增 `wl-chip-active`、
`wl-chips-inline` 之类的变体；需要新语义时给 `Chip` 透传 `data-*`，样式仍走同一套。

## 3. 卡片头固定结构

```
┌─────────────────────────────────────────────┐
│ 标题（h3） 说明（11px muted，单行） [右上控件] │
└─────────────────────────────────────────────┘
```

**铁律：卡片说明文字统一放标题右侧的 `CardHead.hint`，禁止再在标题下方加 hint。**
正文里的补充说明（口径、费用、点击提示等）不属于卡片头，继续用 `.wl-hint` 放在内容区。

- 结构由 `src/client/card-head.jsx` 的 `CardHead` 渲染：`.wl-card-head` = `space-between`，
  `.wl-card-head-text` = 标题 + hint（`align-items: baseline`，同一行、基线对齐），
  `.wl-card-head-actions` = 右上（`margin-left: auto`，与左侧之间是弹性间距）。
- hint 固定样式：`.wl-card-head-hint` —— 11px、第三级文字色、`white-space: nowrap`、
  单行省略号截断，并始终带 `title` 保留全文；不允许换行、不允许挤压右上 chips。
- 文案只解释"看什么"，每条 ≤ 约 18 个汉字；口径细节留给 tooltip 与报告 footer。
- 标题只出现一次；切换控件一律放右上角，与「时刻分析」同位置、同样式。
- 没有右侧控件时只传 `title`（可选 `hint`），不渲染空 actions 容器；骨架屏也必须用
  `CardHead`，保证占位与真实卡片的标题/说明位置一致。
- 卡片内部不再重复页面/页签标题。

## 4. 图例固定结构

- 基础行：`.wl-legend`（flex + wrap + 11px 第三级文字色）。
- 图例项：`.wl-legend-item` + `<i>` 色块；只解释颜色，不写「（点越大越多）」这类解释。
- 需要右侧状态时：`.wl-legend-group` 放左侧图例项，`.wl-status` 放右侧（`margin-left: auto`），
  容器加 `.wl-hour-legend`（`justify-content: space-between`）。
- 时刻图的状态三态由 `hourTokensNote` 决定（判据是宿主 `modelFold.phase`）：
  `first-fold`（本轮含从未折过的会话）→ 「正在计算中……」；
  `background`（已有数据的后台重折/重试）→ 「后台更新中」灰点小字，不打扰；
  `idle` 且 `hourTokensSource.missing > 0` → 「Token 未计入 N 个会话」；`idle` 且 N=0 → 返回 `null`。
  `failedRows` 只计入「未计入」提示，**绝不**把状态变成计算中。

## 5. 状态提示与 hint

| 场景 | class | 说明 |
| --- | --- | --- |
| 卡片头说明（标题右侧） | `.wl-card-head-hint` | 11px、第三级文字色、单行截断 + `title`；只由 `CardHead.hint` 渲染 |
| 正文补充说明 | `.wl-hint` | 11px、第三级文字色；**不得**放在标题下方充当卡片说明 |
| 与上方内容留白 | `.wl-hint .wl-hint-spaced` | 只加 `margin-top`，不另造颜色/字号 |
| 块级第二行 | `.wl-hint .wl-hint-block` | 表格里的补充说明 |
| 状态（未计入 / 计算中 / 回填中 / 读取失败） | `.wl-status` | 可选 `data-state="running"`、`data-tone="error"`；不再新增一次性 class |
| 图例色块 | `.wl-legend-bar / .wl-legend-dot / .wl-legend-peak` | 只在 `.wl-hour-legend` 下定义颜色 |

## 6. 图表 tooltip

- 每个可 hover 的元素必须有**直接挂在自己身上**的原生 `<title>`；
  **不要**把 `<title>` 挂在 `<g>` / 父节点上（多数浏览器不弹）。
- 日历格：`<rect data-kind="calendar-cell"><title>…</title></rect>`。
- 柱状图：可见柱 + 每列一根全高透明命中区（`data-kind="active-bar-hit"`），两者都带 title；
  0 值/1px 柱也能稳定 hover。
- 文案：`日期 · 活跃 x · Token y[ · 周末]`，数字统一走 `formatHours` / `formatTokens`。
- 坐标轴文字、周几标签也带对应累计提示；图例项不需要 title。

## 7. 看板 ↔ 报告同步

报告不是"另一套 UI"，而是看板的静态投影。对应关系固定如下（详见 `docs/report-parity.md`）：

| 看板组件 / 约定 | 报告对应实现（`src/report-html.js`） | 说明 |
| --- | --- | --- |
| `CardHead`（标题 + 右侧 hint） | `cardHead()` → `.card-head` / `.card-head-text` / `.card-hint` | 11px、muted、单行省略 + `title`；禁止标题下方 hint |
| `MetricBarCell` / `barPercent` | `barCell()`（直接 import `barPercent`） | 宽度规则必须同源；视觉为内联 div 背景条 |
| `hourTokensNote` 三态 | 直接 import `hourTokensNote` | 回填中「正在计算中……」/ 空闲「Token 未计入 N 个会话」/ N=0 不渲染 |
| `ChipGroup` 切换 | **不渲染按钮** | 固定默认口径；第二口径用第二张小图或表格列，见 report-parity 的「有意不同」 |
| `formatHours` | 同一函数 | 小时一律 1 位小数；禁止各自 `/3600000` |
| 日历 / 柱状 / treemap / 环形几何 | 同数据源、同 `sectorPath` / 同布局算法 | 视觉参数（峰值深蓝、周末 amber、密度点半径）必须同源 |

报告自包含检查：`<script` = 0、无 `<link` / `src=`、外链仅官方计费页。
改报告后运行 `node build.mjs && node test/verify.mjs`，并更新 `docs/report-parity.md` 状态列。

## 8. 新增 UI 检查清单

1. 切换控件是否用了 `ChipGroup` + `Chip`？有没有新增 `wl-chip-*` class？
2. 卡片头是否用了 `CardHead`，说明是否在标题右侧（hint）、控件是否在右上角？标题下方不应再有 hint。
3. 指标条是否用了 `MetricBarCell`，宽度是否来自 `barPercent`？
4. 状态提示是否用 `.wl-status` / `.wl-hint` 的通用修饰？
5. 所有颜色是否都是宿主 token？zh/en 是否逐键对齐、没有死键？
6. 每个 hover 元素是否有直接挂在形状上的原生 `<title>`？
7. **同一提交**里 `src/report-html.js` 是否已同步？`docs/report-parity.md` 是否已更新？
8. `test/verify.mjs` 是否补了对应结构断言（标记存在性，稳定可跑）？
9. 报告是否仍自包含（无脚本 / 无外链资源 / 外链仅官方计费页）？
10. 新增卡片是否复用了 `CardHead`，补充说明是否用 `.wl-hint` / `.wl-status`？AI 画像按 `docs/ai-profile.md` 的白名单发送数据，且**不进入报告**。
11. 主要会话页的会话表与画像卡是否是 `wl-session-layout` 的同一行兄弟（左约 2fr / 右约 1fr），并在 `<=1080px` 回落堆叠？不要把画像卡塞进表格内部。
