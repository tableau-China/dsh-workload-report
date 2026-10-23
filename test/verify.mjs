// 离线验证：不依赖 DSH 实例，直接验证聚合口径、报告渲染与宿主路由行为。
// 用法：node test/verify.mjs

import { readFile, rm } from "node:fs/promises";

import { aggregate, dateKey, present, resolveRange, rowFromSession, workspaceLabel } from "../src/aggregate.js";
import { escapeHtml, formatHours, formatInt, formatMoney, formatTokens } from "../src/format.js";
import { barPercent } from "../src/client/bar-width.js";
import { renderReport } from "../src/report-html.js";
import { balanceChip } from "../src/client/balance.js";
import {
  PROFILE_DIMENSION_KEYS, PROFILE_EVIDENCE_MAX, PROFILE_HEADLINE_MAX, PROFILE_INSIGHT_MAX, PROFILE_LINE_MAX,
  PROFILE_PAYLOAD_KEYS, PROFILE_TITLE_MAX, assertProfilePayload, buildProfilePayload, isProfileTextUnfinished, localProfile, parseProfileText,
  profileFingerprint, repairProfileJson,
} from "../src/ai-profile.js";
import { profileSections } from "../src/profile-view.js";
import {
  AI_PROFILE_DEFAULTS, TRUNCATION_FINISH_KINDS, normalizeAiProfile, profileWindowDays, profileWindowQuery, systemPrompt,
} from "../src/profile-service.js";
import { hourTokensNote } from "../src/client/hour-status.js";
import { SESSION_PAGE_SECTIONS } from "../src/client/session-layout.js";
import { profileCardPhase, profileRouteInfo, profileSummaryDays } from "../src/client/profile-state.js";
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
  ok(waitReport.includes("等待 3 h"), "展示：报告 KPI 副标题写明「等待 3 h」");
  ok(waitReport.includes("净活跃"), "展示：报告 footer 说明净活跃口径");
  ok(waitReport.includes(">20 m<"), "展示：报告 KPI 活跃时长 = 净活跃 20min（不是 200min）");
  eq(translate("zh", "kpi.active.waitSub", { wait: "3 h" }), "等待 3 h", "i18n：中文等待副标题");
  eq(translate("en", "kpi.active.waitSub", { wait: "3 h" }), "Waiting 3 h", "i18n：英文等待副标题");
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
ok(!/[\s\S]*m-label/.test("") || !parityHtml.includes("m-label"), "结构：按工作区不再逐行重复「我的付出 / Token 消耗」标签（已按需求删除）");
ok(html.includes("活跃 1/30 天"), "报告左侧小字含「活跃 N/M 天」", (html.match(/活跃 \d+\/\d+ 天/) ?? [""])[0]);
ok(!/https?:\/\//.test(html.replace(/https?:\/\/www\.w3\.org/g, "")), "无外部资源引用（自包含）");
ok(!html.includes("platform.deepseek.com") && !html.includes("余额"), "报告不含余额 / 余额接口（余额不入导出）");

// ---------------------------------------------------------------- 宿主路由
console.log("\n—— 文案（i18n）一致性 ——");
{
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
  // 文案引用可能出现在任意客户端模块（chips / card-head / hour-status / balance…）；
  // 全部一起扫描，死键检查才完整（否则新组件里的 key 会被误判为死键）。
  const clientModules = ["index.jsx", "balance.js", "chips.jsx", "card-head.jsx", "hour-status.js", "bar-cell.jsx", "profile-card.jsx"];
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
  // 「按日期明细」：默认展开 + 超过 10 天分页（每页 10 天）
  ok(byDayBlock.includes("<details className=\"wl-card wl-details\" open>"), "明细：默认展开（details 带 open）");
  ok(!byDayBlock.includes("点击展开"), "明细：标题不再写「点击展开」（默认已展开）");
  ok(byDayBlock.includes("DETAIL_PAGE_SIZE") && clientSource.includes("export const DETAIL_PAGE_SIZE = 10"), "明细分页：每页 10 天");
  ok(byDayBlock.includes("pageCount > 1 ?") && byDayBlock.includes("pagedRows.map"), "明细分页：只在超过一页时渲染，表格按页切片");
  ok(byDayBlock.includes("pager.prev") && byDayBlock.includes("pager.next") && byDayBlock.includes("pager.info"), "明细分页：上一页 / 下一页 / 页码文案齐全");
  ok(byDayBlock.includes("disabled={pageIndex === 0}") && byDayBlock.includes("disabled={pageIndex >= pageCount - 1}"), "明细分页：首末页按钮禁用");
  // 分页边界（纯逻辑）：<=10 天不出现分页；11 天起每页 10 天
  {
    const pageCountOf = (n) => Math.max(1, Math.ceil(n / 10));
    eq(pageCountOf(7), 1, "分页边界：7 天 → 1 页（不显示分页控件）");
    eq(pageCountOf(10), 1, "分页边界：10 天 → 1 页（不显示分页控件）");
    eq(pageCountOf(11), 2, "分页边界：11 天 → 2 页");
    eq(pageCountOf(25), 3, "分页边界：25 天 → 3 页");
    eq(pageCountOf(31), 4, "分页边界：31 天 → 4 页（明细上限 31 天）");
  }
  // 「按工作区」页要有与「模型用量」同构的小标题
  const byWorkspaceBlock = clientSource.slice(clientSource.indexOf("function ByWorkspaceView"), clientSource.indexOf("function BySessionView"));
  ok(byWorkspaceBlock.includes('<CardHead title={t("tab.byWorkspace")} hint={t("ws.hint")} />'), "按工作区：左上角有 CardHead 小标题（与模型用量页同构）");
  ok(translate("zh", "ws.hint") !== "ws.hint" && translate("en", "ws.hint") !== "ws.hint", "按工作区：小标题说明 zh/en 都有文案");
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
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
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
  // —— 三态：first-fold / background / idle ——
  const firstFoldNote = hourTokensNote({ modelFold: { phase: "first-fold", running: true, pending: 3 }, hourTokensSource: { missing: 0 } }, tZh, String);
  eq(firstFoldNote?.state, "first-fold", "三态：首次从未折过 → first-fold");
  eq(firstFoldNote?.text, "正在计算中……", "三态：first-fold 文案");
  const backgroundNote = hourTokensNote({ modelFold: { phase: "background", running: true, pending: 0, failedRows: 2 }, hourTokensSource: { missing: 5 } }, tZh, String);
  eq(backgroundNote?.state, "background", "三态：后台增量刷新 → background（即使有失败行）");
  eq(backgroundNote?.text, "后台更新中", "三态：background 文案不打扰");
  eq(hourTokensNote({ modelFold: { phase: "idle", failedRows: 4 }, hourTokensSource: { missing: 0 } }, tZh, String), null, "失败行不阻塞状态：idle + failedRows>0 + N=0 → 不显示计算中");
  eq(hourTokensNote({ modelFold: { phase: "idle" }, hourTokensSource: { missing: 2 } }, tZh, String)?.state, "idle", "三态：空闲且有未计入 → idle");
  ok(/data-state="background"\]::before/.test(stylesSource) && /hour\.background/.test(localesSource), "background 用灰点小字样式（不抢「正在计算中」）");
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
ok(reportWithModels.includes('aria-label="模型 Token 占比"'), "报告右侧＝模型 Token 占比环形图（与看板首页同口径）");
ok(reportWithModels.includes("模型 Token 占比"), "报告小标题为「模型 Token 占比」");
ok(!reportWithModels.includes("柱状图（当前区间）"), "报告不再出现「柱状图（当前区间）」");
ok(!reportWithModels.includes('aria-label="每日活跃时长"'), "报告不再渲染每日柱状图（已由模型环形图取代）");
ok(reportWithModels.includes('aria-label="工作区占比"'), "工作区环形图仍保留");
ok(reportWithModels.includes("总活跃时长") && reportWithModels.includes("总 Token"), "两张环形图的圆心小字各自正确");
// 「模型 Token 占比」必须是独立卡片，不能塞进「每日用量趋势」的容器里
{
  const dailyCard = reportWithModels.match(/<section class="card">\s*<div class="card-head">[\s\S]*?每日用量趋势[\s\S]*?<\/section>/);
  ok(dailyCard !== null, "报告含「每日用量趋势」卡片");
  ok(!dailyCard[0].includes("模型 Token 占比"), "「模型 Token 占比」不在「每日用量趋势」卡片内");
  ok(!reportWithModels.includes("daily-pair") && reportWithModels.includes("daily-plus-model"), "两卡并排但各自独立（daily-plus-model 容器内是两张 card）");
  ok(/\.daily-plus-model > \.card/.test(reportWithModels), "并排容器对两个 .card 直接生效（不是单元格包裹）");
}
{
  const hrefs = [...reportWithModels.matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
  ok(
    hrefs.length >= 3 && hrefs.every((href) => /^https:\/\/(api-docs\.deepseek\.com|platform\.kimi\.com|platform\.claude\.com)\//.test(href)),
    "报告的外链只有官方计费页（其余全部内联）",
    hrefs.join(" · "),
  );
  ok(!/<script|src=|<link /i.test(reportWithModels), "报告仍然无脚本 / 无外链资源（自包含）");
}

console.log("\n—— AI 用户画像（payload 白名单 / 指纹 / 本地规则）——");
{
  const profilePayload = buildProfilePayload(modelSnap);
  eq(
    JSON.stringify(Object.keys(profilePayload).sort()),
    JSON.stringify([...PROFILE_PAYLOAD_KEYS].sort()),
    `payload 顶层键集合严格等于白名单（${PROFILE_PAYLOAD_KEYS.length} 个）`,
  );
  ok(PROFILE_PAYLOAD_KEYS.length >= 50, "白名单已扩充到 50+ 个聚合字段", String(PROFILE_PAYLOAD_KEYS.length));
  eq(profilePayload.activeHours24.unit, "tokens", "activeHours24 注明 Token 口径");
  eq(profilePayload.activeHours24.values.length, 24, "activeHours24 有 24 个小时值");
  ok(profilePayload.byWorkspace.length <= 5 && profilePayload.byWorkspace.length > 0, "byWorkspace 最多 5 项且有数据");
  ok(profilePayload.byModel.length <= 5 && profilePayload.byModel.length > 0, "byModel 最多 5 项且有数据");
  ok(
    profilePayload.byWorkspace.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["name", "share"])),
    "byWorkspace 子项只有 name + share",
  );
  ok(
    profilePayload.byModel.every((item) => JSON.stringify(Object.keys(item).sort()) === JSON.stringify(["name", "share"])),
    "byModel 子项只有 name + share",
  );

  // —— 新增结构：会话 / Token / 时段 / 工作区 / 等待 / 趋势 / 模型 ——
  eq(profilePayload.sessions, modelSnap.totals.sessions, "payload.sessions = 会话总数（含空会话）");
  eq(profilePayload.conversations, modelSnap.totals.conversations, "payload.conversations = 有步骤的会话数");
  eq(profilePayload.tokensInput + profilePayload.tokensOutput + profilePayload.tokensCacheRead + profilePayload.tokensCacheWrite, profilePayload.tokensTotal, "Token 四分量之和 = tokensTotal");
  ok(Math.abs(profilePayload.inputShare + profilePayload.outputShare + profilePayload.cacheReadShare + profilePayload.cacheWriteShare - 1) < 0.001, "Token 四项占比之和 ≈ 1");
  eq(profilePayload.avgOutputTokensPerTurn, Math.round(modelSnap.totals.tokens.output / modelSnap.totals.turns), "平均每轮输出 token 由输出 / 轮次派生");
  eq(profilePayload.avgSessionActiveMs, Math.round(modelSnap.totals.netActiveMs / modelSnap.totals.conversations), "平均会话活跃时长由净活跃 / 对话数派生");
  ok(Math.abs(profilePayload.avgTurnsPerConversation - modelSnap.totals.turns / modelSnap.totals.conversations) < 0.11, "平均每会话轮次派生正确");
  ok(Math.abs(profilePayload.avgStepsPerTurn - modelSnap.totals.steps / modelSnap.totals.turns) < 0.11, "平均每轮步骤派生正确");
  ok(
    Math.abs(profilePayload.durationUnder15mShare + profilePayload.duration15to60mShare + profilePayload.duration1to3hShare + profilePayload.durationOver3hShare - 1) < 0.001,
    "会话时长四桶占比之和 ≈ 1",
  );
  eq(profilePayload.durationSampleSessions, modelSnap.totals.conversations, "时长分桶样本量 = 有步骤的会话数（夹具 ≤300）");
  ok(Math.abs(profilePayload.bandNightActiveShare + profilePayload.bandMorningActiveShare + profilePayload.bandForenoonActiveShare + profilePayload.bandAfternoonActiveShare + profilePayload.bandEveningActiveShare - 1) < 0.001, "5 个时段活跃占比之和 ≈ 1");
  eq(profilePayload.bandForenoonActiveShare, 1, "夹具会话都发生在 10 点 → 上午占比 100%");
  eq(profilePayload.bandNightTokenShare + profilePayload.bandMorningTokenShare + profilePayload.bandForenoonTokenShare + profilePayload.bandAfternoonTokenShare + profilePayload.bandEveningTokenShare, 0, "无事件时间戳时 5 个时段 Token 占比全为 0（不用 0 冒充有数据）");
  eq(profilePayload.workspaceCount, modelSnap.totals.workspaces, "workspaceCount 来自 totals.workspaces");
  eq(profilePayload.topWorkspaceShare, profilePayload.byWorkspace[0].share, "topWorkspaceShare = 第一工作区活跃占比");
  eq(profilePayload.workspaceSwitchCount, 1, "工作区切换次数近似：proj-b → proj-a 共 1 次");
  eq(profilePayload.modelCount, modelSnap.byModel.length, "modelCount 统计全部模型（不受 Top5 截断）");
  eq(profilePayload.topModelShare, profilePayload.byModel[0].share, "topModelShare = 第一模型 Token 占比");
  eq(profilePayload.multiModel, true, "multiModel = 模型数 > 1");
  eq(profilePayload.waitShare, 0, "waitShare = 等待 / (净活跃 + 等待)");
  eq(profilePayload.trendDays, 7, "trendDays 固定为 7");
  eq(profilePayload.trendActiveDeltaPct, null, "前 7 天无数据 → 环比 null（数据不足）");
  eq(profilePayload.trendTokensDeltaPct, null, "前 7 天无 Token → 环比 null（数据不足）");
  for (const key of PROFILE_PAYLOAD_KEYS) {
    const value = profilePayload[key];
    if (typeof value !== "number") continue;
    ok(Number.isFinite(value) && value >= 0, "payload." + key + " 是非负有限数");
  }

  // —— 趋势：14 天窗口能算出近 7 天 vs 前 7 天 ——
  const dayKeyOf = (offset) => new Date(Date.parse("2026-09-27T00:00:00Z") + offset * 86400000).toISOString().slice(0, 10);
  const trendSnapshot = {
    range: { from: "2026-09-27", to: "2026-10-10", days: 14, timeZone: "UTC" },
    totals: { netActiveMs: 0, waitMs: 0, sessions: 0, conversations: 0, turns: 0, steps: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, workspaces: 0 },
    byHour: [],
    byDay: Array.from({ length: 14 }, (_, index) => ({
      date: dayKeyOf(index),
      activeMs: index < 7 ? 1000 : 2000,
      tokensTotal: index < 7 ? 100 : 200,
    })),
    byWorkspace: [],
    byModel: [],
    bySession: [],
  };
  const trendPayload = buildProfilePayload(trendSnapshot);
  eq(trendPayload.trendActivePrevMs, 7000, "趋势：前 7 天活跃 7s");
  eq(trendPayload.trendActiveLastMs, 14000, "趋势：近 7 天活跃 14s");
  eq(trendPayload.trendActiveDeltaPct, 100, "趋势：活跃环比 +100%");
  eq(trendPayload.trendTokensPrev, 700, "趋势：前 7 天 Token 700");
  eq(trendPayload.trendTokensLast, 1400, "趋势：近 7 天 Token 1400");
  eq(trendPayload.trendTokensDeltaPct, 100, "趋势：Token 环比 +100%");
  const shortTrend = buildProfilePayload({ ...trendSnapshot, range: { ...trendSnapshot.range, days: 13 }, byDay: trendSnapshot.byDay.slice(0, 13) });
  eq(shortTrend.trendActiveDeltaPct, null, "区间不足 14 天 → 趋势仍为 null");

  // —— 隐私：键 / 字符串 / 嵌套都不得夹带标题、路径、会话 id ——
  const serializedPayload = JSON.stringify(profilePayload);
  ok(!Object.keys(profilePayload).includes("title") && !Object.keys(profilePayload).includes("cwd") && !Object.keys(profilePayload).includes("sessionId"), "payload 不含 title / cwd / sessionId 顶层键");
  ok(!/"(title|cwd|path|sessionId|prompt|content|message|text)"/i.test(serializedPayload), "payload 序列化后不含私有键名");
  ok(!JSON.stringify(profilePayload).includes(modelSnap.byWorkspace[0].key), "payload 不含工作区完整路径（只留显示名）");
  ok(!serializedPayload.includes("/Users/"), "payload 字符串不含 /Users/ 路径");
  for (const key of ["byWorkspace", "byModel"]) {
    ok(profilePayload[key].every((item) => !item.name.includes("/") && !item.name.includes("\\")), "payload." + key + " 名称不含路径分隔符");
  }
  const privatePayload = buildProfilePayload(snapshot);
  ok(!JSON.stringify(privatePayload).includes("会话 A"), "payload 不含会话标题");
  ok(!JSON.stringify(privatePayload).includes("/Users/me/proj-a"), "payload 不含 cwd 原文");
  ok(profilePayload.weekendShare >= 0 && profilePayload.weekendShare <= 1, "weekendShare 是 0–1 占比");
  ok(profilePayload.nightShare >= 0 && profilePayload.nightShare <= 1, "nightShare 是 0–1 占比");
  ok(profilePayload.waitShare >= 0 && profilePayload.waitShare <= 1, "waitShare 是 0–1 占比");

  let rejected = false;
  try {
    assertProfilePayload({ ...profilePayload, title: "不该出现" });
  } catch {
    rejected = true;
  }
  ok(rejected, "白名单断言拒绝额外键（防止后续改动夹带标题 / 路径）");
  let nestedRejected = false;
  try {
    assertProfilePayload({ ...profilePayload, byWorkspace: [{ name: "proj-a", share: 1, cwd: "/Users/me/proj-a" }] });
  } catch {
    nestedRejected = true;
  }
  ok(nestedRejected, "白名单断言拒绝 byWorkspace 子项夹带 cwd");
  let pathRejected = false;
  try {
    assertProfilePayload({ ...profilePayload, byWorkspace: [{ name: "/Users/me/proj-a", share: 1 }] });
  } catch {
    pathRejected = true;
  }
  ok(pathRejected, "白名单断言拒绝字符串值里的路径");

  const fingerprintA = profileFingerprint(profilePayload);
  const fingerprintB = profileFingerprint(buildProfilePayload(modelSnap));
  eq(fingerprintA, fingerprintB, "同统计的指纹稳定（稳定 JSON）");
  eq(fingerprintA.length, 16, "指纹取 sha256 前 16 位");
  const changedPayload = buildProfilePayload({ ...modelSnap, totals: { ...modelSnap.totals, turns: modelSnap.totals.turns + 1 } });
  ok(profileFingerprint(changedPayload) !== fingerprintA, "统计变化后指纹随之变化");
  ok(profileFingerprint(trendPayload) !== fingerprintA, "新增趋势字段参与指纹（不同统计不同指纹）");

  // —— 本地规则版：与 AI 输出同构 ——
  const localZh = localProfile(profilePayload, "zh");
  const localEn = localProfile(profilePayload, "en");
  ok(localZh.headline.length > 0 && [...localZh.headline].length <= PROFILE_HEADLINE_MAX, "本地规则 headline ≤30 字符");
  ok(localEn.headline.length > 0 && [...localEn.headline].length <= PROFILE_HEADLINE_MAX, "英文本地规则 headline ≤30 字符");
  ok(localZh.dimensions.length >= 4 && localZh.dimensions.length <= 6, "本地规则 4–6 个维度");
  ok(localEn.dimensions.length >= 4 && localEn.dimensions.length <= 6, "英文本地规则 4–6 个维度");
  ok(localZh.dimensions.every((item) => PROFILE_DIMENSION_KEYS.includes(item.key)), "本地规则维度 key 都在允许集合");
  ok(localZh.dimensions.every((item) => [...item.title].length <= PROFILE_TITLE_MAX), "本地规则维度标题 ≤8 字符");
  ok(localZh.dimensions.every((item) => [...item.insight].length <= PROFILE_INSIGHT_MAX && /[0-9]/.test(item.insight)), "本地规则每条结论 ≤60 字符且含数字");
  ok(localZh.dimensions.every((item) => [...item.evidence].length <= PROFILE_EVIDENCE_MAX), "本地规则每条证据 ≤40 字符");
  ok(localZh.advice.length >= 2 && localZh.advice.length <= 3, "本地规则 2–3 条建议");
  ok(localZh.advice.every((item) => [...item.text].length <= PROFILE_LINE_MAX && [...item.why].length <= PROFILE_LINE_MAX), "本地规则建议 text / why 均 ≤40 字符");
  ok(localZh.risk === null || [...localZh.risk].length <= PROFILE_LINE_MAX, "本地规则 risk 为 null 或 ≤40 字符");
  ok(localZh.dimensions.some((item) => item.key === "collab" && /轮|等待/.test(item.insight)), "本地规则覆盖协作（轮次 / 等待）");
  ok(localZh.dimensions.some((item) => item.key === "trend" && /7/.test(item.insight + item.evidence)), "本地规则覆盖趋势（7 天口径）");
  const trendLocal = localProfile(trendPayload, "zh");
  ok(trendLocal.dimensions.some((item) => item.key === "trend" && item.insight.includes("100")), "本地规则有基线时写出环比数字");
  const nightPayload = { ...profilePayload, nightShare: 0.4, bandNightActiveShare: 0.4 };
  const nightLocal = localProfile(nightPayload, "zh");
  ok(typeof nightLocal.risk === "string" && nightLocal.risk.includes("夜间"), "本地规则夜间占比高时给出 risk");
  ok(nightLocal.dimensions.some((item) => item.key === "rhythm" && item.insight.includes("40")), "本地规则夜间维度引用 40% 数字");

  // —— 解析四路径 ——
  const sampleProfile = {
    headline: "夜间型深度工作者",
    dimensions: [
      { key: "rhythm", title: "节奏", insight: "夜间活跃 41%，高峰 23:00", evidence: "22–6 点 41%" },
      { key: "focus", title: "专注", insight: "单会话均值 48 m", evidence: "会话 12 · 均值 48 m" },
      { key: "stack", title: "工具栈", insight: "缓存命中 64%，输入占 12%", evidence: "缓存 64% · 输入 12%" },
      { key: "collab", title: "协作", insight: "等待用户 9%，每会话 4.2 轮", evidence: "等待 9% · 4.2 轮" },
      { key: "trend", title: "趋势", insight: "近 7 天活跃环比 +18%", evidence: "12 h → 14 h" },
    ],
    advice: [
      { text: "固定系统提示与上下文", why: "缓存命中 64%" },
      { text: "合并确认点", why: "等待用户 9%" },
    ],
    risk: "夜间投入偏高 41%",
  };
  const plainParsed = parseProfileText(JSON.stringify(sampleProfile));
  eq(plainParsed.headline, sampleProfile.headline, "解析路径 1：干净 JSON 直接成功");
  eq(plainParsed.dimensions.length, 5, "解析路径 1：保留 5 个维度");
  eq(plainParsed.advice.length, 2, "解析路径 1：保留 2 条建议");
  eq(plainParsed.risk, sampleProfile.risk, "解析路径 1：保留 risk");
  const fencedParsed = parseProfileText("```json\n" + JSON.stringify(sampleProfile) + "\n```");
  eq(fencedParsed.headline, sampleProfile.headline, "解析路径 2：代码围栏包裹可解析");
  const proseParsed = parseProfileText("先解释一句。\n" + JSON.stringify(sampleProfile) + "\n以上。");
  eq(proseParsed.headline, sampleProfile.headline, "解析路径 3：前后夹解释文字时宽松提取");
  const tripleParsed = parseProfileText('"""' + JSON.stringify(sampleProfile) + '"""');
  eq(tripleParsed.headline, sampleProfile.headline, "解析路径 2b：三引号包裹可解析");
  let parseRejected = null;
  try {
    parseProfileText("这不是 JSON");
  } catch (error) {
    parseRejected = error;
  }
  eq(parseRejected?.code, "AI_PARSE_FAILED", "解析路径 4：失败带稳定 code（路由据此降级）");
  ok(String(parseRejected?.rawText ?? "").includes("这不是 JSON"), "解析失败保留原始文本前 300 字");
  ok([...String(parseRejected?.rawText ?? "")].length <= 300, "原始文本截断到 300 字符");
  const digitRejected = (() => {
    try {
      parseProfileText(JSON.stringify({ ...sampleProfile, dimensions: sampleProfile.dimensions.map((item) => ({ ...item, insight: "没有数字的结论" })) }));
      return null;
    } catch (error) {
      return error.code;
    }
  })();
  eq(digitRejected, "AI_PARSE_FAILED", "维度结论缺数字视为解析失败");
  const shortRejected = (() => {
    try {
      parseProfileText(JSON.stringify({ ...sampleProfile, dimensions: sampleProfile.dimensions.slice(0, 3) }));
      return null;
    } catch (error) {
      return error.code;
    }
  })();
  eq(shortRejected, "AI_PARSE_FAILED", "少于 4 个维度视为解析失败（不猜）");
  const adviceRejected = (() => {
    try {
      parseProfileText(JSON.stringify({ ...sampleProfile, advice: sampleProfile.advice.slice(0, 1) }));
      return null;
    } catch (error) {
      return error.code;
    }
  })();
  eq(adviceRejected, "AI_PARSE_FAILED", "少于 2 条建议视为解析失败（不猜）");
  const clamped = parseProfileText(JSON.stringify({
    ...sampleProfile,
    headline: "长".repeat(100),
    dimensions: sampleProfile.dimensions.map((item) => ({ ...item, title: "题".repeat(50), insight: "1".repeat(100), evidence: "证".repeat(100) })),
    advice: sampleProfile.advice.map((item) => ({ text: "建".repeat(100), why: "因".repeat(100) })),
    risk: "险".repeat(100),
  }));
  eq([...clamped.headline].length, PROFILE_HEADLINE_MAX, "解析后 headline 压到 30 字符");
  eq([...clamped.dimensions[0].title].length, PROFILE_TITLE_MAX, "解析后维度标题压到 8 字符");
  eq([...clamped.dimensions[0].insight].length, PROFILE_INSIGHT_MAX, "解析后结论压到 60 字符");
  eq([...clamped.dimensions[0].evidence].length, PROFILE_EVIDENCE_MAX, "解析后证据压到 40 字符");
  eq([...clamped.advice[0].text].length, PROFILE_LINE_MAX, "解析后建议压到 40 字符");
  eq([...clamped.risk].length, PROFILE_LINE_MAX, "解析后 risk 压到 40 字符");
  const keyAlias = parseProfileText(JSON.stringify({ ...sampleProfile, dimensions: sampleProfile.dimensions.map((item) => ({ ...item, key: item.key === "rhythm" ? "unknown" : item.key })) }));
  eq(keyAlias.dimensions[0].key, "focus", "未知维度 key 回退到 focus（不丢整份画像）");
  const nullRisk = parseProfileText(JSON.stringify({ ...sampleProfile, risk: null }));
  eq(nullRisk.risk, null, "risk=null 合法");

  // —— 截断抢救：补齐未闭合的字符串 / 数组 / 对象括号 ——
  const completeText = JSON.stringify({ ...sampleProfile, risk: null });
  const missingBrace = completeText.slice(0, -1);
  ok(isProfileTextUnfinished(missingBrace), "截断检测：缺右括号判定为未收尾");
  ok(!isProfileTextUnfinished(completeText), "截断检测：完整 JSON 判定为已收尾");
  const repairedBrace = repairProfileJson(missingBrace);
  ok(repairedBrace !== null && repairedBrace.repaired === true, "JSON 修复：缺根对象右括号可补齐");
  eq(parseProfileText(repairedBrace.text).headline, sampleProfile.headline, "JSON 修复：补齐后可正常解析出画像");
  const repairedTail = repairProfileJson(completeText.slice(0, -2));
  ok(repairedTail !== null && repairedTail.repaired === true, "JSON 修复：截断在半截值上时回退到上一个逗号边界");
  ok(parseProfileText(repairedTail.text).dimensions.length >= 4, "JSON 修复：回退边界后仍保留足够维度");
  const midString = completeText.slice(0, completeText.indexOf("夜间型深度工作者") + 5);
  const repairedString = repairProfileJson(midString);
  ok(repairedString !== null && repairedString.repaired === true, "JSON 修复：截断在字符串中间时补引号 + 括号");
  eq(JSON.parse(repairedString.text).headline, "夜间型深度", "JSON 修复：字符串中间截断保留已输出部分");
  eq(repairProfileJson("这不是 JSON"), null, "JSON 修复：没有 JSON 对象时返回 null");
  eq(repairProfileJson('{"a":]'), null, "JSON 修复：括号已错配时返回 null（不猜）");
  ok(TRUNCATION_FINISH_KINDS.includes("length") && TRUNCATION_FINISH_KINDS.includes("max-tokens"), "截断 finish.kind 覆盖 length / max-tokens（provider 命名不一）");

  // —— 前端渲染结构（同构归一化 + 源码结构） ——
  const view = profileSections(sampleProfile);
  eq(view.headline, sampleProfile.headline, "渲染结构：headline 直接透传");
  eq(view.dimensions.length, 5, "渲染结构：dimensions 5 条");
  eq(view.dimensions[0].key, "rhythm", "渲染结构：维度带 key（data-key 用）");
  eq(view.dimensions[0].title, "节奏", "渲染结构：维度标题");
  ok(view.dimensions.every((item) => item.insight.length > 0 && item.evidence.length > 0), "渲染结构：维度含结论 + 证据");
  eq(view.advice.length, 2, "渲染结构：advice 2 条");
  ok(view.advice.every((item) => item.text.length > 0 && item.why.length > 0), "渲染结构：建议含 why");
  eq(view.risk, sampleProfile.risk, "渲染结构：risk 透传");
  const emptyView = profileSections(null);
  ok(emptyView.headline === "" && emptyView.dimensions.length === 0 && emptyView.advice.length === 0 && emptyView.risk === null, "渲染结构：空画像也安全");
  const legacyView = profileSections({ traits: ["节奏稳定", "任务聚焦", "模型集中"], advice: "旧建议。" });
  eq(legacyView.dimensions.length, 3, "渲染结构：旧 traits 兼容映射为 dimensions");
  eq(legacyView.advice[0].text, "旧建议。", "渲染结构：旧字符串 advice 兼容为 advice[{text}]");
  const clampedView = profileSections({
    headline: "长".repeat(100),
    dimensions: [{ key: "rhythm", title: "题".repeat(50), insight: "1".repeat(100), evidence: "证".repeat(100) }],
    advice: [{ text: "建".repeat(100), why: "因".repeat(100) }],
    risk: "险".repeat(100),
  });
  eq([...clampedView.headline].length, PROFILE_HEADLINE_MAX, "渲染结构：headline 同样压到 30 字符");
  eq([...clampedView.dimensions[0].title].length, PROFILE_TITLE_MAX, "渲染结构：标题同样压到 8 字符");
  eq([...clampedView.dimensions[0].insight].length, PROFILE_INSIGHT_MAX, "渲染结构：结论同样压到 60 字符");
  eq([...clampedView.dimensions[0].evidence].length, PROFILE_EVIDENCE_MAX, "渲染结构：证据同样压到 40 字符");
  eq([...clampedView.advice[0].text].length, PROFILE_LINE_MAX, "渲染结构：建议同样压到 40 字符");
  eq([...clampedView.risk].length, PROFILE_LINE_MAX, "渲染结构：risk 同样压到 40 字符");

  const cardSource = await readFile(new URL("../src/client/profile-card.jsx", import.meta.url), "utf8");
  const clientIndexSource = await readFile(new URL("../src/client/index.jsx", import.meta.url), "utf8");
  const stylesSource = await readFile(new URL("../src/client/styles.js", import.meta.url), "utf8");
  const localesSource = await readFile(new URL("../src/client/locales.js", import.meta.url), "utf8");
  ok(cardSource.includes("<CardHead"), "画像卡复用 CardHead（标题 + 右侧 hint + 右上按钮）");
  ok(cardSource.includes("profileCardPhase(status, profile)") && cardSource.includes('phase === "hidden"'), "未启用 / probe 中整卡不渲染（不显示入口）");
  ok(cardSource.includes("disabled={generating}") && cardSource.includes("profile.generating"), "生成中按钮禁用并显示「生成中…」");
  // 首开状态机：尚无结果 → notice（提示面板）；未点击绝不进入 generating。
  eq(profileCardPhase("ready", null), "notice", "首开：尚无结果 → 提示面板（notice）");
  eq(profileCardPhase("generating", null), "generating", "点击后：无结果且生成中 → generating");
  eq(profileCardPhase("ready", { headline: "x" }), "result", "生成后：有结果 → result（提示面板消失）");
  eq(profileCardPhase("disabled", null), "hidden", "显式关闭：整卡 hidden");
  eq(profileCardPhase("probing", null), "hidden", "probe 中：整卡隐藏（不闪空卡）");
  const routeKnown = profileRouteInfo({ provider: "deepseek-official", model: "deepseek-flash" });
  ok(routeKnown.known && routeKnown.provider === "deepseek-official" && routeKnown.model === "deepseek-flash", "提示面板：provider/model 来自 probe");
  ok(profileRouteInfo({}).known === false, "提示面板：未知路由回落宿主默认");
  eq(profileSummaryDays({ summaryDays: 45 }, { summaryDays: 30 }, 7), 45, "窗口小字：优先使用响应的 summaryDays");
  eq(profileSummaryDays(null, { summaryDays: 30 }, 7), 30, "窗口小字：无结果时用 probe 的 summaryDays");
  ok(
    cardSource.includes('data-kind="profile-notice"') &&
      cardSource.includes('t("profile.notice.data", { days: formatInt(summaryDays) })') &&
      cardSource.includes('t("profile.notice.model", { provider: route.provider, model: route.model })') &&
      cardSource.includes('t("profile.notice.modelDefault")') &&
      cardSource.includes('t("profile.notice.cost")'),
    "提示面板：三行文案（聚合数据 / provider+model 占位 / 点击才计费）",
  );
  eq(
    (cardSource.match(/data-kind="profile-notice-(?:data|model|cost)"/g) ?? []).length,
    3,
    "提示面板：恰好三行说明（数据 / 模型 / 费用）",
  );
  ok(
    cardSource.includes('data-action="profile-generate"') && cardSource.includes('t("profile.generate")'),
    "提示面板：包含「生成画像」主按钮",
  );
  const mountEffect = cardSource.slice(cardSource.indexOf("useEffect"), cardSource.indexOf("const generate"));
  ok(
    mountEffect.includes("queryOf(true)") && !mountEffect.includes("queryOf(false)"),
    "首开零调用：挂载时只发 probe（probe=1），不请求生成",
  );
  ok(
    /phase === "notice" \|\| phase === "generating" \? \(/.test(cardSource) && /phase === "result" \? \(/.test(cardSource),
    "两态互斥：提示面板只在 notice/generating，结果只在 result",
  );
  ok(cardSource.includes('data-action="profile-regenerate"') && cardSource.includes('t("profile.regenerate")'), "结果态：提供「重新生成」");
  ok(
    cardSource.includes('t("profile.window", { days: formatInt(summaryDays) })') && cardSource.includes('data-kind="profile-window"'),
    "结果态：卡片标注「基于近 N 天汇总」",
  );
  ok(localesSource.includes('"profile.notice.data": "只发送近 {days} 天聚合统计（不含对话正文 / 标题 / 路径）"'), "提示面板中文文案：只发聚合统计");
  ok(
    localesSource.includes('"profile.notice.model": "模型：{provider} / {model}"') &&
      localesSource.includes('"profile.notice.model": "Model: {provider} / {model}"'),
    "提示面板：provider/model 占位 zh/en 对齐",
  );
  ok(
    localesSource.includes('"profile.notice.modelDefault"') &&
      localesSource.includes('"profile.notice.cost"') &&
      localesSource.includes('"profile.window"'),
    "提示面板 / 窗口小字：zh/en 新键齐全",
  );
  ok(!localesSource.includes('"profile.intro"') && !cardSource.includes("profile.intro"), "旧 intro 文案已随提示面板升级删除（无死键）");
  ok(clientIndexSource.includes('import { ProfileCard }') && clientIndexSource.includes("<ProfileCard"), "ProfileCard 已接入（作为独立页签）");
  // 布局：AI 用户画像 = 与「按日期/模型用量/按工作区/主要会话」并列的顶层页签，且在导航右侧。
  eq(SESSION_PAGE_SECTIONS.join(">"), "sessions", "布局：主要会话页只包含会话表（画像不再并列）");
  const sessionBlockSource = clientIndexSource.slice(
    clientIndexSource.indexOf("function BySessionView"),
    clientIndexSource.indexOf("function ByProfileView"),
  );
  ok(!sessionBlockSource.includes("<ProfileCard"), "布局：会话页不再渲染画像卡");
  ok(sessionBlockSource.includes('data-page="sessions"'), "布局：会话页使用独立容器（非两列 grid）");
  ok(!clientIndexSource.includes("wl-session-layout"), "布局：两列布局已移除");
  const profileViewSource = clientIndexSource.slice(
    clientIndexSource.indexOf("function ByProfileView"),
    clientIndexSource.indexOf("function Overlay"),
  );
  ok(profileViewSource.includes("<ProfileCard"), "布局：画像卡渲染在独立页签视图里");
  ok(
    clientIndexSource.includes('data-align="end"') && clientIndexSource.includes('tab.aiProfile'),
    "导航：AI 用户画像页签右对齐（data-align=end）",
  );
  ok(clientIndexSource.includes('tab === "aiProfile"'), "导航：页签切换到画像视图");
  ok(/\.wl-tab\[data-align="end"\] \{[^}]*margin-left:\s*auto/.test(stylesSource), "导航样式：右对齐用 margin-left:auto");
  // 蓝底必须圆角：.wl-tab 基础规则之后还有一条 data-align=end 覆盖块，圆角写在那一块里
  {
    const endTabBlocks = [...stylesSource.matchAll(/\.wl-tab\[data-align="end"\]\s*\{([^}]*)\}/g)].map((match) => match[1]);
    ok(endTabBlocks.some((block) => /border-radius:\s*[1-9]\d*px/.test(block)), "导航样式：画像页签蓝底为圆角矩形（border-radius > 0）");
    ok(
      endTabBlocks.some((block) => /border-radius:\s*[1-9]/.test(block) && /margin-top:/.test(block)),
      "导航样式：圆角块同时留了纵向间距（圆角不被导航底边裁切）",
    );
  }
  eq(translate("zh", "tab.aiProfile"), "AI 用户画像", "页签文案：中文为「AI 用户画像」");
  eq(translate("en", "tab.aiProfile"), "AI profile", "页签文案：英文为 AI profile");
  eq(translate("zh", "profile.title"), "AI 用户画像", "标题：中文为「AI 用户画像」");
  eq(translate("en", "profile.title"), "AI user profile", "标题：英文同步为 AI user profile");
  ok(localesSource.includes('"profile.title": "AI 用户画像"') && localesSource.includes('"profile.title": "AI user profile"'), "标题：zh/en 同步替换，不保留旧键");
  const profileCardCss = stylesSource.slice(stylesSource.indexOf(".wl-profile-card"), stylesSource.indexOf(".wl-profile-meta"));
  ok(
    /background:\s*color-mix\(in srgb,\s*var\(--dsw-static-deepseek-500[^;]*var\(--dsw-alias-bg-layer-2/.test(profileCardCss),
    "底色：画像卡用 layer-2 叠极淡品牌色（只用宿主 token）",
  );
  ok(
    /\.wl-card \{[^}]*background: var\(--dsw-alias-bg-layer-1/.test(stylesSource) &&
      !/\.wl-profile-card \{[^}]*background: var\(--dsw-alias-bg-layer-1/.test(profileCardCss),
    "底色：画像卡与普通卡片（layer-1）不同，有可辨差异",
  );
  ok(
    cardSource.includes('data-kind="profile-truncated"') && cardSource.includes('t("profile.truncated")'),
    "截断提示：卡片底部渲染 profile.truncated 小字",
  );
  ok(
    localesSource.includes('"profile.truncated": "输出被截断，已修复采用"') &&
      localesSource.includes('"profile.truncated": "Output truncated; repaired and used"'),
    "截断提示：zh/en 新键齐全",
  );
  ok(cardSource.includes("profileSections(profile)"), "卡片用 profileSections 做同构归一化");
  ok(cardSource.includes('data-kind="ai-profile"') && cardSource.includes('data-section="profile"'), "渲染结构：画像卡带 data-section=profile（DOM 顺序可量测）");
  ok(cardSource.includes('data-kind="profile-headline"'), "渲染结构：顶部大字 headline（data-kind）");
  ok(cardSource.includes('data-kind="profile-dimensions"') && cardSource.includes("data-key={item.key}"), "渲染结构：维度列表带 key / title / insight");
  ok(cardSource.includes('data-kind="profile-evidence"'), "渲染结构：灰色证据小字");
  ok(cardSource.includes('data-kind="profile-advice"') && cardSource.includes("item.why"), "渲染结构：建议 + why 小字");
  ok(cardSource.includes('data-kind="profile-risk"') && cardSource.includes('t("profile.risk")'), "渲染结构：有 risk 时显示浅色警示条");
  ok(cardSource.includes('data-source=') && cardSource.includes('t("profile.source.llm")') && cardSource.includes('t("profile.source.local")'), "保留来源徽标（AI 生成 / 本地规则版）");
  ok(cardSource.includes("profile.usage") && cardSource.includes("timeText"), "保留 usage 与生成时间");
  ok(cardSource.includes("profile.regenerate"), "保留重新生成按钮");
  ok(stylesSource.includes(".wl-profile-headline") && stylesSource.includes(".wl-profile-dim-evidence") && stylesSource.includes(".wl-profile-risk"), "样式覆盖 headline / 证据 / 风险条");
  ok(localesSource.includes('"profile.risk": "风险提示："') && localesSource.includes('"profile.risk": "Risk: "'), "profile.risk 中英文案齐全");
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
  ok(!parityHtml.includes("轮次（该小时开始的会话数）"), "结构：轮次小图已按需求移除（报告不展示该子图）");
  ok(!parityHtml.includes("wl-chip") && !parityHtml.includes("<button"), "结构：报告没有看板切换控件 / 按钮");
  ok(parityHtml.includes('data-kind="hour-tokens-missing"') && parityHtml.includes('data-state="running"') && parityHtml.includes("正在计算中……"), "结构：回填中状态行显示「正在计算中……」");
  ok(/<div class="card-head">[\s\S]{0,80}<div class="card-head-text"><h2>[^<]+<\/h2><span class="card-hint"/.test(parityHtml), "结构：卡片说明在标题右侧（card-head-text 内）");
  ok(!parityHtml.includes('class="hint"') && !/<p class="hint">/.test(parityHtml), "结构：标题下方不再有旧 hint 段落");
  ok(/\.card-hint \{[^}]*font-size: 11px/.test(parityHtml) && /\.card-hint \{[^}]*color: #6b7280/.test(parityHtml), "结构：标题右侧说明 11px + muted（与看板同字号/同色）");
  ok(parityHtml.includes('data-kind="calendar-cell"') && parityHtml.includes('data-kind="weekday-bar"'), "结构：每日趋势含日历热力图 + 周几累计条");
  ok(!parityHtml.includes('data-kind="peak-label"') && !parityHtml.includes('data-kind="active-bar-hit"'), "结构：每日柱状图已移除（右侧改为模型 Token 占比环形图）");
  ok(parityHtml.includes('aria-label="模型 Token 占比"') && parityHtml.includes('aria-label="工作区占比"'), "结构：两张环形图（模型 Token 占比 / 工作区占比）几何同构");
  // 顶部区间筛选器：只做视觉呈现（不是交互控件、不产生链接）
  ok(parityHtml.includes('class="range-filter"'), "结构：报告顶部有区间筛选器样式");
  ok(["近 7 天", "近 30 天", "近 90 天", "全部"].every((label) => parityHtml.includes(`>${label}</span>`)), "结构：筛选器四档文案齐全");
  ok((parityHtml.match(/class="range-chip" data-active="true"/g) ?? []).length === 1, "结构：恰好一档为当前区间（实底高亮）");
  {
    const filterBlock = parityHtml.slice(parityHtml.indexOf('class="range-filter"'), parityHtml.indexOf('class="range-filter"') + 600);
    ok(!filterBlock.includes("<a ") && !filterBlock.includes("<button"), "结构：筛选器是纯 <span>（报告无脚本、不伪造可点击）");
    ok(!filterBlock.includes("cursor: pointer"), "结构：筛选器无指针手型（视觉标签而非按钮）");
  }
  eq(renderReport(modelSnap, { rangeKey: "all" }).includes('data-active="true">全部'), true, "结构：rangeKey=all 时「全部」高亮");
  ok(parityHtml.includes("data-bar-cell") && /class="bar-cell-fill"[^>]*style="width:[0-9.]+%;background:/.test(parityHtml), "结构：表格比例条与看板同规则（宽度百分比 + 内联背景条）");
  ok(parityHtml.includes("模型占比 · 面积 = Token") && parityHtml.includes("按日模型趋势"), "结构：模型 treemap / 按日趋势都有小标题");
  ok(parityHtml.includes("最活跃模型") && parityHtml.includes("请求占比") && parityHtml.includes("模型费用"), "结构：KPI 含「模型费用」与「最活跃模型」");
  ok(parityHtml.includes("等待 ") && parityHtml.includes("净活跃"), "结构：KPI / footer 写清净活跃与等待口径");
  ok(!parityHtml.includes("用户画像") && !parityHtml.includes('data-kind="ai-profile"') && !parityHtml.includes("本地规则版"), "结构：报告不展示 AI 画像（有意不同，见 report-parity）");
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

// ---------------------------------------------------------------- 打开零折叠 / 三态 / 缓存 / 指标
console.log("\n—— 打开零折叠 / 三态 / 缓存 / 指标 ——");
const PHASE_INDEX = `/tmp/wl-verify-phase-${process.pid}.json`;
await rm(PHASE_INDEX, { force: true }).catch(() => {});
{
  const phaseRoutes = [];
  const phaseState = { reads: 0, gate: Promise.resolve(), release: () => {}, listener: null };
  const phaseRecords = ["N1", "N2"].map((id) => ({
    header: { id, createdAt: base, cwd: "/tmp/phase", isSeeded: false, version: 4 }, live: false, persisted: true,
  }));
  const phaseValues = (id) => ({
    sessionStats: { turns: 1, steps: 1, llmMs: 1000, toolMs: 0 },
    tokenUsage: { uncappedInputTokens: 0, uncachedInputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 0 },
    title: id,
  });
  const phaseSnapshots = Object.fromEntries(phaseRecords.map((record) => [record.header.id, { asOfSeq: 10, values: phaseValues(record.header.id) }]));
  const phaseCtx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on(name, listener) { phaseState.listener = listener; return () => {}; },
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => undefined },
    sessionQuery: {
      listSessions: async () => phaseRecords,
      observeSession: async (id) => ({ header: phaseRecords.find((r) => r.header.id === id).header, projections: { asOfSeq: 10, values: phaseValues(id) }, dispose() {} }),
      readSession: async () => {
        phaseState.reads += 1;
        await phaseState.gate;
        return { session: {}, inheritedEventCount: 0, events: [lifecycleEvent("deepseek-flash")] };
      },
    },
    sessionProjectionCache: { cachedSnapshot: (header) => phaseSnapshots[String(header.id)] },
    webServer: { register(spec) { phaseRoutes.push(spec); return () => {}; } },
  };
  const phaseIndex = apply(phaseCtx, { indexPath: PHASE_INDEX, modelFoldWarmupMs: 60000, refreshMs: 60000 });
  const phaseReady = await waitHealth(phaseRoutes, (body) => body.indexing === false && body.diagnostics?.lastSyncAt > 0, "三态实例索引就绪");
  eq(phaseReady.diagnostics.sessions, 2, "三态实例索引 2 个会话");
  eq(phaseState.reads, 0, "索引就绪不读事件日志（不再由 sync 末尾触发折叠）");
  eq(phaseReady.diagnostics.modelFold.phase, "idle", "打开前 phase = idle（等定时器，不抢跑）");

  // 打开 5 次：只允许命中/构建聚合快照，绝不允许读事件日志
  for (let i = 0; i < 5; i += 1) await callOn(phaseRoutes, "/workload-report/v1/snapshot?days=30&tz=UTC");
  eq(phaseState.reads, 0, "打开 5 次面板：0 次 readSession（读日志）");
  const openDiag = (await waitHealth(phaseRoutes, (body) => body.diagnostics?.snapshotCache?.requests >= 5, "快照缓存统计")).diagnostics;
  eq(openDiag.snapshotCache.hits, 4, "打开 5 次：4 次命中缓存（首开未命中）");
  eq(openDiag.snapshotCache.misses, 1, "打开 5 次：1 次聚合构建（仅首开）");
  eq(openDiag.snapshotCache.hitRate, 0.8, "缓存命中率 4/5 = 80%");
  eq(openDiag.snapshotCache.ttlMs, 15000, "快照缓存 TTL = 15s（5s → 15s）");
  ok(typeof openDiag.snapshotMs === "number" && openDiag.snapshotMs >= 0, "/health 暴露快照构建耗时（snapshotMs）");
  eq(typeof openDiag.foldRoundMs, "number", "/health 暴露折叠单轮耗时（foldRoundMs）");
  eq(openDiag.foldSessionsRead, 0, "/health 暴露折叠读取会话数（foldSessionsRead，打开后仍为 0）");
  const openSnap = JSON.parse((await callOn(phaseRoutes, "/workload-report/v1/snapshot?days=30&tz=UTC")).body);
  const openHealth = (await waitHealth(phaseRoutes, () => true, "缓存指标")).diagnostics;
  eq(openSnap.diagnostics.snapshotCache.hitRate, openHealth.snapshotCache.hitRate, "/snapshot.diagnostics 与 /health 同源暴露缓存指标");

  // first-fold：后台定时器（这里手动触发一次）开始读日志 → phase = first-fold
  phaseState.gate = new Promise((resolve) => { phaseState.release = resolve; });
  phaseIndex.scheduleModelFold({ force: true });
  const folding = await waitHealth(phaseRoutes, (body) => body.diagnostics.modelFold.running === true && body.diagnostics.modelFold.phase !== "idle", "首次折叠开始");
  eq(folding.diagnostics.modelFold.phase, "first-fold", "首次从未折过 → phase = first-fold（显示「正在计算中……」）");
  ok(folding.diagnostics.foldSessionsRead >= 1, "折叠进行中 foldSessionsRead 随读取增长");
  phaseState.release();
  phaseState.gate = Promise.resolve();
  const folded = await waitHealth(phaseRoutes, (body) => body.diagnostics.modelFold.running === false && body.diagnostics.modelFold.pending === 0, "首次折叠完成");
  eq(folded.diagnostics.modelFold.phase, "idle", "首次折叠完成 → phase = idle");

  // 折叠完成必须让快照缓存失效：下一次请求重新聚合
  const beforeInvalidate = folded.diagnostics.snapshotCache.misses;
  await callOn(phaseRoutes, "/workload-report/v1/snapshot?days=30&tz=UTC");
  const afterInvalidate = (await waitHealth(phaseRoutes, (body) => body.diagnostics?.snapshotCache?.misses >= beforeInvalidate + 1, "折叠后缓存失效")).diagnostics;
  eq(afterInvalidate.snapshotCache.misses, beforeInvalidate + 1, "折叠完成 → 快照缓存立即失效（不等 15s TTL）");
  await callOn(phaseRoutes, "/workload-report/v1/snapshot?days=30&tz=UTC");
  eq((await waitHealth(phaseRoutes, (body) => body.diagnostics?.snapshotCache?.hits >= 1, "失效后重新命中")).diagnostics.snapshotCache.misses, beforeInvalidate + 1, "失效后下一次重新命中（只多一次构建）");

  // background：已折过的会话重折 → phase = background（不打扰）
  phaseIndex.rows.get("N1").asOfSeq += 1;
  phaseState.gate = new Promise((resolve) => { phaseState.release = resolve; });
  phaseIndex.scheduleModelFold({ force: true });
  const background = await waitHealth(phaseRoutes, (body) => body.diagnostics.modelFold.running === true && body.diagnostics.modelFold.phase !== "idle", "后台重折开始");
  eq(background.diagnostics.modelFold.phase, "background", "已折过 → 重折 phase = background（只灰点「后台更新中」）");
  phaseState.release();
  phaseState.gate = Promise.resolve();
  await waitHealth(phaseRoutes, (body) => body.diagnostics.modelFold.running === false, "后台重折完成");
  const afterRound = (await waitHealth(phaseRoutes, (body) => body.diagnostics.foldRounds >= 2, "折叠轮次")).diagnostics;
  ok(afterRound.foldRoundMs >= 0 && afterRound.foldRounds >= 2, "折叠轮次与单轮耗时写入 /health", `rounds=${afterRound.foldRounds} ms=${afterRound.foldRoundMs}`);

  // 失败重试低频：20 分钟内不进队列，过了 30 分钟窗口才重试
  const failedRow = phaseIndex.rows.get("N2");
  delete failedRow.models;
  failedRow.modelFoldError = "unsupported descriptor version 2";
  failedRow.modelFoldErrorAt = Date.now() - 20 * 60 * 1000;
  eq(phaseIndex.modelFoldQueue().failed.length, 0, "失败行 20min 内不重试（modelRetryMs = 30min）");
  failedRow.modelFoldErrorAt = Date.now() - 31 * 60 * 1000;
  eq(phaseIndex.modelFoldQueue().failed.length, 1, "失败行超过 30min 才进入低频重试队列");
  eq(phaseIndex.modelFoldDiagnostics().phase, "idle", "失败行不改变 phase（绝不让状态显示为计算中）");
  await rm(PHASE_INDEX, { force: true }).catch(() => {});
}

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

// ---------------------------------------------------------------- AI 用户画像（默认关闭 / 可选 llm / 降级）
console.log("\n—— AI 用户画像（默认关闭 / 缓存 / 降级 / 超时）——");

/** llm 服务桩：listProviders / listModels / prepareCall / stream 全本地，spy 记录次数。 */
function makeLlm({ providers = [{ id: "p" }], models = [{ id: "m" }], text = "", finishKind = "stop", hang = false, prepareError = null } = {}) {
  const spy = { providers: 0, models: 0, prepare: 0, stream: 0, payload: null, prepareConfig: null };
  const service = {
    listProviders() {
      spy.providers += 1;
      return providers;
    },
    async listModels() {
      spy.models += 1;
      return models;
    },
    async prepareCall(config) {
      spy.prepare += 1;
      spy.prepareConfig = { ...config };
      if (prepareError !== null) throw prepareError;
      if (hang) return new Promise(() => {});
      return {
        config: { ...config },
        stream(options) {
          spy.stream += 1;
          spy.payload = options;
          return (async function* () {
            if (text !== "") yield { type: "text-delta", text };
            yield { type: "usage", usage: { inputTokens: 12, outputTokens: 34 } };
            yield { type: "finish", reason: { kind: finishKind } };
          })();
        },
      };
    },
  };
  return { spy, service };
}

/** 宿主路由测试用的合法 AI 输出（4 维度 + 2 建议，所有 insight 含数字）。 */
const AI_HOST_SAMPLE = {
  headline: "白天节奏的稳定交付者",
  dimensions: [
    { key: "rhythm", title: "节奏", insight: "上午活跃 62%，高峰 10:00", evidence: "上午 62% · 高峰 10:00" },
    { key: "focus", title: "专注", insight: "单会话 1.0 h，短会话占 0%", evidence: "会话 1 · 均值 1.0 h" },
    { key: "stack", title: "工具栈", insight: "缓存命中 80%，输入占 20%", evidence: "缓存 80% · 输入 20%" },
    { key: "collab", title: "协作", insight: "等待用户 0%，每会话 2 轮", evidence: "2 轮 · 4 步" },
  ],
  advice: [
    { text: "固定系统提示与上下文", why: "缓存命中 80%" },
    { text: "给高消耗会话设产出目标", why: "单会话 0.83 K" },
  ],
  risk: null,
};
const aiHostText = () => JSON.stringify(AI_HOST_SAMPLE);

/** 起一个隔离宿主实例：可选 llm / 默认模型 / aiProfile 配置。 */
function bootProfile({ aiProfile = {}, llm, defaultSelection } = {}) {
  const routeList = [];
  const getSpy = { count: 0 };
  const pRecords = [
    { header: { id: "p1", createdAt: base, cwd: "/tmp/secret-workspace", isSeeded: false, version: 4 }, live: false, persisted: true },
  ];
  const pValues = {
    sessionStats: { turns: 2, steps: 4, llmMs: HOUR, toolMs: 0 },
    tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 400, cacheWriteTokens: 0 },
    title: "机密会话标题不要外发",
  };
  const pCtx = {
    logger: { info() {}, warn() {} },
    effect(fn) { fn(); return () => {}; },
    on() { return () => {}; },
    get(name) {
      getSpy.count += 1;
      if (name === "llm") return llm;
      if (name === "agentDefaultModel") return defaultSelection === undefined ? undefined : { currentSelection: () => defaultSelection };
      return undefined;
    },
    sessions: { get: () => undefined },
    sessionProjections: { snapshot: () => undefined },
    sessionQuery: {
      listSessions: async () => pRecords,
      observeSession: async () => ({ header: pRecords[0].header, projections: { asOfSeq: 1, values: pValues }, dispose() {} }),
      readSession: async () => ({
        session: {}, inheritedEventCount: 0,
        events: [{
          type: "assistant/message", seq: 1, time: base,
          data: {
            turn: 1, step: 1,
            message: { role: "assistant", source: { kind: "model", provider: "p", model: "m" } },
            usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 0 },
            stream: [{ type: "chunk", time: 0 }, { type: "chunk", time: 400 }],
          },
        }],
      }),
    },
    sessionProjectionCache: { cachedSnapshot: () => ({ asOfSeq: 1, values: pValues }) },
    webServer: { register(spec) { routeList.push(spec); return () => {}; } },
  };
  const config = {
    indexPath: "/tmp/wl-verify-profile-" + process.pid + "-" + (bootProfile.seq++) + ".json",
    // 默认不写 enabled：走插件默认值（应为 true）；显式传 { enabled: false } 才关闭。
    aiProfile,
  };
  const index = apply(pCtx, config);
  return { routeList, indexPath: config.indexPath, profile: index.profile, getSpy };
}
bootProfile.seq = 1;

/** 删掉本次测试的索引与对应画像缓存。 */
async function cleanupProfile(host, body) {
  await rm(host.indexPath, { force: true }).catch(() => {});
  if (typeof body?.fingerprint === "string" && body.fingerprint !== "") {
    await rm(host.profile.cachePath("zh", body.fingerprint), { force: true }).catch(() => {});
  }
}

// 0) 默认包含（无配置）：enabled=true，但首开 probe 仍然零模型调用
{
  eq(AI_PROFILE_DEFAULTS.enabled, true, "默认配置：aiProfile.enabled=true（默认包含）");
  eq(AI_PROFILE_DEFAULTS.minDays, 30, "默认配置：aiProfile.minDays=30");
  eq(normalizeAiProfile({}).enabled, true, "配置归一化：未写 enabled 时默认 true");
  eq(normalizeAiProfile({ enabled: false }).enabled, false, "配置归一化：显式 false 才关闭");
  eq(normalizeAiProfile({ minDays: 45 }).minDays, 45, "配置归一化：minDays 可覆盖");
  eq(profileWindowDays(7, 30), 30, "窗口下限：days=7 → 30");
  eq(profileWindowDays(90, 30), 90, "窗口下限：days=90 保持 90");
  eq(profileWindowDays(7, 45), 45, "窗口下限：minDays=45 时 → 45");
  eq(profileWindowQuery({ days: 7, all: true }, 30).days, 30, "查询窗口：all 也先把 days 抬到 30");

  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, defaultSelection: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "默认包含实例索引完成");
  eq(host.profile.config.enabled, true, "默认包含：宿主配置 enabled=true");
  const probe = await routeJson(host.routeList, "/workload-report/v1/profile?probe=1&days=7&tz=UTC");
  eq(probe.body.enabled, true, "默认包含：probe.enabled=true（入口可见）");
  eq(probe.body.summaryDays, 30, "默认包含：probe 提示窗口至少 30 天");
  eq(llm.spy.prepare, 0, "首开零调用：probe 后 llm.prepareCall 次数 = 0");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=7&tz=UTC&lang=zh");
  eq(res.body.enabled, true, "默认包含：点击生成后 enabled=true");
  ok(res.body.summaryDays >= 30, "默认请求：响应 summaryDays >= 30", String(res.body.summaryDays));
  eq(llm.spy.prepare, 1, "点击生成：llm.prepareCall 次数 = 1");
  await cleanupProfile(host, res.body);
}

// 1) 显式关闭：路由返回 enabled:false，零服务调用（连 ctx.get 都不发生）
{
  const llm = makeLlm();
  const host = bootProfile({ aiProfile: { enabled: false }, llm: llm.service });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "画像默认关闭实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.status, 200, "默认关闭：/profile 仍返回 200");
  eq(res.body.enabled, false, "默认关闭：enabled=false");
  eq(res.body.code, "AI_PROFILE_DISABLED", "默认关闭：code=AI_PROFILE_DISABLED");
  eq(host.profile.calls, 0, "默认关闭：模型调用次数 = 0");
  eq(llm.spy.prepare, 0, "默认关闭：prepareCall 一次都没调");
  eq(host.getSpy.count, 0, "默认关闭：ctx.get 也一次不调（零服务调用）");
  const probe = await routeJson(host.routeList, "/workload-report/v1/profile?probe=1");
  eq(probe.body.enabled, false, "默认关闭 probe：enabled=false（前端据此不渲染入口）");
  eq(llm.spy.prepare, 0, "默认关闭 probe：仍然零模型调用");
  await cleanupProfile(host, null);
}

// 2) llm 服务缺失：本地规则版 + LLM_UNAVAILABLE
{
  const host = bootProfile({ llm: undefined });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "无 llm 实例索引完成");
  const probe = await routeJson(host.routeList, "/workload-report/v1/profile?probe=1");
  eq(probe.body.available, false, "无 llm：probe.available=false");
  eq(probe.body.code, "LLM_UNAVAILABLE", "无 llm：probe.code=LLM_UNAVAILABLE");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "local", "无 llm：降级 source=local");
  eq(res.body.code, "LLM_UNAVAILABLE", "无 llm：code=LLM_UNAVAILABLE");
  ok(typeof res.body.headline === "string" && res.body.headline.length > 0, "无 llm：仍有本地 headline");
  ok(Array.isArray(res.body.dimensions) && res.body.dimensions.length >= 4 && res.body.dimensions.length <= 6, "无 llm：仍有 4–6 个本地维度");
  ok(Array.isArray(res.body.advice) && res.body.advice.length >= 2 && res.body.advice.length <= 3, "无 llm：仍有 2–3 条本地建议");
  ok(res.body.risk === null || typeof res.body.risk === "string", "无 llm：risk 为 null 或字符串");
  ok(res.body.usage.input === 0 && res.body.costHint.inputTokens === 0, "无 llm：usage / costHint 均为 0");
  await cleanupProfile(host, res.body);
}

// 3) 未登录（provider 列表为空）：本地规则版 + ACCOUNT_SIGN_IN_REQUIRED
{
  const llm = makeLlm({ providers: [] });
  const host = bootProfile({ llm: llm.service });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "未登录实例索引完成");
  const probe = await routeJson(host.routeList, "/workload-report/v1/profile?probe=1");
  eq(probe.body.signedIn, false, "未登录：probe.signedIn=false");
  eq(probe.body.code, "ACCOUNT_SIGN_IN_REQUIRED", "未登录：probe.code=ACCOUNT_SIGN_IN_REQUIRED");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "local", "未登录：降级 source=local");
  eq(res.body.code, "ACCOUNT_SIGN_IN_REQUIRED", "未登录：code=ACCOUNT_SIGN_IN_REQUIRED");
  eq(llm.spy.prepare, 0, "未登录：不发起模型调用");
  await cleanupProfile(host, res.body);
}

// 4) 解析失败 / 非 stop：本地规则版 + 稳定 code
{
  const llm = makeLlm({ text: "这不是 JSON" });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "解析失败实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "local", "解析失败：降级 source=local");
  eq(res.body.code, "AI_PARSE_FAILED", "解析失败：code=AI_PARSE_FAILED");
  eq(llm.spy.prepare, 1, "解析失败：确实调用过一次模型");
  ok(String(res.body.diagnostic?.excerpt ?? "").includes("这不是 JSON"), "解析失败：diagnostic.excerpt 保留原始文本");
  ok([...String(res.body.diagnostic?.excerpt ?? "")].length <= 300, "解析失败：diagnostic.excerpt ≤300 字符");
  ok(Array.isArray(res.body.dimensions) && res.body.dimensions.length >= 4, "解析失败：降级后仍有完整本地结构");
  await cleanupProfile(host, res.body);
}
{
  // 无法修复的截断：模型在字符串中间就断了，补齐后 schema 仍不合格 → 本地规则 + AI_NOT_STOPPED
  const truncatedText = '{"headline":"被截断的画像","dimensions":[{"key":"rhythm","title":"节奏","insight":"上午活跃 62%';
  const llm = makeLlm({ text: truncatedText, finishKind: "length" });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "不可修复截断实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "local", "不可修复截断：降级 source=local");
  eq(res.body.code, "AI_NOT_STOPPED", "不可修复截断：code=AI_NOT_STOPPED");
  eq(res.body.diagnostic?.finish?.kind, "length", "不可修复截断：diagnostic.finish.kind=length");
  eq(res.body.diagnostic?.textLength, Array.from(truncatedText).length, "不可修复截断：diagnostic.textLength 记录输出字符数");
  eq(res.body.diagnostic?.repaired, false, "不可修复截断：diagnostic.repaired=false");
  ok(String(res.body.diagnostic?.excerpt ?? "").includes("被截断的画像"), "不可修复截断：diagnostic.excerpt 保留前 300 字");
  ok([...String(res.body.diagnostic?.excerpt ?? "")].length <= 300, "不可修复截断：diagnostic.excerpt ≤300 字符");
  await cleanupProfile(host, res.body);
}
{
  // 可修复的截断：finish.kind=length + 缺根对象右括号 → 补齐后 source=llm + truncated=true
  const completeText = aiHostText();
  const truncatedText = completeText.slice(0, -1);
  const llm = makeLlm({ text: truncatedText, finishKind: "length" });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "可修复截断实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "llm", "可修复截断：source=llm（不降级）");
  eq(res.body.code, null, "可修复截断：code=null");
  eq(res.body.truncated, true, "可修复截断：truncated=true");
  eq(res.body.headline, AI_HOST_SAMPLE.headline, "可修复截断：采用修复后的 headline");
  eq(res.body.dimensions.length, 4, "可修复截断：采用修复后的 4 个维度");
  eq(res.body.diagnostic?.finish?.kind, "length", "可修复截断：diagnostic.finish.kind=length");
  eq(res.body.diagnostic?.textLength, Array.from(truncatedText).length, "可修复截断：diagnostic.textLength");
  eq(res.body.diagnostic?.repaired, true, "可修复截断：diagnostic.repaired=true");
  ok(String(res.body.diagnostic?.excerpt ?? "").startsWith('{"headline"'), "可修复截断：diagnostic.excerpt 保留输出开头");
  await cleanupProfile(host, res.body);
}

// 5) 超时：AbortSignal.timeout(timeoutMs) 触发降级，路由不悬挂
{
  const llm = makeLlm({ hang: true });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m", timeoutMs: 40 } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "超时实例索引完成");
  const started = Date.now();
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  const elapsed = Date.now() - started;
  ok(elapsed < 1000, "超时：路由在 1s 内返回（不悬挂）", elapsed + "ms");
  eq(res.body.source, "local", "超时：降级 source=local");
  eq(res.body.code, "AI_TIMEOUT", "超时：code=AI_TIMEOUT");
  eq(res.body.diagnostic?.error?.stage, "prepareCall", "超时：stage 标记卡住的阶段");
  eq(llm.spy.prepare, 1, "超时：模型准备只发起一次");
  await cleanupProfile(host, res.body);
}

// 6) 成功 + 指纹缓存：第二次不再调用模型，force=1 才重新生成
{
  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m", maxTokens: 1600 } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "成功实例索引完成");
  const probe = await routeJson(host.routeList, "/workload-report/v1/profile?probe=1");
  eq(probe.body.available, true, "probe：已登录可用");
  eq(llm.spy.prepare, 0, "probe 只预检，不调用模型");

  const first = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC&lang=zh");
  eq(first.body.source, "llm", "成功：source=llm");
  eq(first.body.code, null, "成功：code=null");
  eq(first.body.cached, false, "成功：首次 cached=false");
  eq(first.body.usage.input, 12, "成功：记录输入 tokens");
  eq(first.body.usage.output, 34, "成功：记录输出 tokens");
  eq(first.body.usage.total, 46, "成功：usage.total = input + output");
  eq(first.body.costHint.inputTokens, 12, "成功：costHint.inputTokens 记录输入");
  eq(first.body.costHint.outputTokens, 34, "成功：costHint.outputTokens 记录输出（不猜价格）");
  eq(first.body.headline, AI_HOST_SAMPLE.headline, "成功：返回 headline");
  eq(first.body.dimensions.length, 4, "成功：返回 4 个维度");
  eq(first.body.dimensions[0].key, "rhythm", "成功：维度带 key");
  ok(first.body.dimensions.every((item) => item.title && item.insight && item.evidence), "成功：维度含 title / insight / evidence");
  eq(first.body.advice.length, 2, "成功：返回 2 条建议");
  ok(first.body.advice.every((item) => item.text && item.why), "成功：建议含 text / why");
  eq(first.body.risk, null, "成功：risk=null 透传");
  ok(first.body.generatedAt > 0, "成功：记录生成时间");
  eq(llm.spy.prepare, 1, "成功：模型调用 1 次");
  ok(!("maxTokens" in llm.spy.prepareConfig), "成功：prepareCall 参数不含 maxTokens（配置里写了也忽略）");
  eq(AI_PROFILE_DEFAULTS.maxTokens, undefined, "配置默认已移除 maxTokens（避免 JSON 被截断）");
  eq(host.profile.config.maxTokens, undefined, "配置归一化后不保留 maxTokens");
  eq(llm.spy.prepareConfig?.temperature, 0.35, "成功：temperature=0.35");
  eq(llm.spy.prepareConfig?.reasoningEffort, undefined, "成功：仍然不指定 reasoningEffort");

  const systemText = String(llm.spy.payload?.system ?? "");
  ok(systemText.includes("引用数字"), "prompt 必含「引用数字」");
  ok(systemText.includes("可用键"), "prompt 必含「可用键」");
  for (const field of ["headline", "dimensions", "advice", "risk", "evidence", "insight", "why"]) {
    ok(systemText.includes(field), "prompt 含 schema 字段：" + field);
  }
  ok(systemText.includes("trendActiveDeltaPct") && systemText.includes("durationUnder15mShare") && systemText.includes("bandAfternoonActiveShare"), "prompt 的可用键覆盖新增字段");
  ok(systemText.includes("不要 Markdown") && systemText.includes("严格 JSON"), "prompt 要求严格 JSON、不要 Markdown");
  eq(systemPrompt("zh"), systemText, "systemPrompt('zh') 与实际发送的 system 一致");
  ok(systemPrompt("en").includes("senior productivity analyst") && systemPrompt("en").includes("MUST cite concrete numbers"), "英文 prompt 同样要求引用数字");

  const sentPayload = JSON.parse(llm.spy.payload.messages[0].content[0].text);
  eq(
    JSON.stringify(Object.keys(sentPayload).sort()),
    JSON.stringify([...PROFILE_PAYLOAD_KEYS].sort()),
    "实际发给模型的键集合严格等于白名单",
  );
  ok("durationUnder15mShare" in sentPayload && "bandNightTokenShare" in sentPayload && "trendActiveDeltaPct" in sentPayload, "实际发送内容包含新增结构字段");
  ok(sentPayload.trendActiveDeltaPct === null || typeof sentPayload.trendActiveDeltaPct === "number", "趋势环比是数字或 null（数据不足）");
  ok(!JSON.stringify(sentPayload).includes("机密会话标题"), "实际发送内容不含会话标题");
  ok(!JSON.stringify(sentPayload).includes("/tmp/secret-workspace"), "实际发送内容不含路径原文");
  ok(!/"(title|cwd|sessionId|prompt|content|message)"/i.test(JSON.stringify(sentPayload)), "实际发送内容不含私有键");

  const second = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC&lang=zh");
  eq(second.body.cached, true, "缓存命中：第二次 cached=true");
  eq(second.body.fingerprint, first.body.fingerprint, "缓存命中：同一统计指纹");
  eq(second.body.headline, first.body.headline, "缓存命中：headline 与首次一致");
  eq(second.body.dimensions.length, 4, "缓存命中：dimensions 与首次一致");
  eq(second.body.costHint.inputTokens, 12, "缓存命中：costHint 随缓存返回");
  eq(llm.spy.prepare, 1, "缓存命中：第二次请求模型调用次数仍为 1");

  const forced = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC&lang=zh&force=1");
  eq(forced.body.cached, false, "force=1：跳过缓存重新生成");
  eq(llm.spy.prepare, 2, "force=1：模型调用次数 +1");
  await cleanupProfile(host, first.body);
}

// 6b) 汇总窗口至少 minDays：day=7 仍按 30 天聚合，payload/查询窗口 days >= 30
{
  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "窗口下限实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=7&tz=UTC&lang=zh");
  const sent = JSON.parse(llm.spy.payload.messages[0].content[0].text);
  ok(sent.range.days >= 30, "payload：看板选 7 天时实际发送窗口 days >= 30", String(sent.range.days));
  eq(res.body.summaryDays, sent.range.days, "响应 summaryDays 与 payload.range.days 同源");
  eq(llm.spy.prepare, 1, "窗口下限：模型仍只调用一次");
  await cleanupProfile(host, res.body);
}
{
  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m", minDays: 45 } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "minDays=45 实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=7&tz=UTC&lang=zh");
  const sent = JSON.parse(llm.spy.payload.messages[0].content[0].text);
  eq(sent.range.days, 45, "minDays 可配置：days=7 + minDays=45 → payload 45 天");
  eq(res.body.summaryDays, 45, "minDays 可配置：响应 summaryDays=45");
  await cleanupProfile(host, res.body);
}
{
  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "大窗口实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=90&tz=UTC&lang=zh");
  const sent = JSON.parse(llm.spy.payload.messages[0].content[0].text);
  eq(sent.range.days, 90, "窗口上限：看板选 90 天时仍用 90 天（max(当前区间, minDays)）");
  eq(res.body.summaryDays, 90, "窗口上限：响应 summaryDays=90");
  await cleanupProfile(host, res.body);
}

