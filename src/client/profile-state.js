/**
 * 画像卡的状态机与展示数值（纯函数，不依赖 React）。
 *
 * 首开（尚无结果）只渲染提示面板，绝不调用模型；只有点击「生成画像」才进入 generating。
 * verify 直接断言这些阶段，保证「提示面板 → 生成中 → 结果」与组件渲染同源。
 */

export const PROFILE_PHASES = Object.freeze(["hidden", "notice", "generating", "result"]);

/**
 * @param status - probing | ready | generating | disabled。
 * @param profile - 已生成的结果；null 表示尚无结果。
 * @returns hidden | notice | generating | result
 */
export function profileCardPhase(status, profile) {
  if (status === "probing" || status === "disabled") return "hidden";
  if (profile !== null && profile !== undefined) return "result";
  if (status === "generating") return "generating";
  return "notice";
}

/** 汇总窗口天数：优先服务端返回的 summaryDays，其次 probe 的预估值。 */
export function profileSummaryDays(profile, probe, fallback = 30) {
  const candidates = [profile?.summaryDays, probe?.summaryDays, fallback];
  for (const value of candidates) {
    const days = Math.round(Number(value));
    if (Number.isFinite(days) && days > 0) return days;
  }
  return 0;
}

/** probe 返回的 provider/model 是否可用于提示文案（未知时回落宿主默认）。 */
export function profileRouteInfo(probe) {
  const provider = typeof probe?.provider === "string" ? probe.provider.trim() : "";
  const model = typeof probe?.model === "string" ? probe.model.trim() : "";
  return { known: provider !== "" && model !== "", provider, model };
}
