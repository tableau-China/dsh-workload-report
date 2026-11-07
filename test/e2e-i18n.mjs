// 真实浏览器多语言端到端验收：8 种界面语言下打开「工作量报告」面板 + HTML 报告，
// 断言渲染文案来自 src/locales 词典（而不是硬编码 / 英文占位），并逐语言截图留档。
//
// 前置（隔离测试实例：独立 DSH_HOME，不影响用户正在使用的 Web GUI 实例）：
//   ./test/e2e-boot.sh 3299 > .tmp/e2e-boot-3299.log 2>&1 &   # 终端 A：启动隔离实例（独立 DSH_HOME）
//   node test/e2e-i18n.mjs       # 终端 B：跑全部 8 种语言（zh/en/ja/es/fr/de/ru/pt）
//   node test/e2e-i18n.mjs --lang de   # 只跑一种（译者自检 / 局部排查）
//
// 认证：dsh web 启动时会打印 `dsh web: http://127.0.0.1:3299/?token=...`，
// 入口 URL 带 token 才能进（直接开根路径会 401）。脚本在未显式设置 WL_URL 时，
// 会自动从 `.tmp/e2e-boot-<port>.log`（或 `.tmp/e2e-boot.log`）里找这条 URL；
// 也可以手动指定：WL_URL="http://127.0.0.1:3299/?token=..." node test/e2e-i18n.mjs
//
// 语言注入机制：DSH 宿主界面语言来自 locale 服务；浏览器**没有已保存语言偏好**时，
// 按 navigator.languages 里第一个受支持的语言决定初始界面语言。脚本为每种语言新建
// 独立浏览器上下文（fresh localStorage / 偏好），并在页面脚本执行前覆写
// navigator.languages / navigator.language，因此不用点 UI 切语言、不改宿主设置，
// 就能得到 8 种宿主语言环境。
//
// 文案断言全部来自词典（translate(lang, key)），不在脚本里硬编码任何翻译值；
// 翻译改了断言自动跟着改。预期面板标题 / 页签 / KPI / 区间 / 报告标题都跟随语言，
// 且非目标语言特征文案（英文占位标题、中文标题）不出现。
//
// 环境变量（与 test/e2e-ui.mjs 相同）：
//   WL_URL            测试实例入口（默认 http://127.0.0.1:3299；未设置时自动从 boot 日志找带 token 的 URL）
//   WL_CHROME         Chrome 可执行文件路径（默认各平台常见安装位置）
//   WL_PUPPETEER_DIR  puppeteer-core 所在目录（默认本仓库 node_modules → 本机 profile）
//
// 产品：test/.artifacts/i18n-<lang>.png（面板）、test/.artifacts/i18n-report-<lang>.png（报告）。

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { LOCALES, dictionaries, localeTag, translate } from "../src/locales/index.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "test", ".artifacts");
const DEFAULT_ENTRY_URL = "http://127.0.0.1:3299";

/**
 * 入口 URL：优先 WL_URL；否则尝试从 boot 日志里找 dsh web 打印的带 token URL
 * （dsh web 不带 token 直接开根路径会 401）。找不到就退回默认地址，由页面上报 401 提示。
 */
function resolveEntryUrl() {
  if (typeof process.env.WL_URL === "string" && process.env.WL_URL.length > 0) return process.env.WL_URL;
  let port = "3299";
  try {
    port = new URL(DEFAULT_ENTRY_URL).port || port;
  } catch {
    /* 忽略 */
  }
  const candidates = [join(ROOT, ".tmp", `e2e-boot-${port}.log`), join(ROOT, ".tmp", "e2e-boot.log")];
  const pattern = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/g;
  for (const logPath of candidates) {
    if (!existsSync(logPath)) continue;
    try {
      const matches = [...readFileSync(logPath, "utf8").matchAll(pattern)];
      const hit = matches[matches.length - 1];
      if (hit !== undefined) {
        console.log(`入口 token 取自 boot 日志：${logPath}`);
        return hit[1];
      }
    } catch {
      /* 读不到就继续 */
    }
  }
  return DEFAULT_ENTRY_URL;
}

const ENTRY_URL = resolveEntryUrl();
/** 报告页等其它同源路由沿用同一 origin（浏览器 cookie 随上下文共享）。 */
const URL_BASE = new URL(ENTRY_URL).origin;
const WORKSPACE_PATH = process.env.WL_WORKSPACE || "/tmp/dsh-workload-e2e/ws";

