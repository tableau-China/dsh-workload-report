/**
 * 模型维度：归并规则、事件折叠、峰谷判定与费用估算。
 *
 * 数据来自官方事件日志（由 `ctx.sessionQuery.readSession()` 读取，格式迁移与校验交给官方 seam）：
 *   - `assistant/message` → data.message.source.{provider, model} + data.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}
 *   - `request/header`    → data.header.config.reasoningEffort（思考强度）
 *   - `assistant/message` 的 data.stream[] 时间戳窗口 → 各模型耗时权重（用来分摊会话 llmMs，保证守恒）
 *
 * 本模块是纯函数，不读磁盘、不发请求，宿主与离线测试共用。
 */

import { scaleTokenBuckets } from "./hour-scale.js";

/** 未标注模型（缺 provider/model 或 usage）的桶名。 */
export const UNKNOWN_MODEL = "(未标注模型)";

/** 默认交互工具白名单：这些工具的调用时长整段计为「等待用户」，不计入活跃时长。 */
export const DEFAULT_WAIT_TOOLS = ["ask_user_question", "exit_plan_mode"];

/** 等待判定阈值（毫秒）：单次调用短于它就不剔除，避免把碎片交互拆出来。 */
export const DEFAULT_WAIT_MIN_MS = 60000;

/** 归一化等待工具白名单：非数组回退默认，数组里的非字符串项丢弃（空数组 = 关闭白名单）。 */
function waitToolSet(waitTools) {
  const list = Array.isArray(waitTools) ? waitTools : DEFAULT_WAIT_TOOLS;
  return new Set(list.filter((name) => typeof name === "string" && name !== ""));
}

/** 归一化等待阈值（非负有限数，否则用默认 60s）。 */
function waitThresholdOf(waitMinMs) {
  return typeof waitMinMs === "number" && Number.isFinite(waitMinMs) && waitMinMs >= 0 ? waitMinMs : DEFAULT_WAIT_MIN_MS;
}

/**
 * 内置默认归并规则。
 * DeepSeek 官方定价页注 1 原文：*"Use deepseek-flash as the model name. The legacy names
 * deepseek-v4-flash and deepseek-v4-flash-vision-exp are still accepted…"*
 * —— 两者是同一模型（DeepSeek-V4.1-Flash）的新旧名称，合并不会污染口径。
 */
export const DEFAULT_MODEL_GROUPS = [
  { group: "deepseek-v4-flash", match: ["deepseek-flash", "deepseek-v4-flash", "deepseek-v4-flash-vision-exp"] },
];

/**
 * 计算某个 provider/model 的归并组名。
 * @param provider - 提供方 id（可为空）。
 * @param model - 模型 id（可为空）。
 * @param groups - 用户自定义分组（覆盖内置同组规则）。
 * @returns 组名；无匹配时返回 "provider/model" 原文。
 */
export function groupKeyFor(provider, model, groups = []) {
  const p = typeof provider === "string" ? provider.trim() : "";
  const m = typeof model === "string" ? model.trim() : "";
  if (m === "") return UNKNOWN_MODEL;
  const all = [...normalizeGroups(groups), ...DEFAULT_MODEL_GROUPS];
  for (const rule of all) {
    if (rule.match.includes(m)) return rule.group;
  }
  return p === "" ? m : `${p}/${m}`;
}

/** 归一化用户分组配置：支持 {group, match:[]} 数组或 {组名: [模型…]} 映射。 */
export function normalizeGroups(groups) {
  if (Array.isArray(groups)) {
    return groups
      .filter((rule) => rule && typeof rule.group === "string" && Array.isArray(rule.match))
      .map((rule) => ({ group: rule.group, match: rule.match.map(String) }));
  }
  if (groups && typeof groups === "object") {
    return Object.entries(groups)
      .filter(([, list]) => Array.isArray(list))
      .map(([group, list]) => ({ group, match: list.map(String) }));
  }
  return [];
}

