/**
 * 插件文案注册表（客户端 / 宿主 / HTML 报告共用同一份词典）。
 *
 * 长期维护规则（详见 docs/i18n.md）：
 *   · `zh.json` 是键集基准；其它语言必须与 zh 逐键一致、占位符一致；
 *   · 语言 id 跟 DSH 内置语言保持一致：zh / en / ja / es / fr / de / ru / pt；
 *   · 只放展示文案，不放数据、不放日志 / 内部诊断信息；
 *   · 整句一个键，用 {name} 占位符，不要用「前缀 + 变量 + 后缀」拼接句子——
 *     不同语言的语序不同，拼接一定出错。
 *
 * 词典是 JSON 而不是 JS：翻译改动只碰 JSON，不需要懂代码，也不会引入语法错误。
 */

import de from "./de.json" with { type: "json" };
import en from "./en.json" with { type: "json" };
import es from "./es.json" with { type: "json" };
import fr from "./fr.json" with { type: "json" };
import ja from "./ja.json" with { type: "json" };
import pt from "./pt.json" with { type: "json" };
import ru from "./ru.json" with { type: "json" };
import zh from "./zh.json" with { type: "json" };

/** 宿主 locale 服务的命名空间（客户端注册、报告与测试共用一个）。 */
export const NS = "workload-report";

/** 支持的语言 id（与 DSH 内置 8 种语言一致，顺序即兜底顺序）。 */
export const LOCALES = Object.freeze(["zh", "en", "ja", "es", "fr", "de", "ru", "pt"]);

/** 找不到翻译时的兜底语言：英文。 */
export const FALLBACK_LOCALE = "en";

/** 全部词典：既用于注册宿主 locale 服务，也用于查询。 */
export const dictionaries = Object.freeze({ zh, en, ja, es, fr, de, ru, pt });

/** 已知语言 id 集合（快速判定）。 */
const KNOWN = new Set(LOCALES);

/** 语言 id 归一化：`zh-CN` / `pt-BR` → 语言主标签；未知语言 → 英文。 */
export function languageOf(locale) {
  const primary = String(locale ?? "").trim().toLowerCase().split("-")[0];
  return KNOWN.has(primary) ? primary : FALLBACK_LOCALE;
}

/**
 * 该语言在 Intl / `toLocale*` 里使用的 BCP 47 标签。
 * zh 用中国大陆标签，pt 用巴西标签（与 DSH 内置一致）；未知语言返回 en 标签。
 */
const LOCALE_TAGS = Object.freeze({
  zh: "zh-CN",
  en: "en-US",
  ja: "ja-JP",
  es: "es-ES",
  fr: "fr-FR",
  de: "de-DE",
  ru: "ru-RU",
  pt: "pt-BR",
});

/** 语言 id → 语言自称（给模型提示词、以后 possible 的 addLanguage 用）。 */
const LOCALE_LABELS = Object.freeze({
  zh: "中文（简体）",
  en: "English",
  ja: "日本語",
  es: "Español",
  fr: "Français",
  de: "Deutsch",
  ru: "Русский",
  pt: "Português (Brasil)",
});

/** 语言自称（未知语言回落 English）：用于提示词里要求"用用户的语言输出"。 */
export function localeLabel(lang) {
  return LOCALE_LABELS[languageOf(lang)] ?? LOCALE_LABELS[FALLBACK_LOCALE];
}

/** 语言 → Intl 标签（日期等本地化格式用）。 */
export function localeTag(lang) {
  return LOCALE_TAGS[languageOf(lang)] ?? LOCALE_TAGS[FALLBACK_LOCALE];
}

/**
 * 翻译一个键：先查当前语言，再回退英文，最后显示键名本身。
 * @param lang - 语言 id（可带地区后缀）。
 * @param key - 文案键。
 * @param vars - `{name}` 占位符的取值（可选）。
 * @returns 翻译后的文案（未知名占位符原样保留）。
 */
export function translate(lang, key, vars) {
  const active = languageOf(lang);
  const dicts = [dictionaries[active]];
  if (active !== FALLBACK_LOCALE) dicts.push(dictionaries[FALLBACK_LOCALE]);
  let text = key;
  for (const dict of dicts) {
    if (typeof dict?.[key] === "string") {
      text = dict[key];
      break;
    }
  }
  if (vars !== undefined) {
    for (const [name, value] of Object.entries(vars)) text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

/**
 * 生成绑定到某语言的翻译函数（`t(key, vars)`）。
 * 客户端组件、宿主路由、报告渲染都通过它取文案，避免到处传 lang。
 */
export function translator(lang) {
  const active = languageOf(lang);
  return (key, vars) => translate(active, key, vars);
}
