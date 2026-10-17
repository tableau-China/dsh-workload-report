// 离线验证：不依赖 DSH 实例，直接验证聚合口径、报告渲染与宿主路由行为。
// 用法：node test/verify.mjs

import { readFile, rm } from "node:fs/promises";

import { aggregate, dateKey, present, resolveRange, rowFromSession, workspaceLabel } from "../src/aggregate.js";
import { escapeHtml, formatHours, formatInt, formatMoney, formatTokens } from "../src/format.js";
import { barPercent } from "../src/client/bar-width.js";
import { renderReport } from "../src/report-html.js";
import { balanceChip } from "../src/client/balance.js";
import { hourTokensNote } from "../src/client/hour-status.js";
import { translate } from "../src/client/locales.js";
import {
  DEFAULT_PRICING, DEFAULT_WAIT_TOOLS, allocateLlmMs, cacheHitRate, costOf, emptyModelBucket, foldSessionModels,
  groupKeyFor, isPeak, modelLabel, modelTokens, resolvePricing, UNKNOWN_MODEL,
} from "../src/models.js";
import {
  HOUR_CHART_TOP_SPACE, HOUR_DOT_BASE_RADIUS, HOUR_DOT_RADIUS_SPAN, HOUR_DOT_TOP,
  hourBarPercent, hourDotCenterY, hourDotRadius, hourMeasureMax, hourMeasureValue,
  normalizeHourMeasure, scaleTokenBuckets,
} from "../src/hour-scale.js";

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

console.log("\n—— 时刻分析（按轮次落桶，新口径）——");
{
  const MIN = 60000;
  // 整点起算，方便按 UTC 桶核对（foldSessionHours 落桶恒为 UTC，聚合时再按请求时区平移）
  const H0 = Date.UTC(2026, 9, 14, 0); // 周三 00:00 UTC
  const reqHeader = (seq, time) => ({ type: "request/header", seq, time, data: { header: { config: { provider: "deepseek-official", model: "deepseek-flash", reasoningEffort: "max" } } } });
  const turnStart = (seq, time, turn) => ({ type: "turn/start", seq, time, data: { turn } });
  const assistant = (seq, time, turn, step = 1) => ({
    type: "assistant/message", seq, time,
    data: {
      turn, step,
      message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stream: [],
    },
  });
  const toolCall = (seq, time, callId, turn, step = 1) => ({ type: "tool/call", seq, time, data: { turn, step, callId, name: "bash", arguments: "{}" } });
  const toolResult = (seq, time, callId, turn, step = 1) => ({ type: "tool/result", seq, time, data: { turn, step, message: { role: "tool", source: { kind: "tool", callId }, content: [] } } });
  const sumHours = (hours) => hours.reduce((acc, value) => acc + value, 0);

  // ① 多轮分开：同一会话两轮分别在 09:xx 与 13:xx → 两个桶各自有值、互不混合
  const twoTurns = [
    turnStart(1, H0 + 9 * HOUR, 1), reqHeader(2, H0 + 9 * HOUR), assistant(3, H0 + 9 * HOUR + 20 * MIN, 1),
    turnStart(4, H0 + 13 * HOUR, 2), reqHeader(5, H0 + 13 * HOUR), assistant(6, H0 + 13 * HOUR + 30 * MIN, 2),
  ];
  const foldedTurns = foldSessionModels(twoTurns, { sessionLlmMs: 50 * MIN, sessionToolMs: 0, sessionStartMs: H0 });
  eq(foldedTurns.hoursSource, "events", "① 两轮事件累计 = 官方口径 → events（未缩放）");
  eq(Math.round(foldedTurns.hours[9] / MIN), 20, "① 第 1 轮（09:00 起）20min 落 9 桶");
  eq(Math.round(foldedTurns.hours[13] / MIN), 30, "① 第 2 轮（13:00 起）30min 落 13 桶");
  eq(foldedTurns.hours[10], 0, "① 两轮不混合：10 桶为 0");
  eq(foldedTurns.hours[14], 0, "① 两轮不混合：14 桶为 0");
  eq(sumHours(foldedTurns.hours), 50 * MIN, "① 两轮合计 50min === 官方 activeMs（守恒）");

  // ② 跨小时整段归起始：一轮 13:50–14:20（模型 15min + 工具 15min = 30min）→ 全在 13 桶
  const acrossHour = [
    turnStart(1, H0 + 13 * HOUR + 50 * MIN, 1),
    reqHeader(2, H0 + 13 * HOUR + 50 * MIN),
    assistant(3, H0 + 14 * HOUR + 5 * MIN, 1),
    toolCall(4, H0 + 14 * HOUR + 5 * MIN, "c1", 1),
    toolResult(5, H0 + 14 * HOUR + 20 * MIN, "c1", 1),
  ];
  const foldedAcross = foldSessionModels(acrossHour, { sessionLlmMs: 15 * MIN, sessionToolMs: 15 * MIN, sessionStartMs: H0 });
  eq(Math.round(foldedAcross.hours[13] / MIN), 30, "② 13:50–14:20 整段 30min 落 13 桶（模型 + 工具）");
  eq(foldedAcross.hours[14], 0, "② 14 桶为 0（不跨小时切分）");
  eq(sumHours(foldedAcross.hours), 30 * MIN, "② 整段归起始后总量不变");

  // ③ 会话级兜底：无 turn 事件 → 全部计入 createdAt 所在小时（不是最早事件所在小时）
  const sessionAnchor = H0 + 16 * HOUR;
  const noTurnEvents = [reqHeader(1, H0 + 3 * HOUR), assistant(2, H0 + 3 * HOUR + 25 * MIN, undefined)];
  const foldedSession = foldSessionModels(noTurnEvents, { sessionLlmMs: 25 * MIN, sessionToolMs: 0, sessionStartMs: sessionAnchor });
  eq(foldedSession.hoursSource, "events", "③ 会话级兜底仍走事件口径（有可用区间）");
  eq(Math.round(foldedSession.hours[16] / MIN), 25, "③ 25min 全落 createdAt 所在的 16 桶");
  eq(foldedSession.hours[3], 0, "③ 最早事件所在的 3 桶为 0（按会话开始时刻兜底）");
  const sessionRow = {
    ...makeRow({ id: "fallback", cwd: "/tmp/fb", createdAt: sessionAnchor, turns: 1, steps: 1, llmMs: 25 * MIN, toolMs: 0, input: 0, output: 0, cacheRead: 0 }),
    hours: foldedSession.hours,
    hoursSource: foldedSession.hoursSource,
  };
  const fbSnap = present(aggregate([sessionRow], { days: 1, timeZone: "UTC", now: sessionAnchor }));
  eq(Math.round(fbSnap.byHour[16].activeMs / MIN), 25, "③ 聚合：兜底 25min 落在 createdAt 的 16 桶");
  eq(fbSnap.byHour[3].activeMs, 0, "③ 聚合：3 桶为 0");
  ok(Math.abs(sumHours(fbSnap.byHour.map((bucket) => bucket.activeMs)) - fbSnap.totals.activeMs) < 1, "③ 聚合：兜底 sum(byHour) === totals.activeMs");

  // ④ 时区：事件在上海 13:00 开始（= UTC 05:00）→ 上海落 13 桶、UTC 落 5 桶，且无整体 +1h 偏移
  const shTurn = [turnStart(1, H0 + 5 * HOUR, 1), reqHeader(2, H0 + 5 * HOUR), assistant(3, H0 + 5 * HOUR + 30 * MIN, 1)];
  const foldedSh = foldSessionModels(shTurn, { sessionLlmMs: 30 * MIN, sessionToolMs: 0, sessionStartMs: H0 });
  const hourRow = {
    ...makeRow({ id: "h3", cwd: "/tmp/h3", createdAt: H0, turns: 1, steps: 1, llmMs: 30 * MIN, toolMs: 0, input: 0, output: 0, cacheRead: 0 }),
    hours: foldedSh.hours,
    hoursSource: foldedSh.hoursSource,
  };
  const ref = H0 + 12 * HOUR;
  const utcHourSnap = present(aggregate([hourRow], { days: 30, timeZone: "UTC", now: ref }));
  const shHourSnap = present(aggregate([hourRow], { days: 30, timeZone: "Asia/Shanghai", now: ref }));
  eq(Math.round(utcHourSnap.byHour[5].activeMs / MIN), 30, "④ UTC：上海 13:00 = UTC 05:00 → 5 桶 30min");
  eq(Math.round(shHourSnap.byHour[13].activeMs / MIN), 30, "④ Asia/Shanghai：13 桶 30min（无整体 +1h 偏移）");
  eq(shHourSnap.byHour[14].activeMs, 0, "④ Asia/Shanghai：14 桶为 0（不是晚一小时）");
  eq(shHourSnap.byHour[5].activeMs, 0, "④ Asia/Shanghai：已平移，5 桶为 0");
  ok(utcHourSnap.byHour[5].activeMs > 0 && shHourSnap.byHour[5].activeMs === 0, "④ 同一事件在两时区落桶不同");
  const sumUtc = sumHours(utcHourSnap.byHour.map((bucket) => bucket.activeMs));
  const sumSh = sumHours(shHourSnap.byHour.map((bucket) => bucket.activeMs));
  ok(Math.abs(sumUtc - utcHourSnap.totals.activeMs) < 1 && Math.abs(sumSh - shHourSnap.totals.activeMs) < 1, "④ 两时区各自 sum(byHour) === totals.activeMs");
  ok(Math.abs(sumUtc - sumSh) < 1, "④ 换时区只改分布、不改总量");
  eq(utcHourSnap.hourSource.events, 1, "④ 事件口径命中 1 行");

  // ⑤ 新环境场景：创建于 10 小时前、只有 20min 真实活跃 → 不得摊平成 10 小时平峰
  const TEN_HOURS = 10 * HOUR;
  const newEnvEvents = [reqHeader(1, H0 + TEN_HOURS - 20 * MIN), assistant(2, H0 + TEN_HOURS, 1)];
  const foldedNew = foldSessionModels(newEnvEvents, { sessionLlmMs: 20 * MIN, sessionToolMs: 0 });
  eq(Math.round(foldedNew.hours[9] / MIN), 20, "⑤ 事件口径：20min 全落在真实活跃所在的 9 点");
  const newEnvBase = { createdAt: H0, turns: 2, steps: 2, llmMs: 20 * MIN, toolMs: 0, input: 0, output: 0, cacheRead: 0 };
  const eventRow = { ...makeRow({ id: "new-env-events", cwd: "/tmp/ne", ...newEnvBase }), lastPromptAt: H0 + TEN_HOURS, hours: foldedNew.hours, hoursSource: foldedNew.hoursSource };
  const apportionRow = { ...makeRow({ id: "new-env-apportion", cwd: "/tmp/ne", ...newEnvBase }), lastPromptAt: H0 + TEN_HOURS };
  const eventSnap = present(aggregate([eventRow], { days: 1, timeZone: "UTC", now: H0 + TEN_HOURS }));
  const apportionSnap = present(aggregate([apportionRow], { days: 1, timeZone: "UTC", now: H0 + TEN_HOURS }));
  const eventPeak = eventSnap.byHour.reduce((best, h) => (h.activeMs > best.activeMs ? h : best), eventSnap.byHour[0]);
  const apportionPeak = apportionSnap.byHour.reduce((best, h) => (h.activeMs > best.activeMs ? h : best), apportionSnap.byHour[0]);
  eq(eventPeak.hour, 9, "⑤ 事件口径峰值小时 = 真实活跃所在的 9 点");
  eq(Math.round(eventSnap.byHour[9].activeMs / MIN), 20, "⑤ 事件口径：9 点 20min");
  ok(Math.round(apportionPeak.activeMs / MIN) <= 3, "⑤ 旧法把 20min 摊到约 10 小时（峰值 ≈ 2min 假平峰）", `旧法峰值 ${(apportionPeak.activeMs / MIN).toFixed(1)}min`);
  ok(eventSnap.byHour[9].activeMs > apportionSnap.byHour[9].activeMs * 9, "⑤ 事件口径峰值远高于旧法（修复生效）");
  ok(Math.abs(apportionSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - apportionSnap.totals.activeMs) < 1, "⑤ 旧法兜底仍总数守恒");
  eq(eventSnap.hourSource.events, 1, "⑤ 事件口径诊断 events=1");
  eq(apportionSnap.hourSource.apportioned, 1, "⑤ 旧法诊断 apportioned=1");

  // 缩放：事件累计 10min，官方 activeMs=20min → 按比例缩放到官方口径
  const scaledEvents = [reqHeader(1, H0), assistant(2, H0 + 10 * MIN, 1)];
  const foldedScaled = foldSessionModels(scaledEvents, { sessionLlmMs: 20 * MIN, sessionToolMs: 0 });
  eq(foldedScaled.hoursSource, "events-scaled", "事件累计 ≠ 官方口径 → events-scaled");
  eq(Math.round(foldedScaled.hours.reduce((acc, value) => acc + value, 0) / MIN), 20, "缩放后 sum(hours) === 官方 activeMs");
  eq(Math.round(foldedScaled.hours[0] / MIN), 20, "缩放按比例落在 0 点");
  const scaledRow = {
    ...makeRow({ id: "scaled", cwd: "/tmp/s", createdAt: H0, turns: 1, steps: 1, llmMs: 20 * MIN, toolMs: 0, input: 0, output: 0, cacheRead: 0 }),
    hours: foldedScaled.hours,
    hoursSource: foldedScaled.hoursSource,
  };
  const scaledSnap = present(aggregate([scaledRow], { days: 1, timeZone: "UTC", now: H0 }));
  eq(scaledSnap.hourSource.scaled, 1, "缩放行在聚合诊断里记为 scaled");
  ok(Math.abs(scaledSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - scaledSnap.totals.activeMs) < 1, "缩放行聚合后 sum(byHour) === totals.activeMs（守恒）");

  // ⑥ 未回填（无 row.hours）：仍走旧法摊销，且总数守恒
  const noHoursSnap = present(aggregate(rows, { days: 30, timeZone: "Asia/Shanghai", now: base }));
  eq(noHoursSnap.hourSource.apportioned, rows.length, "⑥ 未回填 / modelUsage=off 全部走旧法摊销");
  ok(Math.abs(noHoursSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - noHoursSnap.totals.activeMs) < 1, "⑥ 旧法总数守恒");
  // 混用：有 hours 的行用事件，没有的用摊销，两路各自计入诊断且全局守恒
  const mixedSnap = present(aggregate([...rows, hourRow], { days: 30, timeZone: "Asia/Shanghai", now: ref }));
  eq(mixedSnap.hourSource.events, 1, "⑥ 混用时事件行计 1");
  eq(mixedSnap.hourSource.apportioned, rows.length, "⑥ 混用时旧法行计 rows.length");
  ok(Math.abs(mixedSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - mixedSnap.totals.activeMs) < 1, "⑥ 混用来源 sum(byHour) === totals.activeMs");

  // ⑦–⑨ 时区落桶回归：用户实测"上海 13:00–14:00 被算到 14:00–15:00"必须被逐桶数值证伪。
  // 折叠恒为 UTC 桶，聚合时按请求时区平移；这里直接用真实期望值锁住"整点 / 跨小时 / 跨天"三种边界。
  const hourRowFrom = (id, startMs, endMs) => {
    const llmMs = endMs - startMs;
    const folded = foldSessionModels(
      [turnStart(1, startMs, 1), reqHeader(2, startMs), assistant(3, endMs, 1)],
      { sessionLlmMs: llmMs, sessionToolMs: 0, sessionStartMs: startMs },
    );
    return {
      ...makeRow({ id, cwd: "/tmp/tz", createdAt: startMs, turns: 1, steps: 1, llmMs, toolMs: 0, input: 0, output: 0, cacheRead: 0 }),
      hours: folded.hours,
      hoursSource: folded.hoursSource,
    };
  };
  const hourSnapshot = (row, nowMs) => present(aggregate([row], { days: 1, timeZone: "Asia/Shanghai", now: nowMs }));
  const minutesOf = (snap, hour) => Math.round(snap.byHour[hour].activeMs / MIN);

  // ⑦ 整点段：上海 13:00–14:00（= UTC 05:00–06:00）整段只落 13 桶
  const sh13 = Date.UTC(2026, 9, 16, 5);
  const case1 = hourSnapshot(hourRowFrom("tz-13", sh13, sh13 + 60 * MIN), sh13 + 8 * HOUR);
  eq(minutesOf(case1, 13), 60, "⑦ 上海 13:00–14:00 → 13 点 60min（不整体晚一小时）");
  eq(minutesOf(case1, 12), 0, "⑦ 12 点为 0");
  eq(minutesOf(case1, 14), 0, "⑦ 14 点为 0（若落 14 即为一小时错位）");
  eq(case1.hourSource.events, 1, "⑦ 事件口径命中 1 行");
  ok(case1.byHour.every((bucket, index) => bucket.hour === index), "⑦ byHour 第 i 项的 hour === i（客户端柱/标签同源于此）");
  ok(Math.abs(case1.byHour.reduce((acc, b) => acc + b.activeMs, 0) - case1.totals.activeMs) < 1, "⑦ 逐桶之和守恒");

  // ⑧ 跨小时整段归起始：上海 13:50–14:20（= UTC 05:50–06:20）→ 全部 30min 落 13 点、14 点为 0
  const sh1350 = Date.UTC(2026, 9, 16, 5, 50);
  const case2 = hourSnapshot(hourRowFrom("tz-1350", sh1350, sh1350 + 30 * MIN), sh1350 + 8 * HOUR);
  eq(minutesOf(case2, 13), 30, "⑧ 13:50–14:20 整段 30min 落 13 点（不跨小时切分）");
  eq(minutesOf(case2, 14), 0, "⑧ 14 点为 0（整段归起始小时，不是晚一小时）");
  eq(minutesOf(case2, 12), 0, "⑧ 12 点为 0");

  // ⑨ 跨天整段归起始：上海 23:30–00:30（= UTC 15:30–16:30）→ 全部 60min 落 23 点、次日 0 点为 0
  const sh2330 = Date.UTC(2026, 9, 16, 15, 30);
  const case3 = hourSnapshot(hourRowFrom("tz-overnight", sh2330, sh2330 + 60 * MIN), Date.UTC(2026, 9, 16, 15, 45));
  eq(minutesOf(case3, 23), 60, "⑨ 23:30–00:30 整段 60min 落 23 点（不跨天切分）");
  eq(minutesOf(case3, 0), 0, "⑨ 次日 0 点为 0（整段归起始小时）");
  eq(minutesOf(case3, 1), 0, "⑨ 1 点为 0（不整体后移）");
  eq(minutesOf(case3, 13), 0, "⑨ 13 点为 0（不整体前移）");
}