/** 空模型桶（peak/off 分开记，便于按官方峰谷价精确计费）。 */
export function emptyModelBucket() {
  return {
    requests: 0,
    turns: 0,
    inOff: 0, inPeak: 0,
    outOff: 0, outPeak: 0,
    crOff: 0, crPeak: 0,
    cwOff: 0, cwPeak: 0,
    streamMs: 0,
    llmMs: 0,
    efforts: {},
    raw: {},
  };
}

/** 合并两个模型桶（用于多会话汇总）。 */
export function mergeModelBuckets(a, b) {
  const out = a ?? emptyModelBucket();
  if (!b) return out;
  out.requests += b.requests ?? 0;
  out.turns += b.turns ?? 0;
  out.inOff += b.inOff ?? 0; out.inPeak += b.inPeak ?? 0;
  out.outOff += b.outOff ?? 0; out.outPeak += b.outPeak ?? 0;
  out.crOff += b.crOff ?? 0; out.crPeak += b.crPeak ?? 0;
  out.cwOff += b.cwOff ?? 0; out.cwPeak += b.cwPeak ?? 0;
  out.streamMs += b.streamMs ?? 0;
  out.llmMs += b.llmMs ?? 0;
  for (const [k, v] of Object.entries(b.efforts ?? {})) out.efforts[k] = (out.efforts[k] ?? 0) + v;
  for (const [k, v] of Object.entries(b.raw ?? {})) out.raw[k] = (out.raw[k] ?? 0) + v;
  return out;
}

/**
 * 官方峰谷判定（DeepSeek 定价页注 2）：
 * 峰时 = 01:00–04:00 与 06:00–10:00 UTC，周一至周五；其余时间为谷时（谷价 = 峰价一半）。
 * 注：中国法定节假日无法离线判定，本实现按"工作日峰时"计算 —— 节假日请求会被按峰价估算（略微高估）。
 * @param ms - 事件时间（Unix epoch 毫秒）。
 * @returns 是否峰时。
 */