/** Chrome 可执行文件：优先 $WL_CHROME，其次各平台常见路径（与 e2e-ui.mjs 一致）。 */
function resolveChrome() {
  const candidates = [
    process.env.WL_CHROME,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* 忽略 */
    }
  }
  throw new Error(`找不到 Chrome，请用 WL_CHROME=/path/to/chrome 指定。已尝试：\n${candidates.join("\n")}`);
}

/** puppeteer-core 解析顺序：本目录 → $WL_PUPPETEER_DIR → ~/.dsh/profiles/web（与 e2e-ui.mjs 一致）。 */
function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  const bases = [ROOT, process.env.WL_PUPPETEER_DIR, join(homedir(), ".dsh", "profiles", "web")].filter(
    (base) => typeof base === "string" && base.length > 0,
  );
  const errors = [];
  for (const base of bases) {
    try {
      const resolved = require.resolve("puppeteer-core", { paths: [base] });
      return require(resolved);
    } catch (error) {
      errors.push(`${base}: ${error.message}`);
    }
  }
  throw new Error(`找不到 puppeteer-core（可用 pnpm add -D puppeteer-core 安装）\n${errors.join("\n")}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;
const ok = (condition, label, detail = "") => {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

/** 把一段长文本压成单行片段，失败时给人看（不是给断言用）。 */
const snippet = (text, max = 260) => {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}…`;
};

/** 断言「面板文本包含目标语言文案」，失败时同时打印期望值与实际片段。 */
const assertContains = (text, expected, label) =>
  ok(text.includes(expected), label, `期望含 ${JSON.stringify(expected)}；实际：${JSON.stringify(snippet(text))}`);

// ------------------------------------------------------------------ 语言参数
const argv = process.argv.slice(2);
const langFlagIndex = argv.indexOf("--lang");
const onlyLang = langFlagIndex >= 0 ? argv[langFlagIndex + 1] : undefined;
if (langFlagIndex >= 0 && (onlyLang === undefined || !LOCALES.includes(onlyLang))) {
  console.error(`--lang 需要 8 种语言之一：${LOCALES.join(" / ")}（收到 ${JSON.stringify(onlyLang)}）`);
  process.exit(1);
}
const LANGS = onlyLang === undefined ? [...LOCALES] : [onlyLang];

/** 语言标签：zh→zh-CN、pt→pt-BR……（navigator.languages 注入用）。 */
const tagOf = (lang) => localeTag(lang);

// ------------------------------------------------------------------ 宿主页面准备
/**
 * 关掉宿主遮罩类弹窗（Preview Notice / 登录已超时 / 等待登录等）。
 * 与 test/e2e-ui.mjs 同一套处理：先点文字按钮，点不掉就移除宿主 presentation 容器；
 * 插件自己的浮层（.wl-overlay）不算遮罩，不能误删。
 */
async function dismissHostDialogs(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const dismissed = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog || dialog.querySelector('[data-wl-overlay="true"]')) return false;
      const buttons = [...dialog.querySelectorAll("button")];
      if (buttons.length === 0) return false;
      const target =
        buttons.find((node) => /Continue|继续|Configure later|稍后配置|Got it|知道了|Close|关闭/i.test(node.textContent || "")) ??
        buttons[buttons.length - 1];
      target.click();
      return true;
    });
    if (!dismissed) {
      const removed = await page.evaluate(() => {
        let count = 0;
        for (const mask of document.querySelectorAll('[class*="_mask_"]')) {
          const root = mask.parentElement ?? null;
          if (root !== null && !root.querySelector('[data-wl-overlay="true"]')) {
            root.remove();
            count += 1;
          }
        }
        return count > 0;
      });
      if (!removed) break;
    }
    await sleep(1500);
  }
  // 兜底清扫
  await page.evaluate(() => {
    for (const mask of document.querySelectorAll('[class*="_mask_"]')) {
      const root = mask.parentElement ?? null;
      if (root !== null && !root.querySelector('[data-wl-overlay="true"]')) root.remove();
    }
  });
}

/**
 * 首次引导（仅当宿主真的弹出 Choose workspace 时）。
 * e2e-boot.sh 的独立 DSH_HOME + 在测试工作区启动，通常直接进主界面；
 * 这里沿用 e2e-ui.mjs 的处理只是兜底，不影响语言断言。
 */
