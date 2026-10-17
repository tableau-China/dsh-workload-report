/**
 * 通用切换控件：ChipGroup + Chip。
 *
 * 全站只有这一套 chip：
 *   · 默认态：浅底（宿主 bg-layer-2）+ 1px 边框（border-l2），12px / 24px 高 / 999px 圆角；
 *   · 选中态：主题强调色实底（static-deepseek-500）+ 白字；
 *   · 尺寸、圆角、间距只在 styles.js 的 .wl-chips / .wl-chip 定义一次。
 *
 * 时刻分析、工作区占比、模型用量、每日用量以及顶部时间范围都复用它；
 * 新增切换控件不得再写 wl-chip-xxx 之类的变体 class（见 docs/ui-conventions.md）。
 */

/** 一组 chips：只负责布局与可访问性语义，不写任何尺寸/颜色。 */
export function ChipGroup({ label, children, ...rest }) {
  return (
    <div {...rest} className="wl-chips" role="group" aria-label={label ?? undefined}>
      {children}
    </div>
  );
}

/** 单个 chip：active 决定选中态；其余属性（data-measure / onClick 等）原样透传。 */
export function Chip({ active = false, children, ...rest }) {
  return (
    <button
      {...rest}
      type="button"
      className="wl-chip"
      data-active={active ? "true" : undefined}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}
