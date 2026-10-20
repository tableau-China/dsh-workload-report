/**
 * 「主要会话」页的区块结构（单一事实源）。
 *
 * 会话表在左、AI 画像卡在右：两者是同一个 grid 行的兄弟节点，
 * 会话表约 2fr、画像卡约 1fr，画像卡顶部对齐；窄屏（<= 1080px）回落为上下堆叠。
 *
 * 不要把画像卡塞进会话表内部，也不要放回「按日期」页或插到会话表之前。
 */

export const SESSION_PAGE_SECTIONS = Object.freeze(["sessions", "profile"]);

/** 两列布局参数：组件（index.jsx / profile-card.jsx）、样式与测试共用。 */
export const SESSION_LAYOUT = Object.freeze({
  /** 容器宽度 <= 此值时改为上下堆叠（会话在上、画像在下）。 */
  stackBreakpoint: 1080,
  /** 两列间距（px）。 */
  gap: 14,
  /** 左列（会话表）与右列（画像卡）的比例。 */
  sessionsFr: 2,
  profileFr: 1,
  /** 画像卡最小宽度；避免在 1081–1200px 之间被压得过窄。 */
  profileMinWidth: 280,
});

/** 某个区块在页面中的位置（-1 = 不渲染）。 */
export function sessionSectionIndex(section) {
  return SESSION_PAGE_SECTIONS.indexOf(section);
}

/**
 * 两列布局的几何模型（与 styles.js 的 grid 定义同源，供 verify 与截图脚本量测）。
 *
 * @param width - 看板内容区可用宽度（px）。
 * @param options.sessionsHeight - 会话表高度（px，默认 200），用于堆叠时计算画像卡顶部位置。
 * @returns {{ stacked: boolean, sessions: object, profile: object }}
 */
export function sessionLayoutGeometry(width, { sessionsHeight = 200 } = {}) {
  const total = Math.max(0, Math.round(Number(width) || 0));
  const height = Math.max(0, Math.round(Number(sessionsHeight) || 0));
  if (total <= SESSION_LAYOUT.stackBreakpoint) {
    return {
      stacked: true,
      sessions: { left: 0, right: total, width: total, top: 0, bottom: height },
      profile: { left: 0, right: total, width: total, top: height + SESSION_LAYOUT.gap },
    };
  }
  const units = SESSION_LAYOUT.sessionsFr + SESSION_LAYOUT.profileFr;
  const unit = (total - SESSION_LAYOUT.gap) / units;
  const sessionsWidth = Math.max(0, unit * SESSION_LAYOUT.sessionsFr);
  const profileWidth = Math.max(0, unit * SESSION_LAYOUT.profileFr);
  return {
    stacked: false,
    sessions: { left: 0, right: sessionsWidth, width: sessionsWidth, top: 0, bottom: height },
    profile: {
      left: sessionsWidth + SESSION_LAYOUT.gap,
      right: total,
      width: profileWidth,
      top: 0,
    },
  };
}
