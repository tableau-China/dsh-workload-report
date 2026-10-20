/**
 * AI 用户画像的纯函数层（宿主专用，不打进客户端包）。
 *
 * 红线：发给模型的内容只能是 buildProfilePayload() 返回的白名单对象——
 * 聚合统计，不含对话正文、标题、路径原文。函数内部对键集合做严格断言，
 * 任何新增字段都必须先改 PROFILE_PAYLOAD_KEYS（并同步文档与测试）。
 *
 * 模型失败时用 localProfile() 生成确定性的本地规则画像（不联网、不抛错）；
 * 两者使用同一结构：headline + dimensions + advice + risk。
 */

import { createHash } from "node:crypto";

import { formatHours, formatTokens } from "./format.js";
import {
  PROFILE_DIMENSION_KEYS,
  PROFILE_EVIDENCE_MAX,
  PROFILE_HEADLINE_MAX,
  PROFILE_INSIGHT_MAX,
  PROFILE_LINE_MAX,
  PROFILE_TITLE_MAX,
  clampProfileText,
  hasDigit,
  normalizeDimensionKey,
} from "./profile-schema.js";

export {
  PROFILE_DIMENSION_KEYS,
  PROFILE_EVIDENCE_MAX,
  PROFILE_HEADLINE_MAX,
  PROFILE_INSIGHT_MAX,
  PROFILE_LINE_MAX,
  PROFILE_TITLE_MAX,
  clampProfileText,
};

/**
 * 允许发给模型的顶层键（精确集合，多一个少一个都不行）。
 * 命名约定：*Ms = 毫秒；*Tokens = Token 数；*Share = 0–1 占比；
 * *Count / sessions / conversations 等 = 计数；trend*DeltaPct = 百分比（可为负）；
 * trend* 在区间不足 14 天或前 7 天无数据时为 null。
 */
export const PROFILE_PAYLOAD_KEYS = Object.freeze([
  "range",
  "activeMs",
  "netActiveMs",
  "waitMs",
  "waitShare",
  "sessions",
  "conversations",
  "turns",
  "steps",
  "tokensTotal",
  "tokensInput",
  "tokensOutput",
  "tokensCacheRead",
  "tokensCacheWrite",
  "inputShare",
  "outputShare",
  "cacheReadShare",
  "cacheWriteShare",
  "cacheHitRate",
  "avgOutputTokensPerTurn",
  "avgSessionActiveMs",
  "avgTurnsPerConversation",
  "avgStepsPerTurn",
  "durationUnder15mShare",
  "duration15to60mShare",
  "duration1to3hShare",
  "durationOver3hShare",
  "durationSampleSessions",
  "activeHours24",
  "bandNightActiveShare",
  "bandMorningActiveShare",
  "bandForenoonActiveShare",
  "bandAfternoonActiveShare",
  "bandEveningActiveShare",
  "bandNightTokenShare",
  "bandMorningTokenShare",
  "bandForenoonTokenShare",
  "bandAfternoonTokenShare",
  "bandEveningTokenShare",
  "byWorkspace",
  "byModel",
  "workspaceCount",
  "topWorkspaceShare",
  "workspaceSwitchCount",
  "modelCount",
  "topModelShare",
  "multiModel",
  "weekendShare",
  "nightShare",
  "trendDays",
  "trendActivePrevMs",
  "trendActiveLastMs",
  "trendActiveDeltaPct",
  "trendTokensPrev",
  "trendTokensLast",
  "trendTokensDeltaPct",
]);

/** 允许为负的键（环比可以为负）。 */
const SIGNED_KEYS = new Set(["trendActiveDeltaPct", "trendTokensDeltaPct"]);

/** 允许为 null 的键（数据不足时明确标记，不用 0 冒充）。 */
const NULLABLE_KEYS = new Set([
  "trendActivePrevMs",
  "trendActiveLastMs",
  "trendActiveDeltaPct",
  "trendTokensPrev",
  "trendTokensLast",
  "trendTokensDeltaPct",
]);

const MAX_SHARE_ITEMS = 5;
const MAX_STRING_CHARS = 120;
const ROUND = 10000;
const DAY_MS = 86400000;
const TREND_DAYS = 7;
const MINUTE_MS = 60000;
const HOUR_MS = 3600000;

/**
 * 时间段（覆盖 0–24 点，无空洞）：深夜 0–6、清晨 6–9、上午 9–12、
 * 下午 12–18（含 12–13 午间）、晚间 18–24。与 nightShare（22–6）口径不同。
 */
const BANDS = Object.freeze([
  { key: "night", from: 0, to: 6 },
  { key: "morning", from: 6, to: 9 },
  { key: "forenoon", from: 9, to: 12 },
  { key: "afternoon", from: 12, to: 18 },
  { key: "evening", from: 18, to: 24 },
]);

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const share = (value) => Math.round(Math.max(0, Math.min(1, num(value))) * ROUND) / ROUND;
const ratio = (part, total) => (num(total) > 0 ? share(num(part) / num(total)) : 0);
const round1 = (value) => Math.round(num(value) * 10) / 10;

