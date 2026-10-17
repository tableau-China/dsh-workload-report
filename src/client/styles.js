/**
 * 看板样式：全部走宿主主题 token（--dsw-alias-* / --dsw-static-*），
 * 因此自动跟随 Harness 的浅色 / 深色主题，截图与产品界面一致。
 * 类名前缀 wl- 避免与官方样式冲突。
 */

export const STYLES = `
.wl-overlay {
  position: fixed;
  inset: 0;
  z-index: 240;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 4vh 3vw;
  background: color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 78%, transparent);
  backdrop-filter: blur(6px);
  font-family: var(--dsw-font-family, -apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", sans-serif);
  color: var(--dsw-alias-label-primary, #1a1d21);
  animation: wl-fade 160ms ease-out;
}
@keyframes wl-fade { from { opacity: 0; } to { opacity: 1; } }
.wl-panel {
  width: min(1180px, 100%);
  max-height: 92vh;
  display: flex;
  flex-direction: column;
  background: var(--dsw-alias-bg-layer-1, #ffffff);
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  border-radius: var(--dsw-radius-xl, 16px);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.wl-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  flex-wrap: wrap;
}
.wl-title { font-size: 16px; font-weight: 600; margin: 0; }
.wl-subtitle { font-size: 12px; color: var(--dsw-alias-label-tertiary, #6b7280); margin: 2px 0 0; }
.wl-spacer { flex: 1 1 auto; }
/* 切换控件唯一实现（src/client/chips.jsx）：默认浅底 + 边框，选中主题强调色实底 + 白字。
   尺寸 / 圆角 / 间距只在这里定义；各卡片不得再写变体 class。 */
.wl-chips { display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.wl-chip {
  display: inline-flex; align-items: center; justify-content: center;
  height: 24px; padding: 0 10px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  /* 7% 强调色 + layer-2：宿主 layer-2 在部分主题下就是白色，单用它看不出"浅底" */
  background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 7%, var(--dsw-alias-bg-layer-2, #f2f3f5));
  color: var(--dsw-alias-label-secondary, #4b5563);
  cursor: pointer; font: inherit; font-size: 12px; font-weight: 500; line-height: 1;
  transition: background 120ms ease, border-color 120ms ease, color 120ms ease;
}
.wl-chip:hover { border-color: var(--dsw-static-deepseek-300, #a9b8ff); background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 12%, var(--dsw-alias-bg-layer-2, #f2f3f5)); color: var(--dsw-alias-label-primary, #111); }
.wl-chip[data-active="true"] {
  border-color: var(--dsw-static-deepseek-500, #4d6bfe);
  background: var(--dsw-static-deepseek-500, #4d6bfe);
  color: var(--dsw-alias-label-primary-inverted, #ffffff);
  font-weight: 600;
}
.wl-chip[data-active="true"]:hover { filter: brightness(1.05); color: var(--dsw-alias-label-primary-inverted, #ffffff); }
.wl-chip:focus-visible { outline: 2px solid var(--dsw-static-deepseek-400, #6b83ff); outline-offset: 1px; }
.wl-select {
  font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #fff); color: inherit;
}
.wl-btn {
  display: inline-flex; align-items: center; gap: 6px; font: inherit; font-size: 12px; cursor: pointer;
  padding: 6px 12px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, #e5e7eb);
  background: var(--dsw-alias-bg-layer-1, #fff); color: var(--dsw-alias-label-secondary, #4b5563);
}
.wl-btn:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-primary, #111); }
.wl-btn[data-kind="primary"] {
  background: var(--dsw-static-deepseek-500, #4d6bfe); border-color: transparent; color: #fff;
}
.wl-btn[data-kind="primary"]:hover { filter: brightness(1.05); color: #fff; }
.wl-body { padding: 18px 20px 24px; overflow: auto; }
/* KPI：5 列等宽栅格；Tokens / 模型费用各跨 2 列 —— 8 张卡 = 10 格，正好排满 2 行 */
.wl-kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
.wl-kpi { background: var(--dsw-alias-bg-layer-2, #f7f8fa); border: 1px solid var(--dsw-alias-border-l2, #eceef1); border-radius: 12px; padding: 12px 14px; min-width: 0; }
.wl-kpi[data-kpi="kpi.tokens"] { grid-column: span 2; }
.wl-kpi[data-kpi="kpi.modelCost"] { grid-column: span 2; }
.wl-kpi-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 6px; }
.wl-kpi-value { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; white-space: nowrap; }
/* 模型名可能很长，只有这张卡允许换行 */
.wl-kpi[data-kpi="kpi.topModel"] .wl-kpi-value { white-space: normal; overflow-wrap: anywhere; }
/* 步骤数字比轮次小 2px，整行更紧凑 */
.wl-kpi-steps { font-size: 18px; }
.wl-kpi-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 6px; line-height: 1.45; }
.wl-tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--dsw-alias-border-l2, #e5e7eb); margin-bottom: 14px; }
.wl-tab {
  border: none; background: transparent; font: inherit; font-size: 13px; cursor: pointer; padding: 8px 14px;
  color: var(--dsw-alias-label-tertiary, #6b7280); border-bottom: 2px solid transparent; margin-bottom: -1px;
}
.wl-tab[data-active="true"] { color: var(--dsw-alias-label-primary, #111); border-bottom-color: var(--dsw-static-deepseek-500, #4d6bfe); font-weight: 600; }
.wl-card { background: var(--dsw-alias-bg-layer-1, #fff); border: 1px solid var(--dsw-alias-border-l2, #eceef1); border-radius: 12px; padding: 14px 16px; margin-bottom: 14px; }
.wl-card h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.wl-hint { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin: 0 0 10px; }
/* hint 的两种通用修饰：与上方内容留白 / 块级第二行；不再为每张卡另造 class */
.wl-hint-spaced { margin-top: 8px; }
.wl-hint-block { display: block; margin-top: 2px; }
.wl-hint a { color: var(--dsw-static-deepseek-500, #4d6bfe); text-decoration: none; }
.wl-hint a:hover { text-decoration: underline; }
/* 状态提示（未计入 / 计算中 / 回填中 / 读取失败）统一走这一条 */
.wl-status { font-size: 11px; line-height: 1.5; color: var(--dsw-alias-label-tertiary, #6b7280); margin: 0; white-space: nowrap; }
.wl-status[data-state="running"] { color: var(--dsw-static-deepseek-500, #4d6bfe); }
.wl-status[data-tone="error"] { color: var(--dsw-alias-label-error, #f25a5a); max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.wl-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
.wl-table-scroll { overflow-x: auto; }
.wl-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wl-table th, .wl-table td { text-align: right; padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f1f3); font-variant-numeric: tabular-nums; }
.wl-table th:first-child, .wl-table td:first-child { text-align: left; }
.wl-table th { color: var(--dsw-alias-label-tertiary, #6b7280); font-weight: 500; font-size: 11px; }
.wl-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.wl-name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 主要会话：列内浅色条形图（宽度＝该行数值占本列最大值的比例，数字压在条上） */
.wl-bar-cell { position: relative; display: block; min-width: 56px; height: 20px; border-radius: 5px; background: var(--dsw-alias-bg-layer-2, #f2f3f5); overflow: hidden; }
.wl-bar-cell-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 5px; background: color-mix(in srgb, var(--dsw-static-deepseek-500, #4d6bfe) 20%, transparent); }
.wl-bar-cell-fill[data-kind="steps"] { background: color-mix(in srgb, var(--dsw-static-blue-400, #60a5fa) 22%, transparent); }
.wl-bar-cell-fill[data-kind="activeMs"] { background: color-mix(in srgb, var(--dsw-static-amber-400, #f7ad31) 26%, transparent); }
.wl-bar-cell-fill[data-kind="conversations"] { background: color-mix(in srgb, var(--dsw-static-deepseek-300, #a9b8ff) 34%, transparent); }
/* output（主要会话）与 tokens（按日期明细）共用同一份绿色：同一语义不写两套 */
.wl-bar-cell-fill[data-kind="output"], .wl-bar-cell-fill[data-kind="tokens"] { background: color-mix(in srgb, var(--dsw-static-green-400, #34d399) 22%, transparent); }
/* 数值占满单元格；窄屏超长时省略号截断，title 保留全文（宽度只在单元格内滚动，不撑破表格） */
.wl-bar-cell-value { position: relative; z-index: 1; display: block; padding: 0 7px; line-height: 20px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
/* 可排序表头：当前排序列用主色加粗 + 箭头指示 */
.wl-th-sort { display: inline-flex; align-items: center; gap: 4px; background: none; border: 0; padding: 0; font: inherit; font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #6b7280); cursor: pointer; }
.wl-th-sort:hover { color: var(--dsw-alias-label-primary, #111827); }
.wl-th-sort[data-active] { color: var(--dsw-static-deepseek-500, #4d6bfe); font-weight: 650; }
.wl-sort-mark { font-size: 9px; opacity: 0.5; }
.wl-th-sort[data-active] .wl-sort-mark { opacity: 1; }
.wl-bars { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 12px; }
.wl-bar-track { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eef0f3); overflow: hidden; }
.wl-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--dsw-static-deepseek-400, #6b83ff), var(--dsw-static-deepseek-600, #3b57e0)); }
.wl-bar-fill[data-kind="tokens"] { background: linear-gradient(90deg, var(--dsw-static-green-400, #34d399), var(--dsw-static-green-500, #10b981)); }
.wl-bar-fill[data-kind="days"] { background: linear-gradient(90deg, var(--dsw-static-green-400, #34d399), var(--dsw-static-green-500, #10b981)); }
/* 工作区行：左独立名称列 + 右侧两条同口径 bar。列宽用变量，列头按同一套变量对齐 */
.wl-bars, .wl-metrics-head { --wl-ws-left: 156px; --wl-ws-gap: 18px; }
/* 列头只出现一次，和右侧两栏对齐（左侧名称列用 margin-left 留白，不占额外 grid 单元） */
.wl-metrics-head { display: grid; grid-template-columns: 1fr 1fr; gap: var(--wl-ws-gap); margin-left: calc(var(--wl-ws-left) + var(--wl-ws-gap)); font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 10px; }
/* 一行 = 名称列 + 两条 bar；minmax(0,1fr) 保证窄屏可收缩、不溢出 */
.wl-ws-row { display: grid; grid-template-columns: var(--wl-ws-left) minmax(0, 1fr) minmax(0, 1fr); gap: var(--wl-ws-gap); align-items: start; }
/* 名称列：名称 → 活跃 N 天 → 最近使用；窄屏省略号截断，title 保留全路径 */
.wl-ws-left { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.wl-ws-name { font-size: 13px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-ws-days { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; }
.wl-ws-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-metric { min-width: 0; }
.wl-metric-value { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; margin-bottom: 5px; }
.wl-metric-share { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #6b7280); margin-left: 7px; }
.wl-metric-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 5px; line-height: 1.5; }
.wl-ws-foot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 9px; padding-top: 7px; border-top: 1px dashed var(--dsw-alias-border-l2, #eceef1); }
/* 窄屏：名称列收窄（名称截断、title 留全文），两条 bar 继续并排，整行不溢出 */
@media (max-width: 720px) { .wl-bars, .wl-metrics-head { --wl-ws-left: 104px; --wl-ws-gap: 12px; } }
.wl-state { padding: 28px; text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 13px; }
.wl-note { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); line-height: 1.65; border-top: 1px solid var(--dsw-alias-border-l2, #eceef1); padding-top: 12px; margin-top: 4px; }
.wl-footer-item {
  display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 13px; cursor: pointer;
  background: transparent; border: none; color: var(--dsw-alias-label-secondary, #4b5563);
  padding: 6px 10px; border-radius: 8px; text-align: left;
}
.wl-footer-item:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-primary, #111); }
.wl-icon { flex: 0 0 auto; display: block; }
/* 顶部工具栏余额 chip：紧凑、只用宿主主题 token；未启用时组件根本不渲染（无外壳） */
.wl-balance {
  display: inline-flex; align-items: center; gap: 6px; max-width: 220px;
  padding: 3px 9px; border-radius: 999px; font-size: 12px; line-height: 1.4;
  background: var(--dsw-alias-bg-layer-2, #f2f3f5); color: var(--dsw-alias-label-secondary, #4b5563);
}
.wl-balance-text { font-variant-numeric: tabular-nums; white-space: nowrap; }
.wl-balance-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; }
.wl-balance-link { color: var(--dsw-static-deepseek-500, #4d6bfe); text-decoration: none; white-space: nowrap; }
.wl-balance-link:hover { text-decoration: underline; }
.wl-balance[data-kind="error"] .wl-balance-text { color: var(--dsw-alias-label-tertiary, #6b7280); }
/* 卡片头唯一结构（src/client/card-head.jsx）：左标题（+ 可选说明），右上控件 */
.wl-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
.wl-card-head-text { min-width: 0; }
.wl-card-head-text h3 { margin: 0; }
.wl-card-head-text .wl-hint { margin: 2px 0 0; }
.wl-card-head-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-left: auto; }
/* 并排两图：列宽与上面「每日趋势 + 模型用量」完全一致，上下两行左右边界对齐 */
.wl-grid-2 { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
.wl-grid-2 .wl-card { margin-bottom: 0; }
/* 日历热力图 */
/* 只允许横向滚动（Year-Week 多列时）；纵向必须完整可见——
   注意：overflow-x:auto 会把另一轴的 overflow-y:visible 计算成 auto（CSS 规范），
   于是纵向也冒出滚动条，故这里显式 overflow-y:hidden；svg 改块级以去掉行内基线间隙。 */
.wl-cal-scroll { overflow-x: auto; overflow-y: hidden; }
.wl-cal-scroll > svg { display: block; }
/* 时刻分析：卡片纵向 flex —— header / 图表 / 图例 / 缺失提示依次排，
   图表区吃掉剩余高度（与「每日用量趋势」的 .wl-daily-body 同一做法）。
   行高由 240px 的图表区撑起；右侧饼图卡同行拉伸时把圆环在剩余高度里居中。 */
.wl-hour-card { display: flex; flex-direction: column; min-height: 0; }
.wl-grid-2 > .wl-pie-card { display: flex; flex-direction: column; min-height: 0; }
/* 顶部 64px 固定留给密度点与峰值数值；柱形区从 64px 一直撑到标签上方的 16px，
   高度随卡片伸缩，不再写死 116px。 */
.wl-hour-grid {
  display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 3px;
  flex: 1 1 auto; min-height: 240px; height: auto; margin-top: 6px;
}
.wl-hour-col { position: relative; height: 100%; cursor: default; }
/* 柱形区上沿 64px、下沿 16px：顶部永远留给密度点与峰值数值，切换 measure 不跳 */
.wl-hour-track { position: absolute; left: 0; right: 0; top: 64px; bottom: 16px; display: flex; align-items: flex-end; }
.wl-hour-fill { width: 100%; border-radius: 3px 3px 0 0; background: linear-gradient(180deg, var(--dsw-static-deepseek-400, #6b83ff), var(--dsw-static-deepseek-600, #3b57e0)); min-height: 2px; }
/* 峰值柱＝更深的蓝（--dsw-static-blue-600 = #2563eb），与人类消息点的 amber 明确区分 */
.wl-hour-col[data-peak] .wl-hour-fill { background: var(--dsw-static-blue-600, #2563eb); }
/* 人类消息密度点：top 固定 14px（上沿留白），圆心 = 14 + r；最大 r=8.4 也不会被裁 */
.wl-hour-dot {
  position: absolute; left: 50%; top: 14px; transform: translateX(-50%);
  border-radius: 50%; background: var(--dsw-static-amber-500, #f59e0b); opacity: 0.9;
}
.wl-hour-label { position: absolute; left: 0; right: 0; bottom: 0; font-size: 9px; text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* 峰值柱的数值标签：贴在柱顶（bottom 由柱高算），不占布局高度 */
.wl-hour-value {
  position: absolute; left: 0; right: 0; text-align: center;
  font-size: 9px; line-height: 1.1; font-weight: 650; color: var(--dsw-alias-label-primary, #1a1d21);
  font-variant-numeric: tabular-nums; pointer-events: none; white-space: nowrap;
}
.wl-hour-legend { justify-content: space-between; align-items: center; margin-top: 6px; }
.wl-hour-legend .wl-legend-group { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.wl-hour-legend .wl-status { margin-left: auto; text-align: right; }
.wl-hour-legend .wl-legend-bar { background: linear-gradient(180deg, var(--dsw-static-deepseek-400, #6b83ff), var(--dsw-static-deepseek-600, #3b57e0)); }
.wl-hour-legend .wl-legend-dot { border-radius: 50%; background: var(--dsw-static-amber-500, #f59e0b); }
.wl-hour-legend .wl-legend-peak { background: var(--dsw-static-blue-600, #2563eb); }
/* 工作区环形图 */
.wl-pie-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
.wl-pie-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; flex: 1 1 220px; min-width: 200px; }
.wl-pie-legend li { display: grid; grid-template-columns: 12px 1fr auto auto; align-items: center; gap: 8px; font-size: 12px; }
.wl-pie-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-pie-value { font-variant-numeric: tabular-nums; }
.wl-pie-share { color: var(--dsw-alias-label-tertiary, #6b7280); font-variant-numeric: tabular-nums; min-width: 44px; text-align: right; }
/* 折叠的明细 */
.wl-details summary { cursor: pointer; font-size: 13px; font-weight: 600; outline: none; }
.wl-details summary::-webkit-details-marker { display: none; }
.wl-details summary::before { content: "▸ "; color: var(--dsw-alias-label-tertiary, #6b7280); }
.wl-details[open] summary::before { content: "▾ "; }
.wl-details[open] summary { margin-bottom: 10px; }
@media (max-width: 1080px) { .wl-kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } .wl-grid-2 { grid-template-columns: 1fr; } }
@media (max-width: 720px) { .wl-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wl-kpi[data-kpi="kpi.tokens"], .wl-kpi[data-kpi="kpi.modelCost"] { grid-column: auto; } .wl-name { max-width: 160px; } .wl-bar-cell { min-width: 44px; } }


/* ── 每日用量趋势（左）与模型用量（右）并排 ── */
/* 左右两卡等高：栅格 stretch 即可，卡片不能再写 height:100%（content-box 下会把卡撑出 padding 高度、压住下一行）；
   左侧每日趋势卡内只有 head(auto) → body(flex:1) 两段（底部 legend 已删），body 首选 190px 且可收缩 */
.wl-grid-daily-model { display: grid; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); gap: 14px; margin-bottom: 14px; }
.wl-grid-daily-model > .wl-card { display: flex; flex-direction: column; min-height: 0; margin-bottom: 0; overflow: hidden; }
/* 日历与柱状图共用同一个容器：首选 190px，随行高伸展/收缩（min-height:0 是 flex 溢出的关键）。
   比 0.4.1 压低约 54px，首页两张卡整体变矮；日历按容器高度自适应，填满卡片剩余高度。 */
.wl-daily-body { flex: 1 1 190px; min-height: 0; display: flex; flex-direction: column; justify-content: center; }
/* 柱状图铺满容器剩余高度：viewBox 用容器像素，图形直接到底边（不留底部空白带） */
.wl-chart-fill { flex: 1 1 auto; min-height: 0; height: 100%; overflow: hidden; }
.wl-chart-fill > svg { display: block; }
/* 右列较窄：模型卡内部改为上下堆叠（treemap 在上、趋势在下） */
.wl-model-grid { grid-template-columns: 1fr; gap: 10px; }
@media (max-width: 1080px) { .wl-grid-daily-model { grid-template-columns: 1fr; } .wl-model-grid { grid-template-columns: 1fr; } }
/* 首页「模型 Token 占比」卡：卡片被上一行等高拉伸时，把环形图在**卡内垂直居中**
   （量测口径：图形上留白 vs 下留白，差 ≤ 2px）。hint 的下边距归零，
   于是"图形上方的空白"就是 hint 之后到图形的那段，与下方空白可直接比较。 */
.wl-pie-card .wl-hint { margin-bottom: 0; }
.wl-pie-card .wl-pie-wrap { flex: 1 1 auto; min-height: 0; align-items: center; }
/* ── 模型区块（0.4.0） ── */
.wl-model-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; align-items: start; }
/* treemap 容器：固定高度 + 真实像素 viewBox（矩形铺满，最左/最右到边缘 0px，目标 ≤ 8px） */
.wl-treemap-fill { height: 210px; }
.wl-treemap-fill > svg { display: block; }
/* 模型读日志失败提示：卡片底部小字，可读短句 + title 简化原因；用宿主 token，不新增色值 */
.wl-model-subtitle { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.wl-model-table { margin-top: 14px; }
.wl-model-name { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; }
.wl-model-name i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
/* 骨架屏：卡片框架先就位，只有数值位显示「加载中…」；灰色块只是"位置占位" */
.wl-skeleton-area { border-radius: 8px; background: var(--dsw-alias-bg-layer-2, #f2f3f5); }
.wl-chart-fill.wl-skeleton-area { min-height: 200px; }
.wl-skeleton-mid { height: 160px; }
.wl-skeleton .wl-state { padding: 18px; }
.wl-pending { font-size: 14px; font-weight: 500; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* 图例上边距压到 4px：柱状图的图形底边到图例 ≤ 8px，视觉上"图吃满容器" */
.wl-legend { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin-top: 4px; line-height: 1.5; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
/* legend 里的说明文字不再带 margin-top：日历/柱状图两种 legend 必须一样高，否则图表容器高度会随模式变化 */
.wl-legend .wl-metric-sub { margin-top: 0; }
.wl-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.wl-legend-item i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
@media (max-width: 900px) { .wl-model-grid { grid-template-columns: 1fr; } }
`;
