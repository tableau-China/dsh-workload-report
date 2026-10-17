# UI 约定 — dsh-workload-report

> **铁律**：看板里所有切换控件统一用 `ChipGroup`，所有指标条形统一用 `MetricBarCell`，
> 所有卡片头统一用 `CardHead`。**新增 UI 必须复用这些组件；不得另造样式或变体 class。**
>
> 颜色只用宿主主题 token（`--dsw-alias-*` / `--dsw-static-*`），不写死色值；zh/en 文案逐键对齐，不留死键。

## 1. 共享组件清单

| 组件 | 文件 | 用途 | 使用位置 |
| --- | --- | --- | --- |
| `ChipGroup` / `Chip` | `src/client/chips.jsx` | 切换控件（浅底 + 边框；选中主题强调色实底 + 白字） | 顶部时间范围、每日用量、时刻分析、工作区占比、模型用量 |
| `CardHead` | `src/client/card-head.jsx` | 卡片头：左标题（+ 可选说明），右上控件 | 每日用量趋势、模型 Token 占比、时刻分析、工作区占比、模型用量 |
| `MetricBarCell` | `src/client/bar-cell.jsx`（宽度纯函数 `src/client/bar-width.js`） | 表格内的指标比例条 | 主要会话、按日期明细 |
| `hourTokensNote` | `src/client/hour-status.js` | 时刻图 legend 右侧状态文案判据 | 时刻分析（running / idle / 隐藏三态） |
| `sectorPath` | `src/sector-path.js` | 环形图扇区几何（看板与 HTML 报告共用） | 工作区 / 模型环形图、报告 |

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
│ 标题（h3）                       [右上控件] │
│ 可选说明（.wl-hint）                        │
└─────────────────────────────────────────────┘
```

- 结构由 `src/client/card-head.jsx` 的 `CardHead` 渲染：`.wl-card-head` = `space-between`，
  `.wl-card-head-actions` = 右上（`margin-left: auto`）。
- 标题只出现一次；切换控件一律放右上角，与「时刻分析」同位置、同样式。
- 没有右侧控件时只传 `title`（可选 `hint`），不渲染空 actions 容器。
- 卡片内部不再重复页面/页签标题。

## 4. 图例固定结构

- 基础行：`.wl-legend`（flex + wrap + 11px 第三级文字色）。
- 图例项：`.wl-legend-item` + `<i>` 色块；只解释颜色，不写「（点越大越多）」这类解释。
- 需要右侧状态时：`.wl-legend-group` 放左侧图例项，`.wl-status` 放右侧（`margin-left: auto`），
  容器加 `.wl-hour-legend`（`justify-content: space-between`）。
- 时刻图的状态三态由 `hourTokensNote` 决定：
  `modelFold.running === true` → 「正在计算中……」；
  空闲且 `hourTokensSource.missing > 0` → 「Token 未计入 N 个会话」；
  空闲且 N=0 → 返回 `null`，整条不渲染。

## 5. 状态提示与 hint

| 场景 | class | 说明 |
| --- | --- | --- |
| 普通说明 | `.wl-hint` | 11px、第三级文字色 |
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

## 7. 新增 UI 检查清单

1. 切换控件是否用了 `ChipGroup` + `Chip`？有没有新增 `wl-chip-*` class？
2. 卡片头是否用了 `CardHead`，控件是否在右上角？
3. 指标条是否用了 `MetricBarCell`，宽度是否来自 `barPercent`？
4. 状态提示是否用 `.wl-status` / `.wl-hint` 的通用修饰？
5. 所有颜色是否都是宿主 token？zh/en 是否逐键对齐、没有死键？
6. 每个 hover 元素是否有直接挂在形状上的原生 `<title>`？
