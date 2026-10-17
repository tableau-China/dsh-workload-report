/**
 * 「时刻分析」legend 右侧状态提示的唯一判据（不写死文案/状态）。
 *
 * 输入是快照 diagnostics：
 *   · modelFold.running —— 回填或重折正在执行（runModelFold 同时处理 pending/refold/failed），
 *     小时 Token 会继续变化；
 *   · hourTokensSource.missing —— 有 Token 但读不出事件、未计入时间图的会话数。
 *
 * 返回 { state, text } 或 null（空闲且 N=0 时整条不渲染）：
 *   running → 正在计算中……
 *   idle    → Token 未计入 N 个会话
 */
export function hourTokensNote(diagnostics, t, formatCount = (value) => String(value)) {
  const fold = diagnostics?.modelFold ?? {};
  const running = fold.running === true;
  if (running) return { state: "running", text: t("hour.calculating") };
  const missing = diagnostics?.hourTokensSource?.missing ?? 0;
  if (missing > 0) return { state: "idle", text: t("hour.missingTokens", { count: formatCount(missing) }) };
  return null;
}