console.log("\n—— 时刻分析（Token 口径 + 人类消息密度）——");
{
  const MIN = 60000;
  const H0 = Date.UTC(2026, 9, 14, 0); // 周三 00:00 UTC
  const usage = (input, output, cacheRead = 0, cacheWrite = 0) => ({ inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite });
  const turnStart = (seq, time, turn) => ({ type: "turn/start", seq, time, data: { turn } });
  const reqHeader = (seq, time, turn) => ({ type: "request/header", seq, time, data: { turn, header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } });
  const assistant = (seq, time, turn, tokenUsage) => ({
    type: "assistant/message", seq, time,
    data: {
      turn, step: 1,
      message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
      usage: tokenUsage,
      stream: [],
    },
  });
  const userMessage = (seq, time, turn) => ({ type: "user/message", seq, time, data: { turn, message: { role: "user", content: [] } } });
  const sum = (list) => list.reduce((acc, value) => acc + value, 0);

  // 同一会话：9 点一轮（含一条 10:05 的跨小时消息）、13 点一轮；Token 按**消息时间**落桶
  const events = [
    turnStart(1, H0 + 9 * HOUR, 1),
    reqHeader(2, H0 + 9 * HOUR, 1),
    assistant(3, H0 + 9 * HOUR + 10 * MIN, 1, usage(100, 20, 5, 0)), // 125
    userMessage(4, H0 + 9 * HOUR + 20 * MIN, 1),
    userMessage(5, H0 + 9 * HOUR + 30 * MIN, 1),
    assistant(6, H0 + 10 * HOUR + 5 * MIN, 1, usage(5, 2, 0, 0)), // 7：消息时间 10:05，轮次起点仍是 9 点
    userMessage(7, H0 + 10 * HOUR + 10 * MIN, 1),
    turnStart(8, H0 + 13 * HOUR, 2),
    reqHeader(9, H0 + 13 * HOUR, 2),
    assistant(10, H0 + 13 * HOUR + 10 * MIN, 2, usage(300, 40, 10, 0)), // 350
    userMessage(11, H0 + 13 * HOUR + 20 * MIN, 2),
  ];
  const folded = foldSessionModels(events, { sessionLlmMs: 20 * MIN, sessionToolMs: 0, sessionTokens: 482, sessionStartMs: H0 });
  eq(folded.hourTokens[9], 125, "小时 Token：9 点消息 125 落 9 桶");
  eq(folded.hourTokens[10], 7, "小时 Token：10:05 的消息落 10 桶（按消息时间，不按轮次起点）");
  eq(folded.hourTokens[13], 350, "小时 Token：13 点消息 350 落 13 桶");
  eq(sum(folded.hourTokens), 482, "Σ hourTokens === 官方 tokensTotal（未缩放，±0）");
  eq(folded.hourTokensSource, "events", "小时 Token 来源 = events（事件累计 = 官方合计）");
  eq(folded.hourHumanMsgs[9], 2, "人类消息：9 点 2 条");
  eq(folded.hourHumanMsgs[10], 1, "人类消息：10 点 1 条");
  eq(folded.hourHumanMsgs[13], 1, "人类消息：13 点 1 条");
  eq(sum(folded.hourHumanMsgs), 4, "人类消息总数 = user/message 条数（4）");

  const foldedScaled = foldSessionModels(events, { sessionLlmMs: 20 * MIN, sessionToolMs: 0, sessionTokens: 500, sessionStartMs: H0 });
  eq(foldedScaled.hourTokensSource, "events-scaled", "事件 Token ≠ 官方合计 → events-scaled");
  eq(sum(foldedScaled.hourTokens), 500, "缩放后 Σ hourTokens === 官方 500（±0）");
  ok(foldedScaled.hourTokens.every((value) => Number.isInteger(value)), "缩放后的小时 Token 仍是整数（最大余数法）");
  const foldedNoUsage = foldSessionModels([], { sessionLlmMs: 0, sessionToolMs: 0, sessionTokens: 100, sessionStartMs: H0 });
  eq(foldedNoUsage.hourTokens, null, "官方有 Token 但事件读不出 usage → 无 hourTokens（不编分布）");
  eq(foldedNoUsage.hourTokensSource, null, "无 hourTokens 时来源为 null");

  // 聚合：按消息时间落桶后的 Token 进入 byHour.tokensTotal；humanMsgs 进入同名字段
  const tokenRow = {
    ...makeRow({ id: "tok", cwd: "/tmp/tok", createdAt: H0, turns: 2, steps: 3, llmMs: 20 * MIN, toolMs: 0, input: 300, output: 100, cacheRead: 82 }),
    hours: folded.hours,
    hoursSource: folded.hoursSource,
    hourTokens: folded.hourTokens,
    hourTokensSource: folded.hourTokensSource,
    hourHumanMsgs: folded.hourHumanMsgs,
  };
  const tokenNow = H0 + 14 * HOUR;
  const tokenSnap = present(aggregate([tokenRow], { days: 1, timeZone: "UTC", now: tokenNow }));
  eq(tokenSnap.byHour[9].tokensTotal, 125, "聚合 UTC：9 点 tokensTotal = 125");
  eq(tokenSnap.byHour[10].tokensTotal, 7, "聚合 UTC：10 点 tokensTotal = 7");
  eq(tokenSnap.byHour[13].tokensTotal, 350, "聚合 UTC：13 点 tokensTotal = 350");
  eq(sum(tokenSnap.byHour.map((hour) => hour.tokensTotal)), tokenSnap.totals.tokensTotal, "Σ byHour.tokensTotal === totals.tokensTotal（482）");
  eq(tokenSnap.byHour[9].humanMsgs, 2, "聚合：9 点 humanMsgs = 2");
  eq(tokenSnap.byHour[10].humanMsgs, 1, "聚合：10 点 humanMsgs = 1");
  eq(tokenSnap.byHour[13].humanMsgs, 1, "聚合：13 点 humanMsgs = 1");
  eq(sum(tokenSnap.byHour.map((hour) => hour.humanMsgs)), 4, "聚合：Σ humanMsgs = 4");
  eq(tokenSnap.hourTokensSource.events, 1, "诊断：小时 Token 事件口径命中 1 行");
  eq(tokenSnap.byHour[0].tokensTotal, 0, "没有消息的 0 点 tokensTotal = 0");

  // 时区平移：UTC 9/10/13 → 上海 17/18/21
  const tokenShSnap = present(aggregate([tokenRow], { days: 1, timeZone: "Asia/Shanghai", now: tokenNow }));
  eq(tokenShSnap.byHour[17].tokensTotal, 125, "聚合上海：UTC 9 点 → 17 点 125");
  eq(tokenShSnap.byHour[18].tokensTotal, 7, "聚合上海：UTC 10 点 → 18 点 7");
  eq(tokenShSnap.byHour[21].tokensTotal, 350, "聚合上海：UTC 13 点 → 21 点 350");
  eq(tokenShSnap.byHour[9].tokensTotal, 0, "聚合上海：9 点不再有 Token（已平移）");
  eq(sum(tokenShSnap.byHour.map((hour) => hour.tokensTotal)), tokenShSnap.totals.tokensTotal, "换时区只改分布、不改 Token 总量");

  // 读不出事件（v0 老日志 / 未回填）：不计入时间图 Token，并计入 missing
  const missingRow = makeRow({ id: "miss", cwd: "/tmp/miss", createdAt: H0, turns: 1, steps: 1, llmMs: 10 * MIN, toolMs: 0, input: 10, output: 5, cacheRead: 5 });
  const missSnap = present(aggregate([tokenRow, missingRow], { days: 1, timeZone: "UTC", now: tokenNow }));
  eq(missSnap.hourTokensSource.missing, 1, "读不出事件的会话计入 hourTokensSource.missing = 1");
  eq(sum(missSnap.byHour.map((hour) => hour.tokensTotal)), tokenSnap.totals.tokensTotal, "未计入的会话不进入任何小时 Token");
  ok(sum(missSnap.byHour.map((hour) => hour.tokensTotal)) < missSnap.totals.tokensTotal, "总 Token 仍含该会话（只是时间图不计入）");
  const zeroHourRow = { ...tokenRow, id: "zero-hour", hourTokens: new Array(24).fill(0) };
  eq(present(aggregate([zeroHourRow], { days: 1, timeZone: "UTC", now: tokenNow })).hourTokensSource.missing, 1, "hourTokens 全 0 但有官方 Token → 也计入未计入");
  const tokenReport = renderReport(missSnap, { theme: "light", generatedAt: tokenNow });
  ok(tokenReport.includes("Token 未计入 1 个会话"), "报告图下标注「Token 未计入 N 个会话」");
  ok(tokenReport.includes('data-kind="hour-dot"'), "报告渲染人类消息密度点（circle）");
  ok(tokenReport.includes("Token 产出") && tokenReport.includes("人类消息密度") && tokenReport.includes("峰值"), "报告图例只说明颜色：Token 产出 / 人类消息密度 / 峰值");
  ok(!tokenReport.includes("0–23 点分摊活跃时长"), "报告不再写旧的活跃时长口径");

  // 活会话续聊后 row.tokens 增长：聚合时按比例回正到新总量，仍严格守恒
  const grownRow = { ...tokenRow, id: "grown", tokens: { ...tokenRow.tokens, output: tokenRow.tokens.output + 18 } };
  const grownSnap = present(aggregate([grownRow], { days: 1, timeZone: "UTC", now: tokenNow }));
  eq(sum(grownSnap.byHour.map((hour) => hour.tokensTotal)), grownSnap.totals.tokensTotal, "row.tokens 增长后 Σ byHour.tokensTotal 仍 === totals.tokensTotal（500）");

  // measure：默认 Tokens，切「轮次」取 starts（同一批 byHour 数据）
  eq(normalizeHourMeasure(undefined), "tokens", "measure 缺省 = tokens");
  eq(normalizeHourMeasure("bogus"), "tokens", "非法 measure 回退 tokens");
  eq(normalizeHourMeasure("turns"), "turns", "measure 支持 turns");
  const measureHour = { tokensTotal: 1234, starts: 7, humanMsgs: 3 };
  eq(hourMeasureValue(measureHour, "tokens"), 1234, "measure=tokens 取 tokensTotal");
  eq(hourMeasureValue(measureHour, "turns"), 7, "measure=turns 取该小时 starts");
  eq(hourMeasureMax([{ tokensTotal: 10, starts: 2 }, { tokensTotal: 30, starts: 9 }], "tokens"), 30, "measure=tokens 的最大值取 Token");
  eq(hourMeasureMax([{ tokensTotal: 10, starts: 2 }, { tokensTotal: 30, starts: 9 }], "turns"), 9, "measure=turns 的最大值取轮次");
  eq(hourMeasureMax([], "tokens"), 1, "空数据时最大值为 1（不除零）");
  eq(hourBarPercent(0, 30), 0, "0 值柱高 0");
  eq(hourBarPercent(15, 30), 50, "柱高按当前 measure 的最大值归一");
  ok(hourBarPercent(1, 1000) >= 3, "有值柱至少 3%（细柱可见）");

  // 圆点几何：半径公式、上沿 14px、顶部 64px 容得下最大圆
  eq(HOUR_DOT_TOP, 14, "圆点上沿留白 = 14px");
  eq(HOUR_DOT_BASE_RADIUS, 3.4, "圆点最小半径 = 3.4");
  eq(HOUR_DOT_RADIUS_SPAN, 5.0, "半径增量 = 5.0");
  ok(Math.abs(hourDotRadius(0) - 3.4) < 1e-9, "ratio=0 → r=3.4");
  ok(Math.abs(hourDotRadius(1) - 8.4) < 1e-9, "ratio=1 → r=8.4（最大圆）");
  ok(Math.abs(hourDotCenterY(hourDotRadius(1)) - hourDotRadius(1) - 14) < 1e-9, "最大圆上沿仍是 14px（不被裁）");
  ok(HOUR_CHART_TOP_SPACE >= 14 + hourDotRadius(1) * 2, "顶部 64px 完整容纳最大圆（14 + 16.8）");

  // Token 回正纯函数
  eq(scaleTokenBuckets(new Array(24).fill(0), 10), null, "全 0 桶无法回正 → null（不编分布）");
  eq(scaleTokenBuckets(new Array(24).fill(1), 0), null, "目标 0 → null");
  const scaledTen = scaleTokenBuckets(new Array(24).fill(0).map((_, index) => (index === 0 || index === 5 ? 1 : 0)), 10);
  eq(sum(scaledTen), 10, "scaleTokenBuckets 的和恰好等于目标");
  ok(scaledTen.every((value) => Number.isInteger(value)), "scaleTokenBuckets 不产生小数 Token");

  // 文案：图例只解释颜色（不要括号解释），tooltip 一行三口径
  eq(translate("zh", "hour.legend.tokens"), "Token 产出", "图例「Token 产出」");
  eq(translate("zh", "hour.legend.humans"), "人类消息密度", "图例「人类消息密度」");
  eq(translate("en", "hour.legend.peak"), "Peak", "英文图例「Peak」");
  const legendText = ["tokens", "turns", "humans", "peak"].map((key) => translate("zh", "hour.legend." + key)).join("|");
  ok(!/[()（）]/.test(legendText), "图例文案不含括号解释", legendText);
  const tip = translate("zh", "hour.tip", { hour: 9, tokens: "12.3K", turns: "4", humans: "2" });
  ok(tip.includes("9:00–9:59") && tip.includes("Token 12.3K") && tip.includes("轮次 4") && tip.includes("人类消息 2"), "tooltip = 小时 · Token · 轮次 · 人类消息", tip);
  ok(translate("zh", "hour.missingTokens", { count: 3 }).includes("未计入 3 个会话"), "缺失提示写「未计入 N 个会话」");
}