export function isPeak(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay(); // 0=周日
  if (day === 0 || day === 6) return false;
  const h = d.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

/** 从 stream 事件里取"流式窗口"毫秒（首包 → 末包），作为该次请求的耗时权重。 */
function streamWeight(stream, fallbackTime) {
  if (!Array.isArray(stream) || stream.length === 0) return 0;
  let first = null;
  let last = null;
  for (const item of stream) {
    const t = typeof item?.time === "number" ? item.time : null;
    if (t === null) continue;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  if (first === null || last === null) return 0;
  const span = last - first;
  if (span > 0) return span;
  // 单包（非流式）：给一个最小值，避免权重为 0 导致该模型分不到时间
  return typeof fallbackTime === "number" && fallbackTime > 0 ? 1 : 0;
}

/* ------------------------------------------------- 时刻分布（事件时间戳） */

/** 一小时的毫秒数。 */
const HOUR_MS = 3600000;

/** 合法的事件时间戳（epoch 毫秒）；否则 null。 */
function epochMs(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** stream 的绝对时间戳窗口 [首, 末]；不足两个时间戳时返回 null。 */
function streamWindow(stream) {
  if (!Array.isArray(stream) || stream.length === 0) return null;
  let first = null;
  let last = null;
  for (const item of stream) {
    const t = epochMs(item?.time);
    if (t === null) continue;
    if (first === null || t < first) first = t;
    if (last === null || t > last) last = t;
  }
  return first === null || last === null ? null : [first, last];
}

/** 会话级伪轮次的键：事件没有 `data.turn` 时归入这里。 */
const SESSION_TURN_KEY = "(session)";

/** UTC 毫秒 → 0–23 的 UTC 小时（负数也能正确取模）。 */
function utcHourOf(ms) {
  return ((Math.floor(ms / HOUR_MS) % 24) + 24) % 24;
}

/** 事件所属轮次的键：优先用 `data.turn`，缺失时归入会话级伪轮次。 */
function turnKeyOf(event) {
  const turn = event?.data?.turn;
  if (typeof turn === "number" && Number.isFinite(turn)) return `turn:${turn}`;
  if (typeof turn === "string" && turn !== "") return `turn:${turn}`;
  return SESSION_TURN_KEY;
}

/**
 * 按**轮次（turn）**统计一个会话的 0–23 点活跃时长（毫秒）。
 *
 * **最小归属单位 = 轮次**：多轮会话逐轮分开计算，每个轮次的活跃时长
 * （= 该轮内各步的模型时间 + 工具时间之和）**整段记到「该轮开始时刻」所在的整点**，
 * 不跨小时切分；轮次开始时刻优先取该轮的 `turn/start` 事件，没有则取该轮最早的事件时间。
 *
 * **会话级兜底**：事件没有轮次信息（老会话 / 未回填）时，整段活跃记到 `sessionStartMs`
 * （会话 createdAt）所在的整点；sessionStartMs 未提供时退化为最早事件时间。
 * 事件里完全没有可用区间（或官方 activeMs 为 0）时 `hours = null`，交给聚合层走旧法摊销。
 *
 * **时区**：桶索引是 **UTC 小时**。理由：折叠在后台运行、不携带查询时区，结果还要写进
 * 索引文件跨查询/重启复用；UTC 是唯一时区无关的稳定表示。聚合时再按请求的时区平移
 * （见 aggregate.js 的 localHoursFromUtc），对固定偏移时区（Asia/Shanghai=+8、UTC=0）精确。
 *
 * **口径**：
 *   · 模型时间 = `request/header.time` → 其后第一条 `assistant/message.time` 的区间；
 *     没有可用 header 时退化为该 `assistant/message` 的 stream 首末时间戳；都没有记 0。
 *   · 工具时间 = 按 `callId` 配对 `tool/call.time` → `tool/result.time` 的区间；
 *     **未配对 / 未结束的调用不计**（悬空调用没有可信的结束时间，宁可少算）。
 *
 * **等待用户（三层判定，0.6.5）**：单次工具区间 ≥ waitMinMs 且满足任一条件时整段计为 `waitMs`：
 *   (a) 工具名在 `waitTools` 白名单（默认 ask_user_question / exit_plan_mode）——交互工具；
 *   (b) `tool/call` 与 `tool/result` 之间夹着 `user/message`——人类输入夹层。
 * 等待区间**不进入**活跃时长 / 小时桶；没有 user/message 的普通长任务（编译、跑批）照常算工作。
 * 短于 waitMinMs 的交互不剔除（避免碎片化）。`excludeWait=false` 时完全不判定等待，行为与 0.6.0 一致。
 *
 * **守恒**：官方 activeMs（llmMs + toolMs）与事件累计不等时（未闭合步 / crash 恢复补写），
 * 整体按比例缩放到「官方 activeMs − waitMs」，保证 `sum(hours) === llmMs + toolMs − waitMs`（±1ms）。
 *
 * @param events - 事件数组（官方 SessionLogSnapshot 的 events）。
 * @param options - sessionLlmMs / sessionToolMs：会话官方口径，用于缩放守恒；
 *   sessionTokens：会话官方 Token 合计（row.tokens 四项之和），用于小时 Token 守恒；
 *     传 null 表示"调用方没有官方值"，此时不做回正（宿主总是传数字）；
 *   sessionStartMs：会话 createdAt，用于没有轮次事件时的会话级兜底；
 *   excludeWait：是否剔除等待用户（默认 true）；waitTools：交互工具白名单；waitMinMs：等待判定阈值。
 * @returns {{ hours: number[]|null, source: 'events'|'events-scaled'|null, rawMs: number, targetMs: number, waitMs: number,
 *   hourTokens: number[]|null, hourTokensSource: 'events'|'events-scaled'|null, hourHumanMsgs: number[] }}
 */
export function foldSessionHours(events, {
  sessionLlmMs = 0,
  sessionToolMs = 0,
  sessionTokens = null,
  sessionStartMs = 0,
  excludeWait = true,
  waitTools = DEFAULT_WAIT_TOOLS,
  waitMinMs = DEFAULT_WAIT_MIN_MS,
} = {}) {
  const hours = new Array(24).fill(0);
  /** 按消息时间（UTC 小时）归桶的 Token（与 row.tokens 同一定义：输入 + 输出 + 缓存读 + 缓存写）。 */
  const hourTokens = new Array(24).fill(0);
  /** 按 UTC 小时统计的 user/message 条数（人类消息密度点）。 */
  const hourHumanMsgs = new Array(24).fill(0);
  const list = Array.isArray(events) ? events : [];
  const anchorMs = epochMs(sessionStartMs) ?? 0;
  /** 轮次键 → { startMs, activeMs, fixedStart }；fixedStart 的轮次不再被更早的事件时间改写。 */
  const turns = new Map();
  /** 等待判定：白名单集合 + 阈值（excludeWait=false 时判定条件直接短路）。 */
  const waitingTools = waitToolSet(waitTools);
  const waitThreshold = waitThresholdOf(waitMinMs);

  const ensureTurn = (key, time) => {
    let turn = turns.get(key);
    if (turn === undefined) {
      const sessionKey = key === SESSION_TURN_KEY;
      const fixed = sessionKey && anchorMs > 0;
      turn = { startMs: fixed ? anchorMs : (time ?? 0), activeMs: 0, fixedStart: fixed };
      turns.set(key, turn);
    }
    return turn;
  };
  /** 用事件时间参与「轮次开始时刻」判定（取最早；fixedStart 轮次不动）。 */
  const noteStart = (key, time) => {
    const turn = ensureTurn(key, time);
    if (turn.fixedStart || time === null || time <= 0) return turn;
    if (turn.startMs <= 0 || time < turn.startMs) turn.startMs = time;
    return turn;
  };
  /** 把一段活跃时长累加进某轮次（不做小时切分）。 */
  const addActive = (key, startTime, ms) => {
    if (!(ms > 0)) return;
    const turn = noteStart(key, startTime);
    turn.activeMs += ms;
  };

  /** 最近一条 request/header 的时间（用掉即清，避免重复配给多条 message）。 */
  let headerTime = null;
  /** 事件区间的累计毫秒（只含工作，不含等待）。 */
  let rawMs = 0;
  /** 等待用户累计毫秒（已从活跃时长中剔除）。 */
  let waitMs = 0;
  /** 单调递增的 user/message 计数：用来判断工具调用期间是否夹着人类输入。 */
  let userMark = 0;
  /** 已开始、未结束的工具调用：callId → { time, key, name, userMark }。 */
  const openCalls = new Map();

  for (const event of list) {
    const type = event?.type;
    const time = epochMs(event.time);
    const key = turnKeyOf(event);
    if (type === "turn/start") {
      const turn = ensureTurn(key, time);
      if (time !== null && time > 0) {
        turn.startMs = time;
        turn.fixedStart = true;
      }
      continue;
    }
    if (type === "tool/call") {
      const callId = typeof event.data?.callId === "string" ? event.data.callId : "";
      const name = typeof event.data?.name === "string" ? event.data.name : "";
      if (callId !== "" && time !== null) openCalls.set(callId, { time, key, name, userMark });
      continue;
    }
    if (type === "tool/result") {
      const source = event.data?.message?.source;
      const callId = typeof source?.callId === "string" ? source.callId : "";
      if (callId === "" || time === null) continue;
      const started = openCalls.get(callId);
      if (started === undefined) continue; // 未配对 / 未结束：不计
      openCalls.delete(callId);
      const duration = time - started.time;
      if (duration > 0) {
        // 三层判定：白名单交互工具 / 中间夹着 user/message（且单次时长过阈值）→ 等待；
        // 其余（含没有人类输入的长任务）照常算工作。
        const interleaved = userMark > started.userMark;
        const isWait = excludeWait && duration >= waitThreshold && (waitingTools.has(started.name) || interleaved);
        if (isWait) {
          waitMs += duration;
        } else {
          addActive(started.key, started.time, duration);
          rawMs += duration;
        }
      }
      continue;
    }
    if (type === "user/message") {
      // 人类输入夹层：只影响发生在它之后的工具调用（call → result 之间）
      userMark += 1;
      // 人类消息密度：按消息时间落入 UTC 小时桶（聚合时再按请求时区平移）
      if (time !== null) hourHumanMsgs[utcHourOf(time)] += 1;
      noteStart(key, time);
      continue;
    }
    if (type === "assistant/message") {
      // 按小时 Token：每条 assistant/message 的 usage 全部四项，按**消息时间**归到 UTC 小时桶。
      // 与 row.tokens 同一定义（uncachedInput + output + cacheRead + cacheWrite）。
      if (time !== null) {
        const usage = event.data?.usage;
        const tokens = numOr0(usage?.inputTokens) + numOr0(usage?.outputTokens) +
          numOr0(usage?.cacheReadTokens) + numOr0(usage?.cacheWriteTokens);
        if (tokens > 0) hourTokens[utcHourOf(time)] += tokens;
      }
      if (headerTime !== null && time !== null && time > headerTime) {
        // 模型时间 = request/header.time → assistant/message.time；整段归该 message 所在轮次
        addActive(key, headerTime, time - headerTime);
        rawMs += time - headerTime;
      } else {
        const window = streamWindow(event.data?.stream);
        if (window !== null) {
          addActive(key, window[0], window[1] - window[0]);
          rawMs += window[1] - window[0];
        }
      }
      headerTime = null;
      continue;
    }
    if (type === "request/header") {
      if (time !== null) headerTime = time;
      continue;
    }
    // 其它事件（step/start、turn/end…）只用于校正「轮次开始时刻」
    noteStart(key, time);
  }

  // 每个轮次的活跃时长整段记到「该轮开始时刻」所在整点（不跨小时切分）
  for (const turn of turns.values()) {
    if (!(turn.activeMs > 0) || !(turn.startMs > 0)) continue;
    hours[utcHourOf(turn.startMs)] += turn.activeMs;
  }

  const officialActiveMs = numOr0(sessionLlmMs) + numOr0(sessionToolMs);
  // 等待时长不能超过官方 activeMs（并发 / 异常日志下防止「净活跃」变负）
  const excludedWaitMs = excludeWait ? Math.min(waitMs, officialActiveMs) : 0;
  const targetMs = Math.max(0, officialActiveMs - excludedWaitMs);
  const sum = hours.reduce((acc, value) => acc + value, 0);
  // 小时 Token：只有调用方给了官方合计（sessionTokens !== null）才回正，保证
  // sum(hourTokens) === row.tokensTotal（±0；整数目标用最大余数法，不产生小数 Token）。
  // 官方合计 > 0 但事件里读不出任何 usage → 返回 null，聚合层把它计入「未计入 N 个会话」，
  // 而不是编一个分布出来。
  let hourTokensOut = hourTokens;
  let hourTokensSource = hourTokens.some((value) => value > 0) ? "events" : null;
  if (sessionTokens !== null && sessionTokens !== undefined) {
    const officialTokens = numOr0(sessionTokens);
    const tokenSum = hourTokens.reduce((acc, value) => acc + value, 0);
    if (officialTokens > 0) {
      hourTokensOut = scaleTokenBuckets(hourTokens, officialTokens);
      hourTokensSource = hourTokensOut === null ? null : tokenSum === officialTokens ? "events" : "events-scaled";
    } else {
      // 官方合计为 0：事件里却有 usage → 口径冲突，宁可不展示；全 0 则保留空桶
      hourTokensOut = tokenSum > 0 ? null : hourTokens;
      hourTokensSource = tokenSum > 0 ? null : "events";
    }
  }
  const tokenResult = { hourTokens: hourTokensOut, hourTokensSource, hourHumanMsgs };
  if (sum <= 0 || targetMs <= 0) return { hours: null, source: null, rawMs, targetMs, waitMs: excludedWaitMs, ...tokenResult };
  if (Math.abs(sum - targetMs) <= 1) return { hours, source: "events", rawMs, targetMs, waitMs: excludedWaitMs, ...tokenResult };
  const factor = targetMs / sum;
  for (let i = 0; i < 24; i++) hours[i] *= factor;
  return { hours, source: "events-scaled", rawMs, targetMs, waitMs: excludedWaitMs, ...tokenResult };
}

/**
 * 折叠一个会话的事件日志 → 每个归并组的统计。
 * @param events - 事件数组（官方 SessionLogSnapshot 的 events）。
 * @param options - groups（自定义归并）/ sessionLlmMs / sessionToolMs / sessionTokens（会话官方口径，用于守恒分摊、时刻分布与小时 Token 缩放）/ sessionStartMs（会话 createdAt，时刻分布兜底）/ excludeWait / waitTools / waitMinMs（等待用户剔除）。
 * @returns { models, requests, unknownRequests, totalStreamMs, hours, hoursSource, hoursRawMs, hoursTargetMs, waitMs, hourTokens, hourTokensSource, hourHumanMsgs }
 */
export function foldSessionModels(events, {
  groups = [],
  sessionLlmMs = 0,
  sessionToolMs = 0,
  sessionTokens = null,
  sessionStartMs = 0,
  excludeWait = true,
  waitTools = DEFAULT_WAIT_TOOLS,
  waitMinMs = DEFAULT_WAIT_MIN_MS,
} = {}) {
  const models = {};
  let requests = 0;
  let unknownRequests = 0;
  let totalStreamMs = 0;
  const list = Array.isArray(events) ? events : [];

  for (const event of list) {
    if (event?.type !== "assistant/message") continue;
    const source = event.data?.message?.source ?? {};
    const usage = event.data?.usage ?? null;
    const provider = typeof source.provider === "string" ? source.provider : "";
    const model = typeof source.model === "string" ? source.model : "";
    const key = groupKeyFor(provider, model, groups);
    const bucket = (models[key] ??= emptyModelBucket());
    const tier = isPeak(event.time) ? "Peak" : "Off";
    if (usage === null || usage === undefined) {
      // 缺 usage：计入该模型的请求数，但不计 token（口径：缺字段不猜）
      bucket.requests += 1;
      unknownRequests += 1;
      continue;
    }
    requests += 1;
    bucket.requests += 1;
    bucket[`in${tier}`] += numOr0(usage.inputTokens);
    bucket[`out${tier}`] += numOr0(usage.outputTokens);
    bucket[`cr${tier}`] += numOr0(usage.cacheReadTokens);
    bucket[`cw${tier}`] += numOr0(usage.cacheWriteTokens);
    const rawKey = provider === "" && model === "" ? UNKNOWN_MODEL : `${provider === "" ? "?" : provider}/${model === "" ? "?" : model}`;
    bucket.raw[rawKey] = (bucket.raw[rawKey] ?? 0) + 1;
    const weight = streamWeight(event.data?.stream, event.time);
    bucket.streamMs += weight;
    totalStreamMs += weight;
  }

  // 思考强度分布（来自 request/header，按同一归并规则计数）
  for (const event of list) {
    if (event?.type !== "request/header") continue;
    const config = event.data?.header?.config ?? {};
    const key = groupKeyFor(config.provider, config.model, groups);
    const bucket = (models[key] ??= emptyModelBucket());
    const effort = typeof config.reasoningEffort === "string" && config.reasoningEffort !== "" ? config.reasoningEffort : "default";
    bucket.efforts[effort] = (bucket.efforts[effort] ?? 0) + 1;
  }

  // 会话 llmMs 按 stream 权重分摊（守恒：最后一个模型吸收余数）
  allocateLlmMs(models, sessionLlmMs, totalStreamMs);
  // 同一趟折叠里顺带算小时分布、小时 Token、人类消息与等待用户（同一份 events，不额外读日志）
  const hours = foldSessionHours(list, { sessionLlmMs, sessionToolMs, sessionTokens, sessionStartMs, excludeWait, waitTools, waitMinMs });
  return {
    models,
    requests,
    unknownRequests,
    totalStreamMs,
    hours: hours.hours,
    hoursSource: hours.source,
    hoursRawMs: hours.rawMs,
    hoursTargetMs: hours.targetMs,
    waitMs: hours.waitMs,
    hourTokens: hours.hourTokens,
    hourTokensSource: hours.hourTokensSource,
    hourHumanMsgs: hours.hourHumanMsgs,
  };
}

/** 把会话 llmMs 分摊到各模型（守恒，避免取整漂移）。 */
export function allocateLlmMs(models, sessionLlmMs, totalStreamMs) {
  const keys = Object.keys(models);
  if (keys.length === 0) return models;
  const target = numOr0(sessionLlmMs);
  if (target === 0) return models;
  const weights = keys.map((key) => models[key].streamMs);
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) {
    // 没有 stream 数据：按请求数分摊；请求数也为 0 时按模型数均分
    const reqs = keys.map((key) => models[key].requests);
    const reqSum = reqs.reduce((a, b) => a + b, 0);
    if (reqSum > 0) {
      let assigned = 0;
      keys.forEach((key, i) => {
        const share = i === keys.length - 1 ? target - assigned : target * (reqs[i] / reqSum);
        models[key].llmMs = Math.max(0, share);
        assigned += models[key].llmMs;
      });
    } else {
      const each = target / keys.length;
      keys.forEach((key) => { models[key].llmMs = each; });
    }
    return models;
  }
  let assigned = 0;
  keys.forEach((key, i) => {
    const share = i === keys.length - 1 ? target - assigned : target * (weights[i] / (totalStreamMs > 0 ? totalStreamMs : sum));
    models[key].llmMs = Math.max(0, share);
    assigned += models[key].llmMs;
  });
  return models;
}

/** 模型桶的 token 合计。 */
export function modelTokens(bucket) {
  return (
    numOr0(bucket?.inOff) + numOr0(bucket?.inPeak) +
    numOr0(bucket?.outOff) + numOr0(bucket?.outPeak) +
    numOr0(bucket?.crOff) + numOr0(bucket?.crPeak) +
    numOr0(bucket?.cwOff) + numOr0(bucket?.cwPeak)
  );
}

/** 缓存命中率 = 缓存读 /（缓存读 + 未命中输入）。 */
export function cacheHitRate(bucket) {
  const hit = numOr0(bucket?.crOff) + numOr0(bucket?.crPeak);
  const miss = numOr0(bucket?.inOff) + numOr0(bucket?.inPeak);
  return hit + miss > 0 ? hit / (hit + miss) : null;
}

function numOr0(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/* ------------------------------------------------------------------ 定价 */

/**
 * 内置默认价目（官方公开页，as-of 2026-10-13）。
 * DeepSeek：`https://api-docs.deepseek.com/quick_start/pricing/`（USD）与 `/zh-cn/…`（CNY）
 * 峰时 = 01:00–04:00 与 06:00–10:00 UTC 周一至周五；谷价 = 峰价一半。
 * 缓存写入官方未单独计价 → 记 0（若你的合约不同，用 pricing.overrides 覆盖）。
 */
export const DEFAULT_PRICING = {
  asOf: "2026-10-13",
  currency: "CNY",
  links: [
    { provider: "DeepSeek", url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/", label: "DeepSeek 模型 & 价格" },
    { provider: "Kimi (Moonshot)", url: "https://platform.kimi.com/docs/pricing/chat", label: "Kimi 模型推理定价" },
    { provider: "Anthropic Claude", url: "https://platform.claude.com/docs/en/about-claude/pricing", label: "Claude API pricing" },
  ],
  tables: {
    CNY: {
      "deepseek-v4-flash": { miss: { off: 1, peak: 2 }, cacheHit: { off: 0.02, peak: 0.04 }, output: { off: 4, peak: 8 }, cacheWrite: { off: 0, peak: 0 } },
      "deepseek-v4-pro": { miss: { off: 4.5, peak: 9 }, cacheHit: { off: 0.15, peak: 0.3 }, output: { off: 13.5, peak: 27 }, cacheWrite: { off: 0, peak: 0 } },
    },
    USD: {
      "deepseek-v4-flash": { miss: { off: 0.15, peak: 0.3 }, cacheHit: { off: 0.003, peak: 0.006 }, output: { off: 0.6, peak: 1.2 }, cacheWrite: { off: 0, peak: 0 } },
      "deepseek-v4-pro": { miss: { off: 0.66, peak: 1.32 }, cacheHit: { off: 0.022, peak: 0.044 }, output: { off: 1.98, peak: 3.96 }, cacheWrite: { off: 0, peak: 0 } },
    },
  },
};

/**
 * 解析生效价目：内置默认 + 用户覆盖（`pricing.overrides`，键为归并组名）。
 * @param config - { currency, overrides, asOf, links }。
 * @returns { currency, asOf, links, table, estimated }
 */
export function resolvePricing(config = {}) {
  const currency = config.currency === "USD" ? "USD" : "CNY";
  const base = DEFAULT_PRICING.tables[currency] ?? {};
  const overrides = config.overrides && typeof config.overrides === "object" ? config.overrides : {};
  const table = {};
  for (const [group, price] of Object.entries(base)) table[group] = normalizePrice(price);
  for (const [group, price] of Object.entries(overrides)) {
    table[group] = normalizePrice({ ...(table[group] ?? {}), ...price });
  }
  return {
    currency,
    asOf: typeof config.asOf === "string" && config.asOf !== "" ? config.asOf : DEFAULT_PRICING.asOf,
    links: Array.isArray(config.links) && config.links.length > 0 ? config.links : DEFAULT_PRICING.links,
    table,
    estimated: Object.keys(table).length > 0,
  };
}

function normalizePrice(price = {}) {
  const tier = (value, fallback = 0) => ({
    off: typeof value?.off === "number" && value.off >= 0 ? value.off : fallback,
    peak: typeof value?.peak === "number" && value.peak >= 0 ? value.peak : fallback,
  });
  return {
    miss: tier(price.miss),
    cacheHit: tier(price.cacheHit),
    output: tier(price.output),
    cacheWrite: tier(price.cacheWrite),
  };
}

/**
 * 单个模型桶的费用（未配置该模型单价时返回 null —— 不猜）。
 * @param bucket - 模型桶。
 * @param pricing - resolvePricing() 的结果。
 * @returns 金额（与 pricing.currency 同币种）或 null。
 */
export function costOf(bucket, pricing) {
  // 归并组名可能是 "组名"，也可能是未被归并的 "provider/model"；
  // 价目表用裸模型名作键，所以这里再回退查一次去掉 provider 前缀的名字。
  const key = typeof bucket?.group === "string" ? bucket.group : typeof bucket?.key === "string" ? bucket.key : "";
  const bare = key.includes("/") ? key.slice(key.indexOf("/") + 1) : null;
  const table = pricing?.table ?? {};
  const price = table[key] ?? (bare === null ? undefined : table[bare]);
  if (!price) return null;
  const per = 1e6;
  const sum =
    (numOr0(bucket.inOff) / per) * price.miss.off +
    (numOr0(bucket.inPeak) / per) * price.miss.peak +
    (numOr0(bucket.crOff) / per) * price.cacheHit.off +
    (numOr0(bucket.crPeak) / per) * price.cacheHit.peak +
    (numOr0(bucket.cwOff) / per) * price.cacheWrite.off +
    (numOr0(bucket.cwPeak) / per) * price.cacheWrite.peak +
    (numOr0(bucket.outOff) / per) * price.output.off +
    (numOr0(bucket.outPeak) / per) * price.output.peak;
  return Number.isFinite(sum) ? sum : null;
}

/**
 * 模型展示名：显式别名优先，否则取组名的**最后一段**。
 *
 * 组名可能是多段：`magpie/workbuddy-ai/deepseek-v4.1-flash`
 * （渠道 / 提供商 / 模型）——左侧都是渠道，只有最后一段是模型本身。
 * 2.1.1 之前只去掉第一段，于是二段组名会显示成 `workbuddy-ai/deepseek-v4.1-flash`；
 * 现在统一 `split("/").pop()`，只显示模型名。
 *
 * @param key - 归并组名。
 * @param aliases - modelAliases 配置（先按全名、再按短名查）。
 */
export function modelLabel(key, aliases = {}) {
  if (typeof aliases[key] === "string" && aliases[key] !== "") return aliases[key];
  if (key === UNKNOWN_MODEL) return UNKNOWN_MODEL;
  const parts = String(key).split("/").filter((part) => part !== "");
  const short = parts.length > 0 ? parts[parts.length - 1] : String(key);
  if (typeof aliases[short] === "string" && aliases[short] !== "") return aliases[short];
  return short;
}
