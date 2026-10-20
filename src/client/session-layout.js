/**
 * 「主要会话」页的区块顺序（单一事实源）。
 *
 * 组件按这个数组渲染，verify 直接断言数组 —— 与实际 DOM 顺序同构：
 *   1. sessions：主要会话表（轮次 / 步骤 / 活跃时长 / 输出）
 *   2. profile ：AI 用户画像卡片，紧跟会话表，在同一滚动流里
 *
 * 不要把画像卡放回「按日期」页，也不要插到会话表之前。
 */

export const SESSION_PAGE_SECTIONS = Object.freeze(["sessions", "profile"]);

/** 某个区块在页面中的位置（-1 = 不渲染）。 */
export function sessionSectionIndex(section) {
  return SESSION_PAGE_SECTIONS.indexOf(section);
}
