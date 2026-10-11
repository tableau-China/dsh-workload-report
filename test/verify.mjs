// 离线验证：不依赖 DSH 实例，直接验证聚合口径、报告渲染与宿主路由行为。
// 用法：node test/verify.mjs

import { readFile, rm } from "node:fs/promises";

import { aggregate, dateKey, present, resolveRange, rowFromSession, workspaceLabel } from "../src/aggregate.js";
import { formatDuration, formatTokens, escapeHtml } from "../src/format.js";
import { renderReport } from "../src/report-html.js";

let failures = 0;
const ok = (condition, label, detail = "") => {
  if (condition) {
    console.log(`✓ ${label}`);
  } else {
    failures += 1;
    console.error(`✗ ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
};
const eq = (actual, expected, label) => ok(Object.is(actual, expected), label, `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);

// ---------------------------------------------------------------- 造数据
/** 造一条会话行。 */
function makeRow({ id, cwd, createdAt, turns = 1, steps = 2, llmMs = 1000, toolMs = 500, input = 10, output = 20, cacheRead = 30, isSubagent = false, title = "" }) {
  return {
    id, cwd, createdAt, title, isSubagent, isSeeded: false, agentPreset: "", turns, steps, llmMs, toolMs,
    decodeTokens: output, asOfSeq: null,
    tokens: { input, output, cacheRead, cacheWrite: 0 },
  };
}

const HOUR = 3600000;
const base = Date.parse("2026-10-10T02:00:00Z"); // 北京时间 10:00
const rows = [
  makeRow({ id: "a", cwd: "/Users/me/proj-a", createdAt: base, turns: 3, steps: 5, llmMs: 2 * HOUR, toolMs: 1 * HOUR, input: 100, output: 200, cacheRead: 1000, title: "会话 A" }),
  makeRow({ id: "b", cwd: "/Users/me/proj-a", createdAt: base - 24 * HOUR, turns: 1, steps: 1, llmMs: 1 * HOUR, toolMs: 0, input: 10, output: 50, cacheRead: 500, title: "会话 B" }),
  makeRow({ id: "c", cwd: "/Users/me/proj-b", createdAt: base - 48 * HOUR, turns: 2, steps: 4, llmMs: 30 * 60000, toolMs: 30 * 60000, input: 0, output: 0, cacheRead: 0, title: "会话 C" }),
  makeRow({ id: "d", cwd: "", createdAt: base, turns: 0, steps: 0, llmMs: 0, toolMs: 0, input: 0, output: 0, cacheRead: 0, title: "" }),
  makeRow({ id: "e", cwd: "/Users/me/proj-a", createdAt: base, turns: 2, steps: 3, llmMs: 4 * HOUR, toolMs: 2 * HOUR, input: 7, output: 9, cacheRead: 11, isSubagent: true, title: "子代理" }),
];

// ---------------------------------------------------------------- 聚合
console.log("\n—— 聚合口径 ——");
const snapshot = present(aggregate(rows, { days: 30, timeZone: "Asia/Shanghai", now: base }));
eq(snapshot.totals.sessions, 5, "会话总数 5");
eq(snapshot.totals.conversations, 4, "对话次数 4（零步会话不计）");
eq(snapshot.totals.emptySessions, 1, "空会话 1");
eq(snapshot.totals.mainSessions, 4, "主会话 4");
eq(snapshot.totals.subagentSessions, 1, "子代理 1");
eq(snapshot.totals.turns, 8, "轮次合计 8");
eq(snapshot.totals.steps, 13, "步骤合计 13");
eq(snapshot.totals.llmMs, 7.5 * HOUR, "模型时间 7.5h");
eq(snapshot.totals.toolMs, 3.5 * HOUR, "工具时间 3.5h");
eq(snapshot.totals.activeMs, 11 * HOUR, "活跃时长 = 模型 7.5h + 工具 3.5h = 11h");
eq(snapshot.totals.tokens.input, 117, "输入 token 合计");
eq(snapshot.totals.tokens.output, 259, "输出 token 合计");
eq(snapshot.totals.tokens.cacheRead, 1511, "缓存读取合计");
eq(snapshot.totals.tokensTotal, 1887, "Token 合计");
eq(snapshot.totals.activeDays, 3, "活跃天数 3");
eq(snapshot.totals.workspaces, 2, "覆盖工作区 2（空 cwd 的未知桶不计入 KPI）");

console.log("\n—— 排序与占比 ——");
eq(snapshot.byWorkspace[0].key, "/Users/me/proj-a", "工作区按活跃时长排序，proj-a 第一");
eq(snapshot.byWorkspace[0].label, "proj-a", "工作区显示名取目录名");
const shareSum = snapshot.byWorkspace.reduce((sum, item) => sum + item.activeShare, 0);
ok(Math.abs(shareSum - 1) < 1e-9, "工作区时长占比之和为 1", `实际 ${shareSum}`);
ok(snapshot.byWorkspace.some((item) => item.key === "(unknown)"), "空 cwd 的会话仍出现在按工作区明细里");
const projA = snapshot.byWorkspace.find((item) => item.key === "/Users/me/proj-a");
eq(projA.activeDays, 2, "proj-a 活跃天数 2（10-09 与 10-10 各一条会话）");
eq(snapshot.byWorkspace.find((item) => item.key === "/Users/me/proj-b").activeDays, 1, "proj-b 活跃天数 1");
eq(snapshot.byWorkspace.find((item) => item.key === "(unknown)").activeDays, 1, "未知工作区活跃天数 1");
ok(snapshot.byWorkspace.every((item) => item.activeDays <= item.sessions), "活跃天数不超过会话数");
const narrowRange = present(aggregate(rows, { days: 1, timeZone: "Asia/Shanghai", now: base }));
eq(narrowRange.byWorkspace.find((item) => item.key === "/Users/me/proj-a").activeDays, 1, "收窄区间后活跃天数随之减少（10-09 被排除）");
ok(projA.lastUsedAt > 0, "工作区带最近使用时间（用于行首展示）");
ok(projA.tokenShare > 0 && projA.activeShare > 0, "工作区带 Token 占比与时长占比（两条 bar 共用口径）");

console.log("\n—— 范围筛选 ——");
const mainOnly = present(aggregate(rows, { days: 30, timeZone: "Asia/Shanghai", scope: "main", now: base }));
eq(mainOnly.totals.sessions, 4, "仅主会话：4");
eq(mainOnly.totals.activeMs, 5 * HOUR, "仅主会话活跃时长 5h");
const subOnly = present(aggregate(rows, { days: 30, timeZone: "Asia/Shanghai", scope: "subagent", now: base }));
eq(subOnly.totals.sessions, 1, "仅子代理：1");
eq(subOnly.totals.activeMs, 6 * HOUR, "仅子代理活跃时长 6h");

console.log("\n—— 时刻分析（byHour）——");
const withWindow = rows.map((row) => ({ ...row, lastPromptAt: row.createdAt + 2 * HOUR }));
const hourSnap = present(aggregate(withWindow, { days: 30, timeZone: "Asia/Shanghai", now: base }));
eq(hourSnap.byHour.length, 24, "24 个小时桶");
eq(hourSnap.byHour[0].hour, 0, "第 1 个桶是 0 点");
const hourTotal = hourSnap.byHour.reduce((sum, bucket) => sum + bucket.activeMs, 0);
ok(Math.abs(hourTotal - hourSnap.totals.activeMs) < 1, "分摊后活跃时长守恒", `${hourTotal} vs ${hourSnap.totals.activeMs}`);
const hour10 = hourSnap.byHour[10];
ok(hour10.starts >= 3, "10:00 开始的会话 ≥ 3（base = 北京 10:00）", String(hour10.starts));
ok(hour10.activeMs > 0, "10 点分摊到活跃时长");
const noWindowSnap = present(aggregate(rows, { days: 30, timeZone: "Asia/Shanghai", now: base }));
ok(Math.abs(noWindowSnap.byHour.reduce((sum, bucket) => sum + bucket.activeMs, 0) - noWindowSnap.totals.activeMs) < 1, "没有 lastPromptAt 时也守恒（落在开始小时）");
// lastPromptAt 解析（wire 形状）
const metaRow = rowFromSession({ id: "m", createdAt: base, cwd: "/tmp/x", isSeeded: false }, { sessionListMetadata: { blank: false, lastPromptAt: base + 3600000 } });
eq(metaRow.lastPromptAt, base + 3600000, "sessionListMetadata.lastPromptAt 被识别");

console.log("\n—— 「全部」从最早活跃日算起 ——");
const allSnap = present(aggregate(rows, { all: true, timeZone: "Asia/Shanghai", now: base }));
eq(allSnap.range.from, dateKey(Math.min(...rows.map((row) => row.createdAt)), "Asia/Shanghai"), "全部档的起点＝最早的活跃日（不再是 3650 天前）");
eq(allSnap.range.to, dateKey(base, "Asia/Shanghai"), "全部档的终点＝今天");
ok(allSnap.range.days < 30 && allSnap.range.days >= 3, "全部档跨度＝真实历史长度（本例 3 天）", String(allSnap.range.days));
eq(allSnap.totals.sessions, 5, "全部档仍然包含所有会话");

console.log("\n—— 日历数据源（不受日期筛选影响）——");
const narrowDays = present(aggregate(rows, { days: 1, timeZone: "Asia/Shanghai", now: base }));
ok(narrowDays.byDay.length === 1, "近 1 天的 byDay 只有 1 天");
ok(narrowDays.calendar.days.length === 3, "同一次请求里 calendar 仍返回全部 3 个有记录的日子", String(narrowDays.calendar.days.length));
eq(narrowDays.calendar.from, allSnap.range.from, "calendar.from ＝最早活跃日");
eq(narrowDays.calendar.to, dateKey(base, "Asia/Shanghai"), "calendar.to ＝今天");
eq(narrowDays.calendar.days.reduce((sum, day) => sum + day.sessions, 0), 5, "calendar 覆盖全部会话");
const scopedCalendar = present(aggregate(rows, { all: true, scope: "main", timeZone: "Asia/Shanghai", now: base }));
eq(scopedCalendar.calendar.days.reduce((sum, day) => sum + day.sessions, 0), 4, "calendar 尊重 scope（仅主会话 4 个）");

console.log("\n—— 长区间（「全部」）不截断近期数据 ——");
const longRange = present(aggregate(rows, { days: 3650, timeZone: "Asia/Shanghai", now: base }));
eq(longRange.range.days > 3000, true, "全部区间跨度为 3650 天");
ok(longRange.byDay.length <= 400, "byDay 长度有上界", String(longRange.byDay.length));
ok(longRange.byDay.every((day) => day.sessions > 0), "长区间下 byDay 只含有活动的日子");
ok(longRange.byDay.some((day) => day.date === dateKey(base, "Asia/Shanghai")), "长区间下最近的活动日仍在列表里");
eq(longRange.totals.sessions, 5, "长区间合计与会话总数一致（不受展示截断影响）");
const shortRange = present(aggregate(rows, { days: 7, timeZone: "Asia/Shanghai", now: base }));
eq(shortRange.byDay.length, 7, "小区间补齐空白日（7 天 7 条）");

console.log("\n—— 时区归属 ——");
const edge = [makeRow({ id: "tz", cwd: "/tmp/x", createdAt: Date.parse("2026-10-09T16:30:00Z") })];
eq(dateKey(edge[0].createdAt, "Asia/Shanghai"), "2026-10-10", "UTC 16:30 = 北京 00:30 → 归属 10-10");
eq(dateKey(edge[0].createdAt, "UTC"), "2026-10-09", "同一时刻在 UTC 归属 10-09");
const shanghai = present(aggregate(edge, { days: 1, timeZone: "Asia/Shanghai", now: Date.parse("2026-10-10T03:00:00Z") }));
eq(shanghai.totals.sessions, 1, "近 1 天（北京）能取到该会话");
const utc = present(aggregate(edge, { days: 1, timeZone: "UTC", now: Date.parse("2026-10-10T03:00:00Z") }));
eq(utc.totals.sessions, 0, "近 1 天（UTC）取不到该会话");

console.log("\n—— 区间与别名 ——");
eq(JSON.stringify(resolveRange({ days: 7, now: Date.parse("2026-10-10T03:00:00Z"), timeZone: "UTC" })), JSON.stringify({ from: "2026-10-04", to: "2026-10-10" }), "近 7 天区间含今天");
eq(workspaceLabel("/Users/me/proj-a", { "proj-a": "零售订单系统" }), "零售订单系统", "别名优先");
eq(workspaceLabel("", {}), "(未知工作区)", "空 cwd 显示未知工作区");
eq(formatDuration(5400000), "1.5 H", "时长格式化（单位 H，去掉多余尾零）");
eq(formatDuration(10800000), "3 H", "整点时长不带小数");
eq(formatDuration(0), "0", "零时长");
eq(formatTokens(1500), "1.50 K", "Token 紧凑格式");

// ---------------------------------------------------------------- 报告
console.log("\n—— tokenUsage 两种形状都要认 ——");
const wireRow = rowFromSession(
  { id: "wire", createdAt: base, cwd: "/tmp/x", isSeeded: false },
  { sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 }, tokenUsage: { uncachedInputTokens: 11, outputTokens: 22, cacheReadTokens: 33, cacheWriteTokens: 44 }, title: "wire" },
  null,
);
eq(wireRow.tokens.input, 11, "wire view 形状（官方接口返回值）");
eq(wireRow.tokens.output, 22, "wire view 输出 token");
eq(wireRow.tokens.cacheRead, 33, "wire view 缓存读取");
eq(wireRow.tokens.cacheWrite, 44, "wire view 缓存写入");
const stateRow = rowFromSession(
  { id: "state", createdAt: base, cwd: "/tmp/x", isSeeded: false },
  { sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 }, tokenUsage: { totals: { uncachedInputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 }, last: null }, title: "state" },
  null,
);
eq(stateRow.tokens.input, 1, "持久化 state 形状（{ totals }）仍然兼容");
eq(stateRow.tokens.cacheWrite, 4, "state 形状缓存写入");