console.log("\n—— 等待用户剔除（0.6.5）——");
{
  const MIN = 60000;
  const H0 = Date.UTC(2026, 9, 14, 0); // 周三 00:00 UTC，整点便于核对 UTC 桶
  const turnStart = (seq, time, turn) => ({ type: "turn/start", seq, time, data: { turn } });
  const reqHeader = (seq, time, turn) => ({ type: "request/header", seq, time, data: { turn, header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } } });
  const assistant = (seq, time, turn) => ({
    type: "assistant/message", seq, time,
    data: {
      turn, step: 1,
      message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      stream: [],
    },
  });
  const toolCall = (seq, time, callId, name, turn) => ({ type: "tool/call", seq, time, data: { turn, step: 1, callId, name, arguments: "{}" } });
  const toolResult = (seq, time, callId, turn) => ({ type: "tool/result", seq, time, data: { turn, step: 1, message: { role: "tool", source: { kind: "tool", callId }, content: [] } } });
  const userMessage = (seq, time, turn) => ({ type: "user/message", seq, time, data: { turn, message: { role: "user", content: [] } } });
  const sumHours = (hours) => hours.reduce((acc, value) => acc + value, 0);
  const minutes = (ms) => Math.round(ms / MIN);

  eq(DEFAULT_WAIT_TOOLS.join(","), "ask_user_question,exit_plan_mode", "默认交互工具白名单 = ask_user_question / exit_plan_mode");

  // ①/⑦ 同一会话：等待前 10min 模型 + 3h 交互工具（中间夹 user/message）+ 等待后 10min 模型。
  // 官方 llmMs=20min、toolMs=180min；等待整段剔除后净活跃 20min。
  const waitEvents = [
    turnStart(1, H0 + 9 * HOUR, 1),
    reqHeader(2, H0 + 9 * HOUR, 1),
    assistant(3, H0 + 9 * HOUR + 10 * MIN, 1),
    toolCall(4, H0 + 9 * HOUR + 10 * MIN, "ask-1", "ask_user_question", 1),
    userMessage(5, H0 + 10 * HOUR, 1),
    toolResult(6, H0 + 12 * HOUR + 10 * MIN, "ask-1", 1),
    turnStart(7, H0 + 12 * HOUR + 10 * MIN, 2),
    reqHeader(8, H0 + 12 * HOUR + 10 * MIN, 2),
    assistant(9, H0 + 12 * HOUR + 20 * MIN, 2),
  ];
  const foldedWait = foldSessionModels(waitEvents, { sessionLlmMs: 20 * MIN, sessionToolMs: 180 * MIN, sessionStartMs: H0 });
  eq(foldedWait.waitMs, 180 * MIN, "① 交互工具 3h（含 user/message 夹层）→ waitMs = 180min");
  eq(foldedWait.hoursSource, "events", "① 剔除等待后事件累计 = 净活跃 → events");
  eq(minutes(foldedWait.hours[9]), 10, "① 等待前的 10min 工作落 9 桶");
  eq(minutes(foldedWait.hours[12]), 10, "① 等待后的 10min 工作落 12 桶");
  eq(foldedWait.hours[10], 0, "① 10 桶不含等待");
  eq(foldedWait.hours[11], 0, "① 11 桶不含等待");
  eq(minutes(sumHours(foldedWait.hours)), 20, "① sum(hours) = 净活跃 20min（不含 3h 等待）");

  const waitRow = {
    ...makeRow({ id: "wait", cwd: "/tmp/wait", createdAt: H0 + 9 * HOUR, turns: 2, steps: 2, llmMs: 20 * MIN, toolMs: 180 * MIN, input: 0, output: 0, cacheRead: 0 }),
    waitMs: foldedWait.waitMs,
    hours: foldedWait.hours,
    hoursSource: foldedWait.hoursSource,
  };
  const waitSnap = present(aggregate([waitRow], { days: 1, timeZone: "UTC", now: H0 + 20 * HOUR }));
  eq(waitSnap.totals.activeMs, 200 * MIN, "⑤ 官方 activeMs 保留 = 模型 20min + 工具 180min");
  eq(waitSnap.totals.waitMs, 180 * MIN, "⑤ totals.waitMs = 180min");
  eq(waitSnap.totals.netActiveMs, 20 * MIN, "⑤ totals.netActiveMs = 20min");
  eq(waitSnap.totals.toolMs, 0, "① totals.toolMs 不计入等待（官方 180min → 净工具 0）");
  eq(waitSnap.totals.llmMs + waitSnap.totals.toolMs, waitSnap.totals.netActiveMs, "① 净模型 + 净工具 = 净活跃");
  ok(Math.abs(waitSnap.totals.netActiveMs + waitSnap.totals.waitMs - waitSnap.totals.activeMs) < 1, "⑤ 守恒 netActiveMs + waitMs === activeMs（±1ms）");
  eq(minutes(waitSnap.byHour[9].activeMs), 10, "⑦ 聚合：9 点 10min（等待前的工作）");
  eq(minutes(waitSnap.byHour[12].activeMs), 10, "⑦ 聚合：12 点 10min（等待后的工作）");
  eq(waitSnap.byHour[10].activeMs + waitSnap.byHour[11].activeMs, 0, "⑦ 等待时段不抬高任何小时桶（10/11 点为 0）");
  ok(Math.abs(waitSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - waitSnap.totals.netActiveMs) < 1, "⑦ sum(byHour) === totals.netActiveMs（净活跃守恒）");
  eq(waitSnap.byDay.find((day) => day.sessions > 0).activeMs, 20 * MIN, "⑤ byDay 用净活跃 20min");
  eq(waitSnap.byWorkspace[0].activeMs, 20 * MIN, "⑤ byWorkspace 用净活跃 20min");
  eq(waitSnap.byWorkspace[0].waitMs, 180 * MIN, "⑤ byWorkspace 单独携带 waitMs");
  eq(waitSnap.calendar.days[0].activeMs, 20 * MIN, "⑤ calendar 用净活跃 20min");
  eq(waitSnap.bySession[0].activeMs, 20 * MIN, "⑤ bySession 用净活跃 20min");
  eq(waitSnap.bySession[0].waitMs, 180 * MIN, "⑤ bySession 单独携带 waitMs");

  // ② 非白名单工具 10min，中间有 user/message → 判为等待（人类输入夹层）
  const humanEvents = [
    turnStart(1, H0 + 9 * HOUR, 1),
    reqHeader(2, H0 + 9 * HOUR, 1),
    assistant(3, H0 + 9 * HOUR + 5 * MIN, 1),
    toolCall(4, H0 + 9 * HOUR + 5 * MIN, "bash-1", "bash", 1),
    userMessage(5, H0 + 9 * HOUR + 8 * MIN, 1),
    toolResult(6, H0 + 9 * HOUR + 15 * MIN, "bash-1", 1),
  ];
  const foldedHuman = foldSessionModels(humanEvents, { sessionLlmMs: 5 * MIN, sessionToolMs: 10 * MIN, sessionStartMs: H0 });
  eq(foldedHuman.waitMs, 10 * MIN, "② 非白名单 10min + 有 user/message → waitMs = 10min");
  eq(minutes(foldedHuman.hours[9]), 5, "② 等待剔除后只剩 5min 模型时间");
  eq(minutes(sumHours(foldedHuman.hours)), 5, "② 净活跃 5min（10min 工具被剔除）");

  // ③ 同样的 10min 工具，但没有 user/message → 仍算工作（长任务豁免，不误伤）
  const noHumanEvents = humanEvents.filter((event) => event.type !== "user/message");
  const foldedNoHuman = foldSessionModels(noHumanEvents, { sessionLlmMs: 5 * MIN, sessionToolMs: 10 * MIN, sessionStartMs: H0 });
  eq(foldedNoHuman.waitMs, 0, "③ 非白名单 10min 无 user/message → waitMs = 0（不误伤）");
  eq(foldedNoHuman.hoursSource, "events", "③ 长任务仍走事件口径");
  eq(minutes(sumHours(foldedNoHuman.hours)), 15, "③ 10min 工具照常算工作（合计 15min）");
  eq(minutes(foldedNoHuman.hours[9]), 15, "③ 15min 全落 9 桶");

  // 白名单可扩展：自定义工具即使没有 user/message，命中 waitTools 也整段等待
  const customEvents = [
    turnStart(1, H0 + 9 * HOUR, 1),
    toolCall(2, H0 + 9 * HOUR, "gate-1", "deploy_gate", 1),
    toolResult(3, H0 + 9 * HOUR + 10 * MIN, "gate-1", 1),
  ];
  const foldedCustom = foldSessionModels(customEvents, { sessionLlmMs: 0, sessionToolMs: 10 * MIN, sessionStartMs: H0, waitTools: ["deploy_gate"] });
  eq(foldedCustom.waitMs, 10 * MIN, "② 白名单可扩展：waitTools 命中的自定义工具整段等待");
  eq(foldedCustom.hours, null, "② 全部是等待 → 没有可落的活跃桶（hours=null）");

  // ④ 30s 的短交互 < waitMinMs(60s) → 不剔除（避免碎片化）
  const shortEvents = [
    turnStart(1, H0 + 9 * HOUR, 1),
    reqHeader(2, H0 + 9 * HOUR, 1),
    toolCall(3, H0 + 9 * HOUR, "ask-short", "ask_user_question", 1),
    userMessage(4, H0 + 9 * HOUR + 10 * 1000, 1),
    toolResult(5, H0 + 9 * HOUR + 30 * 1000, "ask-short", 1),
  ];
  const foldedShort = foldSessionModels(shortEvents, { sessionLlmMs: 0, sessionToolMs: 30 * 1000, sessionStartMs: H0 });
  eq(foldedShort.waitMs, 0, "④ 30s 短交互 < waitMinMs → waitMs = 0（不剔除）");
  eq(Math.round(sumHours(foldedShort.hours) / 1000), 30, "④ 30s 仍计为工作");

  // ⑥ excludeWait=false → 与 0.6.0 完全一致：不判等待，3h 工具区间照常算活跃并落桶
  const foldedNoWait = foldSessionModels(waitEvents, { sessionLlmMs: 20 * MIN, sessionToolMs: 180 * MIN, sessionStartMs: H0, excludeWait: false });
  eq(foldedNoWait.waitMs, 0, "⑥ excludeWait=false → 不判定等待（waitMs=0）");
  eq(minutes(foldedNoWait.hours[9]), 190, "⑥ 3h 工具区间回到 9 桶（10 + 180min，与 0.6.0 一致）");
  eq(minutes(foldedNoWait.hours[12]), 10, "⑥ 第 2 轮 10min 落 12 桶");
  eq(minutes(sumHours(foldedNoWait.hours)), 200, "⑥ sum(hours) = 官方 activeMs 200min");
  const noWaitRow = {
    ...makeRow({ id: "no-wait", cwd: "/tmp/wait", createdAt: H0 + 9 * HOUR, turns: 2, steps: 2, llmMs: 20 * MIN, toolMs: 180 * MIN, input: 0, output: 0, cacheRead: 0 }),
    waitMs: foldedNoWait.waitMs,
    hours: foldedNoWait.hours,
    hoursSource: foldedNoWait.hoursSource,
  };
  const noWaitSnap = present(aggregate([noWaitRow], { days: 1, timeZone: "UTC", now: H0 + 20 * HOUR }));
  eq(noWaitSnap.totals.activeMs, 200 * MIN, "⑥ 回归：activeMs 仍为官方 200min");
  eq(noWaitSnap.totals.waitMs, 0, "⑥ 回归：waitMs = 0");
  eq(noWaitSnap.totals.netActiveMs, 200 * MIN, "⑥ 回归：netActiveMs === activeMs（行为与 0.6.0 一致）");
  eq(noWaitSnap.totals.toolMs, 180 * MIN, "⑥ 回归：excludeWait=false 时 toolMs 仍为官方 180min");
  ok(Math.abs(noWaitSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - noWaitSnap.totals.activeMs) < 1, "⑥ 回归：sum(byHour) === totals.activeMs");

  // 展示层：报告 KPI / 每日图都用净活跃，副标题与 footer 单列等待
  const waitReport = renderReport(waitSnap, { theme: "light", title: "等待报告" });
  ok(waitReport.includes("含等待用户 3 h"), "展示：报告 KPI 副标题写明「含等待用户 3 h」");
  ok(waitReport.includes("净活跃"), "展示：报告 footer 说明净活跃口径");
  ok(waitReport.includes(">20 m<"), "展示：报告 KPI 活跃时长 = 净活跃 20min（不是 200min）");
  ok(waitReport.includes("活跃 20 m"), "展示：报告每日柱 tooltip 用净活跃 20min");
  eq(translate("zh", "kpi.active.waitSub", { wait: "3 h" }), "含等待用户 3 h", "i18n：中文等待副标题");
  eq(translate("en", "kpi.active.waitSub", { wait: "3 h" }), "incl. waiting 3 h", "i18n：英文等待副标题");
}

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
console.log("\n—— 时长格式化（formatHours：全站唯一换算入口）——");
eq(formatHours(5868000), "1.6 h", "1.63 h → 1.6 h（旧两位小数统一为一位）");
eq(formatHours(5400000), "1.5 h", "1.5 h 保持一位小数（单位小写 h）");
eq(formatHours(10800000), "3 h", "整点时长去掉 .0（3 h，不是 3.0 h）");
eq(formatHours(0), "0", "零时长");
eq(formatHours(20 * 60000), "20 m", "不足 0.1 h 用分钟");
eq(formatHours(59 * 60000), "59 m", "不足 1 小时仍用分钟（与既有报告断言一致）");
eq(formatHours(3600000), "1 h", "整小时边界切到小时（去掉 .0）");
eq(formatHours(30000), "30 s", "不足 1 分钟用秒");
// 同一数值在 KPI / 表格 / 报告三处必须一致（都调用 formatHours）
const crossMs = 5868000; // 1.63 h → 1.6 h
const crossSnap = present(aggregate([makeRow({ id: "cross", cwd: "/tmp/cross", createdAt: base, llmMs: crossMs, toolMs: 0 })], { days: 30, timeZone: "Asia/Shanghai", now: base }));
const crossHtml = renderReport(crossSnap, { theme: "light", title: "一致性", topSessions: 1 });
const crossDay = crossSnap.byDay.find((day) => day.sessions > 0);
eq(formatHours(crossSnap.totals.netActiveMs), "1.6 h", "KPI 数值 = formatHours(1.63 h)");
eq(formatHours(crossDay.activeMs), "1.6 h", "表格数值与 KPI 一致（同一函数）");
ok(crossHtml.includes('<div class="value">1.6 h</div>'), "报告 KPI 用同一格式化结果", (crossHtml.match(/<div class="value">[^<]+<\/div>/) ?? [""])[0]);
ok(crossHtml.includes("<td>1.6 h</td>"), "报告按日期明细表与 KPI 一致", (crossHtml.match(/<td>[^<]* h<\/td>/) ?? [""])[0]);
ok(!crossHtml.includes("1.63 h"), "报告不再出现两位小数小时");
{
  const clientSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const reportSource = await readFile(new URL("../src/report-html.js", import.meta.url), "utf8");
  ok(!clientSource.includes("formatDuration(") && !clientSource.includes("formatKpiDuration("), "看板不再调用旧时长格式化函数");
  ok(!reportSource.includes("formatDuration(") && !reportSource.includes("formatKpiDuration("), "报告不再调用旧时长格式化函数");
  ok(!/\/\s*3600000/.test(clientSource) && !/\/\s*3600000/.test(reportSource), "看板 / 报告没有各自的毫秒→小时换算");
  ok(clientSource.includes("formatHours") && reportSource.includes("formatHours"), "看板与报告都走 formatHours");
}
console.log("\n—— 比例条（主要会话 / 按日期明细共用 MetricBarCell）——");
eq(barPercent(500, 1000), 50, "bar 宽度 = 本行 / 本列最大值（50%）");
eq(barPercent(250, 2000), 12.5, "同列归一（12.5%）");
eq(barPercent(50, 200), barPercent(500, 2000), "两表同比例数值的 bar 宽度一致（25%）");
eq(barPercent(1000, 1000), 100, "本列最大值铺满 100%");
eq(barPercent(0, 1000), 0, "0 值不画条");
eq(barPercent(1200, 1000), 100, "异常值夹紧到 100%");
{
  const indexSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const cellSource = await readFile(new URL("../src/client/bar-cell.jsx", import.meta.url), "utf8");
  const widthSource = await readFile(new URL("../src/client/bar-width.js", import.meta.url), "utf8");
  ok(cellSource.includes("export function MetricBarCell"), "通用组件 MetricBarCell 存在");
  eq((indexSource.match(/<MetricBarCell/g) ?? []).length, 2, "两处调用点：主要会话 + 按日期明细");
  ok(indexSource.includes('from "./bar-cell.jsx"'), "两张表从同一组件模块导入");
  ok(!indexSource.includes("wl-bar-cell"), "index.jsx 不再复制条形单元格的样式/逻辑");
  ok(cellSource.includes('from "./bar-width.js"') && widthSource.includes("export function barPercent"), "宽度计算只有一份实现");
  ok(/key: "tokens", labelKey: "table.tokens"/.test(indexSource), "日期明细覆盖 Token 合计列");
}