async function ensureWorkspace(page) {
  const needsOnboarding = await page.evaluate(() => document.body.innerText.includes("Choose workspace"));
  if (!needsOnboarding) return;
  await page.evaluate(() => {
    const button = [...document.querySelectorAll("button")].find((node) => (node.textContent || "").includes("Choose workspace"));
    button?.click();
  });
  const box = await page.waitForSelector('textarea[placeholder="Choose a workspace to start"]', { timeout: 15000 }).catch(() => null);
  if (box !== null) {
    await box.type(WORKSPACE_PATH);
    await page.keyboard.press("Enter");
  } else {
    await page.evaluate((ws) => {
      const nodes = [...document.querySelectorAll("button, li, [role='button'], a, div")];
      const hit = nodes.find((node) => (node.textContent || "").includes(ws) && (node.textContent || "").length < 200);
      hit?.click();
    }, WORKSPACE_PATH);
    await sleep(1500);
    await page.evaluate(() => {
      const open = [...document.querySelectorAll("button")].find((node) => /^(Open|打开)$/.test((node.textContent || "").trim()));
      open?.click();
    });
  }
  await sleep(2000);
  await page.evaluate(async () => {
    const clickBy = async (pattern) => {
      const button = [...document.querySelectorAll("button")].find((node) => pattern.test(node.textContent || ""));
      if (button) {
        button.click();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        return true;
      }
      return false;
    };
    for (let i = 0; i < 6; i += 1) {
      if (await clickBy(/Standard mode|标准模式/)) continue;
      if (await clickBy(/Save and continue|保存并继续/)) continue;
      if (await clickBy(/Configure later|稍后配置/)) continue;
      break;
    }
  });
  await sleep(3000);
}

/**
 * 用指定语言打开宿主入口，并等「工作量报告」面板真正渲染出数据。
 * 失败时抛出带页面片段 / 截图路径的错误，由上层按语言记失败、继续跑下一种。
 */
async function openPanel(page) {
  const response = await page.goto(ENTRY_URL, { waitUntil: "networkidle2", timeout: 90000 });
  if (response !== null && (response.status() === 401 || response.status() === 403)) {
    throw new Error(
      `测试实例要求认证（HTTP ${String(response.status())}）：请用 WL_URL 传入 dsh web 打印的带 token URL（http://127.0.0.1:3299/?token=...）`,
    );
  }
  await sleep(4000);
  await dismissHostDialogs(page);
  await ensureWorkspace(page);
  await page.waitForSelector(".wl-footer-item", { timeout: 30000 });
  // 底部入口可能被窗口边缘 / 滚动条遮挡，坐标点击不稳 → 用 DOM click（同 e2e-ui.mjs）
  await page.evaluate(() => document.querySelector(".wl-footer-item")?.click());
  await page.waitForSelector(".wl-panel", { timeout: 30000 });
  // 骨架屏先渲染、快照后到：等骨架被真实视图替换；首次建索引可能很慢，等「正在补齐」消失
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => document.querySelector('[data-kind="indexing"]') === null, { timeout: 120000 }).catch(() => {});
  await sleep(1500);
  await page.evaluate(() => document.querySelector(".wl-panel")?.scrollIntoView({ block: "start" })).catch(() => {});
}