/** 名称只保留最后一段，杜绝把完整路径带进 payload（工作区与模型名共用）。 */
function shortName(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (text === "") return "";
  const parts = text.split(/[\\/]+/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

/** 统计占比：周末（周六 / 周日）活跃时长 / 区间活跃时长。 */
function weekendShareOf(byDay) {
  let weekend = 0;
  let total = 0;
  for (const day of byDay) {
    const ms = Math.max(0, num(day?.activeMs));
    if (ms === 0) continue;
    total += ms;
    const parsed = Date.parse(String(day?.date ?? "") + "T00:00:00Z");
    if (!Number.isFinite(parsed)) continue;
    const weekday = new Date(parsed).getUTCDay();
    if (weekday === 0 || weekday === 6) weekend += ms;
  }
  return total > 0 ? weekend / total : 0;
}

/** 把 24 个小时值按 BANDS 求和并转成占比。 */
function bandShares(values) {
  const sums = Object.fromEntries(BANDS.map((band) => [band.key, 0]));
  for (let hour = 0; hour < 24; hour += 1) {
    const value = Math.max(0, num(values[hour]));
    if (value === 0) continue;
    const band = BANDS.find((item) => hour >= item.from && hour < item.to);
    if (band !== undefined) sums[band.key] += value;
  }
  const total = BANDS.reduce((sum, band) => sum + sums[band.key], 0);
  const out = {};
  for (const band of BANDS) out[band.key] = ratio(sums[band.key], total);
  return out;
}

/** 会话时长分桶（按有轮次 / 步骤的会话；只统计 bySession 样本）。 */
function durationShares(rows) {
  const counts = [0, 0, 0, 0];
  for (const row of rows) {
    const ms = Math.max(0, num(row?.activeMs));
    if (ms < 15 * MINUTE_MS) counts[0] += 1;
    else if (ms < HOUR_MS) counts[1] += 1;
    else if (ms < 3 * HOUR_MS) counts[2] += 1;
    else counts[3] += 1;
  }
  const total = rows.length;
  return counts.map((count) => ratio(count, total));
}

/**
 * 工作区切换次数（近似）：按创建时间排序样本会话，统计相邻两个真实工作区不同的次数。
 * bySession 只保留前 300 行，因此这是"近似值"，不是全量精确计数。
 */
function workspaceSwitches(rows) {
  const ordered = [...rows].sort((a, b) => num(a?.createdAt) - num(b?.createdAt));
  let previous = "";
  let switches = 0;
  for (const row of ordered) {
    const label = String(row?.workspaceLabel ?? "").trim();
    if (label === "" || label === "(未知工作区)") continue;
    if (previous !== "" && label !== previous) switches += 1;
    previous = label;
  }
  return switches;
}

/** 近 7 天 vs 前 7 天：区间不足 14 天或前 7 天无数据时全部 null。 */
function trendOf(byDay, range) {
  const empty = {
    trendDays: TREND_DAYS,
    trendActivePrevMs: null,
    trendActiveLastMs: null,
    trendActiveDeltaPct: null,
    trendTokensPrev: null,
    trendTokensLast: null,
    trendTokensDeltaPct: null,
  };
  if (Math.max(0, Math.round(num(range?.days))) < TREND_DAYS * 2) return empty;
  const end = Date.parse(String(range?.to ?? "") + "T00:00:00Z");
  if (!Number.isFinite(end)) return empty;
  const key = (ms) => new Date(ms).toISOString().slice(0, 10);
  const lastStart = key(end - (TREND_DAYS - 1) * DAY_MS);
  const prevStart = key(end - (TREND_DAYS * 2 - 1) * DAY_MS);
  const prevEnd = key(end - TREND_DAYS * DAY_MS);
  let lastActive = 0;
  let lastTokens = 0;
  let prevActive = 0;
  let prevTokens = 0;
  let prevSeen = false;
  for (const day of byDay) {
    const date = String(day?.date ?? "");
    if (date >= lastStart && date <= String(range?.to ?? "")) {
      lastActive += Math.max(0, num(day?.activeMs));
      lastTokens += Math.max(0, num(day?.tokensTotal));
    } else if (date >= prevStart && date <= prevEnd) {
      prevActive += Math.max(0, num(day?.activeMs));
      prevTokens += Math.max(0, num(day?.tokensTotal));
      prevSeen = true;
    }
  }
  if (!prevSeen || (prevActive <= 0 && prevTokens <= 0)) return empty;
  return {
    trendDays: TREND_DAYS,
    trendActivePrevMs: Math.round(prevActive),
    trendActiveLastMs: Math.round(lastActive),
    trendActiveDeltaPct: prevActive > 0 ? round1(((lastActive - prevActive) / prevActive) * 100) : null,
    trendTokensPrev: Math.round(prevTokens),
    trendTokensLast: Math.round(lastTokens),
    trendTokensDeltaPct: prevTokens > 0 ? round1(((lastTokens - prevTokens) / prevTokens) * 100) : null,
  };
}

/**
 * 从 present() 快照构造白名单 payload。
 *
 * activeHours24 是 Token 口径（每小时 tokensTotal），以保证「Token 或活跃」可核对；
 * nightShare（22:00–06:00）与 5 个 band*Share 用活跃时长，weekendShare 用按日活跃时长。
 * 会话时长分桶只来自 snapshot.bySession（最多 300 行）样本，durationSampleSessions 标注样本量。
 * @param snapshot - 看板/报告同源的 present(aggregate(...)) 结构。
 * @returns 严格白名单对象。
 */
export function buildProfilePayload(snapshot) {
  const totals = snapshot?.totals ?? {};
  const byHour = Array.isArray(snapshot?.byHour) ? snapshot.byHour : [];
  const byDay = Array.isArray(snapshot?.byDay) ? snapshot.byDay : [];
  const range = snapshot?.range ?? {};
  const waitMs = Math.max(0, Math.round(num(totals.waitMs)));
  const netActiveMs = totals.netActiveMs !== undefined
    ? Math.max(0, Math.round(num(totals.netActiveMs)))
    : Math.max(0, Math.round(num(totals.activeMs)) - waitMs);
  const hourTokens = Array.from({ length: 24 }, (_, hour) => Math.max(0, Math.round(num(byHour[hour]?.tokensTotal))));
  const hourActive = Array.from({ length: 24 }, (_, hour) => Math.max(0, num(byHour[hour]?.activeMs)));
  const hourActiveTotal = hourActive.reduce((sum, value) => sum + value, 0);
  const nightMs = hourActive.reduce((sum, value, hour) => (hour >= 22 || hour < 6 ? sum + value : sum), 0);

  const tokenParts = {
    input: Math.max(0, Math.round(num(totals?.tokens?.input))),
    output: Math.max(0, Math.round(num(totals?.tokens?.output))),
    cacheRead: Math.max(0, Math.round(num(totals?.tokens?.cacheRead))),
    cacheWrite: Math.max(0, Math.round(num(totals?.tokens?.cacheWrite))),
  };
  const tokensTotal = tokenParts.input + tokenParts.output + tokenParts.cacheRead + tokenParts.cacheWrite;

  const sessions = Math.max(0, Math.round(num(totals.sessions)));
  const conversations = Math.max(0, Math.round(num(totals.conversations)));
  const turns = Math.max(0, Math.round(num(totals.turns)));
  const steps = Math.max(0, Math.round(num(totals.steps)));

  const workspaceItems = (Array.isArray(snapshot?.byWorkspace) ? snapshot.byWorkspace : [])
    .map((item) => ({ name: shortName(item?.label), share: share(item?.activeShare) }))
    .filter((item) => item.name !== "" && item.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SHARE_ITEMS);

  const modelAll = (Array.isArray(snapshot?.byModel) ? snapshot.byModel : [])
    .map((item) => ({ name: shortName(item?.label), share: share(item?.share) }))
    .filter((item) => item.name !== "" && item.share > 0)
    .sort((a, b) => b.share - a.share);
  const modelItems = modelAll.slice(0, MAX_SHARE_ITEMS);

  const sessionRows = (Array.isArray(snapshot?.bySession) ? snapshot.bySession : [])
    .filter((row) => num(row?.steps) > 0 || num(row?.turns) > 0);
  const [under15m, from15mTo60m, from1hTo3h, over3h] = durationShares(sessionRows);
  const activeBands = bandShares(hourActive);
  const tokenBands = bandShares(hourTokens);
  const trend = trendOf(byDay, range);
  const workspaceCount = Math.max(0, Math.round(num(totals.workspaces)));

  const payload = {
    range: {
      from: String(range.from ?? ""),
      to: String(range.to ?? ""),
      days: Math.max(0, Math.round(num(range.days))),
      timeZone: String(range.timeZone ?? ""),
    },
    activeMs: netActiveMs,
    netActiveMs,
    waitMs,
    waitShare: ratio(waitMs, netActiveMs + waitMs),
    sessions,
    conversations,
    turns,
    steps,
    tokensTotal,
    tokensInput: tokenParts.input,
    tokensOutput: tokenParts.output,
    tokensCacheRead: tokenParts.cacheRead,
    tokensCacheWrite: tokenParts.cacheWrite,
    inputShare: ratio(tokenParts.input, tokensTotal),
    outputShare: ratio(tokenParts.output, tokensTotal),
    cacheReadShare: ratio(tokenParts.cacheRead, tokensTotal),
    cacheWriteShare: ratio(tokenParts.cacheWrite, tokensTotal),
    cacheHitRate: share(snapshot?.derived?.cacheHitRate),
    avgOutputTokensPerTurn: turns > 0 ? Math.round(tokenParts.output / turns) : 0,
    avgSessionActiveMs: conversations > 0 ? Math.round(netActiveMs / conversations) : 0,
    avgTurnsPerConversation: conversations > 0 ? round1(turns / conversations) : 0,
    avgStepsPerTurn: turns > 0 ? round1(steps / turns) : 0,
    durationUnder15mShare: under15m,
    duration15to60mShare: from15mTo60m,
    duration1to3hShare: from1hTo3h,
    durationOver3hShare: over3h,
    durationSampleSessions: sessionRows.length,
    activeHours24: { unit: "tokens", values: hourTokens },
    bandNightActiveShare: activeBands.night,
    bandMorningActiveShare: activeBands.morning,
    bandForenoonActiveShare: activeBands.forenoon,
    bandAfternoonActiveShare: activeBands.afternoon,
    bandEveningActiveShare: activeBands.evening,
    bandNightTokenShare: tokenBands.night,
    bandMorningTokenShare: tokenBands.morning,
    bandForenoonTokenShare: tokenBands.forenoon,
    bandAfternoonTokenShare: tokenBands.afternoon,
    bandEveningTokenShare: tokenBands.evening,
    byWorkspace: workspaceItems,
    byModel: modelItems,
    workspaceCount,
    topWorkspaceShare: workspaceItems[0]?.share ?? 0,
    workspaceSwitchCount: workspaceSwitches(sessionRows),
    modelCount: modelAll.length,
    topModelShare: modelItems[0]?.share ?? 0,
    multiModel: modelAll.length > 1,
    weekendShare: share(weekendShareOf(byDay)),
    nightShare: share(hourActiveTotal > 0 ? nightMs / hourActiveTotal : 0),
    ...trend,
  };

  assertProfilePayload(payload);
  return payload;
}

/** 键名里出现这些词就视为可能夹带私有数据（title / cwd / path / sessionId …）。 */
const FORBIDDEN_KEY = /(^|_)(title|cwd|path|sessionid|prompt|content|message|text|transcript|body|raw)($|_)/i;
/** 这些后缀的键必须是 0–1 占比。 */
const SHARE_KEY = /(Share|HitRate)$/;

/** 递归检查字符串值：不允许换行 / 路径分隔符 / 日志文件名（timeZone 例外）。 */
function assertNoPrivateStrings(value, path = "") {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoPrivateStrings(item, path + "[" + index + "]"));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN_KEY.test(key)) throw new Error("画像 payload 含疑似私有键：" + path + "." + key);
      assertNoPrivateStrings(item, path + "." + key);
    }
    return;
  }
  if (typeof value !== "string") return;
  const leaf = path.split(".").pop() ?? "";
  const chars = Array.from(value);
  if (chars.length > MAX_STRING_CHARS) throw new Error("画像 payload 字符串过长：" + path);
  if (/[\r\n\u0000]/.test(value)) throw new Error("画像 payload 字符串含换行：" + path);
  if (leaf === "timeZone") return;
  if (value.includes("/") || value.includes("\\") || value.startsWith("~")) {
    throw new Error("画像 payload 字符串含路径片段：" + path);
  }
  if (/\.(jsonl?|log|txt)$/i.test(value)) throw new Error("画像 payload 字符串像文件路径：" + path);
}

