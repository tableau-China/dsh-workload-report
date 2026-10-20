// 真实浏览器端到端验证：隔离实例 + 真实投影数据，验证看板渲染、切换与报告页，并留下截图。
//
// 前置：test/e2e-boot.sh 已在 WL_URL（默认 127.0.0.1:3299）启动测试实例。
// 用法：node test/e2e-ui.mjs

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = join(ROOT, "test", ".artifacts");
const ENTRY_URL = process.env.WL_URL || "http://127.0.0.1:3299";
/** 带 token 的入口 URL；其它同源路由继承浏览器 cookie。 */
const URL_BASE = new URL(ENTRY_URL).origin;
/** Chrome 可执行文件：优先 $WL_CHROME，其次各平台常见路径。 */
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
const CHROME = resolveChrome();
const WORKSPACE_PATH = process.env.WL_WORKSPACE || "/tmp/dsh-workload-e2e/ws";

/** puppeteer-core 解析顺序：本目录 → $WL_PUPPETEER_DIR → ~/.dsh/profiles/web。 */
function loadPuppeteer() {
  const require = createRequire(import.meta.url);
  const bases = [ROOT, process.env.WL_PUPPETEER_DIR, join(homedir(), ".dsh", "profiles", "web")].filter((base) => typeof base === "string" && base.length > 0);
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
  if (condition) console.log(`✓ ${label}`);
  else {
    failures += 1;
    console.error(`✗ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
};

mkdirSync(ARTIFACTS, { recursive: true });
const puppeteer = loadPuppeteer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--user-data-dir=/tmp/dsh-workload-chrome"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 2 });

const consoleErrors = [];
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));

try {
  await page.goto(ENTRY_URL, { waitUntil: "networkidle2", timeout: 90000 });
  await sleep(4000);

  // 关掉遮罩类弹窗（Preview Notice 的 Continue、Configure later 等）
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const dismissed = await page.evaluate(() => {
      const dialog = document.querySelector('[role="dialog"]');
      if (!dialog) return false;
      const buttons = [...dialog.querySelectorAll("button")];
      if (buttons.length === 0) return false;
      const target =
        buttons.find((node) => /Continue|继续|Configure later|稍后配置|Got it|知道了|Close|关闭/i.test(node.textContent || "")) ??
        buttons[buttons.length - 1];
      target.click();
      return true;
    });
    if (!dismissed) break;
    await sleep(1500);
  }
  ok((await page.evaluate(() => document.querySelectorAll('[class*="_mask_"]').length)) === 0, "无遮罩层阻挡交互");

  // 首次引导（仅在出现 Choose workspace 时）
  const needsOnboarding = await page.evaluate(() => document.body.innerText.includes("Choose workspace"));
  if (needsOnboarding) {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((node) => (node.textContent || "").includes("Choose workspace"));
      button?.click();
    });
    // 两种情况都要兼容：首次是"路径输入框"，测试 home 复用后是"最近工作区列表"
    const box = await page.waitForSelector('textarea[placeholder="Choose a workspace to start"]', { timeout: 15000 }).catch(() => null);
    if (box !== null) {
      await box.type(WORKSPACE_PATH);
      await page.keyboard.press("Enter");
    } else {
      const picked = await page.evaluate((ws) => {
        const nodes = [...document.querySelectorAll("button, li, [role='button'], a, div")];
        const hit = nodes.find((n) => (n.textContent || "").includes(ws) && (n.textContent || "").length < 200);
        hit?.click();
        return hit !== undefined;
      }, WORKSPACE_PATH);
      ok(picked, "在工作区列表里选中测试工作区", WORKSPACE_PATH);
      // 列表可能还需要一次 Open/打开
      await sleep(1500);
      await page.evaluate(() => {
        const open = [...document.querySelectorAll("button")].find((n) => /^(Open|打开)$/.test((n.textContent || "").trim()));
        open?.click();
      });
    }
    await sleep(2000);
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((node) => (node.textContent || "").trim() === "Open");
      button?.click();
    });
    await sleep(2500);
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
  ok(!(await page.evaluate(() => document.body.innerText.includes("Choose workspace"))), "已进入主界面");

  // 等侧边栏底部的插件按钮
  await page.waitForSelector(".wl-footer-item", { timeout: 30000 });
  ok(true, "侧边栏出现「工作量报告」入口");
  const entryTitle = await page.evaluate(() => document.querySelector(".wl-footer-item")?.getAttribute("title") ?? "");
  ok(/工作量报告/.test(entryTitle) || /Workload/.test(entryTitle), "入口带说明文案", entryTitle);
  await page.screenshot({ path: join(ARTIFACTS, "01-sidebar-entry.png") });

  // 打开看板（用 DOM click：底部入口可能被窗口边缘/滚动条遮挡，坐标点击不稳）
  await page.evaluate(() => document.querySelector(".wl-footer-item")?.click());
  await page.waitForSelector(".wl-panel", { timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll(".wl-kpi-value").length >= 6, { timeout: 30000 });
  // 骨架屏会先渲染（数值位是「加载中…」）：等真实快照到位、骨架被替换后再断言数值
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 });
  // 首次建索引会冷读历史会话：等"正在补齐"提示消失（面板会每 5 秒自动重拉）
  await page.waitForFunction(() => document.querySelector('[data-kind="indexing"]') === null, { timeout: 120000 }).catch(() => {});
  await sleep(1500);

  const kpis = await page.evaluate(() => [...document.querySelectorAll(".wl-kpi-value")].map((node) => node.textContent));
  ok(kpis.length === 8, "看板渲染 8 张 KPI 卡（含「模型费用」「最活跃模型」）", JSON.stringify(kpis));
  ok(kpis.some((value) => /[1-9]/.test(value ?? "")), "KPI 有真实数值（非全 0）", JSON.stringify(kpis));
  ok(/^[\d,]*[1-9][\d,]*$/.test(kpis[1] ?? ""), "「总 Token」KPI 非零且为完整整数（能识别官方 wire 形状）", kpis[1]);
  ok(/[1-9]/.test(kpis[0] ?? ""), "「活跃时长」KPI 非零", kpis[0]);
  const barCount = await page.evaluate(() => document.querySelectorAll(".wl-kpi + * , .wl-kpis .wl-kpi").length);
  ok(barCount >= 6, "KPI 卡片 DOM 完整", String(barCount));
  // ---- KPI：顺序 + 总 Token 必须是完整整数 ----
  const kpiLabels = await page.evaluate(() => [...document.querySelectorAll(".wl-kpi-label")].map((n) => n.textContent));
  ok(
    /活跃|active/i.test(kpiLabels[0] ?? "") && /token/i.test(kpiLabels[1] ?? "") && /费用|cost/i.test(kpiLabels[2] ?? "") && /天|day/i.test(kpiLabels[3] ?? "") && /对话|conversation/i.test(kpiLabels[4] ?? ""),
    "KPI 顺序：活跃时长 → 总 Token → 模型费用 → 活跃天数 → 对话次数",
    JSON.stringify(kpiLabels),
  );
  ok(/^[\d,]+$/.test(kpis[1] ?? "") && (kpis[1] ?? "").length >= 6, "总 Token 是完整整数（非 K/M/B 缩写）", kpis[1]);
  ok(/模型|model/i.test(kpiLabels[7] ?? ""), "第 8 张 KPI 是「最活跃模型」", JSON.stringify(kpiLabels[7]));
  // 8 张卡正好 2 行排满：Tokens / 模型费用各跨 2 列，值不溢出
  const kpiLayout = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".wl-kpis .wl-kpi")];
    return {
      rows: new Set(cards.map((card) => Math.round(card.getBoundingClientRect().top))).size,
      // grid-column: span 2 的计算值落在 grid-column-start（end 是 auto）
      spans: cards.filter((card) => getComputedStyle(card).gridColumnStart === "span 2").map((card) => card.dataset.kpi),
      overflow: cards.some((card) => {
        const value = card.querySelector(".wl-kpi-value");
        return value === null || value.scrollWidth > value.clientWidth + 1;
      }),
    };
  });
  ok(kpiLayout.rows === 2 && kpiLayout.spans.includes("kpi.tokens") && kpiLayout.spans.includes("kpi.modelCost") && !kpiLayout.overflow, "KPI 8 张卡 2 行排满（Tokens / 模型费用跨 2 列）且值不溢出", JSON.stringify(kpiLayout));

  // —— 问题 5：「复制 JSON」按钮已删除（工具栏只剩 刷新 / 导出 / 关闭）——
  const headerButtons = await page.evaluate(() => [...document.querySelectorAll(".wl-head .wl-btn")].map((node) => (node.textContent || "").trim()));
  ok(
    headerButtons.length === 3 && !headerButtons.some((text) => /复制|copied|copy json/i.test(text)),
    "工具栏不再有「复制 JSON」按钮",
    JSON.stringify(headerButtons),
  );

  // ---- 单位统一小写 h/m/s + 备注足够短（降低多语言工作量）----
  const copyCheck = await page.evaluate(() => ({
    kpiActive: document.querySelectorAll(".wl-kpi-value")[0]?.textContent ?? "",
    workspaceValue: document.querySelector(".wl-metrics .wl-metric-value")?.textContent ?? "",
    weekdayTip: document.querySelector('[data-kind="weekday-bar"] title')?.textContent ?? "",
    hints: [...document.querySelectorAll(".wl-hint, .wl-metric-sub, .wl-note")].map((n) => n.textContent ?? ""),
    bodyHasChineseHour: document.body.innerText.includes("小时"),
  }));
  ok(/\d+(\.\d+)?\s*[hms]\b|^0$/i.test(copyCheck.kpiActive.trim()), "活跃时长 KPI 用小写 h/m/s 单位", copyCheck.kpiActive);
  ok(/[hms]\b/i.test(copyCheck.weekdayTip), "周几条 tooltip 用小写 h/m/s 单位", copyCheck.weekdayTip);
  ok(copyCheck.bodyHasChineseHour === false, "界面上不再出现「小时」字样");
  const longestHint = copyCheck.hints.reduce((max, text) => Math.max(max, text.length), 0);
  ok(longestHint <= 90, "备注文案已压短（最长 ≤ 90 字）", `最长 ${longestHint} 字`);

  // ---- 每日用量：默认日历，可切柱状图 ----
  const calendar = await page.evaluate(() => ({
    hasCalendar: document.querySelector(".wl-cal-scroll svg") !== null,
    cells: document.querySelectorAll(".wl-cal-scroll svg rect").length,
    weekLabels: [...document.querySelectorAll(".wl-cal-scroll svg text")].map((n) => n.textContent).filter((t) => /W\d/.test(t ?? "")).slice(0, 3),
    weekdayRows: [...document.querySelectorAll(".wl-cal-scroll svg text")].map((n) => n.textContent).slice(0, 7),
    polylines: document.querySelectorAll(".wl-card svg polyline").length,
    cellTitle: document.querySelector(".wl-cal-scroll svg rect title")?.textContent ?? "",
  }));
  ok(calendar.hasCalendar, "默认显示日历热力图");
  ok(calendar.cells > 0, "日历有格子", String(calendar.cells));
  ok(calendar.polylines === 0, "默认不渲染柱状图（切换前）", String(calendar.polylines));
  ok(calendar.weekLabels.length > 0, "横轴标出 Year-Week", JSON.stringify(calendar.weekLabels));
  ok(calendar.weekdayRows.some((text) => /周|Mon|Tue/i.test(text ?? "")), "纵轴是周一～周日", JSON.stringify(calendar.weekdayRows));
  ok(/活跃|active|无记录|no record/i.test(calendar.cellTitle), "日历格子带 tooltip", calendar.cellTitle.replace(/\n/g, " | "));

  const weekdayBars = await page.evaluate(() => {
    const bars = [...document.querySelectorAll('[data-kind="weekday-bar"]')];
    return {
      count: bars.length,
      tips: bars.slice(0, 2).map((bar) => bar.querySelector("title")?.textContent ?? ""),
      anchors: bars.map((bar) => Math.round(bar.getBoundingClientRect().left)),
    };
  });
  ok(weekdayBars.count === 7, "日历右侧有 7 条周几累计条", String(weekdayBars.count));
  ok(weekdayBars.tips.every((tip) => /\d/.test(tip)), "周几条带累计时长 tooltip", JSON.stringify(weekdayBars.tips));
  const lastCellRight = await page.evaluate(() => {
    const cells = [...document.querySelectorAll(".wl-cal-scroll svg rect")].filter((r) => !r.hasAttribute("data-kind"));
    return cells.length > 0 ? Math.round(Math.max(...cells.map((r) => r.getBoundingClientRect().right))) : 0;
  });
  ok(weekdayBars.anchors.every((left) => left > lastCellRight), "周几条紧贴在最后一列右侧", `cell=${lastCellRight} bar=${weekdayBars.anchors[0]}`);

  // 2) 日历不受顶部区间影响：切到近 7 天，格子数应保持不变
  //    注意两次必须用同一个选择器（只数日历格子，排除右侧 7 条周几 bar）
  const cellsBefore = await page.evaluate(() => document.querySelectorAll(".wl-cal-scroll svg rect:not([data-kind])").length);
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-head .wl-chip")].find((node) => /近 7 天|Last 7/i.test(node.textContent || ""));
    chip?.click();
  });
  await sleep(2000);
  const afterSeven = await page.evaluate(() => ({
    cells: document.querySelectorAll(".wl-cal-scroll svg rect:not([data-kind])").length,
    subtitle: document.querySelector(".wl-subtitle")?.textContent ?? "",
    weekdayBars: document.querySelectorAll('[data-kind="weekday-bar"]').length,
  }));
  ok(afterSeven.cells === cellsBefore, "切到近 7 天后日历格子数不变（固定全历史）", `${cellsBefore} → ${afterSeven.cells}`);
  ok(afterSeven.weekdayBars === 7, "切区间后周几条仍在");
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-head .wl-chip")].find((node) => /近 30 天|Last 30/i.test(node.textContent || ""));
    chip?.click();
  });
  await sleep(1800);

  // 换区间会先出骨架屏：等骨架结束、柱状图 chip 出现再点（否则 chip?.click() 会静默落空）
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => [...document.querySelectorAll(".wl-card-head .wl-chip")].some((node) => /柱状图|Bar chart/i.test(node.textContent || "")), { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-card-head .wl-chip")].find((node) => /柱状图|Bar chart/i.test(node.textContent || ""));
    chip?.click();
  });
  await page.waitForFunction(() => document.querySelector('[data-kind="daily-chart"] svg') !== null, { timeout: 15000 }).catch(() => {});
  await sleep(600);
  const barMode = await page.evaluate(() => ({
    polylines: document.querySelectorAll(".wl-card svg polyline").length,
    calendar: document.querySelector(".wl-cal-scroll") !== null,
    bars: document.querySelectorAll('[data-kind="active-bar"]').length,
    fills: [...new Set([...document.querySelectorAll('[data-kind="active-bar"]')].map((n) => n.getAttribute("fill")))].length,
  }));
  ok(barMode.polylines === 0 && !barMode.calendar && barMode.bars > 0, "切到柱状图后只有柱（折线已删）且日历消失", JSON.stringify(barMode));
  ok(barMode.fills === 2, "柱状图工作日 / 周末两种颜色", JSON.stringify(barMode));
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-card-head .wl-chip")].find((node) => /日历|Calendar/i.test(node.textContent || ""));
    chip?.click();
  });
  await sleep(800);

  // 每日趋势卡几何：与右侧模型占比卡等高、legend 在卡片内容区内、与下一行栅格不重叠
  const dailyGeometry = await page.evaluate(() => {
    const [left, right] = [...document.querySelectorAll(".wl-grid-daily-model > .wl-card")];
    const body = left.querySelector(".wl-daily-body");
    // 日历与柱状图都在 .wl-daily-body 里；这里量的是当前日历的留白
    const chart = left.querySelector(".wl-cal-scroll svg, [data-kind=daily-chart] svg");
    const next = document.querySelector(".wl-grid-daily-model + .wl-grid-2");
    const round = (value) => Math.round(value * 100) / 100;
    const box = chart?.getBoundingClientRect() ?? null;
    const bodyBox = body.getBoundingClientRect();
    return {
      heightDiff: round(Math.abs(left.getBoundingClientRect().height - right.getBoundingClientRect().height)),
      legendCount: left.querySelectorAll(".wl-legend").length,
      blankTop: box === null ? null : round(box.top - bodyBox.top),
      blankBottom: box === null ? null : round(bodyBox.bottom - box.bottom),
      gapToNext: next === null ? null : round(next.getBoundingClientRect().top - left.getBoundingClientRect().bottom),
    };
  });
  ok(dailyGeometry.heightDiff === 0 && dailyGeometry.legendCount === 0 && dailyGeometry.gapToNext !== null && dailyGeometry.gapToNext > 0, "每日趋势卡与模型占比卡等高、无底部 legend、与下一行不重叠", JSON.stringify(dailyGeometry));
  ok(dailyGeometry.blankTop !== null && dailyGeometry.blankBottom !== null && dailyGeometry.blankTop + dailyGeometry.blankBottom <= 40, "日历填满每日趋势卡剩余高度（上下留白合计 ≤ 40px）", JSON.stringify(dailyGeometry));

  // ---- 并排两图：时刻分析 + 工作区占比 ----
  const sideCharts = await page.evaluate(() => {
    const cards = [...document.querySelectorAll(".wl-grid-2 > .wl-card")];
    const rects = cards.map((c) => {
      const r = c.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top) };
    });
    return {
      count: cards.length,
      titles: cards.map((c) => c.querySelector("h3")?.textContent ?? ""),
      rects,
      hourCols: document.querySelectorAll(".wl-hour-col").length,
      peak: document.querySelectorAll(".wl-hour-col[data-peak]").length,
      hourTip: document.querySelector(".wl-hour-col[data-peak]")?.getAttribute("title") ?? "",
      hourPeakValue: document.querySelector(".wl-hour-value")?.textContent ?? "",
      hourChips: [...document.querySelectorAll(".wl-grid-2 .wl-card:first-child .wl-chips .wl-chip")].map((n) => ({ text: n.textContent.trim(), measure: n.getAttribute("data-measure"), active: n.getAttribute("data-active") === "true" })),
      hourLegend: [...document.querySelectorAll(".wl-grid-2 .wl-card:first-child .wl-hour-legend .wl-legend-item")].map((n) => n.textContent.trim()),
      hourHint: document.querySelectorAll(".wl-grid-2 .wl-card:first-child > .wl-hint:not(.wl-hour-note)").length,
      hourDots: [...document.querySelectorAll(".wl-hour-dot")].map((n) => {
        const dot = n.getBoundingClientRect();
        const grid = n.closest(".wl-hour-grid").getBoundingClientRect();
        return { diameter: Math.round(dot.width * 10) / 10, topInset: Math.round((dot.top - grid.top) * 10) / 10 };
      }),
      // 只数并排两图里的工作区环形图（首页右列的模型环形图不在 .wl-grid-2 内）
      pieSlices: document.querySelectorAll(".wl-grid-2 .wl-pie-wrap svg circle, .wl-grid-2 .wl-pie-wrap svg path").length,
      pieLegend: [...document.querySelectorAll(".wl-grid-2 .wl-pie-legend li")].map((n) => n.textContent).slice(0, 3),
    };
  });
  ok(sideCharts.count === 2, "每日用量下方有两张并排卡片", JSON.stringify(sideCharts.titles));
  const [SC1, SC2] = sideCharts.rects;
  ok(SC1 && SC2 && SC1.right <= SC2.left + 1 && Math.abs(SC1.top - SC2.top) < 4, "两张图水平并排（不是上下）", JSON.stringify(sideCharts.rects));
  ok(sideCharts.hourCols === 24, "时刻分析有 24 个小时柱", String(sideCharts.hourCols));
  ok(sideCharts.peak === 1, "最活跃时段被高亮", String(sideCharts.peak));
  ok(/\d+:00/.test(sideCharts.hourTip), "时刻柱带原生 title tooltip（跟随鼠标）", sideCharts.hourTip.replace(/\n/g, " | "));
  ok(/^[\d.,]+\s*[KMB]?$/.test(sideCharts.hourPeakValue), "最大柱顶显示 Token 数值标签", sideCharts.hourPeakValue);
  ok(sideCharts.hourChips.length === 2 && sideCharts.hourChips[0].active && sideCharts.hourChips[0].measure === "tokens", "时刻图默认 measure = Tokens（chips: Tokens / 轮次）", JSON.stringify(sideCharts.hourChips));
  ok(sideCharts.hourLegend.length === 3 && sideCharts.hourLegend.every((text) => !/[()（）]/.test(text)), "图例只说明颜色（Token 产出 / 人类消息密度 / 峰值，无括号解释）", JSON.stringify(sideCharts.hourLegend));
  ok(sideCharts.hourHint === 0, "时刻分析卡片标题下没有小标题", String(sideCharts.hourHint));
  ok(sideCharts.hourDots.every((dot) => dot.topInset >= 13.5) && sideCharts.hourDots.every((dot) => dot.diameter <= 17.4), "密度点上沿留白 ≥14px、最大圆完整", JSON.stringify(sideCharts.hourDots.slice(0, 2)));
  // 柱/标签索引对齐：第 i 根柱的标签、tooltip 小时都必须是 i（防"柱画在 i、标签写着 i+1"这类渲染错位）
  const hourAlign = await page.evaluate(() => {
    const cols = [...document.querySelectorAll(".wl-hour-col")];
    return cols.map((col, index) => ({
      index,
      label: (col.querySelector(".wl-hour-label")?.textContent ?? "").trim(),
      tooltipHour: Number.parseInt((col.getAttribute("title") ?? "").split(":")[0], 10),
      fill: Math.round((col.querySelector(".wl-hour-fill")?.getBoundingClientRect().height ?? 0) * 10) / 10,
      peak: col.hasAttribute("data-peak"),
    }));
  });
  const misaligned = hourAlign.filter((col) => col.label !== String(col.index) || col.tooltipHour !== col.index);
  ok(
    hourAlign.length === 24 && misaligned.length === 0,
    "时刻柱与 0–23 标签逐柱对齐（第 i 根柱的标签与 tooltip 小时都为 i）",
    JSON.stringify(misaligned.slice(0, 3)),
  );
  const peakCols = hourAlign.filter((col) => col.peak);
  const tallest = hourAlign.reduce((best, col) => (col.fill > best.fill ? col : best), { fill: -1, index: -1 });
  ok(
    peakCols.length === 1 && tallest.fill > 0 && peakCols[0].index === tallest.index,
    "高亮小时柱就是填充最高的那根（峰位与柱高一致）",
    JSON.stringify({ peak: peakCols.map((col) => col.index), tallest: tallest.index }),
  );
  ok(sideCharts.pieSlices >= 2 && sideCharts.pieLegend.length >= 2, "工作区环形图有扇区与图例", JSON.stringify(sideCharts.pieLegend));

  // 环形图切换 按时长 / 按 Token
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-grid-2 > .wl-pie-card .wl-card-head .wl-chip")].find((node) => /Token/i.test(node.textContent || ""));
    chip?.click();
  });
  await sleep(800);
  const pieAfter = await page.evaluate(() => ({
    center: document.querySelector(".wl-pie-wrap svg text")?.textContent ?? "",
    active: document.querySelector(".wl-grid-2 > .wl-pie-card .wl-card-head .wl-chip[data-active='true']")?.textContent ?? "",
  }));
  ok(/Token/i.test(pieAfter.active), "环形图可切到「按 Token」", JSON.stringify(pieAfter));

  // ---- 明细默认折叠 ----
  const details = await page.evaluate(() => {
    const node = document.querySelector("details.wl-details");
    return node === null ? null : { open: node.hasAttribute("open"), summary: node.querySelector("summary")?.textContent ?? "", rows: node.querySelectorAll("tbody tr").length };
  });
  ok(details !== null && details.open === false, "按日期明细默认折叠", JSON.stringify(details));
  ok(/明细|detail/i.test(details?.summary ?? ""), "折叠标题写明是明细", details?.summary);
  // ---- 模型区块：独立页签「模型用量」——treemap + 联动筛选 + 官方计费链接 ----
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /模型用量|Model usage/.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(600);
  // 模型维度是后台渐进回填的（要读事件日志），所以先等模型表出现
  await page.waitForFunction(() => document.querySelectorAll(".wl-model-table tbody tr").length > 0, { timeout: 900000 });
  const modelBlock = await page.evaluate(() => ({
    // 卡片头与其它卡一致：有「模型用量」标题，控件在右上
    cardTitle: [...document.querySelectorAll(".wl-card-head h3")].map((n) => n.textContent || "").find((text) => /模型用量|Model usage/.test(text)) ?? null,
    headChips: document.querySelectorAll(".wl-card-head .wl-chips .wl-chip").length,
    // 界面语言可能是中文或英文，两种都要认
    treemapTitle: [...document.querySelectorAll(".wl-card h4")].map((n) => n.textContent || "").some((text) => /模型占比|Model share/.test(text)),
    tiles: document.querySelectorAll('rect[data-kind="model"]').length,
    others: document.querySelectorAll('rect[data-kind="others"]').length,
    rows: document.querySelectorAll(".wl-model-table tbody tr").length,
    links: [...document.querySelectorAll(".wl-hint a")].map((a) => a.getAttribute("href") ?? ""),
    costs: [...document.querySelectorAll(".wl-model-table tbody tr")].map((tr) => tr.lastElementChild?.textContent ?? ""),
    hits: [...document.querySelectorAll(".wl-model-table tbody tr")].map((tr) => tr.children[6]?.textContent ?? ""),
    trendBars: document.querySelectorAll(".wl-model-grid svg rect").length,
    trendLabels: [...document.querySelectorAll(".wl-model-grid svg text")].map((n) => n.textContent ?? "").filter((x) => /\d\d-\d\d/.test(x)).length,
  }));
  ok(modelBlock.cardTitle !== null && modelBlock.headChips === 3, "模型卡片头与其它卡一致（标题 + 右上 3 个 chips）", JSON.stringify({ title: modelBlock.cardTitle, chips: modelBlock.headChips }));
  ok(modelBlock.treemapTitle, "treemap 带小标题「模型占比 · 面积 = Token」");
  ok(modelBlock.tiles > 0, "模型 treemap 渲染出矩形", String(modelBlock.tiles));
  ok(modelBlock.rows > 0, "模型明细表有数据行", String(modelBlock.rows));
  ok(modelBlock.trendBars > 0, "按日模型趋势有柱子", String(modelBlock.trendBars));
  ok(modelBlock.trendLabels > 0, "趋势图带日期刻度", String(modelBlock.trendLabels));
  ok(modelBlock.links.some((href) => /deepseek/.test(href)), "给出 DeepSeek 官方计费链接", JSON.stringify(modelBlock.links));
  ok(modelBlock.links.some((href) => /kimi|moonshot/i.test(href)), "给出 Kimi 官方计费链接（无官方价也保留链接）", JSON.stringify(modelBlock.links));
  ok(modelBlock.costs.some((text) => /[\u00a5$]/.test(text)), "DeepSeek 模型显示费用估算", JSON.stringify(modelBlock.costs));
  ok(modelBlock.hits.some((text) => /%/.test(text)), "模型明细含缓存命中率", JSON.stringify(modelBlock.hits));

  // —— 问题 2：回填完成后「正在回填」提示必须消失，模型数据留在页面上 ——
  await page.waitForFunction(() => document.querySelector('[data-kind="model-folding"]') === null, { timeout: 300000 }).catch(() => {});
  const foldGone = await page.evaluate(() => ({
    folding: document.querySelector('[data-kind="model-folding"]') === null,
    rows: document.querySelectorAll(".wl-model-table tbody tr").length,
    emptyNotice: [...document.querySelectorAll(".wl-card p")].some((n) => /正在回填|Filling in model/.test(n.textContent || "")),
  }));
  ok(foldGone.folding && !foldGone.emptyNotice && foldGone.rows > 0, "回填提示已消失且模型区有数据（不再常驻）", JSON.stringify(foldGone));

  // —— 问题 3：treemap 必须铺满容器（左右留白 ≤ 8px）——
  const treemapGeometry = await page.evaluate(() => {
    const box = document.querySelector('[data-kind="model-treemap"]');
    const rects = [...document.querySelectorAll('rect[data-kind="model"], rect[data-kind="others"]')];
    if (box === null || rects.length === 0) return null;
    const b = box.getBoundingClientRect();
    const lefts = rects.map((r) => r.getBoundingClientRect().left);
    const rights = rects.map((r) => r.getBoundingClientRect().right);
    const round = (v) => Math.round(v * 10) / 10;
    return {
      gapLeft: round(Math.min(...lefts) - b.left),
      gapRight: round(b.right - Math.max(...rights)),
      boxW: Math.round(b.width),
      boxH: Math.round(b.height),
    };
  });
  ok(
    treemapGeometry !== null && treemapGeometry.gapLeft <= 8 && treemapGeometry.gapRight <= 8,
    "treemap 矩形铺满容器（左右留白 ≤ 8px）",
    JSON.stringify(treemapGeometry),
  );
  // 点击第一个模型 → 右侧趋势被筛选（出现清除按钮 + 选中态）
  const trendBefore = await page.evaluate(() => ({
    segments: document.querySelectorAll(".wl-model-grid > div:nth-child(2) svg rect").length,
    clear: [...document.querySelectorAll(".wl-chip")].filter((n) => /清除|Clear/.test(n.textContent || "")).length,
  }));
  await page.evaluate(() => {
    const tile = document.querySelector('rect[data-kind="model"]');
    tile?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(1000);
  const trendAfter = await page.evaluate(() => ({
    segments: document.querySelectorAll(".wl-model-grid > div:nth-child(2) svg rect").length,
    clear: [...document.querySelectorAll(".wl-chip")].filter((n) => /清除|Clear/.test(n.textContent || "")).length,
    selectedStroke: [...document.querySelectorAll('rect[data-kind="model"]')].map((r) => Number(r.getAttribute("stroke-width"))).filter((w) => w > 1).length,
    dimmed: [...document.querySelectorAll('rect[data-kind="model"] ~ *')].length,
  }));
  ok(trendBefore.clear === 0, "筛选前没有「清除筛选」按钮", JSON.stringify(trendBefore));
  ok(trendAfter.clear === 1, "点击模型后出现「清除筛选」", JSON.stringify(trendAfter));
  ok(trendAfter.selectedStroke >= 1, "被选中的模型有明显选中态（描边加粗）", JSON.stringify(trendAfter));
  ok(trendAfter.segments <= trendBefore.segments, "右侧趋势按选中模型收窄", trendBefore.segments + "→" + trendAfter.segments);
  // 清除筛选
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-chip")].find((n) => /清除|Clear/.test(n.textContent || ""));
    chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await sleep(600);
  const cleared = await page.evaluate(() => [...document.querySelectorAll(".wl-chip")].filter((n) => /清除|Clear/.test(n.textContent || "")).length);
  ok(cleared === 0, "清除筛选后回到全部模型", String(cleared));

  // 回到「按日期」再截图（首页＝每日趋势 + 模型 Token 占比环形图）
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /按日期|By date/.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(900);
  // —— 问题 1：环形图卡被上一行等高拉伸时，图形区必须在卡内上下居中（上下留白差 ≤ 2px）——
  const pieGeometry = await page.evaluate(() => {
    const card = document.querySelector(".wl-pie-card");
    if (card === null) return null;
    const svg = card.querySelector(".wl-pie-wrap svg");
    const hint = card.querySelector(".wl-hint");
    if (svg === null) return null;
    const style = getComputedStyle(card);
    const contentBottom = card.getBoundingClientRect().bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
    const rect = svg.getBoundingClientRect();
    // 上留白从说明文字下沿算起；hint 的下边距已归零，两端口径一致
    const above = hint === null ? rect.top - card.getBoundingClientRect().top : rect.top - hint.getBoundingClientRect().bottom;
    const below = contentBottom - rect.bottom;
    const round = (v) => Math.round(v * 10) / 10;
    return { above: round(above), below: round(below), diff: round(Math.abs(above - below)), cardH: Math.round(card.getBoundingClientRect().height) };
  });
  ok(
    pieGeometry !== null && pieGeometry.diff <= 2,
    "首页「模型 Token 占比」环形图在卡内上下居中（上下留白差 ≤ 2px）",
    JSON.stringify(pieGeometry),
  );
  await page.screenshot({ path: join(ARTIFACTS, "02-dashboard-by-day.png") });

  // 切到「按工作区」
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /按工作区|By workspace/.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(1200);
  const workspaceRows = await page.evaluate(() => document.querySelectorAll(".wl-bars li").length);
  ok(workspaceRows > 0, "按工作区有排行数据", String(workspaceRows));
  // 每行必须是"左付出 / 右消耗"两块，而不是上下两行
  const metrics = await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".wl-bars li")];
    const first = rows[0];
    if (!first) return null;
    const blocks = [...first.querySelectorAll(".wl-metric")];
    const labels = blocks.map((b) => b.querySelector(".wl-metric-label")?.textContent ?? "");
    const subs = blocks.map((b) => b.querySelector(".wl-metric-sub")?.textContent ?? "");
    const values = blocks.map((b) => b.querySelector(".wl-metric-value")?.textContent ?? "");
    const widths = blocks.map((b) => Math.round(b.querySelector(".wl-bar-fill")?.getBoundingClientRect().width ?? 0));
    const rects = blocks.map((b) => {
      const r = b.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });
    return { count: blocks.length, labels, subs, values, widths, rects, rows: rows.length, perRow: rows.map((r) => r.querySelectorAll(".wl-metric").length) };
  });
  ok(metrics !== null && metrics.count === 2, "每行两块指标（付出 / 消耗）", JSON.stringify(metrics?.labels));
  ok(metrics?.perRow.every((n) => n === 2), "所有工作区行都是两块", JSON.stringify(metrics?.perRow));
  const labelsPerRow = await page.evaluate(() => document.querySelectorAll(".wl-bars .wl-metric-label").length);
  ok(labelsPerRow === 0, "每行不再重复「我的付出 / Token 消耗」标签", String(labelsPerRow));
  const headLabels = await page.evaluate(() => [...document.querySelectorAll(".wl-metrics-head span")].map((n) => n.textContent));
  ok(headLabels.length === 2 && /付出|effort/i.test(headLabels[0] ?? "") && /Token/i.test(headLabels[1] ?? ""), "顶部只出现一次列头", JSON.stringify(headLabels));
  const [L, R] = metrics?.rects ?? [];
  ok(L && R && L.right <= R.left + 1, "两块确实是左右并排（左边右边界 ≤ 右边左边界）", `L.right=${L?.right} R.left=${R?.left}`);
  ok(L && R && Math.abs((L.top + L.bottom) / 2 - (R.top + R.bottom) / 2) < 6, "两块在同一水平线上（不是上下两行）", `top差=${Math.abs((L?.top ?? 0) - (R?.top ?? 0))}`);
  // 界面语言可能是中文或英文，两种都要认
  const effortSub = metrics?.subs[0] ?? "";
  ok(/\d+\s*\/\s*\d+/.test(effortSub) && /(天|days)/i.test(effortSub), "左块小字含「活跃 N/M 天」", effortSub);
  ok(/输出|output/i.test(metrics?.subs[1] ?? ""), "右块小字含「输出 Token」", metrics?.subs[1]);
  ok((metrics?.widths[0] ?? 0) > 0 || (metrics?.widths[1] ?? 0) > 0, "两条 bar 实际渲染出宽度", JSON.stringify(metrics?.widths));
  // 左栏是时长（小写 h/m/s），右栏是 Token（K/M/B 缩写或整数）——两栏口径不同，不能都按 h/m/s 断言
  ok(
    // 值文本是「数值 + 占比」直接拼接（如 "77.12 h40.9%"），单位后面没有词边界，不能用 \b
    /\d\s*[hms]/i.test(metrics?.values?.[0] ?? "") && (/[KMB]/i.test(metrics?.values?.[1] ?? "") || /\d{4,}/.test(metrics?.values?.[1] ?? "")),
    "工作区数值：左栏时长用小写 h/m/s、右栏 Token 用 K/M/B",
    JSON.stringify(metrics?.values),
  );
  const headers = await page.evaluate(() => [...document.querySelectorAll(".wl-card table th")].map((n) => n.textContent));
  ok(headers.some((text) => /活跃天数|Active days/.test(text ?? "")) && headers.some((text) => /Token 占比|Token share/.test(text ?? "")), "表格含活跃天数与 Token 占比列", JSON.stringify(headers.slice(0, 12)));
  await page.screenshot({ path: join(ARTIFACTS, "03-dashboard-by-workspace.png") });

  // 切到「主要会话」
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /主要会话|Top sessions/.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(1200);
  const sessionRows = await page.evaluate(() => document.querySelectorAll(".wl-card .wl-table tbody tr").length);
  ok(sessionRows > 0, "主要会话有数据", String(sessionRows));
  await page.screenshot({ path: join(ARTIFACTS, "04-dashboard-by-session.png") });

  // 切换范围到「近 90 天」，验证会重新拉数据
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-chip")].find((node) => /近 90 天|Last 90/.test(node.textContent || ""));
    chip?.click();
  });
  // 换区间会先出骨架屏：等骨架消失再读标题（固定 sleep 在慢快照下会读到「加载中」的副标题）
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 }).catch(() => {});
  await sleep(600);
  const rangeText = await page.evaluate(() => document.querySelector(".wl-subtitle")?.textContent ?? "");
  ok(rangeText.includes("~"), "切换范围后标题显示区间", rangeText);

  // 「全部」档：区间起点＝最早活跃日，活跃天数分母不是 3650
  await page.evaluate(() => {
    const chip = [...document.querySelectorAll(".wl-head .wl-chip")].find((node) => /全部|All time/i.test(node.textContent || ""));
    chip?.click();
  });
  await page.waitForFunction(() => document.querySelector("[data-kind=skeleton]") === null, { timeout: 60000 }).catch(() => {});
  await sleep(1000);
  const allTime = await page.evaluate(() => ({
    kpis: [...document.querySelectorAll(".wl-kpi-value")].map((n) => n.textContent),
    subtitle: document.querySelector(".wl-subtitle")?.textContent ?? "",
  }));
  const denominator = Number((allTime.kpis[3] ?? "").replace(/[^\d/]/g, "").split("/")[1] ?? "0");
  ok(denominator > 0 && denominator < 400, "「全部」档活跃天数分母＝真实历史跨度（不是 3650）", allTime.kpis[3]);
  ok(/2026-0[89]/.test(allTime.subtitle), "「全部」档区间从最早活跃日开始", allTime.subtitle);

  // 导出 HTML 报告（直接访问路由，等价于按钮行为）
  const reportPage = await browser.newPage();
  await reportPage.setViewport({ width: 1240, height: 1400, deviceScaleFactor: 2 });
  const reportUrl = `${URL_BASE}/workload-report/v1/report.html?days=90&tz=Asia%2FShanghai&theme=light&title=%E5%B7%A5%E4%BD%9C%E9%87%8F%E6%8A%A5%E5%91%8A`;
  const response = await reportPage.goto(reportUrl, { waitUntil: "networkidle2", timeout: 60000 });
  ok(response?.status() === 200, "报告页返回 200", String(response?.status()));
  const reportText = await reportPage.evaluate(() => document.body.innerText.slice(0, 400));
  ok(/工作量报告/.test(reportText), "报告页渲染标题");
  ok(!/总 Token\s*\n?\s*0\b/.test(reportText) && /[KMB]/.test(reportText), "报告页 Token 非零", reportText.replace(/\n/g, " ").slice(0, 160));
  ok(!/加载失败|Failed/.test(reportText), "报告页无错误");

  // —— 问题 4：导出报告与看板对齐（模型用量一节 + 模型费用 KPI + 去折线 / 周末异色）——
  const reportDom = await reportPage.evaluate(() => {
    const treemap = document.querySelector("svg.treemap");
    const parent = treemap?.parentElement ?? null;
    const round = (v) => Math.round(v * 10) / 10;
    return {
      text: document.body.innerText,
      kpis: [...document.querySelectorAll(".kpi .label")].map((n) => n.textContent || ""),
      hasTreemap: treemap !== null,
      treemapGap: treemap === null || parent === null ? null : {
        left: round(treemap.getBoundingClientRect().left - parent.getBoundingClientRect().left),
        right: round(parent.getBoundingClientRect().right - treemap.getBoundingClientRect().right),
      },
      polylines: document.querySelectorAll("polyline").length,
      scripts: document.querySelectorAll("script").length,
      styles: document.querySelectorAll("style").length,
      links: [...document.querySelectorAll("a")].map((n) => n.getAttribute("href") ?? "").filter((href) => /^https?:/.test(href)),
      weekendBars: [...document.querySelectorAll("svg rect")].filter((r) => (r.getAttribute("fill") ?? "").toLowerCase() === "#f59e0b").length,
      modelRows: [...document.querySelectorAll("table tbody tr")].length,
    };
  });
  ok(/模型用量/.test(reportDom.text), "报告含「模型用量」一节（模型区不再为空）");
  ok(reportDom.kpis.some((text) => /模型费用/.test(text)), "报告 KPI 含「模型费用」", JSON.stringify(reportDom.kpis));
  ok(reportDom.hasTreemap && reportDom.treemapGap !== null && reportDom.treemapGap.left <= 8 && reportDom.treemapGap.right <= 8, "报告含铺满容器的 treemap", JSON.stringify(reportDom.treemapGap));
  ok(reportDom.polylines === 0, "报告每日趋势无折线（与看板一致）", String(reportDom.polylines));
  ok(reportDom.weekendBars > 0, "报告每日趋势有周末异色柱", String(reportDom.weekendBars));
  ok(reportDom.scripts === 0 && reportDom.links.every((href) => /deepseek|kimi|moonshot|claude/.test(href)), "报告保持自包含（无脚本；外链仅官方计费页）", JSON.stringify(reportDom.links));
  await reportPage.screenshot({ path: join(ARTIFACTS, "05-report-light.png"), fullPage: true });

  const darkResponse = await reportPage.goto(reportUrl.replace("theme=light", "theme=dark"), { waitUntil: "networkidle2", timeout: 60000 });
  ok(darkResponse?.status() === 200, "深色报告页返回 200");
  await reportPage.screenshot({ path: join(ARTIFACTS, "06-report-dark.png"), fullPage: true });

  // ---- 状态行三态 DOM 断言：first-fold / background / idle（拦截快照，只改 diagnostics）----
  // 回到「按日」页签（时刻分析卡在这里），并取一张真实快照作为底稿。
  await page.evaluate(() => {
    const tab = [...document.querySelectorAll(".wl-tab")].find((node) => /按日|By day/i.test(node.textContent || ""));
    tab?.click();
  });
  await sleep(1200);
  const snapshotUrl = await page.evaluate(() => {
    const entries = performance.getEntriesByType("resource").map((entry) => entry.name).filter((name) => name.includes("/workload-report/v1/snapshot"));
    return entries[entries.length - 1] ?? null;
  });
  ok(typeof snapshotUrl === "string", "找到看板的快照请求 URL", String(snapshotUrl));
  const realSnapshot = await page.evaluate(async (url) => (await fetch(url)).json(), snapshotUrl);
  let fakeStatus = null;
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const isSnapshot = request.url().includes("/workload-report/v1/snapshot");
    if (fakeStatus === null || !isSnapshot) {
      void request.continue();
      return;
    }
    const body = JSON.parse(JSON.stringify(realSnapshot));
    body.diagnostics = {
      ...body.diagnostics,
      modelFold: {
        ...body.diagnostics.modelFold,
        phase: fakeStatus.phase,
        running: fakeStatus.running,
        pending: fakeStatus.pending,
        failedRows: fakeStatus.failedRows,
      },
      hourTokensSource: { ...(body.diagnostics.hourTokensSource ?? {}), missing: fakeStatus.missing },
    };
    void request.respond({ status: 200, contentType: "application/json; charset=utf-8", body: JSON.stringify(body) });
  });
  const clickRefresh = async () => {
    await page.evaluate(() => {
      const button = [...document.querySelectorAll(".wl-head .wl-btn")].find((node) => /刷新|Refresh/i.test(node.textContent || ""));
      button?.click();
    });
  };
  const statusCase = async (name, status, selectorState, expectedText, shot) => {
    fakeStatus = status;
    await clickRefresh();
    await page.waitForFunction(
      (state) => document.querySelector('[data-kind="hour-tokens-missing"]')?.getAttribute("data-state") === state,
      { timeout: 20000 },
      selectorState,
    ).catch(() => {});
    const dom = await page.evaluate(() => {
      const node = document.querySelector('[data-kind="hour-tokens-missing"]');
      const style = node === null ? null : getComputedStyle(node);
      return {
        state: node?.getAttribute("data-state") ?? null,
        text: node?.textContent ?? null,
        color: style?.color ?? null,
        before: node === null ? null : getComputedStyle(node, "::before").content,
      };
    });
    ok(dom.state === selectorState && (dom.text ?? "").includes(expectedText), `状态行三态：${name}`, JSON.stringify(dom));
    if (shot !== null) await page.screenshot({ path: join(ARTIFACTS, shot) });
    return dom;
  };
  const firstFoldDom = await statusCase("first-fold", { phase: "first-fold", running: true, pending: 3, failedRows: 0, missing: 0 }, "first-fold", "正在计算", "07-status-first-fold.png");
  const backgroundDom = await statusCase("background", { phase: "background", running: true, pending: 0, failedRows: 2, missing: 5 }, "background", "后台更新中", "08-status-background.png");
  const idleDom = await statusCase("idle", { phase: "idle", running: false, pending: 0, failedRows: 4, missing: 3 }, "idle", "Token 未计入 3 个会话", "09-status-idle.png");
  ok(firstFoldDom.color !== idleDom.color, "first-fold 用强调色，与 idle 的 muted 不同", `${firstFoldDom.color} vs ${idleDom.color}`);
  ok(backgroundDom.before !== null && backgroundDom.before !== "none", "background 带灰点（::before）", String(backgroundDom.before));
  ok(idleDom.text.includes("未计入"), "失败行不阻塞：idle 仍只显示「未计入 N 个会话」", String(idleDom.text));
  // idle + N=0：整条不渲染
  fakeStatus = { phase: "idle", running: false, pending: 0, failedRows: 6, missing: 0 };
  await clickRefresh();
  await page.waitForFunction(() => document.querySelector('[data-kind="hour-tokens-missing"]') === null, { timeout: 20000 }).catch(() => {});
  ok((await page.evaluate(() => document.querySelector('[data-kind="hour-tokens-missing"]') === null)), "idle + N=0：状态行整条不渲染（失败行不会让它变成计算中）");

  // API 自检
  const apiResult = await page.evaluate(async () => {
    const response = await fetch("/workload-report/v1/snapshot?days=30&scope=all&tz=Asia%2FShanghai");
    const json = await response.json();
    return { status: response.status, sessions: json.totals?.sessions, conversations: json.totals?.conversations, workspaces: json.byWorkspace?.length, diagnostics: json.diagnostics };
  });
  ok(apiResult.status === 200, "接口 /snapshot 200");
  ok(apiResult.sessions > 0, "接口返回真实会话数", JSON.stringify(apiResult));

  const realErrors = consoleErrors.filter((text) => !/favicon|ResizeObserver|Download the React DevTools/i.test(text));
  ok(realErrors.length === 0, "无控制台错误", realErrors.slice(0, 3).join(" | "));
} catch (error) {
  failures += 1;
  console.error("✗ 运行异常:", error.message);
  await page.screenshot({ path: join(ARTIFACTS, "99-failure.png") }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n截图目录: ${ARTIFACTS}`);
console.log(failures === 0 ? "E2E 全部通过 ✓" : `E2E ${failures} 项失败 ✗`);
process.exit(failures === 0 ? 0 : 1);
