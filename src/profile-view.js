/**
 * 画像展示结构归一化（客户端与服务端测试共用，不含 React / Node 依赖）。
 *
 * 服务端保证结构合法；这里再做一次兜底：旧缓存 / 手工调试 / 半截数据都能渲染，
 * 同时把长度上限统一到 profile-schema.js，避免宿主与前端各截一套。
 *
 * 维度标题在模型漏填 / 旧数据里缺失时用词典键兜底（`profile.dimension.*`），
 * 所以需要调用方传入翻译函数 `t`；不传时按中文（老单测 / 报告调用点兼容）。
 */

import { translator } from "./locales/index.js";
import {
  PROFILE_DIMENSION_KEYS,
  PROFILE_DIMENSION_LABEL_KEYS,
  PROFILE_EVIDENCE_MAX,
  PROFILE_HEADLINE_MAX,
  PROFILE_INSIGHT_MAX,
  PROFILE_LINE_MAX,
  PROFILE_TITLE_MAX,
  clampProfileText,
  normalizeDimensionKey,
} from "./profile-schema.js";

/** 默认翻译函数：老调用点（只传 profile 的单测 / 报告）按中文兜底。 */
const defaultTranslate = translator("zh");

/** 维度 key → 兜底标题（词典键缺失时退回「观察」）。 */
function dimensionTitleOf(t, key) {
  return t(PROFILE_DIMENSION_LABEL_KEYS[key] ?? "profile.observation");
}

/** 旧的 traits/advice-string 结构 → headline/dimensions/advice（只用于兼容，不参与新生成）。 */
function legacyDimensions(profile, t) {
  const traits = Array.isArray(profile?.traits) ? profile.traits : [];
  return traits
    .map((trait, index) => {
      const key = PROFILE_DIMENSION_KEYS[index % PROFILE_DIMENSION_KEYS.length];
      return {
        key,
        title: dimensionTitleOf(t, key),
        insight: clampProfileText(trait, PROFILE_INSIGHT_MAX),
        evidence: "",
      };
    })
    .filter((item) => item.insight !== "");
}

/**
 * 把 /profile 的任意版本结果归一化成渲染所需结构。
 * @param profile - 服务端返回的画像对象（AI / 本地规则 / 旧缓存）。
 * @param t - 翻译函数 `(key, vars) => string`；缺省按中文（兼容老调用点）。
 * @returns {{ headline: string, dimensions: Array, advice: Array, risk: string|null }}
 */
export function profileSections(profile, t = defaultTranslate) {
  const translate = typeof t === "function" ? t : defaultTranslate;
  const source = profile !== null && typeof profile === "object" ? profile : {};
  const headline = clampProfileText(source.headline, PROFILE_HEADLINE_MAX);

  let dimensions = (Array.isArray(source.dimensions) ? source.dimensions : [])
    .map((item) => {
      if (item === null || typeof item !== "object") return null;
      const key = normalizeDimensionKey(item.key);
      // 模型漏标题时用维度词典键兜底（不再丢掉整条结论）；标题上限仍统一裁剪。
      const title = clampProfileText(item.title, PROFILE_TITLE_MAX) || dimensionTitleOf(translate, key);
      const insight = clampProfileText(item.insight, PROFILE_INSIGHT_MAX);
      if (insight === "") return null;
      return {
        key,
        title,
        insight,
        evidence: clampProfileText(item.evidence, PROFILE_EVIDENCE_MAX),
      };
    })
    .filter((item) => item !== null)
    .slice(0, 6);
  if (dimensions.length === 0) dimensions = legacyDimensions(source, translate);

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