/**
 * 白名单断言：顶层键集合必须严格等于 PROFILE_PAYLOAD_KEYS；
 * 子结构只允许 range / activeHours24 / name+share；并递归拒绝私有键与路径字符串。
 */
export function assertProfilePayload(payload) {
  const expected = [...PROFILE_PAYLOAD_KEYS].sort();
  const actual = Object.keys(payload ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("画像 payload 键集合不符合白名单：" + actual.join(",") + "（期望 " + expected.join(",") + "）");
  }
  const rangeKeys = Object.keys(payload.range ?? {}).sort();
  if (JSON.stringify(rangeKeys) !== JSON.stringify(["days", "from", "timeZone", "to"])) {
    throw new Error("画像 payload.range 键集合不符合白名单：" + rangeKeys.join(","));
  }
  const hourKeys = Object.keys(payload.activeHours24 ?? {}).sort();
  if (JSON.stringify(hourKeys) !== JSON.stringify(["unit", "values"])) {
    throw new Error("画像 payload.activeHours24 键集合不符合白名单：" + hourKeys.join(","));
  }
  if (!Array.isArray(payload.activeHours24.values) || payload.activeHours24.values.length !== 24) {
    throw new Error("画像 payload.activeHours24.values 必须是 24 个小时值");
  }
  for (const [key, list] of [["byWorkspace", payload.byWorkspace], ["byModel", payload.byModel]]) {
    if (!Array.isArray(list) || list.length > MAX_SHARE_ITEMS) throw new Error("画像 payload." + key + " 最多 " + MAX_SHARE_ITEMS + " 项");
    for (const item of list) {
      const keys = Object.keys(item ?? {}).sort();
      if (JSON.stringify(keys) !== JSON.stringify(["name", "share"])) {
        throw new Error("画像 payload." + key + " 子项键集合不符合白名单：" + keys.join(","));
      }
    }
  }
  for (const key of PROFILE_PAYLOAD_KEYS) {
    const value = payload[key];
    if (value === null) {
      if (!NULLABLE_KEYS.has(key)) throw new Error("画像 payload." + key + " 不允许为 null");
      continue;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value)) throw new Error("画像 payload." + key + " 必须是有限数");
      if (value < 0 && !SIGNED_KEYS.has(key)) throw new Error("画像 payload." + key + " 必须是非负数");
      if (SHARE_KEY.test(key) && value > 1) throw new Error("画像 payload." + key + " 必须是 0–1 占比");
      continue;
    }
    if (key === "range" || key === "activeHours24" || key === "byWorkspace" || key === "byModel" || key === "multiModel") continue;
    throw new Error("画像 payload." + key + " 类型不合法");
  }
  assertNoPrivateStrings(payload);
  return true;
}

