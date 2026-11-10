/**
 * Sparkline 几何（纯函数，无 DOM / React 依赖）。
 *
 * 看板 JSX 使用；保持纯函数，便于单测与复用。
 * 原则：**不采样、不聚合、不编数字** —— 每个真实日一个点；null（数据缺失）处断开线段，
 * 不画 0 冒充「真的很低」。点数越多，点越小、线越细、点越淡，但 tooltip 仍覆盖每一天。
 */

/** 视觉分档：点数越多越克制，避免长区间糊成一团。 */
export function sparkStrategy(pointCount) {
  if (pointCount <= 14) return { radius: 1.7, stroke: 1.9, dotOpacity: 0.6 };
  if (pointCount <= 45) return { radius: 1.0, stroke: 1.5, dotOpacity: 0.42 };
  return { radius: 0.65, stroke: 1.2, dotOpacity: 0.3 };
}

/**
 * 计算折线 / 面积路径与点位。
 * @param values - 逐日数值数组；null / undefined 表示该日无数据（断开）。
 * @param options - { width, height, padX, padTop, padBottom, domain: "zero" | "ratio" }
 * @returns { points, segments, base, strategy, width, height }
 *   points: 与 values 等长的 [x,y] 数组（无数据处为 null）
 *   segments: [{ line, area, points: [{ index, point, value }] }]，null 处自然分段
 */
export function sparkGeometry(values, {
  width = 120,
  height = 30,
  padX = 2,
  padTop = 4,
  padBottom = 4,
  domain = "zero",
} = {}) {
  const n = values.length;
  const base = height - padBottom;
  if (n === 0) return { points: [], segments: [], base, strategy: sparkStrategy(0), width, height };

  const numeric = values.filter((v) => v !== null && v !== undefined);
  const max = Math.max(0, ...numeric);
  const hi = domain === "ratio" ? 1 : (max > 0 ? max * 1.12 : 1);
  const x = (i) => (n === 1 ? width / 2 : padX + (i * (width - 2 * padX)) / (n - 1));
  const y = (v) => height - padBottom - ((v / hi) * (height - padTop - padBottom));
  const points = values.map((v, i) => (v === null || v === undefined ? null : [x(i), y(v)]));

  // 按非 null 分段：数据缺失的日子断开，不连线、不画点。
  const segments = [];
  let current = [];
  points.forEach((point, index) => {
    if (point === null) {
      if (current.length > 0) segments.push(current);
      current = [];
    } else {
      current.push({ index, point, value: values[index] });
    }
  });
  if (current.length > 0) segments.push(current);

  const out = segments.map((segment) => {
    const line = segment
      .map((item, k) => `${k === 0 ? "M" : "L"}${item.point[0].toFixed(1)},${item.point[1].toFixed(1)}`)
      .join(" ");
    const area = segment.length > 1
      ? `${line} L${segment.at(-1).point[0].toFixed(1)},${base} L${segment[0].point[0].toFixed(1)},${base} Z`
      : "";
    return { line, area, points: segment };
  });

  return { points, segments: out, base, strategy: sparkStrategy(n), width, height };
}
