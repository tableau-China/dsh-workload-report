/**
 * 纯聚合逻辑：宿主插件、HTML 报告生成器与离线测试共用同一份实现。
 *
 * 数据来源是 Harness 官方投影（client-visible wire 值），不是本插件自己解析日志：
 *   - sessionStats → turns / steps / llmMs(模型时间) / toolMs(工具时间) / decodeTokens
 *   - tokenUsage   → uncachedInputTokens / outputTokens / cacheReadTokens / cacheWriteTokens
 *   - title        → 会话标题
 *   - row.models   → 模型维度（由 src/models.js 从官方事件日志折叠，见 docs/models.md）
 * 会话身份（id / createdAt / cwd / 是否为子代理）来自 SessionHeader。
 *
 * 口径（写进 README，避免误读）：
 *   - 「活跃时长」= 模型时间 + 工具时间，是引擎累计工作时间，不是墙钟打开时长；
 *     并发的会话/子代理会各自累加，因此它不能读作「用了多少小时」。
 *   - 「对话次数」= 至少产生过 1 个步骤（step）的会话数；零步会话单列，不计入对话。
 *   - 归属日期用会话创建时间在所给时区下的自然日；跨天续聊的活动仍算创建那天。
 */

import { cacheHitRate, costOf, mergeModelBuckets, modelLabel, modelTokens, emptyModelBucket, UNKNOWN_MODEL } from "./models.js";

/** 需要向投影缓存/注册表读取的键。 */
export const PROJECTION_KEYS = ["sessionStats", "tokenUsage", "title", "sessionListMetadata"];

/** 受支持的统计范围。 */
export const SCOPES = ["all", "main", "subagent"];

/** 空 token 桶。 */
export function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** 收敛成非负有限数，任何异常输入都当作 0。 */
export function num(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** token 合计。 */
export function tokensTotal(tokens) {
  return num(tokens?.input) + num(tokens?.output) + num(tokens?.cacheRead) + num(tokens?.cacheWrite);
}

/** 会话的引擎活跃时长（毫秒）。 */
export function activeMs(row) {
  return num(row?.llmMs) + num(row?.toolMs);
}

/** 会话是否属于子代理。 */
function isSubagentHeader(header) {
  return header?.origin === "subagent" || num(header?.delegationDepth) > 0;
}

/**
 * 归一化会话身份。
 * @param header - SessionHeader（来自 ctx.sessionQuery.listSessions()）。
 * @returns 与会话身份相关的字段。
 */
export function normalizeHeader(header = {}) {
  const cwd = typeof header.cwd === "string" && header.cwd.length > 0 ? header.cwd : "";
  return {
    id: String(header.id ?? ""),
    cwd,
    createdAt: num(header.createdAt),
    isSubagent: isSubagentHeader(header),
    isSeeded: header.isSeeded === true,
    agentPreset: typeof header.agentPreset === "string" ? header.agentPreset : "",
  };
}

/**
 * 把一条会话（身份 + 投影值）折成聚合用的行。
 * @param header - SessionHeader。
 * @param values - 投影值（sessionStats / tokenUsage / title）。
 * @param asOfSeq - 投影水位，仅作展示/诊断。
 * @returns 会话行。
 */
export function rowFromSession(header, values = {}, asOfSeq = null) {
  const stats = values.sessionStats ?? {};
  // tokenUsage 有两种形状：
  //   · 官方 wire view（sessionProjections.snapshot / cachedSnapshot）→ { uncachedInputTokens, outputTokens, ... }
  //   · 持久化 state（投影检查点文件里的 val）        → { totals: {...}, last: {...} }
  // 两种都要认，否则从官方接口读到的一切都会被当成 0。
  const usage = values.tokenUsage ?? {};
  const totals = usage.totals ?? usage;
  // sessionListMetadata：最后一次"用户提问"的时间，用来界定会话的活跃窗口（时刻分析用）。
  const meta = values.sessionListMetadata ?? {};
  const lastPromptAt = typeof meta.lastPromptAt === "number" && meta.lastPromptAt > 0 ? meta.lastPromptAt : null;
  return {
    ...normalizeHeader(header),
    title: typeof values.title === "string" ? values.title : "",
    turns: num(stats.turns),
    steps: num(stats.steps),
    llmMs: num(stats.llmMs),
    toolMs: num(stats.toolMs),
    decodeTokens: num(stats.decodeTokens),
    tokens: {
      input: num(totals.uncachedInputTokens),
      output: num(totals.outputTokens),
      cacheRead: num(totals.cacheReadTokens),
      cacheWrite: num(totals.cacheWriteTokens),
    },
    lastPromptAt,
    asOfSeq: typeof asOfSeq === "number" ? asOfSeq : null,
  };
}

/** 时区化的小时（0–23）。 */
export function hourOf(ms, timeZone) {
  return Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hour12: false, hourCycle: "h23" }).format(new Date(ms)),
  );
}