/** 递归按键排序，保证同一份统计得到同一个指纹。 */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const next = {};
    for (const key of Object.keys(value).sort()) next[key] = canonical(value[key]);
    return next;
  }
  return value;
}

/** 稳定 JSON（键排序）。 */
export function stableStringify(value) {
  return JSON.stringify(canonical(value));
}

/** 统计指纹：白名单对象稳定 JSON 的 sha256 前 16 位。 */
export function profileFingerprint(payload) {
  assertProfilePayload(payload);
  return createHash("sha256").update(stableStringify(payload), "utf8").digest("hex").slice(0, 16);
}

/** 单条文案压到 ≤40 个字符（保留旧导出，内部走统一的 clampProfileText）。 */
export function clampProfileLine(value) {
  return clampProfileText(value, PROFILE_LINE_MAX);
}

/** 百分比文案：0.1234 → 12.3%。 */
function percent(value) {
  const text = (Math.max(0, Math.min(1, num(value))) * 100).toFixed(1);
  return text.replace(/\.0$/, "") + "%";
}

/** 构造一个维度（统一裁剪长度，避免模型漏填时结构不一致）。 */
function dimension(key, title, insight, evidence) {
  return {
    key: normalizeDimensionKey(key),
    title: clampProfileText(title, PROFILE_TITLE_MAX),
    insight: clampProfileText(insight, PROFILE_INSIGHT_MAX),
    evidence: clampProfileText(evidence, PROFILE_EVIDENCE_MAX),
  };
}

