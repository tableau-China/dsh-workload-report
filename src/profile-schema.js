/**
 * 画像结构与长度约束（纯常量 + 纯函数，宿主与客户端共用）。
 *
 * 这个模块不能 import node:*，因为它会被 esbuild 打进浏览器端 lib/client.js；
 * 解析、本地规则与前端兜底都从这里取同一组上限，避免宿主放宽、前端截断不一致。
 */

/** 一句话画像上限（字符 / Unicode 码点）。 */
export const PROFILE_HEADLINE_MAX = 30;
/** 维度标题上限。 */
export const PROFILE_TITLE_MAX = 8;
/** 维度结论上限（必须含数字）。 */
export const PROFILE_INSIGHT_MAX = 60;
/** 证据 / 建议 / 风险单行上限。 */
export const PROFILE_LINE_MAX = 40;
/** 证据行上限（与建议单行同宽，单独命名便于阅读）。 */
export const PROFILE_EVIDENCE_MAX = PROFILE_LINE_MAX;

/** 允许的维度 key；顺序即前端默认展示顺序。 */
export const PROFILE_DIMENSION_KEYS = Object.freeze(["rhythm", "focus", "stack", "collab", "trend"]);

/** 维度 key 的中文短名（模型漏标题 / 本地兜底时用）。 */
export const PROFILE_DIMENSION_LABELS = Object.freeze({
  rhythm: "节奏",
  focus: "专注",
  stack: "工具栈",
  collab: "协作",
  trend: "趋势",
});

/** 文本压到 ≤max 个字符（按 Unicode 码点，超出用省略号，仍不超过 max）。 */
export function clampProfileText(value, max = PROFILE_LINE_MAX) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  const limit = Math.max(1, Math.round(Number(max) || PROFILE_LINE_MAX));
  if (chars.length <= limit) return chars.join("");
  return chars.slice(0, limit - 1).join("") + "…";
}

/** 是否含阿拉伯数字（模型结论必须引用具体数字）。 */
export function hasDigit(value) {
  return /[0-9]/.test(String(value ?? ""));
}

/** 维度 key 归一化：大小写 / 空白 / 常见别名都收敛到允许集合，未知回退 focus。 */
export function normalizeDimensionKey(value) {
  const key = String(value ?? "").trim().toLowerCase();
  if (PROFILE_DIMENSION_KEYS.includes(key)) return key;
  const aliases = {
    rhythm: "rhythm", pace: "rhythm", schedule: "rhythm", 节奏: "rhythm", 时段: "rhythm",
    focus: "focus", deep: "focus", concentration: "focus", 专注: "focus", 深度: "focus",
    stack: "stack", tools: "stack", tool: "stack", model: "stack", models: "stack", 工具: "stack", 技术栈: "stack",
    collab: "collab", collaboration: "collab", interaction: "collab", 协作: "collab", 交互: "collab",
    trend: "trend", trends: "trend", growth: "trend", 趋势: "trend", 变化: "trend",
  };
  return aliases[key] ?? "focus";
}