// ------------------------------------------------------------------ 单语言验收
async function checkLanguage(browser, lang) {
  console.log(`\n=== ${lang}（${tagOf(lang)}） ===`);
  const tag = tagOf(lang);
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  const pageErrors = [];
  const consoleErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 1 });
  // 双保险：navigator.languages（客户端检测）+ Accept-Language（万一宿主按请求头判断）
  await page.setExtraHTTPHeaders({ "Accept-Language": `${tag},${lang};q=0.9` });
  await page.evaluateOnNewDocument(
    (active, primary) => {
      Object.defineProperty(navigator, "languages", { get: () => [active, primary], configurable: true });
      Object.defineProperty(navigator, "language", { get: () => active, configurable: true });
    },
    tag,
    lang,
  );

  try {
    let panelReady = false;
    try {
      await openPanel(page);
      panelReady = true;
    } catch (error) {
      ok(false, "面板打开（等待 .wl-footer-item / .wl-panel 超时）", error.message);
      await page.screenshot({ path: join(ARTIFACTS, `i18n-${lang}-failed.png`) }).catch(() => {});
      try {
        const text = await page.evaluate(() => document.body.innerText.slice(0, 600));
        console.error(`  页面片段：${JSON.stringify(snippet(text))}`);
      } catch {
        /* 页面可能已崩 */
      }
    }

    if (panelReady) {
      const dom = await page.evaluate(() => ({
        htmlLang: document.documentElement.lang,
        footerTitle: document.querySelector(".wl-footer-item")?.getAttribute("title") ?? "",
        panelText: document.querySelector(".wl-panel")?.innerText ?? "",
        panelTitle: document.querySelector(".wl-title")?.textContent ?? "",
        tabs: [...document.querySelectorAll(".wl-panel .wl-tabs .wl-tab")].map((node) => (node.textContent || "").trim()),
        kpiLabels: [...document.querySelectorAll(".wl-panel .wl-kpi-label")].map((node) => (node.textContent || "").trim()),
        chips: [...document.querySelectorAll(".wl-panel .wl-chips .wl-chip")].map((node) => (node.textContent || "").trim()),
        scopes: [...document.querySelectorAll(".wl-panel .wl-select option")].map((node) => (node.textContent || "").trim()),
      }));
      console.log(`  · 宿主 html lang = ${JSON.stringify(dom.htmlLang)}（注入标签 ${tag}，仅记录不作断言：宿主可能归一化）`);

      // 1) 顶部核心文案：面板标题 / 页签 / KPI / 区间 —— 全部来自词典
      ok(dom.panelTitle === translate(lang, "panel.title"), "面板标题 = 词典 panel.title", `实际 ${JSON.stringify(dom.panelTitle)} / 期望 ${JSON.stringify(translate(lang, "panel.title"))}`);
      for (const key of ["tab.byDay", "kpi.tokens", "range.7"]) {
        assertContains(dom.panelText, translate(lang, key), `面板含词典文案 ${key}`);
      }
      // 2) 结构位置精确断言：5 个页签 / Tokens KPI / 区间 chip / 统计范围下拉
      const expectedTabs = ["tab.byDay", "tab.model", "tab.byWorkspace", "tab.bySession", "tab.aiProfile"].map((key) => translate(lang, key));
      ok(
        dom.tabs.length === expectedTabs.length && dom.tabs.every((text, index) => text === expectedTabs[index]),
        "5 个页签文案逐项 = 词典 tab.*",
        `实际 ${JSON.stringify(dom.tabs)} / 期望 ${JSON.stringify(expectedTabs)}`,
      );
      assertContains(dom.kpiLabels.join("\n"), translate(lang, "kpi.tokens"), "KPI 卡「总 Token」标签 = 词典 kpi.tokens");
      assertContains(dom.chips.join("\n"), translate(lang, "range.7"), "区间 chip 含词典 range.7");
      assertContains(dom.scopes.join("\n"), translate(lang, "scope.all"), "统计范围下拉含词典 scope.all");
      // 3) 侧边栏底部入口说明文案（插件注册到宿主 sidebar.footer.action 的 title）
      ok(dom.footerTitle === translate(lang, "action.title"), "侧边栏入口 title = 词典 action.title", `实际 ${JSON.stringify(dom.footerTitle)} / 期望 ${JSON.stringify(translate(lang, "action.title"))}`);
      // 4) 不允许裸露文案键名（漏翻 / 忘注册词典时会露出来）
      ok(!/(?:panel|tab|kpi|range|scope|action)\.[a-zA-Z]/.test(dom.panelText), "面板没有裸露的文案键名", JSON.stringify(snippet(dom.panelText)));
      // 5) 非英文时不得使用英文占位（当前 6 国语言翻译合入前这里会红，是预期信号）
      if (lang !== "en") {
        ok(
          translate(lang, "panel.title") !== translate("en", "panel.title") && translate(lang, "tab.byDay") !== translate("en", "tab.byDay"),
          "该语言词典不是英文占位（panel.title / tab.byDay 已翻译）",
          `panel.title=${JSON.stringify(translate(lang, "panel.title"))}`,
        );
        assertContains(dom.panelText, translate(lang, "tab.byDay"), "面板含该语言的页签文案（非英文）");
      }
      // 6) 非目标语言特征不能串台：英文标题 / 中文标题（ja 含汉字，不做中文缺席断言，只断言包含日语值）
      if (lang !== "en") {
        ok(
          !dom.panelText.includes(dictionaries.en["panel.title"]),
          "面板不含英文标题（非 en 语言不串台）",
          `不应含 ${JSON.stringify(dictionaries.en["panel.title"])}；实际：${JSON.stringify(snippet(dom.panelText))}`,
        );
      }
      if (lang !== "zh" && lang !== "ja") {
        ok(
          !dom.panelText.includes(dictionaries.zh["panel.title"]),
          "面板不含中文标题（非 zh/ja 语言不串台）",
          `不应含 ${JSON.stringify(dictionaries.zh["panel.title"])}；实际：${JSON.stringify(snippet(dom.panelText))}`,
        );
      }
      if (lang === "ja") {
        // 日语词典本身就用汉字，不能按「无中文」判；只确认 panel.title 是日语词典值（上面已断言）
        console.log("  · ja：只断言包含日语词典值，不断言不含汉字（词典自身含汉字）");
      }
      // 7) 页面无 JS 异常
      ok(pageErrors.length === 0, "面板页无 JS 异常", pageErrors.slice(0, 3).join(" | "));
      if (consoleErrors.length > 0) console.log(`  · console error ${consoleErrors.length} 条（仅记录）：${snippet(consoleErrors.join(" | "), 200)}`);

      await page.screenshot({ path: join(ARTIFACTS, `i18n-${lang}.png`) });
      console.log(`  · 截图 test/.artifacts/i18n-${lang}.png`);
    }

    // ---- HTML 报告：语言由 query lang 显式指定 ----
    const reportPage = await context.newPage();
    const reportErrors = [];
    reportPage.on("pageerror", (error) => reportErrors.push(error.message));
    await reportPage.setViewport({ width: 1240, height: 1400, deviceScaleFactor: 1 });
    try {
      const reportUrl = `${URL_BASE}/workload-report/v1/report.html?days=7&tz=UTC&lang=${lang}`;
      const response = await reportPage.goto(reportUrl, { waitUntil: "networkidle2", timeout: 60000 });
      ok(response?.status() === 200, `报告页返回 200（lang=${lang}）`, String(response?.status()));
      const report = await reportPage.evaluate(() => ({
        lang: document.documentElement.lang,
        text: document.body.innerText,
      }));
      ok(
        report.lang === tagOf(lang),
        `报告页 <html lang> = localeTag(${lang})（${tagOf(lang)}）`,
        `实际 ${JSON.stringify(report.lang)}`,
      );
      assertContains(report.text, translate(lang, "report.title"), `报告页正文含词典 report.title`);
      ok(!/\breport\.[a-zA-Z]/.test(report.text), "报告页没有裸露的文案键名", JSON.stringify(snippet(report.text)));
      ok(reportErrors.length === 0, "报告页无 JS 异常", reportErrors.slice(0, 3).join(" | "));
      await reportPage.screenshot({ path: join(ARTIFACTS, `i18n-report-${lang}.png`), fullPage: true });
      console.log(`  · 截图 test/.artifacts/i18n-report-${lang}.png`);
    } catch (error) {
      ok(false, `报告页校验（lang=${lang}）`, error.message);
      await reportPage.screenshot({ path: join(ARTIFACTS, `i18n-report-${lang}-failed.png`) }).catch(() => {});
    } finally {
      await reportPage.close().catch(() => {});
    }
  } finally {
    await context.close().catch(() => {});
  }
}

// ------------------------------------------------------------------ 主流程
mkdirSync(ARTIFACTS, { recursive: true });
const CHROME = resolveChrome();
const puppeteer = loadPuppeteer();
console.log(`入口：${ENTRY_URL}`);
console.log(`语言：${LANGS.join(", ")}（共 ${LANGS.length} 种，标签取自 localeTag()）`);
console.log(`Chrome：${CHROME}`);

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--user-data-dir=/tmp/dsh-workload-chrome-i18n"],
});

try {
  for (const lang of LANGS) {
    try {
      await checkLanguage(browser, lang);
    } catch (error) {
      // 单个语言整体崩了不影响其它语言：记失败 + 继续
      ok(false, `${lang} 验收流程`, error?.stack ?? String(error));
    }
  }
} finally {
  await browser.close().catch(() => {});
}

console.log("");
if (failures > 0) {
  console.error(`${failures} 项失败 ✗`);
  process.exitCode = 1;
} else {
  console.log(`i18n 真实浏览器验收全部通过 ✓（${LANGS.length} 种语言）`);
}
