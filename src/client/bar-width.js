/** 比例条宽度计算：纯函数，浏览器组件与离线断言共用（不依赖 React / JSX）。 */

/**
 * 计算比例条宽度百分比（0–100），并夹紧异常值。
 * @param value - 本行数值。
 * @param max - 本列最大值。
 * @returns 0–100 的百分比（组件按 1 位小数渲染）。
 */
export function barPercent(value, max) {
  const current = Number.isFinite(value) && value > 0 ? value : 0;
  const ceiling = Number.isFinite(max) && max > 0 ? max : 0;
  if (ceiling === 0) return 0;
  return Math.max(0, Math.min(100, (current / ceiling) * 100));
}
