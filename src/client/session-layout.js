/**
 * 「主要会话」页的区块结构（单一事实源）。
 *
 * 「主要会话」页只包含会话表；「AI 用户画像」是导航最右侧的独立顶层页签
 * （`index.jsx` 里的 `data-align="end"`），不再与本页共用两列布局。
 * 0.7.0–0.7.1 的 `SESSION_LAYOUT` 网格参数与 `sessionLayoutGeometry()` 已随之删除。
 */

export const SESSION_PAGE_SECTIONS = Object.freeze(["sessions"]);

/** 某个区块在页面中的位置（-1 = 不渲染）。 */
export function sessionSectionIndex(section) {
  return SESSION_PAGE_SECTIONS.indexOf(section);
}
