/**
 * AI 用户画像的纯函数层（宿主专用，不打进客户端包）。
 *
 * 红线：发给模型的内容只能是 buildProfilePayload() 返回的白名单对象——
 * 聚合统计，不含对话正文、标题、路径原文。函数内部对键集合做严格断言，
 * 任何新增字段都必须先改 PROFILE_PAYLOAD_KEYS（并同步文档与测试）。
 *
 * 模型失败时用 localProfile() 生成确定性的本地规则画像（不联网、不抛错）。
 */

import { createHash } from "node:crypto";

import { formatHours, formatTokens } from "./format.js";

/** 允许发给模型的顶层键（精确集合，多一个少一个都不行）。 */
export const PROFILE_PAYLOAD_KEYS = Object.freeze([
  "range",
  "activeMs",
  "netActiveMs",
  "waitMs",
  "conversations",
  "turns",
  "steps",
  "tokensTotal",
  "cacheHitRate",
  "activeHours24",
  "byWorkspace",
  "byModel",
  "weekendShare",
  "nightShare",
]);

const MAX_SHARE_ITEMS = 5;
const MAX_LINE_CHARS = 40;
const ROUND = 10000;

const num = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
const share = (value) => Math.round(Math.max(0, Math.min(1, num(value))) * ROUND) / ROUND;

/** 工作区只保留显示名最后一段，杜绝把完整路径带进 payload。 */
function workspaceName(value) {
  const text = String(value ?? "").trim();
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

/**
 * 从 present() 快照构造白名单 payload。
 *
 * activeHours24 是 Token 口径（每小时 tokensTotal），以保证「Token 或活跃」可核对；
 * nightShare（22:00–06:00）用活跃时长，weekendShare 用按日活跃时长。
 * @param snapshot - 看板/报告同源的 present(aggregate(...)) 结构。
 * @returns 严格白名单对象。
 */
export function buildProfilePayload(snapshot) {
  const totals = snapshot?.totals ?? {};
  const byHour = Array.isArray(snapshot?.byHour) ? snapshot.byHour : [];
  const byDay = Array.isArray(snapshot?.byDay) ? snapshot.byDay : [];
  const netActiveMs = Math.max(0, num(totals.netActiveMs));
  const hoursTokens = Array.from({ length: 24 }, (_, hour) => Math.max(0, Math.round(num(byHour[hour]?.tokensTotal))));
  const hourActive = Array.from({ length: 24 }, (_, hour) => Math.max(0, num(byHour[hour]?.activeMs)));
  const hourActiveTotal = hourActive.reduce((sum, value) => sum + value, 0);
  const nightMs = hourActive.reduce((sum, value, hour) => (hour >= 22 || hour < 6 ? sum + value : sum), 0);

  const workspaceItems = (Array.isArray(snapshot?.byWorkspace) ? snapshot.byWorkspace : [])
    .map((item) => ({ name: workspaceName(item?.label), share: share(item?.activeShare) }))
    .filter((item) => item.name !== "" && item.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SHARE_ITEMS);

  const modelItems = (Array.isArray(snapshot?.byModel) ? snapshot.byModel : [])
    .map((item) => ({ name: String(item?.label ?? "").trim(), share: share(item?.share) }))
    .filter((item) => item.name !== "" && item.share > 0)
    .sort((a, b) => b.share - a.share)
    .slice(0, MAX_SHARE_ITEMS);

  const payload = {
    range: {
      from: String(snapshot?.range?.from ?? ""),
      to: String(snapshot?.range?.to ?? ""),
      days: Math.max(0, Math.round(num(snapshot?.range?.days))),
      timeZone: String(snapshot?.range?.timeZone ?? ""),
    },
    activeMs: Math.round(netActiveMs),
    netActiveMs: Math.round(netActiveMs),
    waitMs: Math.max(0, Math.round(num(totals.waitMs))),
    conversations: Math.max(0, Math.round(num(totals.conversations))),
    turns: Math.max(0, Math.round(num(totals.turns))),
    steps: Math.max(0, Math.round(num(totals.steps))),
    tokensTotal: Math.max(0, Math.round(num(totals.tokensTotal))),
    cacheHitRate: share(snapshot?.derived?.cacheHitRate),
    activeHours24: { unit: "tokens", values: hoursTokens },
    byWorkspace: workspaceItems,
    byModel: modelItems,
    weekendShare: share(weekendShareOf(byDay)),
    nightShare: share(hourActiveTotal > 0 ? nightMs / hourActiveTotal : 0),
  };

  assertProfilePayload(payload);
  return payload;
}

/**
 * 白名单断言：顶层键集合必须严格等于 PROFILE_PAYLOAD_KEYS；
 * 子结构也只允许 name/share、unit/values，防止后续改动把路径或标题偷偷带出去。
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

/** 单条文案压到 ≤40 个字符（超出用省略号，仍不超过 40）。 */
export function clampProfileLine(value) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(text);
  if (chars.length <= MAX_LINE_CHARS) return chars.join("");
  return chars.slice(0, MAX_LINE_CHARS - 1).join("") + "…";
}