console.log("\n—— HTML 报告 ——");
const dirty = present(aggregate([makeRow({ id: "x", cwd: "/tmp/proj<img src=x onerror=alert(1)>", createdAt: base, title: "<img src=x onerror=alert(1)>" })], { days: 30, timeZone: "Asia/Shanghai", now: base }));
const html = renderReport(dirty, { theme: "dark", title: "测试报告", note: "给客户 <b>备注</b>" });
ok(html.startsWith("<!doctype html>"), "报告是完整 HTML 文档");
ok(!html.includes("<script>"), "报告不含 <script>");
ok(!html.includes("<img src=x") && html.includes("&lt;img src=x"), "标题里的标签被转义（文本保留、标签失效）");
ok(!html.includes("<img src=x") && html.includes("proj&lt;img src=x onerror=alert(1)&gt;"), "工作区名里的标签已转义（可读文本保留）");
ok(!html.includes("<img src=x"), "标题里的 HTML 已转义");
ok(html.includes("测试报告"), "标题写入报告");
ok(html.includes("&lt;b&gt;备注&lt;/b&gt;"), "备注已转义");
ok(html.includes("累计活跃时长"), "含 KPI 文案");
ok(html.includes("<svg"), "含内联 SVG 图表");
ok(html.includes("活跃天数"), "报告的工作区表格含「活跃天数」列");
ok(html.includes("ws-metrics"), "报告的工作区条形区是左右两块布局");
ok(html.includes("is-tokens"), "报告右侧那条 bar 是 Token（is-tokens）");
ok(html.includes("我的付出") && html.includes("Token 消耗"), "报告左右两块的标题分别是「我的付出」「Token 消耗」");
ok(html.includes("活跃 1/30 天"), "报告左侧小字含「活跃 N/M 天」", (html.match(/活跃 \d+\/\d+ 天/) ?? [""])[0]);
ok(!/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org/g, "")), "无外部资源引用（自包含）");