console.log("\n—— 通用 chip / 卡片头 / 样式收敛 ——");
{
  const indexSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const chipsSource = await readFile(new URL("../src/client/chips.jsx", import.meta.url), "utf8");
  const headSource = await readFile(new URL("../src/client/card-head.jsx", import.meta.url), "utf8");
  const stylesSource = await readFile(new URL("../src/client/styles.js", import.meta.url), "utf8");
  const docsSource = await readFile(new URL("../docs/ui-conventions.md", import.meta.url), "utf8");
  ok(chipsSource.includes("export function ChipGroup") && chipsSource.includes("export function Chip"), "通用 chip 组件存在（ChipGroup / Chip）");
  ok(indexSource.includes('from "./chips.jsx"') && indexSource.includes('from "./card-head.jsx"'), "看板从共享组件导入，不复制实现");
  ok((indexSource.match(/<ChipGroup/g) ?? []).length >= 5, "ChipGroup 至少 5 处：顶部范围 / 每日 / 时刻 / 工作区 / 模型");
  eq((indexSource.match(/<button[^>]*className="wl-chip"/g) ?? []).length, 0, "index.jsx 不再手写 wl-chip 按钮");
  ok(!/wl-chip-active|wl-chips-inline/.test(indexSource) && !/wl-chip-active|wl-chips-inline/.test(stylesSource), "没有 wl-chip-active / wl-chips-inline 变体 class");
  ok(/className="wl-chip"/.test(chipsSource) && /data-active={active \? "true"/.test(chipsSource), "chip 的默认/选中态由 data-active 驱动");
  ok(/\.wl-chip \{[^}]*border: 1px solid var\(--dsw-alias-border-l2/s.test(stylesSource) && /\.wl-chip \{[^}]*background: color-mix\(in srgb, var\(--dsw-static-deepseek-500[^}]*var\(--dsw-alias-bg-layer-2/s.test(stylesSource), "默认态：浅底 + 边框（token 混色，不写死色值）");
  ok(/\.wl-chip\[data-active="true"\] \{[^}]*background: var\(--dsw-static-deepseek-500/s.test(stylesSource) && /\.wl-chip\[data-active="true"\] \{[^}]*color: var\(--dsw-alias-label-primary-inverted/s.test(stylesSource), "选中态：主题强调色实底 + 白字");
  ok(/\.wl-chips \{[^}]*display: inline-flex[^}]*gap: 6px/s.test(stylesSource) && /\.wl-chip \{[^}]*height: 24px[^}]*border-radius: 999px/s.test(stylesSource), "尺寸 / 间距 / 圆角只有一份");
  ok(headSource.includes("export function CardHead") && (indexSource.match(/<CardHead/g) ?? []).length >= 5, "卡片头统一用 CardHead（5 处：每日 / 模型占比 / 时刻 / 工作区 / 模型用量）");
  ok(/\.wl-card-head \{[^}]*justify-content: space-between/s.test(stylesSource) && /\.wl-card-head-actions \{[^}]*margin-left: auto/s.test(stylesSource), "卡片头：标题在左、控件右上");
  ok(headSource.includes("wl-card-head-hint") && /title=\{hint\}/.test(headSource) && !headSource.includes('<p className="wl-hint">'), "CardHead.hint 渲染在标题右侧，并带 title 保留全文（不再走标题下方段落）");
  ok(/\.wl-card-head-text \{[^}]*align-items: baseline/s.test(stylesSource) && !/\.wl-card-head-text \.wl-hint/.test(stylesSource), "说明与标题同一行且基线对齐，旧的下方 hint 规则已删除");
  ok(/\.wl-card-head-hint \{[^}]*font-size: 11px/s.test(stylesSource) && /\.wl-card-head-hint \{[^}]*white-space: nowrap/s.test(stylesSource) && /\.wl-card-head-hint \{[^}]*text-overflow: ellipsis/s.test(stylesSource) && /\.wl-card-head-hint \{[^}]*var\(--dsw-alias-label-tertiary/s.test(stylesSource), "hint 固定样式：11px muted 单行截断（宿主 token）");
  ok(!/<h3>[\s\S]{0,160}<p className="wl-hint">/.test(indexSource), "标题下方不再有 hint 节点（统一到标题右侧）");
  eq((stylesSource.match(/\.wl-legend \{/g) ?? []).length, 1, "legend 基础样式只定义一次");
  ok(!/wl-hour-note|wl-fold-error|wl-model-note|wl-model-links|wl-model-raw/.test(stylesSource), "旧的一次性提示 class 已收敛到 .wl-status / .wl-hint 修饰");
  ok(/status|提示/.test(docsSource) && docsSource.includes("ChipGroup") && docsSource.includes("MetricBarCell") && docsSource.includes("CardHead"), "docs/ui-conventions.md 写明共享组件与固定结构");
  ok(docsSource.includes("CardHead.hint") && docsSource.includes("禁止再在标题下方加 hint"), "docs 写明卡片说明统一放标题右侧、禁止标题下方加 hint");
  // 构建产物必须包含本轮 UI：防止忘记 node build.mjs 导致用户加载旧 bundle
  const builtSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  ok(
    builtSource.includes("calendar-cell") && builtSource.includes("active-bar-hit") && builtSource.includes("hour.calculating") && builtSource.includes("wl-card-head-actions") && builtSource.includes("wl-card-head-hint"),
    "lib/client.js 含本轮 UI（构建产物与源码同步）",
  );
}

console.log("\n—— 图表 tooltip 逐元素（原生 title）——");
{
  const indexSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
  ok(indexSource.includes('data-kind="calendar-cell"') && /data-kind="calendar-cell"[\s\S]{0,700}<title>/.test(indexSource), "日历每格 rect 自带 title（不挂父 g）");
  ok(indexSource.includes('data-kind="active-bar-hit"') && /data-kind="active-bar-hit"[\s\S]{0,500}<title>/.test(indexSource), "柱状图每根柱有全高命中区 + title（1px 柱也能 hover）");
  ok(indexSource.includes("weekend: weekend ? t(\"tip.weekend\")") && indexSource.includes("tip.weekday") && indexSource.includes("tip.week"), "柱/日历/周几轴/周标签都有可读提示");
  ok(!indexSource.includes('t("tip.day"') && !localesSource.includes('"tip.day"'), "旧的 tip.day 三行文案已删除（统一 tip.daily）");
  ok(/"tip.daily": "\{date\} · 活跃 \{active\} · Token \{tokens\}\{weekend\}"/.test(localesSource), "tip.daily = 日期 · 活跃 x · Token y[ · 周末]");
  ok(/"tip.weekend": " · 周末"/.test(localesSource) && /"tip.weekend": " · weekend"/.test(localesSource), "zh/en 都有周末后缀");
  // 审计发现的父节点 title：模型 treemap 与模型趋势都必须挂在实际形状上
  ok(/data-kind=\{rect\.item === null \? "others" : "model"\}[\s\S]{0,600}<title>/.test(indexSource), "模型 treemap 的 title 挂在 rect（不是 g）");
  ok(/data-kind="model-trend-hit"[\s\S]{0,300}<title>/.test(indexSource), "模型趋势每列有命中区 title（不是 g）");
}
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
ok(!html.includes("platform.deepseek.com") && !html.includes("余额"), "报告不含余额 / 余额接口（余额不入导出）");

// ---------------------------------------------------------------- 宿主路由
console.log("\n—— 文案（i18n）一致性 ——");
{
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
  // 文案引用可能出现在任意客户端模块（chips / card-head / hour-status / balance…）；
  // 全部一起扫描，死键检查才完整（否则新组件里的 key 会被误判为死键）。
  const clientModules = ["index.jsx", "balance.js", "chips.jsx", "card-head.jsx", "hour-status.js", "bar-cell.jsx"];
  const clientSource = (await Promise.all(
    clientModules.map((name) => readFile(new URL(`../src/client/${name}`, import.meta.url), "utf8")),
  )).join("\n");
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
  // 「每日用量趋势」的旧提示（全历史；右侧＝各周几累计）已删除：键与渲染一起消失，不留空标签
  ok(!zhKeys.includes("cal.hint") && !enKeys.includes("cal.hint"), "日历提示键已从 zh/en 删除");
  ok(!zhKeys.includes("hour.sub") && !enKeys.includes("hour.sub"), "时刻卡片小标题键已从 zh/en 删除（无死键）");
  ok(!zhKeys.includes("hour.peak") && !enKeys.includes("hour.peak"), "旧「最活跃」文案键已删除（图例只解释颜色）");
  ok(!clientSource.includes("hour.sub") && !clientSource.includes("hour.peak"), "时刻卡片不再渲染小标题与「最活跃」行");
  ok(!clientSource.includes("cal.hint"), "看板不再引用日历提示键");
  ok(!localesSource.includes("全历史；右侧") && !localesSource.includes("Full history; right edge"), "中英文提示文案均已从字典删除");
  const byDayBlock = clientSource.slice(clientSource.indexOf("function ByDayView"), clientSource.indexOf("function ByWorkspaceView"));
  // 三张卡的说明都走 CardHead.hint（标题右侧），标题下方节点数为 0
  const dailyHead = byDayBlock.slice(byDayBlock.indexOf('title={t("chart.daily")}'), byDayBlock.indexOf('className="wl-daily-body"'));
  ok(dailyHead.length > 0 && dailyHead.includes('hint={t("chart.hint")}'), "「每日用量趋势」说明走 CardHead.hint（标题右侧，不在标题下方）");
  const hourHead = byDayBlock.slice(byDayBlock.indexOf('title={t("hour.title")}'), byDayBlock.indexOf("<HourChart"));
  ok(hourHead.length > 0 && hourHead.includes('hint={t(hourMeasure === "turns" ? "hour.hintTurns" : "hour.hint")}'), "「时刻分析」说明走 CardHead.hint，并随口径切换文案");
  ok(byDayBlock.includes('<CardHead title={t("pie.model")} hint={t("pie.modelHint")} />'), "「模型 Token 占比」小标题改为 CardHead.hint（与另两张卡同一位置）");
  ok(byDayBlock.includes('<CardHead title={t("pie.title")}>') && !byDayBlock.includes('hint={t("pie.byTime")}'), "「工作区占比」标题下方不再挂口径 hint（口径由右上 chips 表达）");
  ok(!/<p className="wl-hint">\s*<\/p>/.test(clientSource), "没有留下空提示标签");
  // 长文案检查：直接按行取字典里的值长度，避免动态正则转义
  const zhLines = localesSource.slice(zhStart, enStart).split("\n");
  const longKeys = zhKeys.filter((key) => {
    const line = zhLines.find((item) => item.trim().startsWith(`"${key}":`));
    if (line === undefined) return false;
    const value = line.slice(line.indexOf(":") + 1).trim().replace(/,$/, "");
    return value.length > 80;
  });
  ok(longKeys.length === 0, "没有超长文案（>80 字，发布前应压短）", longKeys.join(", "));
  // 卡片说明：只讲"看什么"，每条 ≤ 约 18 个汉字；口径细节留给 tooltip / 报告 footer
  const hintKeys = ["chart.hint", "hour.hint", "hour.hintTurns", "pie.modelHint", "model.hint"];
  const cjkCount = (text) => (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  const hintValue = (key) => {
    const line = zhLines.find((item) => item.trim().startsWith(`"${key}":`));
    return line === undefined ? null : line.slice(line.indexOf(":") + 1).trim().replace(/,$/, "").replace(/^"|"$/g, "");
  };
  ok(hintKeys.every((key) => zhKeys.includes(key) && enKeys.includes(key)), "三张卡的说明键 zh/en 齐全（逐键对齐）");
  const longHints = hintKeys.filter((key) => cjkCount(hintValue(key) ?? "") > 18);
  ok(longHints.length === 0, "卡片说明 ≤ 18 个汉字（只解释看什么）", longHints.map((key) => `${key}=${hintValue(key)}`).join(", "));
  ok(hintKeys.every((key) => clientSource.includes(`"${key}"`) || clientSource.includes(`t("${key}")`)), "说明键全部在客户端被引用（无死键）");
}

console.log("\n—— 时刻卡片（默认 Tokens / chips / 顶部密度点）——");
{
  const clientSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const statusSource = await readFile(new URL("../src/client/hour-status.js", import.meta.url), "utf8");
  const stylesSource = await readFile(new URL("../src/client/styles.js", import.meta.url), "utf8");
  const reportSource = await readFile(new URL("../src/report-html.js", import.meta.url), "utf8");
  const hostSource = await readFile(new URL("../index.js", import.meta.url), "utf8");
  ok(/useState\("tokens"\)/.test(clientSource), "默认 measure = Tokens");
  ok(clientSource.includes('data-measure="tokens"') && clientSource.includes('data-measure="turns"'), "两个 measure chips 都在 DOM（Tokens / 轮次）");
  ok(/onClick=\{\(\) => setHourMeasure\("tokens"\)\}/.test(clientSource) && /onClick=\{\(\) => setHourMeasure\("turns"\)\}/.test(clientSource), "chips 点击切换 measure 状态");
  ok(/hourMeasure === "tokens"/.test(clientSource) && /hourMeasure === "turns"/.test(clientSource), "chip 选中态跟随 measure");
  ok(/className="wl-hour-grid"/.test(clientSource) && !clientSource.includes("hour.sub"), "卡片头无小标题、图表仍是 24 列网格");
  ok(/\.wl-hour-card \{[^}]*display: flex[^}]*flex-direction: column/s.test(stylesSource) && /\.wl-hour-grid \{[^}]*flex: 1 1 auto/s.test(stylesSource) && /\.wl-hour-grid \{[^}]*min-height: 240px/s.test(stylesSource) && /\.wl-grid-2 > \.wl-pie-card \{[^}]*display: flex/s.test(stylesSource), "图表区 flex 填充卡片（最小 240px），右侧饼图同行拉伸并居中");
  ok(/\.wl-hour-track \{[^}]*top: 64px/s.test(stylesSource) && /\.wl-hour-track \{[^}]*bottom: 16px/s.test(stylesSource) && !/\.wl-hour-track \{[^}]*height: 116px/s.test(stylesSource), "柱形区从顶部 64px 撑到底部 16px（随卡片高度伸缩）");
  ok(/\.wl-hour-col\[data-peak\] \.wl-hour-fill \{[^}]*var\(--dsw-static-blue-600/s.test(stylesSource) && /\.wl-hour-dot \{[^}]*var\(--dsw-static-amber-500/s.test(stylesSource) && /\.wl-hour-legend \.wl-legend-peak \{[^}]*var\(--dsw-static-blue-600/s.test(stylesSource) && /peak: "#2f4bd8"/.test(reportSource) && /isPeak \? palette\.peak : palette\.input/.test(reportSource), "峰值柱/图例用深蓝 token，人类消息点用 amber token（报告同色）");
  ok(/\.wl-hour-dot \{[^}]*top: 14px/s.test(stylesSource), "密度点 CSS 上沿固定 14px");
  ok(clientSource.includes("hourDotRadius") && clientSource.includes("hour.dotTip"), "密度点用统一半径函数，并带「小时 + 人类消息条数」title");
  ok(clientSource.includes("wl-hour-legend") && clientSource.includes("hour.legend.tokens") && clientSource.includes("hour.legend.humans") && clientSource.includes("hour.legend.peak"), "图例三项：Token 产出 / 人类消息密度 / 峰值");
  ok(clientSource.includes("data-kind=\"hour-tokens-missing\"") && statusSource.includes("hour.missingTokens"), "读不出事件的会话在卡片里标注「未计入 N 个会话」");
  // 状态提示判据：只读 diagnostics（modelFold / hourTokensSource），不在组件里写死
  const tZh = (key, vars) => translate("zh", key, vars);
  const runningNote = hourTokensNote({ modelFold: { running: true }, hourTokensSource: { missing: 4 } }, tZh, String);
  eq(runningNote?.state, "running", "回填/重折进行中 → running");
  eq(runningNote?.text, "正在计算中……", "回填/重折进行中文案");
  const idleNote = hourTokensNote({ modelFold: { running: false }, hourTokensSource: { missing: 4 } }, tZh, (value) => formatInt(value));
  eq(idleNote?.state, "idle", "空闲且有未计入 → idle");
  eq(idleNote?.text, "Token 未计入 4 个会话", "空闲且 N>0 文案（N 来自 diagnostics）");
  eq(hourTokensNote({ modelFold: { running: false }, hourTokensSource: { missing: 0 } }, tZh, String), null, "空闲且 N=0：整条不渲染（返回 null）");
  ok(statusSource.includes("diagnostics?.modelFold") && statusSource.includes("hourTokensSource?.missing"), "状态判据来自 diagnostics，不写死");
  ok(/\.wl-hour-legend \{[^}]*justify-content: space-between/s.test(stylesSource), "图例行 space-between（左侧图例、右侧状态）");
  ok(/\.wl-hour-legend \.wl-status \{[^}]*margin-left: auto/s.test(stylesSource), "状态提示靠右对齐");
  ok(reportSource.includes("hourDotRadius") && reportSource.includes("人类消息密度") && reportSource.includes("Token 产出"), "报告时刻图同步 Tokens 口径与密度点");
  ok(/const INDEX_VERSION = 7\b/.test(hostSource), "INDEX_VERSION 6 → 7（新增字段必须重折）");
  ok(hostSource.includes('"hourTokens"') && hostSource.includes('"hourHumanMsgs"') && /MODEL_ROW_FIELDS[\s\S]{0,400}hourTokens/.test(hostSource), "hourTokens / hourHumanMsgs 随行持久化并由 carryModelFields 搬运");
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
  ok(!declared.has("deepseekAccount"), "deepseekAccount 用 ctx.get 可选获取，不写进必需 inject（老版 DSH 不会挂起等待）");
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
    // 官方 readSession()：模型维度用它读事件日志（stub 给每个会话一条 assistant/message）
    readSession: async (id) => ({
      session: records.find((r) => r.header.id === id)?.header ?? {},
      inheritedEventCount: 0,
      events: [
        {
          type: "assistant/message",
          seq: 1,
          time: Date.UTC(2026, 9, 14, 2),
          data: {
            turn: 1,
            step: 1,
            message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
            stream: [{ type: "chunk", time: Date.UTC(2026, 9, 14, 2) }, { type: "chunk", time: Date.UTC(2026, 9, 14, 2) + 500 }],
          },
        },
      ],
    }),
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

/** 在指定路由表上发一次请求（多实例测试用；call 默认打第一条路由）。 */
function callOn(routeList, url, method = "GET") {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 0,
      headers: {},
      body: "",
      writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
      end(chunk) { if (chunk) this.body += chunk; resolve({ status: this.statusCode, headers: this.headers, body: this.body }); },
    };
    try {
      routeList[0].handler({ method, url }, res);
    } catch (error) {
      reject(error);
    }
  });
}

/** 轮询 /health 直到条件满足。 */
async function waitHealth(routeList, predicate, label) {
  for (let i = 0; i < 300; i += 1) {
    const body = JSON.parse((await callOn(routeList, "/workload-report/v1/health")).body);
    if (predicate(body)) return body;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等待超时：${label}`);
}

/** 触发一次强制重扫并等它**真正跑完**（refresh 同步在后台跑，请求不等它）。 */
async function forceRescan(routeList) {
  await callOn(routeList, "/workload-report/v1/snapshot?days=30&tz=UTC&refresh=1");
  return waitHealth(routeList, (body) => body.diagnostics.syncing === false && body.diagnostics.lastSyncAt > 0, "重扫完成");
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

// ---------------------------------------------------------------- 模型维度（0.4.0）
console.log("\n—— 模型归并与峰谷 ——");
eq(groupKeyFor("deepseek-official", "deepseek-flash"), "deepseek-v4-flash", "deepseek-flash 归并到 deepseek-v4-flash（官方注 1：legacy 名）");
eq(groupKeyFor("deepseek-official", "deepseek-v4-flash"), "deepseek-v4-flash", "legacy 名 deepseek-v4-flash 同样归并");
eq(groupKeyFor("moonshotai-cn", "kimi-k3"), "moonshotai-cn/kimi-k3", "其它模型保持 provider/model");
eq(groupKeyFor("", ""), UNKNOWN_MODEL, "缺 provider/model 归入未标注桶");
eq(groupKeyFor("acme", "x", { "my-group": ["x"] }), "my-group", "用户自定义归并规则生效");
eq(groupKeyFor("acme", "x", [{ group: "g2", match: ["x"] }]), "g2", "数组形式的自定义规则同样生效");
eq(modelLabel("deepseek-v4-flash", {}), "deepseek-v4-flash", "展示名默认取组名");
eq(modelLabel("moonshotai-cn/kimi-k3", {}), "kimi-k3", "展示名去掉 provider 前缀");
eq(modelLabel("moonshotai-cn/kimi-k3", { "moonshotai-cn/kimi-k3": "K3 旗舰" }), "K3 旗舰", "别名优先");
eq(isPeak(Date.UTC(2026, 9, 14, 2)), true, "02:00 UTC 周三 → 峰时");
eq(isPeak(Date.UTC(2026, 9, 14, 12)), false, "12:00 UTC 周三 → 谷时");
eq(isPeak(Date.UTC(2026, 9, 17, 2)), false, "周六 02:00 → 谷时（周末全谷）");

console.log("\n—— 事件折叠 ——");
const mkAssistant = (seq, time, provider, model, usage, streamSpan) => ({
  type: "assistant/message", seq, time,
  data: {
    turn: 1, step: 1,
    message: { role: "assistant", source: { kind: "model", provider, model } },
    ...(usage === null ? {} : { usage }),
    stream: streamSpan === undefined ? [] : [{ type: "chunk", time }, { type: "chunk", time: time + streamSpan }],
  },
});
const mkHeader = (seq, time, provider, model, effort) => ({ type: "request/header", seq, time, data: { header: { config: { provider, model, reasoningEffort: effort } } } });
const peakTime = Date.UTC(2026, 9, 14, 2); // 周三 02:00 UTC = 峰时
const offTime = Date.UTC(2026, 9, 14, 12); // 周三 12:00 UTC = 谷时
const foldEvents = [
  mkAssistant(1, peakTime, "deepseek-official", "deepseek-v4-flash", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 9000, cacheWriteTokens: 0 }, 600),
  mkAssistant(2, offTime, "deepseek-official", "deepseek-flash", { inputTokens: 2000, outputTokens: 200, cacheReadTokens: 18000, cacheWriteTokens: 0 }, 400),
  mkAssistant(3, offTime, "deepseek-official", "deepseek-flash", null, 300), // 缺 usage：计请求不计 token
  mkAssistant(4, peakTime, "deepseek-official", "deepseek-v4-pro", { inputTokens: 500, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0 }, 1000),
  mkHeader(5, peakTime, "deepseek-official", "deepseek-v4-flash", "max"),
  mkHeader(6, offTime, "deepseek-official", "deepseek-flash", "max"),
  mkHeader(7, offTime, "deepseek-official", "deepseek-v4-pro", "high"),
];
const folded = foldSessionModels(foldEvents, { sessionLlmMs: 1000 });
const flash = folded.models["deepseek-v4-flash"];
const pro = folded.models["deepseek-official/deepseek-v4-pro"];
eq(flash.requests, 3, "归并后 flash 请求数 3（含 1 次缺 usage）");
eq(folded.models["deepseek-official/deepseek-flash"], undefined, "旧名不再单独成桶（已归并）");
eq(pro.requests, 1, "pro 请求数 1");
eq(flash.inPeak, 1000, "峰时输入计入 inPeak");
eq(flash.inOff, 2000, "谷时输入计入 inOff");
eq(flash.crPeak + flash.crOff, 27000, "缓存读合计正确");
eq(flash.outPeak + flash.outOff, 300, "输出合计正确");
eq(folded.unknownRequests, 1, "缺 usage 的请求被记录（不猜 token）");
eq(flash.efforts.max, 2, "思考强度 max 计数 2");
eq(pro.efforts.high, 1, "思考强度 high 计数 1");
eq(flash.raw["deepseek-official/deepseek-flash"], 1, "原始组成：legacy 名保留（明细可展开）");
eq(flash.raw["deepseek-official/deepseek-v4-flash"], 1, "原始组成：新名保留");
eq(Math.round(flash.llmMs + pro.llmMs), 1000, "各模型耗时之和 = 会话 llmMs（守恒）");
eq(flash.llmMs, 500, "按流式窗口分摊：flash 500（窗口 1000 vs 1000）");
eq(modelTokens(flash), 1000 + 2000 + 100 + 200 + 9000 + 18000, "模型 token 合计正确");
ok(Math.abs(cacheHitRate(flash) - 27000 / 30000) < 1e-9, "缓存命中率 = 缓存读 /(缓存读+未命中输入)");
eq(cacheHitRate(emptyModelBucket()), null, "无数据时命中率为 null（显示 —）");

console.log("\n—— 耗时分摊与官方价目 ——");
const onlyOne = foldSessionModels([mkAssistant(1, peakTime, "p", "m", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0 })], { sessionLlmMs: 777 });
eq(onlyOne.models["p/m"].llmMs, 777, "单模型无流式窗口：全部时间归它（守恒）");
const noStream = foldSessionModels([
  mkAssistant(1, peakTime, "p", "m1", { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  mkAssistant(2, peakTime, "p", "m2", { inputTokens: 3, outputTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 }),
], { sessionLlmMs: 1000 });
ok(Math.abs(noStream.models["p/m1"].llmMs + noStream.models["p/m2"].llmMs - 1000) < 1e-9, "无流式数据时按请求数分摊（守恒）");
const cny = resolvePricing({});
ok(cny.currency === "CNY" && cny.asOf === DEFAULT_PRICING.asOf, "默认币种 CNY 且带 as-of");
eq(costOf({ key: "deepseek-v4-flash", inPeak: 1e6, inOff: 1e6, outPeak: 1e6, outOff: 1e6, crPeak: 1e6, crOff: 1e6, cwOff: 0, cwPeak: 0 }, cny), 15.06, "flash 峰谷各半 1M×6 → ¥15.06");
eq(costOf({ key: "moonshotai-cn/kimi-k3", inOff: 1e6 }, cny), null, "未配置单价的模型返回 null（不编数字）");
eq(costOf({ key: "deepseek-official/deepseek-v4-pro", inOff: 1e6, outOff: 0, inPeak: 0, outPeak: 0, crOff: 0, crPeak: 0, cwOff: 0, cwPeak: 0 }, cny), 4.5, "带 provider 前缀的 key 也能命中价目（回退到裸模型名）");
const usd = resolvePricing({ currency: "USD" });
eq(costOf({ key: "deepseek-v4-flash", inOff: 1e6, crOff: 0, outOff: 0, inPeak: 0, crPeak: 0, outPeak: 0, cwOff: 0, cwPeak: 0 }, usd), 0.15, "USD 价目生效（$0.15/1M 未命中输入）");
const overridden = resolvePricing({ overrides: { "moonshotai-cn/kimi-k3": { miss: { off: 2, peak: 4 }, output: { off: 8, peak: 16 } } } });
eq(costOf({ key: "moonshotai-cn/kimi-k3", inOff: 1e6, outOff: 1e6, inPeak: 0, outPeak: 0, crOff: 0, crPeak: 0, cwOff: 0, cwPeak: 0 }, overridden), 10, "用户覆盖单价生效（2 + 8）");
ok(cny.links.length >= 3 && cny.links[0].url.includes("deepseek"), "官方计费链接随价目一起下发");

console.log("\n—— 模型维度接入聚合 ——");
const modelRows = [
  { ...makeRow({ id: "m1", cwd: "/Users/me/proj-a", createdAt: base, turns: 3, steps: 5, llmMs: 2000, toolMs: 1000, input: 3500, output: 350, cacheRead: 28000 }), models: folded.models },
  { ...makeRow({ id: "m2", cwd: "/Users/me/proj-b", createdAt: base - 24 * HOUR, turns: 1, steps: 2, llmMs: 500, toolMs: 100, input: 100, output: 10, cacheRead: 900 }), models: { "moonshotai-cn/kimi-k3": { requests: 2, turns: 1, inOff: 100, inPeak: 0, outOff: 10, outPeak: 0, crOff: 900, crPeak: 0, cwOff: 0, cwPeak: 0, streamMs: 100, llmMs: 500, efforts: { high: 2 }, raw: { "moonshotai-cn/kimi-k3": 2 } } } },
];
const modelSnap = present(aggregate(modelRows, { days: 30, timeZone: "Asia/Shanghai", now: base, pricing: cny, activeModelMetric: "requests" }));
eq(modelSnap.byModel.length, 3, "byModel 三行（flash / pro / kimi）");
eq(modelSnap.byModel[0].key, "deepseek-v4-flash", "默认按请求数排序：flash 第一（3 次）");
eq(modelSnap.topModel.key, "deepseek-v4-flash", "topModel = flash");
eq(modelSnap.topModel.metric, "requests", "topModel 口径 = requests");
ok(Math.abs(modelSnap.byModel.reduce((s, m) => s + m.tokensTotal, 0) - modelSnap.totals.tokensTotal) < 1e-9, "各模型 token 之和 = 总 Token（守恒）");
ok(Math.abs(modelSnap.byModel.reduce((s, m) => s + m.share, 0) - 1) < 1e-9, "模型占比之和 = 1");
const tokenSnap = present(aggregate(modelRows, { days: 30, timeZone: "Asia/Shanghai", now: base, pricing: cny, activeModelMetric: "tokens" }));
eq(tokenSnap.topModel.key, "deepseek-v4-flash", "切到 tokens 口径后仍是 flash（量最大）");
const llmSnap = present(aggregate(modelRows, { days: 30, timeZone: "Asia/Shanghai", now: base, pricing: cny, activeModelMetric: "activeMs" }));
eq(llmSnap.topModel.metric, "llmMs", "activeMs 口径归一化为 llmMs");
ok(modelSnap.modelDaily.length === modelSnap.byDay.length, "modelDaily 与 byDay 天数对齐");
ok(modelSnap.modelDaily.every((day) => Object.keys(day.values).length >= 0), "modelDaily 每日结构完整");
eq(modelSnap.pricing.costed.covered, 2, "费用覆盖度：2/3 有官方价（kimi 无价）");
ok(modelSnap.pricing.totalCost !== null && modelSnap.pricing.totalCost > 0, "总费用为已知单价模型的合计（> 0）");

console.log("\n—— 报告与路由中的模型维度 ——");
const reportWithModels = renderReport(modelSnap, { theme: "light", title: "测试报告" });
ok(reportWithModels.includes("模型用量"), "报告含「模型用量」一节");
ok(reportWithModels.includes('class="treemap"'), "报告含 treemap 图");
ok(reportWithModels.includes("模型占比 · 面积 = Token"), "treemap 带口径小标题（模型占比 · 面积 = Token）");
ok(reportWithModels.includes("按日模型趋势"), "按日趋势带小标题（与看板 h4 同位置）");
ok(reportWithModels.includes("api-docs.deepseek.com"), "报告 footer 给出官方计费链接");
ok(reportWithModels.includes("官方计费标准"), "报告 footer 标注官方计费标准");
ok(reportWithModels.includes("deepseek-v4-flash"), "报告列出模型名");
ok(reportWithModels.includes(">模型费用<"), "报告 KPI 增加「模型费用」（与看板同标签）");
ok(reportWithModels.includes("最活跃模型") && reportWithModels.includes("请求占比"), "报告 KPI 增加「最活跃模型」（与看板同口径）");
ok(reportWithModels.includes("个模型有官方价"), "模型费用 KPI 副标题给出价目覆盖度");
ok(reportWithModels.includes('aria-label="每日活跃时长"'), "报告每日趋势＝单序列活跃时长（与看板柱状图一致）");
ok(!reportWithModels.includes("<polyline"), "报告每日趋势去掉了折线");
ok(reportWithModels.includes("（周末）"), "报告每日趋势周末柱异色（tooltip 标出周末）");
ok(reportWithModels.includes(">周末<") && reportWithModels.includes("#f59e0b"), "报告图例给出周末色");
{
  const hrefs = [...reportWithModels.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  ok(
    hrefs.length >= 3 && hrefs.every((href) => /^https:\/\/(api-docs\.deepseek\.com|platform\.kimi\.com|platform\.claude\.com)\//.test(href)),
    "报告的外链只有官方计费页（其余全部内联）",
    hrefs.join(" · "),
  );
  ok(!/<script|src=|<link /i.test(reportWithModels), "报告仍然无脚本 / 无外链资源（自包含）");
}

console.log("\n—— 报告结构对齐（看板 → 报告）——");
{
  // 回填中：状态行必须显示「正在计算中……」；数据用模型快照，时刻 / 日历 / KPI 都有内容。
  const runningSnap = {
    ...modelSnap,
    // 密度点需要人类消息数据：给 9 点补一条，保证结构断言不依赖测试数据是否恰好有 humanMsgs
    byHour: modelSnap.byHour.map((hour) => (hour.hour === 9 ? { ...hour, humanMsgs: 4 } : hour)),
    diagnostics: { modelFold: { running: true }, hourTokensSource: { missing: 3 } },
  };
  const parityHtml = renderReport(runningSnap, { theme: "light", title: "对齐报告" });
  ok(parityHtml.includes('data-kind="hour-dot"'), "结构：时刻图有人类消息密度点（data-kind=hour-dot）");
  ok(parityHtml.includes("Tokens 口径") && parityHtml.includes("Token 产出"), "结构：时刻图明确默认 Tokens 口径");
  ok(parityHtml.includes("轮次（该小时开始的会话数）") && parityHtml.includes('aria-label="时刻分析：轮次"'), "结构：轮次作为第二张小图呈现（不伪造切换按钮）");
  ok(!parityHtml.includes("wl-chip") && !parityHtml.includes("<button"), "结构：报告没有看板切换控件 / 按钮");
  ok(parityHtml.includes('data-kind="hour-tokens-missing"') && parityHtml.includes('data-state="running"') && parityHtml.includes("正在计算中……"), "结构：回填中状态行显示「正在计算中……」");
  ok(/<div class="card-head">[\s\S]{0,80}<div class="card-head-text"><h2>[^<]+<\/h2><span class="card-hint"/.test(parityHtml), "结构：卡片说明在标题右侧（card-head-text 内）");
  ok(!parityHtml.includes('class="hint"') && !/<p class="hint">/.test(parityHtml), "结构：标题下方不再有旧 hint 段落");
  ok(/\.card-hint \{[^}]*font-size: 11px/.test(parityHtml) && /\.card-hint \{[^}]*color: #6b7280/.test(parityHtml), "结构：标题右侧说明 11px + muted（与看板同字号/同色）");
  ok(parityHtml.includes('data-kind="calendar-cell"') && parityHtml.includes('data-kind="weekday-bar"'), "结构：每日趋势含日历热力图 + 周几累计条");
  ok(parityHtml.includes('data-kind="peak-label"') && parityHtml.includes('data-kind="active-bar-hit"'), "结构：柱状图有峰值标签与全高命中区 tooltip");
  ok(parityHtml.includes("data-bar-cell") && /class="bar-cell-fill"[^>]*style="width:[0-9.]+%;background:/.test(parityHtml), "结构：表格比例条与看板同规则（宽度百分比 + 内联背景条）");
  ok(parityHtml.includes("模型占比 · 面积 = Token") && parityHtml.includes("按日模型趋势"), "结构：模型 treemap / 按日趋势都有小标题");
  ok(parityHtml.includes("最活跃模型") && parityHtml.includes("请求占比") && parityHtml.includes("模型费用"), "结构：KPI 含「模型费用」与「最活跃模型」");
  ok(parityHtml.includes("含等待用户") && parityHtml.includes("净活跃"), "结构：KPI / footer 写清净活跃与含等待用户口径");
  {
    const hrefs = [...parityHtml.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    ok(hrefs.every((href) => /^https:\/\/(api-docs\.deepseek\.com|platform\.kimi\.com|platform\.claude\.com)\//.test(href)), "结构：报告外链仅官方计费页", hrefs.join(" · "));
    ok(!/<script|<link |\ssrc=/i.test(parityHtml), "结构：报告无脚本 / 无外链资源（自包含）");
  }
  // 空闲 + 有未计入会话：状态行回到「Token 未计入 N 个会话」
  const idleSnap = {
    ...modelSnap,
    byHour: runningSnap.byHour,
    diagnostics: { modelFold: { running: false }, hourTokensSource: { missing: 3 } },
  };
  const idleHtml = renderReport(idleSnap, { theme: "dark" });
  ok(idleHtml.includes('data-state="idle"') && idleHtml.includes("Token 未计入 3 个会话"), "结构：空闲时状态行显示「Token 未计入 N 个会话」");
  ok(!idleHtml.includes("正在计算中……"), "结构：空闲时不残留「正在计算中……」");
}

const snapRes = await call("/workload-report/v1/snapshot?days=30&tz=UTC");
const snapJson = JSON.parse(snapRes.body);
ok(Array.isArray(snapJson.byModel), "/snapshot 返回 byModel 数组");
ok(Array.isArray(snapJson.modelDaily), "/snapshot 返回 modelDaily 数组");
ok(snapJson.pricing !== undefined && Array.isArray(snapJson.pricing.links), "/snapshot 返回官方价目与链接");
ok(snapJson.diagnostics.modelUsage === true, "诊断里带 modelUsage 开关状态");
ok(
  snapJson.hourSource !== undefined && typeof snapJson.hourSource.events === "number" && typeof snapJson.hourSource.apportioned === "number",
  "/snapshot 顶层暴露 hourSource（时刻分布来源诊断）",
);
ok(
  JSON.stringify(snapJson.diagnostics.hourSource) === JSON.stringify(snapJson.hourSource),
  "diagnostics.hourSource 与顶层 hourSource 同源",
);
// 0.4.1 修复点：回填完成（pending = 0）后模型区必须有数据。
// 0.4.0 的缺陷是：已折过的行只要 asOfSeq 前进就重新计入 pending → 界面永远"回填中"。
{
  const foldReady = await waitHealth(routes, (body) => body.diagnostics.modelFold.running === false && body.diagnostics.modelFold.pending === 0, "模型回填完成");
  eq(foldReady.diagnostics.modelFold.pending, 0, "回填完成后 /health modelFold.pending = 0");
  ok(
    typeof foldReady.diagnostics.modelFold.refold === "number" && typeof foldReady.diagnostics.modelFold.failedRows === "number",
    "诊断把 pending / refold / failedRows 分开（已折过的不再混进 pending）",
    JSON.stringify(foldReady.diagnostics.modelFold),
  );
  const modelApi = JSON.parse((await call("/workload-report/v1/snapshot?days=30&tz=UTC")).body);
  ok(modelApi.byModel.length > 0, "回填完成后 /snapshot 模型区有数据", JSON.stringify(modelApi.byModel.map((m) => m.key)));
  const hs = modelApi.hourSource;
  eq(hs.events + hs.scaled + hs.apportioned, modelApi.totals.sessions, "hourSource 三项之和 = 会话数（每行恰好一种来源）");
  eq(hs.scaled, modelApi.totals.sessions, "stub 事件只有 stream 窗口：全部按 events-scaled 落库");
}

// ---------------------------------------------------------------- 模型折叠生命周期（0.4.1 修复）
console.log("\n—— 模型折叠生命周期（pending 语义 / 行换代不丢 / 重启复用）——");
const LIFECYCLE_INDEX = `/tmp/wl-verify-lifecycle-${process.pid}.json`;
await rm(LIFECYCLE_INDEX, { force: true }).catch(() => {});

/** 折叠用的事件：一条 assistant/message（带 usage 与流式窗口）。 */
const lifecycleEvent = (model) => ({
  type: "assistant/message", seq: 1, time: Date.UTC(2026, 9, 14, 2),
  data: {
    turn: 1, step: 1,
    message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model } },
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
    stream: [{ type: "chunk", time: 0 }, { type: "chunk", time: 400 }],
  },
});

/**
 * 起一个隔离宿主实例（独立路由表 + 独立索引文件）：
 *   L1 检查点可用；L2 可切成活会话；L3 的 readSession 永远抛错（真实世界的旧格式日志）。
 */
function bootLifecycle() {
  const routeList = [];
  const state = { live: false, reads: 0, listener: null };
  const lcRecords = ["L1", "L2", "L3"].map((id) => ({
    header: { id, createdAt: base, cwd: "/tmp/lc", isSeeded: false, version: 4 }, live: false, persisted: true,
  }));
  const values = (id) => ({
    sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 },
    tokenUsage: { uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
    title: id,
  });
  const lcSnapshots = { L1: { asOfSeq: 10, values: values("L1") }, L2: { asOfSeq: 20, values: values("L2") } };
  const lcCtx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { state.listener = listener; return () => {}; },
    sessions: { get: (id) => (state.live && id === "L2" ? { id: "L2", header: lcRecords[1].header } : undefined) },
    sessionProjections: { snapshot: () => ({ asOfSeq: lcSnapshots.L2.asOfSeq, values: lcSnapshots.L2.values }) },
    sessionQuery: {
      listSessions: async () => lcRecords,
      // L3 也能从投影拿到 Token（只是事件日志读不出）：用来验证「时间图未计入但总量仍含它」
      observeSession: async (id) => ({ header: lcRecords.find((r) => r.header.id === id).header, projections: { asOfSeq: 5, values: values(id) }, dispose() {} }),
      readSession: async (id) => {
        state.reads += 1;
        if (id === "L3") throw new Error("unsupported descriptor version 2");
        return { session: {}, inheritedEventCount: 0, events: [lifecycleEvent(id === "L2" ? "deepseek-v4-pro" : "deepseek-flash")] };
      },
    },
    sessionProjectionCache: { cachedSnapshot: (header) => lcSnapshots[String(header.id)] },
    webServer: { register(spec) { routeList.push(spec); return () => {}; } },
  };
  apply(lcCtx, { indexPath: LIFECYCLE_INDEX });
  return { routeList, state, lcSnapshots, lcRecords };
}

const first = bootLifecycle();
const settledFold = await waitHealth(first.routeList, (body) => body.indexing === false && body.diagnostics.modelFold.running === false && body.diagnostics.modelFold.pending === 0, "首次回填完成");
eq(settledFold.diagnostics.modelFold.pending, 0, "首次回填完成后 pending = 0");
eq(settledFold.diagnostics.modelFold.failedRows, 1, "读日志失败的会话单独计入 failedRows（不混进 pending）");
ok(String(settledFold.diagnostics.modelFold.lastError ?? "").includes("unsupported descriptor"), "/health 暴露 modelFold.lastError（能直接定位到会话与原因）");
ok(typeof settledFold.diagnostics.modelFold.lastErrorAt === "number" && settledFold.diagnostics.modelFold.lastErrorAt > 0, "lastError 带时间戳");
const lifecycleSnap = JSON.parse((await callOn(first.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
eq(lifecycleSnap.byModel.length, 2, "回填后 /snapshot.byModel 有两个模型（L2 pro + L1 flash）");
// 小时 Token：L1/L2 可读（事件 usage 420 → 按官方 115 回正，events-scaled）；L3 读不出 → missing
const lifecycleTokens = lifecycleSnap.byHour.reduce((sum, hour) => sum + hour.tokensTotal, 0);
eq(lifecycleSnap.diagnostics.hourTokensSource.scaled, 2, "宿主诊断：2 行小时 Token 走 events-scaled");
eq(lifecycleSnap.diagnostics.hourTokensSource.missing, 1, "宿主诊断：1 行读不出事件 → hourTokensSource.missing");
eq(lifecycleSnap.byHour[2].tokensTotal, 230, "宿主：小时 Token 落在消息时间（UTC 02 点）230");
eq(lifecycleTokens, lifecycleSnap.totals.tokensTotal - 115, "宿主：未计入会话的 Token 不进入 byHour（345 − 115）");
eq(lifecycleSnap.byHour[2].humanMsgs, 0, "宿主：该会话没有 user/message，humanMsgs = 0");
const readsAfterFirst = first.state.reads;
eq(readsAfterFirst, 3, "首次回填把 3 个会话各读一次（含 1 个失败）");

// 行换代不丢：refresh 重扫会用投影重建每一行（检查点命中），折叠结果必须原样带过来
await forceRescan(first.routeList);
const rescanned = JSON.parse((await callOn(first.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
eq(rescanned.byModel.length, 2, "重扫（行被投影重建）后模型数据仍在");
eq(first.state.reads, readsAfterFirst, "重扫不重读日志（已折过的不重折）");
eq(rescanned.diagnostics.modelFold.pending, 0, "重扫后 pending 仍为 0");

// 活会话水位 +1：不重折、pending 不涨（0.4.0 就是在这里永远 pending）
first.state.live = true;
first.lcSnapshots.L2.asOfSeq += 1;
first.state.listener({ id: "L2", header: first.lcRecords[1].header }, { type: "step/end" });
const liveFold = await waitHealth(first.routeList, (body) => body.diagnostics.modelFold.running === false, "活会话增量");
eq(liveFold.diagnostics.modelFold.pending, 0, "活会话 asOfSeq +1 后 pending 仍为 0（水位阈值生效）");
eq(liveFold.diagnostics.modelFold.refold, 0, "活会话只前进 1 个水位：不触发重折");
eq(JSON.parse((await callOn(first.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body).byModel.length, 2, "活会话增量更新后模型数据没被清掉");

// 会话转冷后水位前进：进重折队列，但**不算 pending**（界面提示不复活）
first.state.live = false;
first.lcSnapshots.L2.asOfSeq += 1;
await forceRescan(first.routeList);
const coldFold = await waitHealth(first.routeList, (body) => body.diagnostics.modelFold.refold >= 1, "转冷后水位前进进入重折队列");
eq(coldFold.diagnostics.modelFold.refold, 1, "会话转冷后水位前进：进入重折队列");
eq(coldFold.diagnostics.modelFold.pending, 0, "重折不计入 pending（界面不再显示「回填中」）");
eq(JSON.parse((await callOn(first.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body).byModel.length, 2, "待重折的行仍有旧数据可用");

// 重启：换实例读同一份索引 —— 模型数据原样回来，且一次日志都不重读
const second = bootLifecycle();
const restartedFold = await waitHealth(second.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0 && body.diagnostics.modelFold.running === false, "重启实例索引就绪");
eq(restartedFold.diagnostics.modelFold.pending, 0, "重启后 pending = 0（模型数据从索引缓存读回）");
eq(restartedFold.diagnostics.modelFold.done, 0, "重启后没有重新折叠任何会话");
eq(second.state.reads, 0, "重启后一次 readSession 都没发生（不重折全部）");
const restartSnap = JSON.parse((await callOn(second.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
eq(restartSnap.byModel.length, 2, "重启后模型区仍有数据");
eq(restartSnap.diagnostics.modelFold.failedRows, 1, "重启后失败行数也从索引缓存读回");
ok(
  String(restartSnap.diagnostics.modelFold.lastError ?? "").includes("unsupported descriptor") && restartSnap.diagnostics.modelFold.lastErrorAt > 0,
  "重启后 /health 仍能看到失败原因与时间（从索引缓存读回，不需要重试一次才知道）",
  String(restartSnap.diagnostics.modelFold.lastError),
);
await rm(LIFECYCLE_INDEX, { force: true }).catch(() => {});

// ---------------------------------------------------------------- 等待用户剔除的宿主配置（0.6.5）
console.log("\n—— 等待用户剔除的宿主配置（excludeWait）——");

/** 起一个隔离宿主实例：投影 llmMs=20min / toolMs=180min，事件里有一段 3h 的 ask_user_question。 */
function bootWaitHost({ excludeWait, waitMinMs } = {}) {
  const routeList = [];
  const hostRecords = [{ header: { id: "W1", createdAt: Date.UTC(2026, 9, 14, 9), cwd: "/tmp/wait-host", isSeeded: false, version: 4 }, live: false, persisted: true }];
  const hostValues = {
    sessionStats: { turns: 2, steps: 2, llmMs: 20 * 60000, toolMs: 180 * 60000 },
    tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    title: "wait-host",
  };
  const hostEvents = [
    { type: "turn/start", seq: 1, time: Date.UTC(2026, 9, 14, 9), data: { turn: 1 } },
    {
      type: "request/header", seq: 2, time: Date.UTC(2026, 9, 14, 9),
      data: { turn: 1, header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } },
    },
    {
      type: "assistant/message", seq: 3, time: Date.UTC(2026, 9, 14, 9, 10),
      data: {
        turn: 1, step: 1,
        message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stream: [],
      },
    },
    { type: "tool/call", seq: 4, time: Date.UTC(2026, 9, 14, 9, 10), data: { turn: 1, step: 1, callId: "w", name: "ask_user_question", arguments: "{}" } },
    { type: "user/message", seq: 5, time: Date.UTC(2026, 9, 14, 10), data: { turn: 1, message: { role: "user", content: [] } } },
    { type: "tool/result", seq: 6, time: Date.UTC(2026, 9, 14, 12, 10), data: { turn: 1, step: 1, message: { role: "tool", source: { kind: "tool", callId: "w" }, content: [] } } },
    { type: "turn/start", seq: 7, time: Date.UTC(2026, 9, 14, 12, 10), data: { turn: 2 } },
    {
      type: "request/header", seq: 8, time: Date.UTC(2026, 9, 14, 12, 10),
      data: { turn: 2, header: { config: { provider: "deepseek-official", model: "deepseek-flash" } } },
    },
    {
      type: "assistant/message", seq: 9, time: Date.UTC(2026, 9, 14, 12, 20),
      data: {
        turn: 2, step: 1,
        message: { role: "assistant", source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        stream: [],
      },
    },
  ];
  const hostCtx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => undefined },
    sessionQuery: {
      listSessions: async () => hostRecords,
      observeSession: async () => ({ header: hostRecords[0].header, projections: { asOfSeq: 1, values: {} }, dispose() {} }),
      readSession: async () => ({ session: {}, inheritedEventCount: 0, events: hostEvents }),
    },
    sessionProjectionCache: { cachedSnapshot: () => ({ asOfSeq: 10, values: hostValues }) },
    webServer: { register(spec) { routeList.push(spec); return () => {}; } },
  };
  const config = {
    indexPath: "/tmp/wl-verify-wait-host-" + process.pid + "-" + String(excludeWait) + ".json",
    excludeWait,
  };
  if (waitMinMs !== undefined) config.waitMinMs = waitMinMs;
  apply(hostCtx, config);
  return { routeList, indexPath: config.indexPath };
}

const waitHost = bootWaitHost({ excludeWait: true });
await waitHealth(waitHost.routeList, (body) => body.indexing === false && body.diagnostics.modelFold.running === false && body.diagnostics.modelFold.pending === 0, "等待会话回填完成");
const waitHostSnap = JSON.parse((await callOn(waitHost.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
eq(waitHostSnap.totals.activeMs, 200 * 60000, "宿主（excludeWait=true）：官方 activeMs = 200min");
eq(waitHostSnap.totals.waitMs, 180 * 60000, "宿主（excludeWait=true）：waitMs = 180min");
eq(waitHostSnap.totals.netActiveMs, 20 * 60000, "宿主（excludeWait=true）：netActiveMs = 20min");
ok(Math.abs(waitHostSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - waitHostSnap.totals.netActiveMs) < 1, "宿主（excludeWait=true）：sum(byHour) === netActiveMs");
await rm(waitHost.indexPath, { force: true }).catch(() => {});

const noWaitHost = bootWaitHost({ excludeWait: false });
await waitHealth(noWaitHost.routeList, (body) => body.indexing === false && body.diagnostics.modelFold.running === false && body.diagnostics.modelFold.pending === 0, "不剔除等待的会话回填完成");
const noWaitHostSnap = JSON.parse((await callOn(noWaitHost.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
eq(noWaitHostSnap.totals.activeMs, 200 * 60000, "宿主（excludeWait=false）：activeMs = 200min");
eq(noWaitHostSnap.totals.waitMs, 0, "宿主（excludeWait=false）：waitMs = 0（与 0.6.0 一致）");
eq(noWaitHostSnap.totals.netActiveMs, 200 * 60000, "宿主（excludeWait=false）：netActiveMs === activeMs");
ok(Math.abs(noWaitHostSnap.byHour.reduce((acc, b) => acc + b.activeMs, 0) - noWaitHostSnap.totals.activeMs) < 1, "宿主（excludeWait=false）：sum(byHour) === activeMs（回归）");
await rm(noWaitHost.indexPath, { force: true }).catch(() => {});

// ---------------------------------------------------------------- 余额显示（0.5.0，默认关闭 + 可选依赖）
console.log("\n—— 余额显示（默认关闭 / 可选依赖）——");

/** 宿主 deepseekAccount 服务桩：getState / getBalance 都是本地桩，不联网。 */
function walletService({ balance, fail = false } = {}) {
  const spy = { balanceCalls: 0, stateCalls: 0 };
  return {
    spy,
    service: {
      async getState() {
        spy.stateCalls += 1;
        return { status: "credential-stored", attempt: null, links: { topUpUrl: "https://platform.deepseek.com/top_up", usageUrl: "https://platform.deepseek.com/usage" } };
      },
      async getBalance() {
        spy.balanceCalls += 1;
        if (fail) throw new Error("platform 502");
        return balance;
      },
    },
  };
}

/** 起一个隔离宿主实例；service 为 undefined = 老版 DSH（ctx.get 返回 undefined）。 */
function bootBalance({ enabled, refreshMs, service } = {}) {
  const routeList = [];
  const bRecords = [{ header: { id: "b1", createdAt: base, cwd: "/tmp/bal", isSeeded: false, version: 4 }, live: false, persisted: true }];
  const bCtx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    get: (name) => (name === "deepseekAccount" ? service : undefined),
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => undefined },
    sessionQuery: {
      listSessions: async () => bRecords,
      observeSession: async () => ({ header: bRecords[0].header, projections: { asOfSeq: 1, values: {} }, dispose() {} }),
      readSession: async () => ({ session: {}, inheritedEventCount: 0, events: [] }),
    },
    sessionProjectionCache: { cachedSnapshot: () => undefined },
    webServer: { register(spec) { routeList.push(spec); return () => {}; } },
  };
  const config = { indexPath: "/tmp/wl-verify-balance-" + process.pid + "-" + (bootBalance.seq++) + ".json" };
  if (enabled !== undefined) config.balance = { enabled };
  if (refreshMs !== undefined) config.balance.refreshMs = refreshMs;
  apply(bCtx, config);
  return { routeList, indexPath: config.indexPath };
}
bootBalance.seq = 1;

/** 打一条路由并解析 JSON。 */
async function routeJson(routeList, url) {
  const response = await callOn(routeList, url);
  return { status: response.status, body: JSON.parse(response.body) };
}

// 1) 默认关闭：服务在场也一次都不调用（spy = 0）
{
  const spy = walletService({ balance: { status: "ready", value: [{ currency: "CNY", balance: "12.34" }], bonusWallets: [] } });
  const host = bootBalance({ service: spy.service });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "默认关闭实例索引完成");
  const snap = await routeJson(host.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC");
  eq(snap.body.balance.enabled, false, "默认关闭：快照 balance.enabled=false");
  eq(snap.body.balance.supported, false, "默认关闭：连服务都不探测（supported=false）");
  eq(spy.spy.balanceCalls, 0, "默认关闭：getBalance 调用次数 = 0（零外发请求）");
  eq(spy.spy.stateCalls, 0, "默认关闭：getState 也一次不调");
  const bal = await routeJson(host.routeList, "/workload-report/v1/balance");
  eq(bal.status, 200, "默认关闭：/balance 仍返回 200");
  eq(bal.body.balance.enabled, false, "默认关闭：/balance 的 enabled=false");
  eq(spy.spy.balanceCalls, 0, "默认关闭：命中也 /balance 不调用 getBalance");
  await rm(host.indexPath, { force: true }).catch(() => {});
}

// 2) 已登录 ready：金额 / 赠送 / 本地链接 + refreshMs 缓存
{
  const spy = walletService({ balance: { status: "ready", value: [{ currency: "CNY", balance: "12.34" }], bonusWallets: [{ currency: "CNY", balance: "5.00" }] } });
  const host = bootBalance({ enabled: true, service: spy.service });
  const bal = await routeJson(host.routeList, "/workload-report/v1/balance");
  eq(bal.body.balance.enabled, true, "启用 + 已登录：enabled=true");
  eq(bal.body.balance.supported, true, "启用 + 服务在场：supported=true");
  eq(bal.body.balance.loggedIn, true, "启用 + ready：loggedIn=true");
  eq(bal.body.balance.currency, "CNY", "余额币种 CNY");
  eq(bal.body.balance.amount, 12.34, "余额金额 12.34");
  eq(bal.body.balance.bonus, 5, "赠送余额 5.00");
  eq(bal.body.balance.topUpUrl, "https://platform.deepseek.com/top_up", "充值链接来自本地 getState（不出网）");
  eq(bal.body.balance.usageUrl, "https://platform.deepseek.com/usage", "用量链接来自本地 getState");
  eq(bal.body.balance.error, null, "成功时 error=null");
  eq(spy.spy.balanceCalls, 1, "启用后 getBalance 恰好调用 1 次");
  await routeJson(host.routeList, "/workload-report/v1/balance");
  eq(spy.spy.balanceCalls, 1, "refreshMs 内复用缓存（不重复出网）");
  await routeJson(host.routeList, "/workload-report/v1/balance?refresh=1");
  eq(spy.spy.balanceCalls, 2, "refresh=1 强制刷新");
  const snap = await routeJson(host.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC");
  ok(snap.body.balance !== undefined && snap.body.balance.loggedIn === true, "快照带 balance 字段（与 /balance 同源）");
  await rm(host.indexPath, { force: true }).catch(() => {});
}

// 3) 未登录：getBalance 返回 null（不是错误），本地链接照给
{
  const spy = walletService({ balance: null });
  const host = bootBalance({ enabled: true, service: spy.service });
  const bal = await routeJson(host.routeList, "/workload-report/v1/balance");
  eq(bal.body.balance.loggedIn, false, "未登录：loggedIn=false");
  eq(bal.body.balance.amount, null, "未登录：金额为 null");
  eq(bal.body.balance.error, null, "未登录：不是错误（error=null）");
  eq(bal.body.balance.topUpUrl, "https://platform.deepseek.com/top_up", "未登录：仍给充值链接");
  await rm(host.indexPath, { force: true }).catch(() => {});
}

// 4) getBalance 抛错：只写 error，不影响快照
{
  const spy = walletService({ fail: true });
  const host = bootBalance({ enabled: true, service: spy.service });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "抛错场景索引完成");
  const bal = await routeJson(host.routeList, "/workload-report/v1/balance");
  ok(String(bal.body.balance.error ?? "").includes("platform 502"), "请求失败：error 记下原始原因", String(bal.body.balance.error));
  eq(bal.body.balance.loggedIn, false, "请求失败：loggedIn=false");
  eq(bal.body.balance.amount, null, "请求失败：金额为 null（不编数字）");
  eq(bal.body.balance.topUpUrl, "https://platform.deepseek.com/top_up", "请求失败：仍给充值链接（不弹错）");
  const snap = await routeJson(host.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC");
  eq(snap.status, 200, "请求失败：快照照常返回 200");
  eq(snap.body.totals.sessions, 1, "请求失败：快照数据不受影响");
  await rm(host.indexPath, { force: true }).catch(() => {});
}

// 5) 服务不存在（老版 DSH）：可选依赖不写进 inject，插件完成 apply / sync / 快照
{
  const host = bootBalance({ enabled: true, service: undefined });
  const health = await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "服务不存在实例索引完成");
  ok(health.ok === true, "服务不存在：/health 正常（插件没有挂起等待 inject）");
  const snap = await routeJson(host.routeList, "/workload-report/v1/snapshot?days=30&tz=UTC");
  eq(snap.status, 200, "服务不存在：快照仍返回 200（不抛 without inject）");
  eq(snap.body.totals.sessions, 1, "服务不存在：sync / 聚合照常完成");
  eq(snap.body.balance.enabled, true, "服务不存在：enabled 如实反映配置");
  eq(snap.body.balance.supported, false, "服务不存在：supported=false（界面显示「当前 DSH 不支持」）");
  const bal = await routeJson(host.routeList, "/workload-report/v1/balance");
  eq(bal.body.balance.error, null, "服务不存在：不是错误，只是不支持");
  await rm(host.indexPath, { force: true }).catch(() => {});
}

// 6) chip 文案：同构量测（客户端组件与测试共用 balanceChip）
console.log("\n—— 余额 chip 文案（同构量测）——");
const tBalance = (key, vars) => translate("zh", key, vars);
const disabledChip = balanceChip({ enabled: false, supported: true, loggedIn: true, currency: "CNY", amount: 12.34, bonus: 5, topUpUrl: "https://x", usageUrl: null, error: null }, tBalance);
eq(disabledChip, null, "未启用：balanceChip 返回 null（chip 完全不渲染）");
const readyChip = balanceChip({ enabled: true, supported: true, loggedIn: true, currency: "CNY", amount: 12.34, bonus: 5, topUpUrl: "https://x", usageUrl: null, error: null }, tBalance);
eq(readyChip.text, "余额 ¥12.34", "已登录：主文案「余额 ¥12.34」");
eq(readyChip.sub, "赠送 ¥5.00", "已登录：副文本「赠送 ¥5.00」");
eq(readyChip.link, null, "已登录：不显示充值链接");
eq(balanceChip({ enabled: true, supported: true, loggedIn: true, currency: "USD", amount: 12.34, bonus: null }, tBalance).text, "余额 $12.34", "已登录：USD 用 $ 符号");
const signedOutChip = balanceChip({ enabled: true, supported: true, loggedIn: false, currency: null, amount: null, bonus: null, topUpUrl: "https://platform.deepseek.com/top_up", usageUrl: null, error: null }, tBalance);
eq(signedOutChip.text, "未登录", "未登录：主文案「未登录」");
eq(signedOutChip.link.href, "https://platform.deepseek.com/top_up", "未登录：带充值链接");
eq(signedOutChip.link.label, "充值", "未登录：链接文案「充值」");
const errorChip = balanceChip({ enabled: true, supported: true, loggedIn: false, currency: null, amount: null, bonus: null, topUpUrl: "https://platform.deepseek.com/top_up", usageUrl: null, error: "余额查询超时（8000ms）" }, tBalance);
eq(errorChip.text, "\u2014", "请求失败：主文案「—」");
ok(errorChip.link !== null && errorChip.link.href.includes("top_up"), "请求失败：仍给充值链接（不弹错）");
const unsupportedChip = balanceChip({ enabled: true, supported: false, loggedIn: false, currency: null, amount: null, bonus: null, topUpUrl: null, usageUrl: null, error: null }, tBalance);
eq(unsupportedChip.text, "当前 DSH 不支持", "服务不存在：主文案「当前 DSH 不支持」");
eq(unsupportedChip.link, null, "服务不存在：没有链接可给");
eq(formatMoney(12.34, "CNY"), "¥12.34", "金额格式化：¥ 两位小数");
eq(formatMoney(0.5, "USD"), "$0.5000", "金额格式化：<1 用四位小数");
eq(formatMoney(null, "CNY"), "\u2014", "金额格式化：没有值显示 —");

// 收尾：删掉本次的临时索引
await rm(INDEX_PATH, { force: true }).catch(() => {});
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`}`);
process.exit(failures === 0 ? 0 : 1);