// 7) 未配置 provider/model：回落到宿主默认模型
{
  const llm = makeLlm({ text: aiHostText() });
  const host = bootProfile({ llm: llm.service, defaultSelection: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "默认模型实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.source, "llm", "默认模型：成功 source=llm");
  eq(res.body.model.provider, "p", "默认模型：provider 来自 agentDefaultModel");
  eq(res.body.model.model, "m", "默认模型：model 来自 agentDefaultModel");
  eq(res.body.route.origin, "agentDefaultModel", "默认模型：route.origin=agentDefaultModel");
  await cleanupProfile(host, res.body);
}

// 8) 失败诊断：保留底层 code / message / stage，并暴露 route / precheck
{
  const prepareError = new Error("X");
  prepareError.code = "PROVIDER_NOT_FOUND";
  const llm = makeLlm({ prepareError });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "诊断失败实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.status, 200, "诊断：失败仍返回 200（不抛给 UI）");
  eq(res.body.source, "local", "诊断：失败降级 source=local");
  eq(res.body.code, "AI_FAILED", "诊断：映射码 AI_FAILED");
  eq(res.body.diagnostic?.source, "local", "诊断：diagnostic.source=local");
  eq(res.body.diagnostic?.code, "AI_FAILED", "诊断：diagnostic.code=映射码");
  eq(res.body.diagnostic?.error?.code, "PROVIDER_NOT_FOUND", "诊断：底层错误码被保留（PROVIDER_NOT_FOUND）");
  eq(res.body.diagnostic?.error?.stage, "prepareCall", "诊断：stage 标记 prepareCall");
  ok(String(res.body.diagnostic?.error?.message ?? "").includes("X"), "诊断：保留底层 message");
  eq(
    JSON.stringify(Object.keys(res.body.diagnostic.error).sort()),
    JSON.stringify(["code", "message", "stage"]),
    "诊断：diagnostic.error 固定 code / message / stage",
  );
  eq(res.body.route?.provider, "p", "诊断：route.provider 可见");
  eq(res.body.route?.model, "m", "诊断：route.model 可见");
  eq(res.body.route?.origin, "config", "诊断：route.origin=config");
  eq(JSON.stringify(res.body.precheck?.providers), JSON.stringify(["p"]), "诊断：precheck.providers 来自 listProviders");
  eq(JSON.stringify(res.body.precheck?.models), JSON.stringify(["m"]), "诊断：precheck.models 来自 listModels");
  ok(typeof res.body.headline === "string" && res.body.headline.length > 0, "诊断：默认路径仍有本地 headline");
  ok(Array.isArray(res.body.dimensions) && res.body.dimensions.length >= 4, "诊断：默认路径仍有 4–6 个本地维度");
  ok(Array.isArray(res.body.advice) && res.body.advice.length >= 2, "诊断：默认路径仍有 2–3 条本地建议");

  const health = await routeJson(host.routeList, "/workload-report/v1/health");
  const aiProfile = health.body.diagnostics.aiProfile;
  eq(
    JSON.stringify(Object.keys(aiProfile).sort()),
    JSON.stringify(["enabled", "lastAt", "lastCode", "lastError", "lastStage", "route"]),
    "/health：aiProfile 字段固定",
  );
  eq(aiProfile.enabled, true, "/health：aiProfile.enabled=true");
  eq(aiProfile.lastCode, "AI_FAILED", "/health：lastCode=AI_FAILED");
  eq(aiProfile.lastStage, "prepareCall", "/health：lastStage=prepareCall");
  ok(String(aiProfile.lastError ?? "").includes("X"), "/health：lastError 保留底层 message");
  ok(aiProfile.lastAt > 0, "/health：lastAt 有值");
  eq(aiProfile.route?.provider, "p", "/health：route.provider 与 /profile 同源");
  await cleanupProfile(host, res.body);
}

// 9) 诊断脱敏与截断：token / key 字样与明文密钥都不出现，message ≤ 300 字符
{
  const prepareError = new Error("X token=sk-live-abc123 key=super-secret " + "a".repeat(400));
  prepareError.code = "PROVIDER_NOT_FOUND";
  const llm = makeLlm({ prepareError });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "脱敏实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  const message = String(res.body.diagnostic?.error?.message ?? "");
  ok(message.includes("X"), "脱敏：保留非敏感信息");
  ok(!/token|key/i.test(message), "脱敏：message 不含 key / token 字样", message);
  ok(!message.includes("sk-live-abc123") && !message.includes("super-secret"), "脱敏：不泄露明文密钥");
  const chars = Array.from(message).length;
  ok(chars > 0 && chars <= 300, "截断：message 不超过 300 字符", String(chars));
  const health = await routeJson(host.routeList, "/workload-report/v1/health");
  const lastError = String(health.body.diagnostics.aiProfile.lastError ?? "");
  ok(!/token|key/i.test(lastError) && Array.from(lastError).length <= 300, "/health：lastError 同样脱敏并截断");
  await cleanupProfile(host, res.body);
}

// 10) 调试用 provider/model 查询覆盖：只影响本次请求，且不写缓存
{
  const llm = makeLlm({
    providers: [{ id: "p" }, { id: "q" }],
    models: [{ id: "m" }, { id: "n" }],
    text: aiHostText(),
  });
  const host = bootProfile({ llm: llm.service, aiProfile: { provider: "p", model: "m" } });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "调试覆盖实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC&provider=q&model=n");
  eq(res.body.source, "llm", "查询覆盖：成功 source=llm");
  eq(res.body.route?.origin, "query", "查询覆盖：route.origin=query");
  eq(llm.spy.prepareConfig?.provider, "q", "查询覆盖：prepareCall 收到 provider=q");
  eq(llm.spy.prepareConfig?.model, "n", "查询覆盖：prepareCall 收到 model=n");
  eq(res.body.model?.provider, "q", "查询覆盖：响应 model.provider=q");
  eq(res.body.model?.model, "n", "查询覆盖：响应 model.model=n");
  ok(res.body.precheck?.models?.includes("n"), "查询覆盖：precheck.models 含调试模型");

  const normal = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(normal.body.cached, false, "查询覆盖：不写缓存，正常请求重新生成");
  eq(llm.spy.prepareConfig?.provider, "p", "查询覆盖：正常路径仍用配置 provider=p");
  eq(normal.body.route?.origin, "config", "查询覆盖：正常路径 origin=config");
  eq(llm.spy.prepare, 2, "查询覆盖：调试请求与正常请求各调用一次模型");
  await cleanupProfile(host, res.body);
  await cleanupProfile(host, normal.body);
}

// 11) 现场场景：宿主默认模型 provider 不在 listProviders 里
{
  const llm = makeLlm({ providers: [{ id: "deepseek-official" }], models: [{ id: "deepseek-flash" }] });
  const host = bootProfile({
    llm: llm.service,
    defaultSelection: { provider: "magpie", model: "workbuddy-ai/default-model" },
  });
  await waitHealth(host.routeList, (body) => body.indexing === false && body.diagnostics.lastSyncAt > 0, "未注册 provider 实例索引完成");
  const res = await routeJson(host.routeList, "/workload-report/v1/profile?days=30&tz=UTC");
  eq(res.body.code, "MISSING_CREDENTIAL", "未注册 provider：code=MISSING_CREDENTIAL");
  eq(res.body.diagnostic?.error?.code, "MISSING_CREDENTIAL", "未注册 provider：底层 code 可见");
  eq(res.body.diagnostic?.error?.stage, "route", "未注册 provider：stage=route");
  eq(res.body.route?.provider, "magpie", "未注册 provider：route 仍显示默认 provider");
  eq(res.body.route?.model, "workbuddy-ai/default-model", "未注册 provider：route 仍显示默认 model");
  eq(res.body.route?.origin, "agentDefaultModel", "未注册 provider：origin=agentDefaultModel");
  eq(JSON.stringify(res.body.precheck?.providers), JSON.stringify(["deepseek-official"]), "未注册 provider：precheck 暴露已注册列表");
  eq(res.body.precheck?.models?.length, 0, "未注册 provider：models 为空数组（不伪造）");
  const health = await routeJson(host.routeList, "/workload-report/v1/health");
  eq(health.body.diagnostics.aiProfile.lastCode, "MISSING_CREDENTIAL", "/health：现场场景 lastCode 可见");
  eq(health.body.diagnostics.aiProfile.lastStage, "route", "/health：现场场景 lastStage=route");
  eq(health.body.diagnostics.aiProfile.route?.provider, "magpie", "/health：现场场景 route.provider 可见");
  await cleanupProfile(host, res.body);
}

// 收尾：删掉本次的临时索引
await rm(INDEX_PATH, { force: true }).catch(() => {});
console.log(`\n${failures === 0 ? "全部通过 ✓" : `${failures} 项失败 ✗`}`);
process.exit(failures === 0 ? 0 : 1);