// ---------------------------------------------------------------- 宿主路由
console.log("\n—— 文案（i18n）一致性 ——");
{
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
  const clientSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const zhStart = localesSource.indexOf("export const zh = {");
  const enStart = localesSource.indexOf("export const en = {");
  const keyOf = (block) => [...block.matchAll(/^\s*"([^"]+)":/gm)].map((match) => match[1]);
  const zhKeys = keyOf(localesSource.slice(zhStart, enStart));
  const enKeys = keyOf(localesSource.slice(enStart));
  eq(zhKeys.length, enKeys.length, `中英文字典键数一致（各 ${zhKeys.length}）`);
  ok(
    zhKeys.every((key) => enKeys.includes(key)) && enKeys.every((key) => zhKeys.includes(key)),
    "中英文字典键集合完全一致（不会漏翻译 / 不会多出无用键）",
  );
  // 组件里出现的"键形状"字符串（含数组里通过变量使用的键）
  const referenced = new Set([...clientSource.matchAll(/"([a-z][a-zA-Z]*(?:\.[a-zA-Z0-9]+)+)"/g)].map((match) => match[1]));
  const dynamicFamilies = ["scope.", "tab.", "range."];
  // 只校验"属于已知文案命名空间"的字面量——槽位名（sidebar.footer.action / shell.overlay 等）不是文案键
  const namespaces = new Set(zhKeys.map((key) => key.split(".")[0]));
  const missing = [...referenced]
    .filter((key) => namespaces.has(key.split(".")[0]))
    .filter((key) => !zhKeys.includes(key) && !dynamicFamilies.some((family) => key.startsWith(family)));
  ok(missing.length === 0, "组件引用的文案键都存在于字典", missing.join(", "));
  const dead = zhKeys.filter((key) => !referenced.has(key) && !dynamicFamilies.some((family) => key.startsWith(family)));
  ok(dead.length === 0, "字典里没有无人使用的死键", dead.join(", "));
  // 长文案检查：直接按行取字典里的值长度，避免动态正则转义
  const zhLines = localesSource.slice(zhStart, enStart).split("\n");
  const longKeys = zhKeys.filter((key) => {
    const line = zhLines.find((item) => item.trim().startsWith(`"${key}":`));
    if (line === undefined) return false;
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/,$/, "");
    return value.length > 80;
  });
  ok(longKeys.length === 0, "没有超长文案（>80 字，发布前应压短）", longKeys.join(", "));
}

