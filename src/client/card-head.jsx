/**
 * 卡片头的唯一结构：左侧「标题 (+ 可选说明)」，右侧「控件」。
 *
 * 所有带切换控件的卡片都必须用它，保证标题、留白、右上控件位置一致：
 *   每日用量趋势 / 时刻分析 / 工作区占比 / 模型用量 / 模型 Token 占比。
 * 无右侧控件时只渲染标题，不留下空的 actions 容器。
 */
export function CardHead({ title, hint = null, children = null }) {
  return (
    <div className="wl-card-head">
      <div className="wl-card-head-text">
        <h3>{title}</h3>
        {hint === null ? null : <p className="wl-hint">{hint}</p>}
      </div>
      {children === null ? null : <div className="wl-card-head-actions">{children}</div>}
    </div>
  );
}
