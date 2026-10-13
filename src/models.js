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

/** 未标注模型（缺 provider/model 或 usage）的桶名。 */
export const UNKNOWN_MODEL = "(未标注模型)";

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

/**
 * 折叠一个会话的事件日志 → 每个归并组的统计。
 * @param events - 事件数组（官方 SessionLogSnapshot 的 events）。
 * @param options - groups（自定义归并）/ sessionLlmMs（会话官方 llmMs，用于守恒分摊）。
 * @returns { models, requests, unknownRequests, totalStreamMs }
 */
export function foldSessionModels(events, { groups = [], sessionLlmMs = 0 } = {}) {
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
  return { models, requests, unknownRequests, totalStreamMs };
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
 * 模型展示名：显式别名优先，否则用组名（取 "/" 后段，保持简洁）。
 * @param key - 归并组名。
 * @param aliases - modelAliases 配置。
 */
export function modelLabel(key, aliases = {}) {
  if (typeof aliases[key] === "string" && aliases[key] !== "") return aliases[key];
  if (key === UNKNOWN_MODEL) return UNKNOWN_MODEL;
  const short = key.includes("/") ? key.slice(key.indexOf("/") + 1) : key;
  if (typeof aliases[short] === "string" && aliases[short] !== "") return aliases[short];
  return short;
}
