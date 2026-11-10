/**
 * 卡片头的唯一结构：左侧「标题 + 紧右侧的小字说明」，右侧「控件」。
 *
 * 说明（hint）只解释"看什么"，必须渲染在标题同一行的右侧：
 * 11px、muted、单行不换行；放不下时省略号截断，并始终用 title 保留全文。
 * **禁止再在标题下方加 hint**（正文里的补充说明用 .wl-hint，不属于卡片头）。
 *
 * 所有带切换控件的卡片都必须用它，保证标题、留白、右上控件位置一致：
 *   每日用量趋势 / 时刻分析 / 工作区占比 / 模型用量 / 模型 Token 占比。
 * 无右侧控件时只渲染标题（可带 hint），不留下空的 actions 容器。
 *
 * summary（2.6.0）：可选的「标题后总结」，紧跟 h3、在 hint 之前，用于日历图这类
 * 需要一句话概括全图的数值（活跃天数 / 连续活跃）。它与 hint 的区别：
 * hint 解释「看什么」，summary 给出「看出来的数字」。
 */
export function CardHead({ title, hint = null, summary = null, children = null }) {
  return (
    <div className="wl-card-head">
      <div className="wl-card-head-text">
        <h3>{title}</h3>
        {summary === null ? null : (
          <span className="wl-card-head-summary">{summary}</span>
        )}
        {hint === null ? null : (
          <span className="wl-card-head-hint" title={hint}>{hint}</span>
        )}
      </div>
      {children === null ? null : <div className="wl-card-head-actions">{children}</div>}
    </div>
  );
}
