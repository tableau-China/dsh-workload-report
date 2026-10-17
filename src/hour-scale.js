/**
 * 时刻分析的量纲与几何（纯函数，宿主 / 看板 / 报告 / 离线断言共用）。
 *
 * 只给数值与阈值，不碰 DOM：客户端用 DOM、报告用 SVG，但"用哪个 measure、
 * 柱多高、圆点多大、上沿留多少"必须是同一份实现，否则两处会漂。
 * 颜色不在这里定义——全部由宿主主题 token 提供（--dsw-*）。
 */

/** 圆点上沿的固定留白（px）：无论半径多大，圆的最上沿都停在这里，最大圆也不会被裁。 */
export const HOUR_DOT_TOP = 14;

/** 人类消息密度点的半径公式：r = 3.4 + ratio × 5.0（ratio ∈ [0,1]，最大 8.4）。 */
export const HOUR_DOT_BASE_RADIUS = 3.4;
export const HOUR_DOT_RADIUS_SPAN = 5.0;

/**
 * 图表顶部预留空间（px）：64 = 圆点区（14 上沿 + 最大直径 16.8）+ 峰值数值 + 余量。
 * 柱形区从这之下开始，圆点与柱顶数值互不压叠。
 */
export const HOUR_CHART_TOP_SPACE = 64;

/** 两种 measure：Token 产出（默认）与轮次（该小时开始的会话数）。 */
export const HOUR_MEASURES = ["tokens", "turns"];

/** 把任意输入收敛为受支持的 measure；缺省 / 非法 → tokens。 */
export function normalizeHourMeasure(measure) {
  return HOUR_MEASURES.includes(measure) ? measure : "tokens";
}

/** 该小时在当前 measure 下的取值。 */
export function hourMeasureValue(hour, measure) {
  if (normalizeHourMeasure(measure) === "turns") return nonNegative(hour?.starts);
  return nonNegative(hour?.tokensTotal);
}

/** 当前 measure 的最大值（至少 1，避免除零）。 */
export function hourMeasureMax(hours, measure) {
  const list = Array.isArray(hours) ? hours : [];
  let max = 0;
  for (const hour of list) {
    const value = hourMeasureValue(hour, measure);
    if (value > max) max = value;
  }
  return Math.max(1, max);
}

/** 柱高百分比：有值至少 3%（细柱也看得见），0 值不画。 */
export function hourBarPercent(value, max) {
  const v = nonNegative(value);
  if (v <= 0) return 0;
  const m = nonNegative(max) > 0 ? max : 1;
  return Math.max(3, (v / m) * 100);
}

/** 人类消息密度点的半径比例（0..1）。 */
export function hourDotRatio(humanMsgs, maxHumanMsgs) {
  const value = nonNegative(humanMsgs);
  const max = nonNegative(maxHumanMsgs);
  if (value <= 0 || max <= 0) return 0;
  return Math.min(1, value / max);
}

/** 圆点半径（px）：3.4 + ratio × 5.0。 */
export function hourDotRadius(ratio) {
  const r = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  return HOUR_DOT_BASE_RADIUS + r * HOUR_DOT_RADIUS_SPAN;
}

/** 圆心 y（px）：上沿恒为 HOUR_DOT_TOP，所以 centerY = 14 + r（最大圆也不会被裁）。 */
export function hourDotCenterY(radius) {
  const r = nonNegative(radius);
  return HOUR_DOT_TOP + r;
}

/**
 * 把 24 个 Token 桶按比例回正到官方合计，且**和恰好等于 target**。
 * 折叠（src/models.js）与聚合（src/aggregate.js）共用：官方的 row.tokens 可能因
 * 未闭合步 / crash 恢复补写与事件累计不等；这里按比例缩放，整数目标用最大余数法
 * 分完整数余数（不产生小数 Token），保证 sum(out) === target。
 * @param values - 24 个非负桶。
 * @param target - 目标合计（官方 Token 合计）。
 * @returns 24 个桶；sum <= 0 / target <= 0 / 输入为空时返回 null（不伪造）。
 */
export function scaleTokenBuckets(values, target) {
  if (!Array.isArray(values) || values.length !== 24) return null;
  const list = values.map((value) => nonNegative(value));
  const sum = list.reduce((acc, value) => acc + value, 0);
  const goal = nonNegative(target);
  if (!(sum > 0) || !(goal > 0)) return null;
  if (sum === goal) return list;

  const factor = goal / sum;
  const scaled = list.map((value) => value * factor);
  // 整数目标：最大余数法补齐整数余数，sum 严格等于目标（Token 不应出现小数）
  if (Number.isInteger(goal)) {
    const out = scaled.map((value) => Math.floor(value));
    let rest = goal - out.reduce((acc, value) => acc + value, 0);
    if (rest > 0) {
      const order = scaled
        .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
        .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
      for (let i = 0; i < rest; i++) out[order[i % order.length].index] += 1;
    }
    return out;
  }
  // 非整数目标（理论上官方 Token 为整数）：浮点缩放 + 最大桶吸收误差
  let largest = 0;
  for (let i = 1; i < 24; i++) if (scaled[i] > scaled[largest]) largest = i;
  let others = 0;
  for (let i = 0; i < 24; i++) if (i !== largest) others += scaled[i];
  scaled[largest] = Math.max(0, goal - others);
  return scaled;
}

function nonNegative(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