/**
 * 本地规则画像：纯统计 + 固定规则，不联网、不依赖模型。
 * 与 AI 输出同构（headline + dimensions + advice + risk），降级时观感一致。
 * @param payload - buildProfilePayload() 的结果。
 * @param lang - zh | en。
 */
export function localProfile(payload, lang = "zh") {
  const zh = lang !== "en";
  const totalActive = num(payload.netActiveMs) + num(payload.waitMs);
  const waitShare = num(payload.waitShare) || (totalActive > 0 ? num(payload.waitMs) / totalActive : 0);
  const values = payload.activeHours24?.values ?? [];
  const hasHourTokens = values.some((value) => num(value) > 0);
  let peakHour = 0;
  for (let hour = 1; hour < 24; hour += 1) if (num(values[hour]) > num(values[peakHour])) peakHour = hour;
  const topWorkspace = payload.byWorkspace?.[0];
  const topModel = payload.byModel?.[0];
  const turnsPer = num(payload.avgTurnsPerConversation);
  const stepsPer = num(payload.avgStepsPerTurn);
  const avgSession = formatHours(payload.avgSessionActiveMs);
  const cache = num(payload.cacheHitRate);
  const night = num(payload.nightShare);
  const weekend = num(payload.weekendShare);
  const peakBand = ["night", "morning", "forenoon", "afternoon", "evening"].reduce((best, key) => {
    const shareValue = num(payload["band" + key.charAt(0).toUpperCase() + key.slice(1) + "ActiveShare"]);
    return shareValue > best.share ? { key, share: shareValue } : best;
  }, { key: "afternoon", share: -1 }).key;
  const bandNamesZh = { night: "深夜", morning: "清晨", forenoon: "上午", afternoon: "下午", evening: "晚间" };
  const dimensions = [];

  // 1) 节奏：夜间 / 周末 / 时段占比三选一，附高峰小时。
  if (night >= 0.25) {
    dimensions.push(dimension("rhythm", zh ? "夜间节奏" : "Night rhythm",
      zh ? "夜间活跃 " + percent(night) + "，高峰在 " + peakHour + ":00"
        : percent(night) + " of activity is at night; peak at " + peakHour + ":00",
      zh ? "深夜 22–6 点 · 高峰 " + peakHour + ":00"
        : "22–6 share " + percent(night) + " · peak " + peakHour + ":00"));
  } else if (!hasHourTokens) {
    dimensions.push(dimension("rhythm", zh ? "节奏" : "Rhythm",
      zh ? "净活跃 " + formatHours(payload.netActiveMs) + "，小时 Token 待回填"
        : formatHours(payload.netActiveMs) + " net active; hourly tokens pending",
      zh ? "净活跃 " + formatHours(payload.netActiveMs) : "net " + formatHours(payload.netActiveMs)));
  } else {
    const bandKeys = ["night", "morning", "forenoon", "afternoon", "evening"];
    const bandTotal = bandKeys.reduce((sum, key) => sum + num(payload["band" + key.charAt(0).toUpperCase() + key.slice(1) + "ActiveShare"]), 0);
    const peakBandShare = num(payload["band" + peakBand.charAt(0).toUpperCase() + peakBand.slice(1) + "ActiveShare"]);
    dimensions.push(dimension("rhythm", zh ? "节奏" : "Rhythm",
      bandTotal > 0
        ? (zh ? (bandNamesZh[peakBand] ?? "下午") + "最活跃（" + percent(peakBandShare) + "）" : peakBand + " is the busiest band (" + percent(peakBandShare) + ")")
        : (zh ? "活跃高峰在 " + peakHour + ":00" : "Peak at " + peakHour + ":00"),
      zh ? "高峰 " + peakHour + ":00 · 周末 " + percent(weekend)
        : "peak " + peakHour + ":00 · weekend " + percent(weekend)));
  }

  // 2) 专注：单会话时长 + 短会话占比。
  dimensions.push(dimension("focus", zh ? "专注" : "Focus",
    zh ? "单会话均值 " + avgSession + "，" + percent(num(payload.durationUnder15mShare)) + " 在 15 分钟内"
      : avgSession + " per conversation; " + percent(num(payload.durationUnder15mShare)) + " under 15 min",
    zh ? "会话 " + num(payload.conversations) + " · 样本 " + num(payload.durationSampleSessions)
      : num(payload.conversations) + " conversations · sample " + num(payload.durationSampleSessions)));

  // 3) 工具栈：模型集中度 + 缓存命中率。
  if (topModel) {
    dimensions.push(dimension("stack", zh ? "工具栈" : "Stack",
      zh ? topModel.name + " 占 " + percent(topModel.share) + "，缓存命中 " + percent(cache)
        : topModel.name + " is " + percent(topModel.share) + "; cache hits " + percent(cache),
      zh ? "模型 " + num(payload.modelCount) + " 个 · 输入 " + percent(num(payload.inputShare))
        : num(payload.modelCount) + " models · input " + percent(num(payload.inputShare))));
  } else {
    dimensions.push(dimension("stack", zh ? "工具栈" : "Stack",
      zh ? "区间 Token " + formatTokens(payload.tokensTotal) + "，缓存命中 " + percent(cache)
        : formatTokens(payload.tokensTotal) + " tokens; cache hits " + percent(cache),
      zh ? "输出 " + formatTokens(payload.tokensOutput) : "output " + formatTokens(payload.tokensOutput)));
  }

  // 4) 协作：等待占比 + 轮次 / 步骤。
  dimensions.push(dimension("collab", zh ? "协作" : "Collab",
    zh ? "等待用户 " + percent(waitShare) + "，每会话 " + turnsPer.toFixed(1) + " 轮"
      : "Waiting " + percent(waitShare) + "; " + turnsPer.toFixed(1) + " turns per conversation",
    zh ? "步 / 轮 " + stepsPer.toFixed(1) + " · 输出 / 轮 " + formatTokens(payload.avgOutputTokensPerTurn)
      : stepsPer.toFixed(1) + " steps/turn · " + formatTokens(payload.avgOutputTokensPerTurn) + " output/turn"));

  // 5) 趋势：有前 7 天基线才写环比，否则明确「样本不足」。
  if (payload.trendActiveDeltaPct !== null && payload.trendActiveDeltaPct !== undefined) {
    const delta = num(payload.trendActiveDeltaPct);
    dimensions.push(dimension("trend", zh ? "趋势" : "Trend",
      zh ? "近 7 天活跃环比 " + (delta >= 0 ? "+" : "") + delta.toFixed(1) + "%"
        : "Active last 7d " + (delta >= 0 ? "+" : "") + delta.toFixed(1) + "%",
      zh ? "前 7 天 " + formatHours(payload.trendActivePrevMs) + " → 近 7 天 " + formatHours(payload.trendActiveLastMs)
        : formatHours(payload.trendActivePrevMs) + " → " + formatHours(payload.trendActiveLastMs)));
  } else {
    dimensions.push(dimension("trend", zh ? "趋势" : "Trend",
      zh ? "区间 " + num(payload.range?.days) + " 天，近 7 天基线不足"
        : num(payload.range?.days) + "-day range; 7d baseline is thin",
      zh ? "近 7 天 vs 前 7 天：数据不足" : "last 7d vs prev 7d: not enough data"));
  }

  const advice = [];
  if (night >= 0.25) {
    advice.push({ text: zh ? "把深度任务前移到上午" : "Move deep work earlier", why: zh ? "夜间占 " + percent(night) + "，高峰 " + peakHour + ":00" : "Night " + percent(night) });
  } else if (cache < 0.3) {
    advice.push({ text: zh ? "固定系统提示与上下文" : "Stabilize prompts and context", why: zh ? "缓存命中仅 " + percent(cache) : "Cache hit only " + percent(cache) });
  } else {
    advice.push({ text: zh ? "复用当前高命中上下文" : "Reuse the high-hit context", why: zh ? "缓存命中 " + percent(cache) + "，单会话 " + avgSession : "Cache " + percent(cache) + ", " + avgSession + "/session" });
  }
  if (waitShare >= 0.15) {
    advice.push({ text: zh ? "合并确认点，减少等待" : "Batch confirmations", why: zh ? "等待用户占 " + percent(waitShare) : "Waiting is " + percent(waitShare) });
  } else if (payload.trendActiveDeltaPct !== null && payload.trendActiveDeltaPct !== undefined && num(payload.trendActiveDeltaPct) < -10) {
    advice.push({ text: zh ? "给近一周设一个交付目标" : "Set one delivery goal", why: zh ? "活跃环比 " + num(payload.trendActiveDeltaPct).toFixed(1) + "%" : "Active " + num(payload.trendActiveDeltaPct).toFixed(1) + "%" });
  } else {
    advice.push({ text: zh ? "按会话设定产出目标" : "Set output goals per session", why: zh ? "输出 / 轮 " + formatTokens(payload.avgOutputTokensPerTurn) : formatTokens(payload.avgOutputTokensPerTurn) + " output/turn" });
  }
  if (weekend >= 0.2) {
    advice.push({ text: zh ? "给周末留出整块恢复时间" : "Reserve weekend recovery", why: zh ? "周末活跃占 " + percent(weekend) : "Weekend " + percent(weekend) });
  }

  let risk = null;
  if (night >= 0.3) risk = zh ? "夜间投入偏高（" + percent(night) + "）" : "High night load (" + percent(night) + ")";
  else if (waitShare >= 0.3) risk = zh ? "等待确认偏多（" + percent(waitShare) + "）" : "Frequent waiting (" + percent(waitShare) + ")";
  else if (payload.trendActiveDeltaPct !== null && payload.trendActiveDeltaPct !== undefined && num(payload.trendActiveDeltaPct) <= -25) {
    risk = zh ? "近一周活跃下滑 " + num(payload.trendActiveDeltaPct).toFixed(1) + "%" : "Activity down " + num(payload.trendActiveDeltaPct).toFixed(1) + "%";
  }

  const headline = night >= 0.25
    ? (zh ? "夜间型深度工作者" : "Late-night deep worker")
    : waitShare >= 0.25
      ? (zh ? "高频确认型协作者" : "High-confirmation collaborator")
      : (zh ? "白天节奏的稳定交付者" : "Steady daytime deliverer");

  return {
    headline: clampProfileText(headline, PROFILE_HEADLINE_MAX),
    dimensions: dimensions.slice(0, 6).map((item) => ({
      ...item,
      title: clampProfileText(item.title, PROFILE_TITLE_MAX),
      insight: clampProfileText(item.insight, PROFILE_INSIGHT_MAX),
      evidence: clampProfileText(item.evidence, PROFILE_EVIDENCE_MAX),
    })),
    advice: advice.slice(0, 3).map((item) => ({
      text: clampProfileText(item.text, PROFILE_LINE_MAX),
      why: clampProfileText(item.why, PROFILE_LINE_MAX),
    })),
    risk: risk === null ? null : clampProfileText(risk, PROFILE_LINE_MAX),
  };
}