/** 时刻分析的切片粒度：半小时。 */
const HOUR_SLICE_MS = 30 * 60000;
/** 窗口保护：极端跨月的会话最多参与 90 天的分摊，避免拖慢聚合。 */
const HOUR_WINDOW_CAP_MS = 90 * 86400000;

/**
 * 把一个会话的活跃时长分摊到 24 个小时桶里。
 *
 * 口径：会话的活跃窗口 = [createdAt, lastPromptAt]（lastPromptAt 是最后一次用户提问）。
 * 把该会话的引擎活跃时长按"墙钟重叠比例"平摊到覆盖的小时；同一会话同一小时只记一次覆盖。
 * 这是近似——引擎时间不等于墙钟时间，长窗口会话会被摊薄——但用来回答"我一般几点在干活"足够稳。
 * @param buckets - 24 个桶。
 * @param row - 会话行。
 * @param timeZone - IANA 时区。
 */
export function distributeHours(buckets, row, timeZone) {
  const start = row.createdAt;
  if (!(start > 0)) return;
  const rawEnd = typeof row.lastPromptAt === "number" && row.lastPromptAt > start ? row.lastPromptAt : start;
  // 严格覆盖 [start, end)：切片比例之和恰好为 1，分摊后总时长守恒（不因取整漂移）
  const end = Math.max(Math.min(rawEnd, start + HOUR_WINDOW_CAP_MS), start + 1);
  const span = end - start;
  const activeTotal = row.llmMs + row.toolMs;
  const seen = new Set();
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(cursor + HOUR_SLICE_MS, end);
    const hour = hourOf(cursor, timeZone);
    const bucket = buckets[hour];
    if (bucket !== undefined) {
      bucket.activeMs += activeTotal * ((next - cursor) / span);
      if (!seen.has(hour)) {
        seen.add(hour);
        bucket.sessions += 1;
      }
    }
    cursor = next;
  }
  const startBucket = buckets[hourOf(start, timeZone)];
  if (startBucket !== undefined) startBucket.starts += 1;
}

/**
 * 时区化的自然日键 YYYY-MM-DD。
 * @param ms - Unix epoch 毫秒。
 * @param timeZone - IANA 时区名。
 * @returns YYYY-MM-DD。
 */
export function dateKey(ms, timeZone) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(ms));
}