/** 百分比文案：0.1234 → 12.3%。 */
function percent(value) {
  const text = (Math.max(0, Math.min(1, num(value))) * 100).toFixed(1);
  return text.replace(/\.0$/, "") + "%";
}

/**
 * 本地规则画像：纯统计 + 固定规则，不联网、不依赖模型。
 * 覆盖工作节奏 / 任务偏好 / 技术栈倾向 / 协作模式（+ 工作区聚焦）四个维度。
 * @param payload - buildProfilePayload() 的结果。
 * @param lang - zh | en。
 * @returns { traits: string[], advice: string }，每条 ≤40 字符。
 */
export function localProfile(payload, lang = "zh") {
  const zh = lang !== "en";
  const totalActive = num(payload.netActiveMs) + num(payload.waitMs);
  const waitShare = totalActive > 0 ? num(payload.waitMs) / totalActive : 0;
  const values = payload.activeHours24?.values ?? [];
  const hasHourTokens = values.some((value) => num(value) > 0);
  let peakHour = 0;
  for (let hour = 1; hour < 24; hour += 1) if (num(values[hour]) > num(values[peakHour])) peakHour = hour;
  const topWorkspace = payload.byWorkspace?.[0];
  const topModel = payload.byModel?.[0];
  const turnsPer = num(payload.conversations) > 0 ? num(payload.turns) / num(payload.conversations) : 0;
  const stepsPer = num(payload.conversations) > 0 ? num(payload.steps) / num(payload.conversations) : 0;
  const tokensPer = num(payload.conversations) > 0 ? num(payload.tokensTotal) / num(payload.conversations) : 0;
  const traits = [];

  if (num(payload.nightShare) >= 0.25) {
    traits.push(zh
      ? "夜间（22–6 点）活跃占 " + percent(payload.nightShare) + "，深度工作偏晚"
      : "Night work (22–6) is " + percent(payload.nightShare) + "; deep work runs late");
  } else if (num(payload.weekendShare) >= 0.2) {
    traits.push(zh
      ? "周末活跃占 " + percent(payload.weekendShare) + "，节奏较满"
      : "Weekend activity is " + percent(payload.weekendShare) + "; the pace stays full");
  } else if (!hasHourTokens) {
    traits.push(zh
      ? "区间净活跃 " + formatHours(payload.netActiveMs) + "，小时 Token 待回填"
      : formatHours(payload.netActiveMs) + " net active; hourly tokens pending");
  } else {
    traits.push(zh
      ? "活跃高峰在 " + peakHour + ":00，以白天节奏为主"
      : "Peak activity at " + peakHour + ":00; daytime rhythm dominates");
  }

  traits.push(zh
    ? "每次对话约 " + turnsPer.toFixed(1) + " 轮 / " + stepsPer.toFixed(1) + " 步"
    : "About " + turnsPer.toFixed(1) + " turns / " + stepsPer.toFixed(1) + " steps per conversation");

  if (topModel) {
    traits.push(zh
      ? "主要使用 " + topModel.name + "（占 " + percent(topModel.share) + "）"
      : "Mainly uses " + topModel.name + " (" + percent(topModel.share) + ")");
  } else {
    traits.push(zh
      ? "区间 Token 合计 " + formatTokens(payload.tokensTotal)
      : formatTokens(payload.tokensTotal) + " tokens in range");
  }

  traits.push(zh
    ? (waitShare >= 0.15 ? "等待用户占 " + percent(waitShare) + "，协作确认较多" : "等待用户占 " + percent(waitShare) + "，执行较连续")
    : (waitShare >= 0.15 ? "Waiting for you is " + percent(waitShare) + "; frequent confirmations" : "Waiting is " + percent(waitShare) + "; execution stays continuous"));

  if (topWorkspace) {
    traits.push(zh
      ? "时间主要投入 " + topWorkspace.name + "（占 " + percent(topWorkspace.share) + "）"
      : "Most time goes to " + topWorkspace.name + " (" + percent(topWorkspace.share) + ")");
  } else {
    traits.push(zh
      ? "区间净活跃 " + formatHours(payload.netActiveMs) + "，共 " + payload.conversations + " 次对话"
      : formatHours(payload.netActiveMs) + " net active across " + payload.conversations + " conversations");
  }

  let advice;
  if (num(payload.nightShare) >= 0.25) {
    advice = zh ? "夜间占比偏高，可把深度任务前移到白天。" : "Night work is high; move deep tasks to daytime.";
  } else if (num(payload.cacheHitRate) < 0.3) {
    advice = zh ? "缓存命中偏低，固定系统提示与上下文可提效。" : "Low cache hits; keep system prompts and context stable.";
  } else if (num(payload.weekendShare) >= 0.2) {
    advice = zh ? "周末仍较活跃，给恢复留出整块时间。" : "Weekends stay busy; reserve full blocks for recovery.";
  } else if (tokensPer > 0) {
    advice = zh
      ? "单次对话约 " + formatTokens(tokensPer) + " Token，给高消耗会话设定产出目标。"
      : "~" + formatTokens(tokensPer) + " tokens per conversation; set output goals for heavy ones.";
  } else {
    advice = zh ? "保持当前节奏，先积累更多区间数据。" : "Keep the current rhythm and gather more range data.";
  }

  return {
    traits: traits.slice(0, 5).map(clampProfileLine),
    advice: clampProfileLine(advice),
  };
}