/** 解析失败（带稳定 code，路由据此降级为本地规则）。 */
class ProfileParseError extends Error {
  constructor(message, rawText = "") {
    super(message);
    this.name = "ProfileParseError";
    this.code = "AI_PARSE_FAILED";
    /** 原始输出前 300 字（只来自模型，不含任何会话数据），供 diagnostic 定位。 */
    this.rawText = Array.from(String(rawText ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim()).slice(0, 300).join("");
  }
}

/** 诊断用摘录：去控制字符、压空白，最多 300 个字符（只来自模型输出）。 */
export function profileExcerpt(text, max = 300) {
  const clean = Array.from(String(text ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim());
  const limit = Math.max(1, Math.round(Number(max) || 300));
  return clean.slice(0, limit).join("");
}

/** 去掉 BOM、代码围栏与三引号包裹；保留内部原文。 */
function unwrapProfileText(text) {
  let raw = String(text ?? "").replace(/^\uFEFF/, "").trim();
  const fence = raw.match(/^```[a-zA-Z0-9_-]*\s*([\s\S]*?)\s*```\s*$/);
  if (fence !== null) raw = fence[1].trim();
  const triple = raw.match(/^("""|''')\s*([\s\S]*?)\s*\1$/);
  if (triple !== null) raw = triple[2].trim();
  return raw;
}

/** 解析一段文本；失败返回 null（由调用方决定是否宽松提取）。 */
function tryParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * 扫描 JSON 文本的括号 / 字符串状态，返回补齐未闭合部分所需的后缀。
 *
 * 这是"截断可抢救"的基础：只补结构（字符串引号 + { / [ 的右括号），
 * 不改写已有内容；结构已经坏掉（右括号与左括号不匹配）时返回 null。
 */
function jsonClosureOf(text) {
  const chars = Array.from(String(text ?? ""));
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of chars) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }
    if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) return null;
    }
  }
  let suffix = "";
  // 末尾停在字符串里：补引号（若最后一个字符是未完成的转义，先补一个反斜杠）。
  if (inString) suffix += escaped ? "\\\"" : '"';
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    suffix += stack[index] === "{" ? "}" : "]";
  }
  return { suffix, balanced: !inString && stack.length === 0 };
}

/** 文本是否明显没有收尾（JSON 括号 / 字符串未闭合）。 */
export function isProfileTextUnfinished(text) {
  const unwrapped = unwrapProfileText(String(text ?? ""));
  const start = unwrapped.indexOf("{");
  if (start < 0) return false;
  const closure = jsonClosureOf(unwrapped.slice(start).trim());
  return closure === null || closure.balanced === false;
}

/** 从后往前找一个可安全截断的边界（逗号 / 已打开的括号），用于丢掉半截的键值。 */
function lastRepairBoundary(text) {
  const chars = Array.from(String(text ?? ""));
  let inString = false;
  let escaped = false;
  let boundary = -1;
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === ",") boundary = index;
    else if (char === "{" || char === "[") boundary = index + 1;
  }
  return boundary;
}

/**
 * 截断抢救：先原样尝试，失败就补齐未闭合的字符串 / 数组 / 对象括号，再 JSON.parse。
 * 仍然失败时逐级回退到上一个逗号 / 括号边界，丢掉被截断的半截键值（例如 `"risk":`）。
 *
 * @param text - 模型输出原文（可带代码围栏 / 前后解释）。
 * @returns `{ text, repaired }`（text 为可解析的 JSON 字符串），无法修复时返回 null。
 */
export function repairProfileJson(text) {
  const original = String(text ?? "").trim();
  const unwrapped = unwrapProfileText(original);
  const start = unwrapped.indexOf("{");
  if (start < 0) return null;
  let body = unwrapped.slice(start).trim();
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const closure = jsonClosureOf(body);
    if (closure === null) return null;
    const candidate = body + closure.suffix;
    if (tryParseJson(candidate) !== null) {
      return { text: candidate, repaired: candidate.trim() !== original };
    }
    const boundary = lastRepairBoundary(body);
    if (boundary <= 0) return null;
    const next = body.slice(0, boundary).replace(/[\s,]+$/, "");
    if (next === body || next === "") return null;
    body = next;
  }
  return null;
}

/** 把模型输出归一化成严格结构；任何不符合 schema 的地方都视为解析失败（不猜）。 */
function normalizeParsedProfile(parsed, raw) {
  if (parsed === null || typeof parsed !== "object") throw new ProfileParseError("模型输出不是 JSON 对象", raw);
  const headline = clampProfileText(parsed.headline, PROFILE_HEADLINE_MAX);
  if (headline === "") throw new ProfileParseError("模型输出缺少 headline", raw);
  const rawDimensions = Array.isArray(parsed.dimensions) ? parsed.dimensions : null;
  if (rawDimensions === null) throw new ProfileParseError("模型输出缺少 dimensions", raw);
  const dimensions = rawDimensions
    .map((item) => {
      if (item === null || typeof item !== "object") return null;
      const title = clampProfileText(item.title, PROFILE_TITLE_MAX);
      const insight = clampProfileText(item.insight, PROFILE_INSIGHT_MAX);
      const evidence = clampProfileText(item.evidence, PROFILE_EVIDENCE_MAX);
      if (title === "" || insight === "" || evidence === "") return null;
      return {
        key: normalizeDimensionKey(item.key),
        title,
        insight,
        evidence,
      };
    })
    .filter((item) => item !== null)
    .slice(0, 6);
  if (dimensions.length < 4) throw new ProfileParseError("模型输出有效维度少于 4 条", raw);
  if (!dimensions.every((item) => hasDigit(item.insight))) {
    throw new ProfileParseError("模型输出结论未引用数字", raw);
  }
  const rawAdvice = Array.isArray(parsed.advice) ? parsed.advice : null;
  if (rawAdvice === null) throw new ProfileParseError("模型输出缺少 advice 数组", raw);
  const advice = rawAdvice
    .map((item) => {
      if (item === null || typeof item !== "object") return null;
      const text = clampProfileText(item.text, PROFILE_LINE_MAX);
      const why = clampProfileText(item.why, PROFILE_LINE_MAX);
      if (text === "" || why === "") return null;
      return { text, why };
    })
    .filter((item) => item !== null)
    .slice(0, 3);
  if (advice.length < 2) throw new ProfileParseError("模型输出有效建议少于 2 条", raw);
  const riskText = parsed.risk === null || parsed.risk === undefined ? "" : String(parsed.risk).trim();
  const risk = riskText === "" ? null : clampProfileText(riskText, PROFILE_LINE_MAX);
  return { headline, dimensions, advice, risk };
}

/**
 * 解析模型输出（四路径）：
 *   1) 干净 JSON 直接 JSON.parse；
 *   2) ```json 围栏 / """ 包裹先剥壳再解析；
 *   3) 前后夹解释文字时，取第一个 { 到最后一个 } 宽松提取；
 *   4) 仍失败 → 抛 AI_PARSE_FAILED，路由降级本地规则，rawText 前 300 字进 diagnostic。
 */
export function parseProfileText(text) {
  const raw = String(text ?? "").trim();
  const unwrapped = unwrapProfileText(raw);
  let parsed = tryParseJson(unwrapped);
  if (parsed === null) {
    const start = unwrapped.indexOf("{");
    const end = unwrapped.lastIndexOf("}");
    if (start >= 0 && end > start) parsed = tryParseJson(unwrapped.slice(start, end + 1));
  }
  if (parsed === null) throw new ProfileParseError("模型输出不含可解析的 JSON 对象", raw);
  return normalizeParsedProfile(parsed, raw);
}
