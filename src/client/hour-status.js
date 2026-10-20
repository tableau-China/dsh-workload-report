/**
 * 「时刻分析」legend 右侧状态提示的唯一判据（不写死文案/状态）。
 *
 * 输入是快照 diagnostics（宿主 modelFold.phase 是唯一判据）：
 *   · first-fold —— 本轮包含「从未折过」的会话 → 正在计算中……（只在真的算的时候出现）；
 *   · background —— 已有数据的后台重折/重试 → 后台更新中（灰点小字，不打扰）；
 *   · idle       —— 空闲 → 只提示「Token 未计入 N 个会话」（N>0 时）。
 * failedRows 绝不参与判断：读日志失败只计入未计入提示，不会让状态显示为计算中。
 * 没有 phase 的老宿主退回 running 语义（向后兼容，不改变旧版行为）。
 */
export function hourTokensNote(diagnostics, t, formatCount = (value) => String(value)) {
  const fold = diagnostics?.modelFold ?? {};
  const phase = fold.phase;
  if (phase === "first-fold") return { state: "first-fold", text: t("hour.calculating") };
  if (phase === "background") return { state: "background", text: t("hour.background") };
  if (phase === undefined && fold.running === true) return { state: "running", text: t("hour.calculating") };
  const missing = diagnostics?.hourTokensSource?.missing ?? 0;
  if (missing > 0) return { state: "idle", text: t("hour.missingTokens", { count: formatCount(missing) }) };
  return null;
}
