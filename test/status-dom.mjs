// 状态行三态 DOM 断言（真实浏览器，拦截 /snapshot 只改 diagnostics）。
// 前置：隔离实例已启动，WL_URL 带 token。
// 用法：WL_URL='http://127.0.0.1:3299/?token=...' node test/status-dom.mjs
import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "test", ".artifacts");
const URL = process.env.WL_URL || "http://127.0.0.1:3299/";
const CHROME = process.env.WL_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PUPPETEER_DIR = process.env.WL_PUPPETEER_DIR || join(process.env.HOME ?? "", ".dsh", "profiles", "web", "node_modules");
if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
const require = createRequire(import.meta.url);
const puppeteer = require(require.resolve("puppeteer-core", { paths: [PUPPETEER_DIR, ROOT] }));
mkdirSync(ARTIFACTS, { recursive: true });

let failures = 0;
const ok = (condition, label, detail = "") => {
  if (condition) console.log(`✓ ${label}`);
  else { failures += 1; console.error(`✗ ${label}${detail === "" ? "" : ` — ${detail}`}`); }
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox", "--user-data-dir=/tmp/dsh-workload-status-dom"] });
const page = await browser.newPage();
await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto(URL, { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(3500);
  await page.evaluate(() => document.querySelector(".wl-footer-item")?.click());
  await page.waitForSelector(".wl-panel", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 });
  // 关掉 DSH 自己的登录/引导浮层（不是本插件的面板），避免遮挡截图
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dismissed = await page.evaluate(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((node) => !node.classList.contains("wl-overlay"));
      const dialog = dialogs[0];
      if (dialog === undefined) return false;
      const button = [...dialog.querySelectorAll("button")].find((node) => /Cancel|取消|Close|关闭|Configure later|稍后配置/i.test(node.textContent || ""));
      (button ?? dialog.querySelector("button"))?.click();
      return true;
    });
    if (!dismissed) break;
    await sleep(800);
  }
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /按日|By day/i.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(1000);
  ok((await page.evaluate(() => document.querySelectorAll(".wl-chart, .wl-hour-grid").length)) > 0, "时刻分析卡已渲染");

  const snapshotUrl = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/workload-report/v1/snapshot"));
    return entries[entries.length - 1] ?? null;
  });
  ok(typeof snapshotUrl === "string", "找到快照请求 URL", String(snapshotUrl));
  const real = await page.evaluate(async (url) => (await fetch(url)).json(), snapshotUrl);
  ok(real?.diagnostics?.modelFold !== undefined, "真实快照带 modelFold diagnostics");

  let fake = null;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    if (fake === null || !request.url().includes("/workload-report/v1/snapshot")) {
      void request.continue();
      return;
    }
    const body = JSON.parse(JSON.stringify(real));
    body.diagnostics.modelFold = { ...body.diagnostics.modelFold, phase: fake.phase, running: fake.running, pending: fake.pending, failedRows: fake.failedRows };
    body.diagnostics.hourTokensSource = { ...(body.diagnostics.hourTokensSource ?? {}), missing: fake.missing };
    void request.respond({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
  });
  const clickRefresh = () => page.evaluate(() => {
    const button = [...document.querySelectorAll(".wl-head .wl-btn")].find((node) => /刷新|Refresh/i.test(node.textContent || ""));
    button?.click();
  });
  const assertCase = async (name, status, expectedState, expectedText, shot) => {
    fake = status;
    await clickRefresh();
    await page.waitForFunction(
      (state) => document.querySelector('[data-kind="hour-tokens-missing"]')?.getAttribute("data-state") === state,
      { timeout: 20000 },
      expectedState,
    ).catch(() => {});
    const dom = await page.evaluate(() => {
      const node = document.querySelector('[data-kind="hour-tokens-missing"]');
      return {
        state: node?.getAttribute("data-state") ?? null,
        text: node?.textContent ?? null,
        color: node === null ? null : getComputedStyle(node).color,
        dot: node === null ? null : getComputedStyle(node, "::before").content,
      };
    });
    const texts = Array.isArray(expectedText) ? expectedText : [expectedText];
    ok(dom.state === expectedState && texts.some((text) => (dom.text ?? "").includes(text)), `三态 DOM：${name}`, JSON.stringify(dom));
    if (shot !== null) {
      await page.evaluate(() => document.querySelector(".wl-hour-card")?.scrollIntoView({ block: "center" }));
      await sleep(300);
      const card = await page.$(".wl-hour-card");
      if (card !== null) await card.screenshot({ path: join(ARTIFACTS, shot) });
      else await page.screenshot({ path: join(ARTIFACTS, shot) });
    }
    return dom;
  };
  const first = await assertCase("first-fold", { phase: "first-fold", running: true, pending: 3, failedRows: 0, missing: 0 }, "first-fold", ["正在计算", "Calculating"], "07-status-first-fold.png");
  const background = await assertCase("background", { phase: "background", running: true, pending: 0, failedRows: 2, missing: 5 }, "background", ["后台更新中", "Updating in background"], "08-status-background.png");
  const idle = await assertCase("idle", { phase: "idle", running: false, pending: 0, failedRows: 4, missing: 3 }, "idle", ["Token 未计入 3 个会话", "3 sessions excluded"], "09-status-idle.png");
  ok(first.color !== idle.color, "first-fold 用强调色、idle 用 muted", `${first.color} vs ${idle.color}`);
  ok(background.dot !== "none", "background 有灰点（::before）", String(background.dot));
  fake = { phase: "idle", running: false, pending: 0, failedRows: 6, missing: 0 };
  await clickRefresh();
  await page.waitForFunction(() => document.querySelector('[data-kind="hour-tokens-missing"]') === null, { timeout: 20000 }).catch(() => {});
  ok(await page.evaluate(() => document.querySelector('[data-kind="hour-tokens-missing"]') === null), "idle + N=0：状态行不渲染（失败行不触发计算中）");
  ok(errors.length === 0, "无页面异常", errors.slice(0, 2).join(" | "));
} catch (error) {
  failures += 1;
  console.error("✗ 运行异常:", error.message);
  await page.screenshot({ path: join(ARTIFACTS, "99-status-failure.png") }).catch(() => {});
} finally {
  await browser.close();
}
console.log(failures === 0 ? "状态三态 DOM 全部通过 ✓" : `状态三态 DOM ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
