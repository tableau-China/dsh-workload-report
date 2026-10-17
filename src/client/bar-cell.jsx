/**
 * 通用比例条单元格：「主要会话」与「按日期明细」两张表共用这一份实现。
 * 浅色条宽度 = 本行数值 / 本列最大值；数值压在条上。
 * 宽度计算在 bar-width.js（纯函数，可离线单测）；样式统一在 styles.js 的 .wl-bar-cell*。
 */

import { barPercent } from "./bar-width.js";

export { barPercent };

/**
 * 比例条单元格（React 组件）。
 * @param props.value - 原始数值（用于计算条宽）。
 * @param props.max - 本列最大值。
 * @param props.text - 展示文本（调用方用 formatHours / formatTokens / formatInt 格式化）。
 * @param props.title - 悬停全文；窄屏截断时仍可读。
 * @param props.kind - 语义 / 颜色标记（turns / steps / activeMs / output / conversations / tokens）。
 */
export function MetricBarCell({ value, max, text, title, kind }) {
  const percent = barPercent(value, max);
  return (
    <span className="wl-bar-cell" data-component="metric-bar-cell" data-kind={kind} title={title ?? text}>
      <span className="wl-bar-cell-fill" data-kind={kind} style={{ width: `${percent.toFixed(1)}%` }} />
      <span className="wl-bar-cell-value">{text}</span>
    </span>
  );
}