/** YYYY-MM-DD 校验。 */
export function isDateKey(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

/**
 * 解析日期区间参数；缺省为最近 N 天（含今天）。
 * @param options - from / to / days / now / timeZone。
 * @returns { from, to } 均为 YYYY-MM-DD。
 */
export function resolveRange({ from, to, days = 30, now = Date.now(), timeZone = "UTC" } = {}) {
  const today = dateKey(now, timeZone);
  const end = isDateKey(to) ? to : today;
  let start = isDateKey(from) ? from : null;
  if (start === null) {
    const span = Math.max(1, Math.min(3650, Math.floor(days)));
    const ms = Date.parse(`${end}T00:00:00Z`) - (span - 1) * 86400000;
    start = new Date(ms).toISOString().slice(0, 10);
  }
  return start <= end ? { from: start, to: end } : { from: end, to: start };
}

/** 区间包含的天数（含端点，仅做上界判断用）。 */
export function dayCount(range) {
  const span = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86400000;
  return Number.isFinite(span) ? Math.max(1, Math.round(span) + 1) : 1;
}

/** 枚举区间内每一天（含端点），最多 400 天。 */
export function enumerateDays(range) {
  const out = [];
  let cursor = Date.parse(`${range.from}T00:00:00Z`);
  const end = Date.parse(`${range.to}T00:00:00Z`);
  while (cursor <= end && out.length < 400) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return out;
}

/**
 * 工作区显示名：显式别名（按完整路径或目录名）优先，否则取目录名。
 * @param cwd - 会话创建目录。
 * @param aliases - 别名表。
 * @returns 展示用名称。
 */
export function workspaceLabel(cwd, aliases = {}) {
  if (cwd && typeof aliases[cwd] === "string") return aliases[cwd];
  if (cwd === "") return "(未知工作区)";
  const parts = cwd.split("/").filter(Boolean);
  const base = parts.length > 0 ? parts[parts.length - 1] : cwd;
  if (typeof aliases[base] === "string") return aliases[base];
  return base;
}

/** 空统计桶。 */
function emptyBucket() {
  return {
    sessions: 0,
    conversations: 0,
    mainSessions: 0,
    subagentSessions: 0,
    emptySessions: 0,
    turns: 0,
    steps: 0,
    llmMs: 0,
    toolMs: 0,
    activeMs: 0,
    decodeTokens: 0,
    tokens: emptyTokens(),
  };
}

/** 模型桶：key 为归并组名。 */
function addModelRow(modelMap, row) {
  const models = row.models;
  if (models === null || typeof models !== "object") return;
  for (const [key, bucket] of Object.entries(models)) {
    let target = modelMap.get(key);
    if (target === undefined) {
      target = { key, ...emptyModelBucket() };
      modelMap.set(key, target);
    }
    mergeModelBuckets(target, bucket);
  }
}

/** 把一行累加进桶。 */
function addRow(bucket, row) {
  bucket.sessions += 1;
  if (row.steps > 0) bucket.conversations += 1;
  else bucket.emptySessions += 1;
  if (row.isSubagent) bucket.subagentSessions += 1;
  else bucket.mainSessions += 1;
  bucket.turns += row.turns;
  bucket.steps += row.steps;
  bucket.llmMs += row.llmMs;
  bucket.toolMs += row.toolMs;
  bucket.activeMs += activeMs(row);
  bucket.decodeTokens += row.decodeTokens;
  bucket.tokens.input += row.tokens.input;
  bucket.tokens.output += row.tokens.output;
  bucket.tokens.cacheRead += row.tokens.cacheRead;
  bucket.tokens.cacheWrite += row.tokens.cacheWrite;
  return bucket;
}

/**
 * 按区间与范围筛选会话行。
 * @param rows - 会话行。
 * @param options - from / to / timeZone / scope。
 * @returns 命中的行。
 */
export function filterRows(rows, { from, to, timeZone, scope = "all" } = {}) {
  return rows.filter((row) => {
    if (scope === "main" && row.isSubagent) return false;
    if (scope === "subagent" && !row.isSubagent) return false;
    if (isDateKey(from) || isDateKey(to)) {
      const key = dateKey(row.createdAt, timeZone);
      if (isDateKey(from) && key < from) return false;
      if (isDateKey(to) && key > to) return false;
    }
    return true;
  });
}

/**
 * 生成完整快照。
 * @param rows - 全部会话行。
 * @param options - from / to / days / timeZone / scope / aliases / includeEmptyDays。
 * @returns { range, scope, totals, byDay, byWorkspace }。
 */
export function aggregate(rows, options = {}) {
  const {
    timeZone = "UTC",
    scope = "all",
    aliases = {},
    now = Date.now(),
    includeEmptyDays = true,
    all = false,
    pricing = { currency: "CNY", asOf: "", links: [], table: {}, estimated: false },
    modelAliases = {},
    activeModelMetric = "requests",
  } = options;

  // 只看 scope 的集合：用来算"最早活跃日"，以及生成不受日期筛选影响的日历数据
  const scopedAll = filterRows(rows, { scope, timeZone });

  // all（「全部」档）：区间从**最早的活跃日**开始，而不是固定 3650 天前
  const earliestKey = scopedAll.length > 0
    ? scopedAll.reduce((min, row) => (row.createdAt < min ? row.createdAt : min), scopedAll[0].createdAt)
    : null;
  const range = all && earliestKey !== null
    ? { from: dateKey(earliestKey, timeZone), to: dateKey(now, timeZone) }
    : resolveRange({ ...options, now, timeZone });

  const scoped = all ? scopedAll : filterRows(rows, { ...range, timeZone, scope });

  const totals = emptyBucket();
  const dayMap = new Map();
  /** 日历专用：全历史逐日（不受日期筛选影响）。 */
  const calendarMap = new Map();
  const workspaceMap = new Map();
  /** 0–23 点的时刻分布（用于"我哪个时间段更活跃"）。 */
  const hourBuckets = Array.from({ length: 24 }, (_, hour) => ({ hour, activeMs: 0, sessions: 0, starts: 0, tokens: emptyTokens(), conversations: 0 }));
  /** 工作区 → 有活动的自然日集合（用于「活跃天数」这一列/这条 bar）。 */
  const workspaceDays = new Map();
  /** 模型维度：归并组 → 桶。 */
  const modelMap = new Map();
  /** 模型 → 逐日 token 总量（treemap 右侧的按日趋势）。 */
  const modelDayMap = new Map();

  // 先铺日历的全历史日序列（只按 scope，不受 range 影响）
  for (const row of scopedAll) {
    const calendarKey = dateKey(row.createdAt, timeZone);
    let calendarDay = calendarMap.get(calendarKey);
    if (calendarDay === undefined) {
      calendarDay = { date: calendarKey, ...emptyBucket() };
      calendarMap.set(calendarKey, calendarDay);
    }
    addRow(calendarDay, row);
  }

  for (const row of scoped) {
    addRow(totals, row);

    const key = dateKey(row.createdAt, timeZone);
    let day = dayMap.get(key);
    if (day === undefined) {
      day = { date: key, ...emptyBucket() };
      dayMap.set(key, day);
    }
    addRow(day, row);

    const wkey = row.cwd || "(unknown)";
    let workspace = workspaceMap.get(wkey);
    if (workspace === undefined) {
      workspace = { key: wkey, label: workspaceLabel(row.cwd, aliases), path: row.cwd, lastUsedAt: 0, ...emptyBucket() };
      workspaceMap.set(wkey, workspace);
    }
    if (row.createdAt > workspace.lastUsedAt) workspace.lastUsedAt = row.createdAt;
    addRow(workspace, row);

    const hourBucket = hourBuckets[hourOf(row.createdAt, timeZone)];
    if (hourBucket !== undefined) {
      if (row.steps > 0) hourBucket.conversations += 1;
      hourBucket.tokens.input += row.tokens.input;
      hourBucket.tokens.output += row.tokens.output;
      hourBucket.tokens.cacheRead += row.tokens.cacheRead;
      hourBucket.tokens.cacheWrite += row.tokens.cacheWrite;
    }
    distributeHours(hourBuckets, row, timeZone);

    let daySet = workspaceDays.get(wkey);
    if (daySet === undefined) {
      daySet = new Set();
      workspaceDays.set(wkey, daySet);
    }
    daySet.add(key);

    addModelRow(modelMap, row);
    if (row.models !== null && typeof row.models === "object") {
      let dayModels = modelDayMap.get(key);
      if (dayModels === undefined) {
        dayModels = new Map();
        modelDayMap.set(key, dayModels);
      }
      for (const [modelKey, bucket] of Object.entries(row.models)) {
        const tokens = modelTokens(bucket);
        if (tokens > 0) dayModels.set(modelKey, (dayModels.get(modelKey) ?? 0) + tokens);
      }
    }
  }

  const withTotals = (bucket) => ({ ...bucket, tokensTotal: tokensTotal(bucket.tokens) });
  // 小区间补齐空白日（曲线连续）；长区间（如「全部」）只给有活动的日子，
  // 避免 400 天枚举上限把最近的数据截断。
  const days = dayCount(range) <= 180 ? enumerateDays(range) : [...dayMap.keys()].sort();
  // 「覆盖 N 个工作区」只数真实工作区，空 cwd 的未知桶不进这个 KPI（明细里仍会显示）
  const realWorkspaces = [...workspaceMap.keys()].filter((key) => key !== "(unknown)").length;

  return {
    range: { ...range, timeZone, days: dayCount(range) },
    scope,
    totals: { ...withTotals(totals), workspaces: realWorkspaces, activeDays: dayMap.size },
    byDay: days
      .map((date) => {
        const day = dayMap.get(date);
        if (day === undefined) {
          return includeEmptyDays ? { date, ...withTotals(emptyBucket()) } : null;
        }
        return withTotals(day);
      })
      .filter((day) => day !== null),
    byWorkspace: [...workspaceMap.values()]
      .map((workspace) => withTotals({ ...workspace, activeDays: (workspaceDays.get(workspace.key) ?? new Set()).size }))
      .sort((a, b) => b.activeMs - a.activeMs || b.tokensTotal - a.tokensTotal || a.label.localeCompare(b.label)),
    byHour: hourBuckets.map((bucket) => ({ ...bucket, tokensTotal: tokensTotal(bucket.tokens) })),
    // 模型维度（未启用 modelUsage 时为空数组）
    byModel: buildByModel(modelMap, pricing, modelAliases, totals, activeModelMetric),
    modelDaily: days.map((date) => {
      const dayModels = modelDayMap.get(date);
      const values = {};
      if (dayModels !== undefined) for (const [modelKey, tokens] of dayModels) values[modelKey] = tokens;
      return { date, values };
    }),
    topModel: pickTopModel(modelMap, modelAliases, activeModelMetric, totals),
    pricing: {
      currency: pricing.currency,
      asOf: pricing.asOf,
      links: pricing.links,
      costed: costedModels(modelMap, pricing),
      totalCost: totalModelCost(modelMap, pricing),
    },
    // 日历图数据源：从最早活跃日到今天，全部有记录的日子的逐日明细（含 activeMs / tokens 等）
    calendar: {
      from: earliestKey === null ? range.to : dateKey(earliestKey, timeZone),
      to: dateKey(now, timeZone),
      days: [...calendarMap.values()]
        .map(withTotals)
        .sort((a, b) => a.date.localeCompare(b.date)),
    },
    bySession: scoped
      .map((row) => ({
        id: row.id,
        title: row.title,
        cwd: row.cwd,
        workspaceLabel: workspaceLabel(row.cwd, aliases),
        date: dateKey(row.createdAt, timeZone),
        createdAt: row.createdAt,
        isSubagent: row.isSubagent,
        turns: row.turns,
        steps: row.steps,
        activeMs: activeMs(row),
        llmMs: row.llmMs,
        toolMs: row.toolMs,
        tokens: row.tokens,
        tokensTotal: tokensTotal(row.tokens),
      }))
      .sort((a, b) => b.activeMs - a.activeMs || b.tokensTotal - a.tokensTotal)
      .slice(0, 300),
  };
}

/** 归一化「最活跃模型」口径。 */
function normalizeMetric(metric) {
  if (metric === "tokens" || metric === "activeMs" || metric === "llmMs" || metric === "requests") return metric === "activeMs" ? "llmMs" : metric;
  return "requests";
}

/** 取模型的排序值。 */
function metricOf(bucket, metric) {
  if (metric === "tokens") return modelTokens(bucket);
  if (metric === "llmMs") return num(bucket.llmMs);
  return num(bucket.requests);
}

/** 组装 byModel 列表（含占比、命中率与费用）。 */
function buildByModel(modelMap, pricing, modelAliases, totals, metric) {
  const metricKey = normalizeMetric(metric);
  const totalTokens = modelTokens({ inOff: totals.tokens.input, inPeak: 0, crOff: totals.tokens.cacheRead, crPeak: 0, outOff: totals.tokens.output, outPeak: 0, cwOff: totals.tokens.cacheWrite, cwPeak: 0 }) || 1;
  const list = [...modelMap.values()]
    // request/header 会为"只出现在请求头、没有任何 assistant/message"的模型建桶；
    // 这类桶请求与 token 皆为 0，展示出来只会干扰阅读，直接过滤。
    .filter((bucket) => num(bucket.requests) > 0 || modelTokens(bucket) > 0)
    .map((bucket) => {
    const tokens = modelTokens(bucket);
    const input = bucket.inOff + bucket.inPeak;
    const cacheRead = bucket.crOff + bucket.crPeak;
    const output = bucket.outOff + bucket.outPeak;
    const cacheWrite = bucket.cwOff + bucket.cwPeak;
    return {
      key: bucket.key,
      label: modelLabel(bucket.key, modelAliases),
      requests: num(bucket.requests),
      llmMs: num(bucket.llmMs),
      efforts: bucket.efforts ?? {},
      raw: bucket.raw ?? {},
      tokens: { input, output, cacheRead, cacheWrite },
      tokensTotal: tokens,
      share: tokens / totalTokens,
      cacheHitRate: cacheHitRate(bucket),
      cost: costOf(bucket, pricing),
      metricValue: metricOf(bucket, metricKey),
    };
  });
  const metricSum = list.reduce((sum, item) => sum + item.metricValue, 0) || 1;
  return list
    .map((item) => ({ ...item, metricShare: item.metricValue / metricSum }))
    .sort((a, b) => b.metricValue - a.metricValue || b.tokensTotal - a.tokensTotal || a.label.localeCompare(b.label));
}

/** 「最活跃模型」：按配置口径取第一名。 */
function pickTopModel(modelMap, modelAliases, metric, totals) {
  const metricKey = normalizeMetric(metric);
  const list = buildByModel(modelMap, { table: {} }, modelAliases, totals, metricKey);
  if (list.length === 0) return null;
  const first = list[0];
  return {
    key: first.key,
    label: first.label,
    metric: metricKey,
    metricValue: first.metricValue,
    metricShare: first.metricShare,
    tokensTotal: first.tokensTotal,
    share: first.share,
    requests: first.requests,
  };
}

/** 有官方单价的模型数 / 总数（用于界面提示"费用覆盖度"）。 */
function costedModels(modelMap, pricing) {
  const list = [...modelMap.values()];
  const withPrice = list.filter((bucket) => costOf(bucket, pricing) !== null);
  return { covered: withPrice.length, total: list.length };
}

/** 已知单价模型的总费用（未知单价的不计入，也不猜）。 */
function totalModelCost(modelMap, pricing) {
  let sum = 0;
  let any = false;
  for (const bucket of modelMap.values()) {
    const cost = costOf(bucket, pricing);
    if (cost !== null) {
      sum += cost;
      any = true;
    }
  }
  return any ? sum : null;
}

/** 把快照压成适合 UI/报告的展示结构（补上占比与派生指标）。
 * @param snapshot - aggregate() 的结果。
 * @returns 展示结构。
 */
export function present(snapshot) {
  const totalTokens = snapshot.totals.tokensTotal || 1;
  const totalActive = snapshot.totals.activeMs || 1;
  return {
    ...snapshot,
    byWorkspace: snapshot.byWorkspace.map((item) => ({
      ...item,
      tokenShare: item.tokensTotal / totalTokens,
      activeShare: item.activeMs / totalActive,
      avgTokensPerConversation: item.conversations > 0 ? item.tokensTotal / item.conversations : 0,
      avgActiveMsPerConversation: item.conversations > 0 ? item.activeMs / item.conversations : 0,
    })),
    byModel: (snapshot.byModel ?? []).map((item) => ({
      ...item,
      costPerRequest: item.cost !== null && item.requests > 0 ? item.cost / item.requests : null,
      avgOutputPerRequest: item.requests > 0 ? item.tokens.output / item.requests : 0,
    })),
    derived: {
      avgTokensPerConversation:
        snapshot.totals.conversations > 0 ? snapshot.totals.tokensTotal / snapshot.totals.conversations : 0,
      avgActiveMsPerConversation:
        snapshot.totals.conversations > 0 ? snapshot.totals.activeMs / snapshot.totals.conversations : 0,
      cacheHitRate:
        snapshot.totals.tokens.input + snapshot.totals.tokens.cacheRead > 0
          ? snapshot.totals.tokens.cacheRead / (snapshot.totals.tokens.input + snapshot.totals.tokens.cacheRead)
          : 0,
      outputPerActiveHour:
        snapshot.totals.activeMs > 0 ? snapshot.totals.tokens.output / (snapshot.totals.activeMs / 3600000) : 0,
    },
  };
}
