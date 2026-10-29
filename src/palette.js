/**
 * 数据可视化统一色板（Tableau 10）。
 *
 * 为什么集中在一处：此前图表颜色散落在 client/styles.js（CSS 变量）、
 * client/index.jsx（treemap/pie 内联数组）、report-html.js（PALETTES）三处，
 * 同一个指标在不同视图里可能不是同一个颜色，导出报告和看板也会不一致。
 * 现在分类色板只在这里定义一次，看板与报告都从这里取。
 *
 * 语义色（SEMANTIC）用于"同一指标全站同色"：轮次永远是蓝、我的付出永远是橙、
 * Token 永远是绿、速度永远是红，避免同一语义在不同图表里换色。
 */

/** Tableau 10 分类色板（10 色，按顺序取用）。 */
export const TABLEAU10 = Object.freeze([
  "#5778a4", // 0 蓝
  "#e49444", // 1 橙
  "#d1615d", // 2 红
  "#85b6b2", // 3 青
  "#6a9f58", // 4 绿
  "#e7ca60", // 5 黄
  "#a87c9f", // 6 紫
  "#f1a2a9", // 7 粉
  "#967662", // 8 棕
  "#b8b0ac", // 9 灰
]);

/** 指标 → 颜色（全站统一，不随图表变化）。 */
export const SEMANTIC = Object.freeze({
  turns: TABLEAU10[0], // 会话 / 轮次
  effort: TABLEAU10[1], // 我的付出（活跃时长）
  speed: TABLEAU10[2], // 输出速度
  days: TABLEAU10[3], // 活跃天数
  tokens: TABLEAU10[4], // Token 消耗
  requests: TABLEAU10[5], // 请求数
  conversations: TABLEAU10[6], // 对话数
  cache: TABLEAU10[8], // 缓存
  steps: TABLEAU10[9], // 步骤
});

/** 把十六进制色转成带透明度的 rgba（用于比例条的浅色填充）。 */
export function withAlpha(hex, alpha) {
  const text = String(hex).replace("#", "");
  const full = text.length === 3 ? text.split("").map((c) => c + c).join("") : text;
  const value = Number.parseInt(full, 16);
  if (!Number.isFinite(value) || full.length !== 6) return `rgba(87, 120, 164, ${alpha})`;
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}
