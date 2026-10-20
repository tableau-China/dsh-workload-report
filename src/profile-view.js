/**
 * 画像展示结构归一化（客户端与服务端测试共用，不含 React / Node 依赖）。
 *
 * 服务端保证结构合法；这里再做一次兜底：旧缓存 / 手工调试 / 半截数据都能渲染，
 * 同时把长度上限统一到 profile-schema.js，避免宿主与前端各截一套。
 */

import {
  PROFILE_DIMENSION_KEYS,
  PROFILE_DIMENSION_LABELS,
  PROFILE_EVIDENCE_MAX,
  PROFILE_HEADLINE_MAX,
  PROFILE_INSIGHT_MAX,
  PROFILE_LINE_MAX,
  PROFILE_TITLE_MAX,
  clampProfileText,
  normalizeDimensionKey,
} from "./profile-schema.js";

/** 旧的 traits/advice-string 结构 → headline/dimensions/advice（只用于兼容，不参与新生成）。 */
function legacyDimensions(profile) {
  const traits = Array.isArray(profile?.traits) ? profile.traits : [];
  return traits
    .map((trait, index) => {
      const key = PROFILE_DIMENSION_KEYS[index % PROFILE_DIMENSION_KEYS.length];
      return {
        key,
        title: PROFILE_DIMENSION_LABELS[key] ?? "观察",
        insight: clampProfileText(trait, PROFILE_INSIGHT_MAX),
        evidence: "",
      };
    })
    .filter((item) => item.insight !== "");
}

/**
 * 把 /profile 的任意版本结果归一化成渲染所需结构。
 * @param profile - 服务端返回的画像对象（AI / 本地规则 / 旧缓存）。
 * @returns {{ headline: string, dimensions: Array, advice: Array, risk: string|null }}
 */
export function profileSections(profile) {
  const source = profile !== null && typeof profile === "object" ? profile : {};
  const headline = clampProfileText(source.headline, PROFILE_HEADLINE_MAX);

  let dimensions = (Array.isArray(source.dimensions) ? source.dimensions : [])
    .map((item) => {
      if (item === null || typeof item !== "object") return null;
      const title = clampProfileText(item.title, PROFILE_TITLE_MAX);
      const insight = clampProfileText(item.insight, PROFILE_INSIGHT_MAX);
      if (title === "" || insight === "") return null;
      return {
        key: normalizeDimensionKey(item.key),
        title,
        insight,
        evidence: clampProfileText(item.evidence, PROFILE_EVIDENCE_MAX),
      };
    })
    .filter((item) => item !== null)
    .slice(0, 6);
  if (dimensions.length === 0) dimensions = legacyDimensions(source);

  let advice = (Array.isArray(source.advice) ? source.advice : [])
    .map((item) => {
      if (item === null || typeof item !== "object") return null;
      const text = clampProfileText(item.text, PROFILE_LINE_MAX);
      if (text === "") return null;
      return { text, why: clampProfileText(item.why, PROFILE_LINE_MAX) };
    })
    .filter((item) => item !== null)
    .slice(0, 3);
  if (advice.length === 0 && typeof source.advice === "string" && source.advice.trim() !== "") {
    advice = [{ text: clampProfileText(source.advice, PROFILE_LINE_MAX), why: "" }];
  }

  const riskText = source.risk === null || source.risk === undefined ? "" : String(source.risk).trim();
  return {
    headline,
    dimensions,
    advice,
    risk: riskText === "" ? null : clampProfileText(riskText, PROFILE_LINE_MAX),
  };
}
