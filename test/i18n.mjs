// 多语言词典一致性检查（离线、零依赖）：
//   node test/i18n.mjs            # 全量检查（CI / 发布前必须全绿）
//   node test/i18n.mjs --lang ja  # 只看某种语言（译者自检，快速定位缺失键 / 占位符问题）
//
// 检查内容：
//   1. 8 部词典都是合法 JSON、键集合与 zh 完全一致、键顺序一致；
//   2. 占位符逐键一致（{name} 数量 / 名字 / 顺序），翻译不许吞占位符；
//   3. 值非空、无零宽字符 / BOM；
//   4. 客户端与报告源码里没有写死的中文文案（注释除外）；
//   5. 词典里没有死键（所有键都有代码引用）。
//
// 作为模块导入时导出 checkI18n(ok, eq)，由 test/verify.mjs 复用同一套断言；
// 直接执行时自己维护计数器并打印摘要。

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { dictionaries, LOCALES, NS } from "../src/locales/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 键集基准。 */
export const BASE_LOCALE = "zh";

/** 占位符提取：{name}（允许重复出现，按出现顺序比较）。 */
function placeholdersOf(text) {
  return [...String(text).matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
}

/** 词典键是否按 zh 顺序排列（翻译文件 diff 更稳，也避免键错位）。 */
function sameOrder(baseKeys, keys) {
  if (baseKeys.length !== keys.length) return false;
  return baseKeys.every((key, index) => keys[index] === key);
}

/** 静态扫描：去掉注释后，源码里是否还有中文（写死文案）。 */
export function hardcodedChinese(source) {
  const withoutBlockComments = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const withoutLineComments = withoutBlockComments
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return /[\u4e00-\u9fff]/.test(withoutLineComments);
}

/** 需要保持"零写死文案"的源码清单（按职责分组，便于出错时定位）。 */
const COPY_SOURCES = [
  "src/client/index.jsx",
  "src/client/balance.js",
  "src/client/bar-cell.jsx",
  "src/client/card-head.jsx",
  "src/client/chips.jsx",
  "src/client/hour-status.js",
  "src/client/profile-card.jsx",
  "src/client/profile-state.js",
  "src/client/session-layout.js",
  "src/client/sync-state.js",
  "src/client/sync-view.jsx",
];

/** 允许动态键的命名空间（`t("tab." + id)` 这类，无法静态枚举）。 */
const DYNAMIC_FAMILIES = ["scope.", "tab.", "range.", "device.", "set.freq.", "set.freqNote.", "set.icon.", "hour.legend.", "profile.code."];

/** 某段源码里被引用的文案键（字面量形式）。 */
function referencedKeys(source) {
  const literal = [...source.matchAll(/"([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9]+)+)"/g)].map((match) => match[1]);
  const single = [...source.matchAll(/'([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9]+)+)'/g)].map((match) => match[1]);
  const template = [...source.matchAll(/`([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9]+)+)`/g)].map((match) => match[1]);
  const prefixed = [...source.matchAll(/t\(\s*"([a-z][a-zA-Z]*)\.([a-zA-Z0-9]+)"/g)].map((match) => match[1] + "." + match[2]);
  return new Set([...literal, ...single, ...template, ...prefixed]);
}

/**
 * 执行全部检查。
 * @param ok - 断言回调（失败只计数，不抛错）。
 * @param eq - 相等断言回调。
 * @param options - `{ lang: "ja" }` 时只检查该语言。
 */
export async function checkI18n(ok, eq, options = {}) {
  const only = typeof options.lang === "string" ? options.lang : null;
  if (only !== null) {
    ok(LOCALES.includes(only), `语言 id 合法（${only}）`);
  }

  const base = dictionaries[BASE_LOCALE];
  const baseKeys = Object.keys(base);
  ok(baseKeys.length > 0, `基准词典非空（${BASE_LOCALE}：${String(baseKeys.length)} 键）`);
  eq(NS, "workload-report", "locale 命名空间固定");

  // 1. 每部词典：合法对象 / 键集 / 顺序 / 占位符 / 空值 / 零宽字符
  for (const lang of LOCALES) {
    if (only !== null && lang !== only) continue;
    const dict = dictionaries[lang];
    ok(dict !== undefined && dict !== null && typeof dict === "object", `词典存在（${lang}）`);
    if (dict === undefined || dict === null) continue;
    const keys = Object.keys(dict);
    eq(keys.length, baseKeys.length, `${lang} 键数 = ${BASE_LOCALE}（${String(baseKeys.length)}）`);
    const missing = baseKeys.filter((key) => !(key in dict));
    const extra = keys.filter((key) => !(key in base));
    ok(missing.length === 0, `${lang} 无缺失键`, missing.slice(0, 8).join(", "));
    ok(extra.length === 0, `${lang} 无多余键`, extra.slice(0, 8).join(", "));
    ok(sameOrder(baseKeys, keys), `${lang} 键顺序与 ${BASE_LOCALE} 一致（翻译文件 diff 稳定）`);
    if (lang === BASE_LOCALE) continue;

    const badValues = keys.filter((key) => typeof dict[key] !== "string" || dict[key].trim() === "");
    ok(badValues.length === 0, `${lang} 没有空值 / 非字符串值`, badValues.slice(0, 8).join(", "));
    const badPlaceholders = [];
    for (const key of baseKeys) {
      const zhPlaceholders = placeholdersOf(base[key]);
      const langPlaceholders = placeholdersOf(dict[key]);
      if (zhPlaceholders.length !== langPlaceholders.length || zhPlaceholders.some((name, index) => name !== langPlaceholders[index])) {
        badPlaceholders.push(key);
      }
    }
    ok(badPlaceholders.length === 0, `${lang} 占位符与 ${BASE_LOCALE} 一致`, badPlaceholders.slice(0, 8).join(", "));
    const badChars = keys.filter((key) => /[\u200b\ufeff]/.test(dict[key]));
    ok(badChars.length === 0, `${lang} 无零宽空格 / BOM`, badChars.slice(0, 8).join(", "));
    const cjk = keys.filter((key) => lang !== "ja" && /[\u4e00-\u9fff]/.test(dict[key]));
    ok(cjk.length === 0, `${lang} 没有残留中文`, cjk.slice(0, 8).join(", "));
    // 兜底语言本身就是英文，不参与「漏译」检查。
    if (lang === "en") continue;
    // 必须真正翻译的「界面骨架」键：这些键与英文一样说明整份词典没翻（或漏了一大块）。
    const MUST_TRANSLATE = ["action.label", "panel.title", "tab.byDay", "kpi.tokens", "range.7", "table.turns", "state.empty", "action.refresh", "profile.title"];
    const untranslatedCore = MUST_TRANSLATE.filter((key) => dict[key] === dictionaries.en[key]);
    ok(untranslatedCore.length === 0, `${lang} 核心界面文案已翻译`, untranslatedCore.join(", "));
    // 其余键允许个别与英文同形（品牌名 / 格式串 / 缩写），但成片相同说明漏译。
    const needsTranslation = baseKeys.filter((key) => base[key] !== dictionaries.en[key]);
    const untranslated = needsTranslation.filter((key) => dict[key] === dictionaries.en[key]);
    ok(untranslated.length <= 8, `${lang} 翻译覆盖（疑似漏译 ≤8 个）`, untranslated.slice(0, 10).join(", "));
  }

  // 2. 源码零写死中文（注释除外）
  const offenders = [];
  for (const relative of COPY_SOURCES) {
    let source;
    try {
      source = await readFile(join(ROOT, relative), "utf8");
    } catch {
      // 文件可能随重构改名：不在这里判失败，交给各自模块测试
      continue;
    }
    if (hardcodedChinese(source)) offenders.push(relative);
  }
  ok(offenders.length === 0, "用户可见文案没有写死在源码里（全部走词典）", offenders.join(", "));

  // 3. 死键检查：所有词典键都要有代码引用
  const sourceFiles = [];
  async function collect(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await collect(full);
      else if (/\.(js|jsx)$/.test(entry.name)) sourceFiles.push(full);
    }
  }
  await collect(join(ROOT, "src"));
  sourceFiles.push(join(ROOT, "index.js"));
  const used = new Set();
  for (const file of sourceFiles) {
    const source = await readFile(file, "utf8");
    for (const key of referencedKeys(source)) used.add(key);
  }
  const dead = baseKeys.filter((key) => !used.has(key) && !DYNAMIC_FAMILIES.some((family) => key.startsWith(family)));
  ok(dead.length === 0, "词典没有死键（每个键都有代码引用）", dead.slice(0, 12).join(", "));

  // 4. 卡片说明别太长（中文 ≤18 字），保持"只解释看什么"
  const hintKeys = ["chart.hint", "hour.hint", "hour.hintTurns", "pie.modelHint", "model.hint"];
  const cjkCount = (text) => (String(text).match(/[\u4e00-\u9fff]/g) ?? []).length;
  const longHints = hintKeys.filter((key) => cjkCount(base[key] ?? "") > 18);
  ok(longHints.length === 0, "卡片说明 ≤18 个汉字", longHints.map((key) => `${key}=${base[key]}`).join(", "));

  // 5. 汇报统计（不参与断言）
  return { locales: LOCALES, keys: baseKeys.length, sources: COPY_SOURCES.length };
}

// ---------------------------------------------------------------- CLI
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const langArgIndex = process.argv.indexOf("--lang");
  const lang = langArgIndex >= 0 ? process.argv[langArgIndex + 1] : undefined;
  let failures = 0;
  const ok = (condition, label, detail = "") => {
    if (condition) console.log(`✓ ${label}`);
    else {
      failures += 1;
      console.error(`✗ ${label}${detail === "" ? "" : ` — ${detail}`}`);
    }
  };
  const eq = (actual, expected, label) => ok(Object.is(actual, expected), label, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
  const summary = await checkI18n(ok, eq, { lang });
  console.log(`\n词典：${summary.locales.length} 种语言 · ${summary.keys} 键 · 扫描 ${summary.sources} 个源码文件`);
  if (failures > 0) {
    console.error(`\n${failures} 项失败 ✗`);
    process.exitCode = 1;
  } else {
    console.log("i18n 检查全部通过 ✓");
  }
}