/** 解析失败（带稳定 code，路由据此降级为本地规则）。 */
class ProfileParseError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProfileParseError";
    this.code = "AI_PARSE_FAILED";
  }
}

/**
 * 解析模型输出：只接受 { traits: string[3..5], advice: string }。
 * 允许 JSON 代码围栏，其他形状一律视为解析失败（降级，不猜）。
 */
export function parseProfileText(text) {
  const raw = String(text ?? "").trim();
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) throw new ProfileParseError("模型输出不含 JSON 对象");
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (error) {
    throw new ProfileParseError("模型输出 JSON 解析失败：" + (error instanceof Error ? error.message : String(error)));
  }
  const rawTraits = Array.isArray(parsed?.traits) ? parsed.traits : Array.isArray(parsed?.features) ? parsed.features : null;
  const traits = (rawTraits ?? [])
    .map((item) => String(item ?? "").trim())
    .filter((item) => item !== "")
    .slice(0, 5)
    .map(clampProfileLine);
  const advice = String(parsed?.advice ?? parsed?.suggestion ?? "").trim();
  if (traits.length < 3) throw new ProfileParseError("模型输出特征少于 3 条");
  if (advice === "") throw new ProfileParseError("模型输出缺少建议");
  return { traits, advice: clampProfileLine(advice) };
}

/** 供测试与路由共用：单条文案上限。 */
export const PROFILE_LINE_MAX = MAX_LINE_CHARS;
