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
.wl-chips { display: flex; gap: 4px; background: var(--dsw-alias-bg-layer-2, #f2f3f5); padding: 3px; border-radius: 999px; }
.wl-chip {
  border: none; background: transparent; cursor: pointer; font: inherit; font-size: 12px;
  color: var(--dsw-alias-label-secondary, #4b5563); padding: 4px 12px; border-radius: 999px;
}
.wl-chip[data-active="true"] { background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #111); font-weight: 600; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
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
.wl-kpis { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 10px; margin-bottom: 18px; }
.wl-kpi { background: var(--dsw-alias-bg-layer-2, #f7f8fa); border: 1px solid var(--dsw-alias-border-l2, #eceef1); border-radius: 12px; padding: 12px 14px; }
.wl-kpi-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 6px; }
.wl-kpi-value { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
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
.wl-legend { display: flex; gap: 14px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 8px; flex-wrap: wrap; }
.wl-dot { display: inline-block; width: 8px; height: 8px; border-radius: 2px; margin-right: 5px; vertical-align: middle; }
.wl-table { width: 100%; border-collapse: collapse; font-size: 12px; }
.wl-table th, .wl-table td { text-align: right; padding: 7px 9px; border-bottom: 1px solid var(--dsw-alias-border-l2, #f0f1f3); font-variant-numeric: tabular-nums; }
.wl-table th:first-child, .wl-table td:first-child { text-align: left; }
.wl-table th { color: var(--dsw-alias-label-tertiary, #6b7280); font-weight: 500; font-size: 11px; }
.wl-table tbody tr:hover { background: var(--dsw-alias-interactive-bg-hover, #f7f8fa); }
.wl-name { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wl-bars { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 12px; }
.wl-bar-head { display: flex; justify-content: space-between; font-size: 12px; margin-bottom: 4px; gap: 12px; }
.wl-bar-value { color: var(--dsw-alias-label-tertiary, #6b7280); font-variant-numeric: tabular-nums; }
.wl-bar-track { height: 8px; border-radius: 999px; background: var(--dsw-alias-bg-layer-2, #eef0f3); overflow: hidden; }
.wl-bar-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, var(--dsw-static-deepseek-400, #6b83ff), var(--dsw-static-deepseek-600, #3b57e0)); }
.wl-bar-fill[data-kind="tokens"] { background: linear-gradient(90deg, var(--dsw-static-green-400, #34d399), var(--dsw-static-green-500, #10b981)); }
.wl-bar-fill[data-kind="days"] { background: linear-gradient(90deg, var(--dsw-static-green-400, #34d399), var(--dsw-static-green-500, #10b981)); }
.wl-bar-head-second { margin-top: 8px; }
.wl-bar-label { font-size: 12px; color: var(--dsw-alias-label-secondary, #4b5563); }
/* 列头只出现一次，和每行的两栏对齐 */
.wl-metrics-head { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 10px; }
/* 工作区一行：左「付出」右「消耗」并排 */
.wl-ws-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
.wl-ws-name { font-size: 13px; font-weight: 600; }
.wl-ws-meta { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); white-space: nowrap; }
.wl-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.wl-metric { min-width: 0; }
.wl-metric-label { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-bottom: 3px; }
.wl-metric-value { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; margin-bottom: 5px; }
.wl-metric-share { font-size: 11px; font-weight: 400; color: var(--dsw-alias-label-tertiary, #6b7280); margin-left: 7px; }
.wl-metric-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 5px; line-height: 1.5; }
.wl-ws-foot { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 9px; padding-top: 7px; border-top: 1px dashed var(--dsw-alias-border-l2, #eceef1); }
@media (max-width: 720px) { .wl-metrics { grid-template-columns: 1fr; gap: 12px; } }
.wl-bar-sub { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 4px; }
.wl-state { padding: 28px; text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); font-size: 13px; }
.wl-note { font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); line-height: 1.65; border-top: 1px solid var(--dsw-alias-border-l2, #eceef1); padding-top: 12px; margin-top: 4px; }
.wl-footer-item {
  display: flex; align-items: center; gap: 8px; width: 100%; font: inherit; font-size: 13px; cursor: pointer;
  background: transparent; border: none; color: var(--dsw-alias-label-secondary, #4b5563);
  padding: 6px 10px; border-radius: 8px; text-align: left;
}
.wl-footer-item:hover { background: var(--dsw-alias-interactive-bg-hover, #f2f3f5); color: var(--dsw-alias-label-primary, #111); }
.wl-icon { flex: 0 0 auto; display: block; }
/* 卡片头：标题 + 右侧切换 */
.wl-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
.wl-chips-inline { margin-bottom: 10px; }
/* 并排两图 */
.wl-grid-2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
.wl-grid-2 .wl-card { margin-bottom: 0; }
/* 日历热力图 */
.wl-cal-scroll { overflow-x: auto; padding-bottom: 4px; }
.wl-cal-scale { display: inline-flex; align-items: center; gap: 4px; }
.wl-cal-swatch { display: inline-block; width: 11px; height: 11px; border-radius: 3px; }
/* 时刻分析 */
.wl-hour-grid { display: grid; grid-template-columns: repeat(24, minmax(0, 1fr)); gap: 3px; align-items: end; height: 150px; margin-top: 6px; }
.wl-hour-col { position: relative; display: flex; flex-direction: column; justify-content: flex-end; height: 100%; cursor: default; }
.wl-hour-track { height: 118px; display: flex; align-items: flex-end; }
.wl-hour-fill { width: 100%; border-radius: 3px 3px 0 0; background: linear-gradient(180deg, var(--dsw-static-deepseek-400, #6b83ff), var(--dsw-static-deepseek-600, #3b57e0)); min-height: 2px; }
.wl-hour-col[data-peak] .wl-hour-fill { background: linear-gradient(180deg, var(--dsw-static-amber-400, #f7ad31), var(--dsw-static-amber-600, #dd8629)); }
.wl-hour-label { font-size: 9px; text-align: center; color: var(--dsw-alias-label-tertiary, #6b7280); margin-top: 3px; }
.wl-hour-tip {
  position: absolute; bottom: 100%; left: 50%; transform: translateX(-50%);
  background: var(--dsw-alias-bg-layer-2, #22242a); color: var(--dsw-alias-label-primary, #fff);
  border: 1px solid var(--dsw-alias-border-l2, #333); border-radius: 8px; padding: 6px 9px; font-size: 11px;
  white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .12s ease; z-index: 5;
}
.wl-hour-col:hover .wl-hour-tip { opacity: 1; }
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
@media (max-width: 720px) { .wl-kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .wl-name { max-width: 160px; } }


/* ── 模型区块（0.4.0） ── */
.wl-model-grid { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr); gap: 18px; align-items: start; }
.wl-model-subtitle { margin: 0 0 6px; font-size: 13px; font-weight: 600; color: var(--dsw-alias-label-secondary, #4b5563); }
.wl-model-note { margin: 8px 0 0; }
.wl-model-links a { color: var(--dsw-static-deepseek-500, #4d6bfe); text-decoration: none; }
.wl-model-links a:hover { text-decoration: underline; }
.wl-model-table { margin-top: 14px; }
.wl-model-name { display: inline-flex; align-items: center; gap: 6px; background: none; border: 0; padding: 0; cursor: pointer; color: inherit; font: inherit; }
.wl-model-name i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.wl-model-raw { display: block; margin-top: 2px; }
.wl-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 6px; }
.wl-legend-item { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--dsw-alias-label-tertiary, #6b7280); }
.wl-legend-item i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
@media (max-width: 900px) { .wl-model-grid { grid-template-columns: 1fr; } }
`;