console.log("\n—— 宿主路由（stub ctx）——");
const hostModule = await import("../index.js");
const { apply } = hostModule;

// 静态检查：index.js 里访问的每个 ctx 服务都必须在 inject 里声明，
// 否则 cordis 会抛 "cannot get property ... without inject"，而它被 catch 后表现为"实时路径静默失效"。
{
  const source = await readFile(new URL("../index.js", import.meta.url), "utf8");
  const builtins = new Set(["logger", "effect", "on", "once", "inject", "get", "set", "reflect", "emit", "scope", "parallel", "serial", "waterfall", "bail", "start", "stop"]);
  const accessed = new Set();
  for (const match of source.matchAll(/\b(?:this\.)?ctx\.([A-Za-z_$][\w$]*)/g)) accessed.add(match[1]);
  const declared = new Set(hostModule.inject);
  const undeclared = [...accessed].filter((name) => !builtins.has(name) && !declared.has(name));
  ok(undeclared.length === 0, "index.js 访问的 ctx 服务都已声明在 inject 里", `未声明: ${undeclared.join(", ")}`);
  ok(declared.has("sessionProjections") && declared.has("sessions"), "声明了实时路径所需服务（sessionProjections / sessions）");
}
const records = [
  { header: { id: "session-1", createdAt: base, cwd: "/Users/me/proj-a", isSeeded: false, version: 4 }, live: false, persisted: true },
  { header: { id: "session-2", createdAt: base - 3 * HOUR, cwd: "/Users/me/proj-b", isSeeded: false, version: 4, origin: "subagent", delegationDepth: 1 }, live: false, persisted: true },
  { header: { id: "session-3", createdAt: base - 5 * HOUR, cwd: "/Users/me/proj-a", isSeeded: false, version: 4 }, live: false, persisted: true },
];
const snapshots = {
  "session-1": { asOfSeq: 10, values: { sessionStats: { turns: 2, steps: 4, llmMs: HOUR, toolMs: 0 }, tokenUsage: { totals: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 } }, title: "主会话一" } },
  "session-2": { asOfSeq: 5, values: { sessionStats: { turns: 1, steps: 2, llmMs: HOUR, toolMs: HOUR }, tokenUsage: { totals: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 40, cacheWriteTokens: 0 } }, title: "子代理" } },
  // session-3 故意不给检查点：走官方冷读兜底（真实世界里格式迁移后的旧会话就是这种情况）
};
/** 冷读返回值（sessionQuery.observeSession）与冷读次数。 */
const coldValues = {
  // 注意：observeSession 给的是 wire 形状（直接是 bucket），不是 { totals }
  "session-3": { sessionStats: { turns: 1, steps: 1, llmMs: 30 * 60000, toolMs: 0 }, tokenUsage: { uncachedInputTokens: 5, outputTokens: 7, cacheReadTokens: 9, cacheWriteTokens: 0 }, title: "冷读会话" },
};
let coldReads = 0;
let coldDisposed = 0;
const routes = [];
let eventListener = null;
const ctx = {
  logger: { info() {}, warn() {} },
  effect(fn) { fn(); return () => {}; },
  on(name, listener) { eventListener = listener; return () => {}; },
  sessions: { get: () => undefined },
  sessionProjections: { snapshot: () => undefined },
  sessionQuery: {
    listSessions: async () => records,
    observeSession: async (id) => {
      coldReads += 1;
      return {
        header: records.find((r) => r.header.id === id).header,
        projections: { asOfSeq: 77, values: coldValues[id] ?? {} },
        dispose() { coldDisposed += 1; },
      };
    },
  },
  sessionProjectionCache: { cachedSnapshot: (header) => snapshots[String(header.id)] },
  webServer: { register(spec) { routes.push(spec); return () => {}; } },
};
// 每次跑用独立索引文件，保证冷读路径可复现（真实运行时会持久化到 DSH_HOME）
const INDEX_PATH = `/tmp/wl-verify-index-${process.pid}.json`;
apply(ctx, { indexPath: INDEX_PATH });
ok(routes.length === 1 && routes[0].kind === "prefix", "注册了 1 个 prefix 路由");
eq(routes[0].path, "/workload-report/v1", "默认 apiPath");
ok(typeof eventListener === "function", "订阅了 session/event 以增量更新活会话");

