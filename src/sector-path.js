/**
 * 环形扇区几何：看板与报告共用同一份实现，保证两处的扇区形状与白描边缝隙完全一致。
 */

/**
 * 环形扇区路径（外弧 → 内弧，闭合成一个扇区）。
 * 白描边需要扇区的真实轮廓：stroke-dasharray 画的圆只有颜色、描不出两条半径边。
 * 角度以 +x 轴为 0（调用方整体 rotate(-90)，让 0 点朝正上方）。
 * @param outer - 外半径。
 * @param inner - 内半径。
 * @param from - 起始角（弧度）。
 * @param to - 结束角（弧度）。
 * @returns SVG path 的 d 属性。
 */
export function sectorPath(outer, inner, from, to) {
  const point = (radius, angle) => `${(radius * Math.cos(angle)).toFixed(2)} ${(radius * Math.sin(angle)).toFixed(2)}`;
  const sweep = to - from;
  if (sweep >= Math.PI * 2 - 1e-6) {
    // 满环：A 命令的起点终点重合会导致不渲染，拆成两段半圆
    const mid = from + Math.PI;
    return `${sectorPath(outer, inner, from, mid)} ${sectorPath(outer, inner, mid, to)}`;
  }
  const large = sweep > Math.PI ? 1 : 0;
  return [
    `M ${point(outer, from)}`,
    `A ${outer} ${outer} 0 ${large} 1 ${point(outer, to)}`,
    `L ${point(inner, to)}`,
    `A ${inner} ${inner} 0 ${large} 0 ${point(inner, from)}`,
    "Z",
  ].join(" ");
}