/** 调用路由并等待响应结束。 */
function call(url, method = "GET") {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(chunk) { if (chunk) this.body += chunk; resolve({ status: this.statusCode, headers: this.headers, body: this.body }); },
    };
    try {
      routes[0].handler({ method, url }, res);
    } catch (error) {
      reject(error);
    }
  });
}

/** 等索引同步完成（stub 里冷读是瞬时的，真实环境首次可能要几分钟）。 */
async function waitIndexed() {
  for (let i = 0; i < 100; i += 1) {
    const response = await call("/workload-report/v1/health");
    const body = JSON.parse(response.body);
    if (body.indexing === false && body.diagnostics?.lastSyncAt > 0) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("索引未在预期时间内完成");
}

const health = await call("/workload-report/v1/health");
eq(health.status, 200, "/health 返回 200");
ok(typeof JSON.parse(health.body).indexing === "boolean", "/health 带 indexing 进度标记");
const healthBody = await waitIndexed();
eq(healthBody.indexing, false, "索引同步完成后 indexing=false");
eq(healthBody.diagnostics.sessions, 3, "/health 报告 3 个会话");
eq(healthBody.diagnostics.cached, 2, "/health 报告 2 个命中检查点");
eq(healthBody.diagnostics.cold, 1, "/health 报告 1 个冷读补齐（检查点未命中）");
eq(healthBody.diagnostics.missing, 0, "/health 报告 0 个彻底缺失");
eq(coldDisposed, 1, "冷读观察对象被 dispose（不泄漏）");

eq(coldReads, 1, "首次同步完成 1 次冷读");
const snapshotRes = await call(`/workload-report/v1/snapshot?days=30&tz=Asia%2FShanghai`);
eq(snapshotRes.status, 200, "/snapshot 返回 200");
const api = JSON.parse(snapshotRes.body);
eq(api.totals.sessions, 3, "接口会话数 3");
eq(api.totals.conversations, 3, "接口对话数 3（冷读补齐后包含 session-3）");
eq(api.totals.subagentSessions, 1, "接口识别出 1 个子代理（origin=subagent）");
eq(api.totals.tokens.input, 115, "接口输入 token = 100 + 10 + 冷读 5");
eq(api.totals.activeMs, 3.5 * HOUR, "接口活跃时长 3.5h（含冷读会话 30 分钟）");
ok(api.byWorkspace.length === 2, "接口按工作区分组 2 条");
ok(typeof api.generatedAt === "number", "接口带 generatedAt");
eq(api.diagnostics.cold, 1, "快照自带诊断：cold=1");

// 第二次同步：检查点命中 + 本地索引复用，不再冷读
const beforeReuse = coldReads;
await call(`/workload-report/v1/snapshot?days=30&tz=UTC&refresh=1`);
eq(coldReads, beforeReuse, "refresh 重扫不重复冷读（本地索引 + 检查点足够）");

const exportRes = await call("/workload-report/v1/export.json?days=30&tz=UTC");
eq(exportRes.status, 200, "/export.json 返回 200");
ok(String(exportRes.headers["content-disposition"] ?? "").includes("attachment"), "导出带 attachment 头");

const reportRes = await call("/workload-report/v1/report.html?days=30&tz=UTC&theme=dark");
eq(reportRes.status, 200, "/report.html 返回 200");
ok(String(reportRes.headers["content-type"] ?? "").startsWith("text/html"), "报告 content-type 正确");
ok(reportRes.body.includes("工作量报告"), "报告正文含标题");

const missing = await call("/workload-report/v1/nope");
eq(missing.status, 404, "未知路由 404");
const wrongMethod = await call("/workload-report/v1/snapshot", "POST");
eq(wrongMethod.status, 405, "非 GET 405");

// 活会话增量更新
const liveSession = { id: "session-1", header: records[0].header };
ctx.sessions = { get: () => liveSession };
ctx.sessionProjections = { snapshot: () => ({ asOfSeq: 99, values: { sessionStats: { turns: 9, steps: 20, llmMs: 5 * HOUR, toolMs: HOUR }, tokenUsage: { totals: { uncachedInputTokens: 999, outputTokens: 888, cacheReadTokens: 777, cacheWriteTokens: 0 } }, title: "实时" } }) };
eventListener(liveSession, { type: "step/end" });
const afterLive = await call(`/workload-report/v1/snapshot?days=30&tz=UTC`);
const liveApi = JSON.parse(afterLive.body);
eq(liveApi.totals.tokens.input, 1014, "活会话事件即时反映到快照（999 + 10 + 冷读 5）");

// 收尾：删掉本次的临时索引
await rm(INDEX_PATH, { force: true }).catch(() => {});
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`}`);
process.exit(failures === 0 ? 0 : 1);
