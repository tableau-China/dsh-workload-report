/**
 * AI 用户画像的宿主编排：可选 llm 服务、白名单 payload、磁盘缓存、超时与降级。
 *
 * 铁律：
 *   · 默认包含（enabled=true）但只手动触发：打开面板 / probe 绝不调用模型；
 *   · 显式 enabled=false 时才算关闭（不探测 llm、不生成、零服务调用）；
 *   · llm 用 ctx.get("llm") 可选获取（不写进 inject，缺失时插件照常加载）；
 *   · 只发送 buildProfilePayload() 的白名单聚合统计，绝不发对话正文 / 标题 / 路径；
 *   · 任何失败（服务缺失 / 未登录 / 超时 / 非 stop / 解析失败）都降级为本地规则，
 *     路由永远返回 200，不把异常抛给 UI；
 *   · 缓存按统计指纹 + 语言落盘（与索引同目录，原子写），指纹相同不重复调用模型。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  PROFILE_PAYLOAD_KEYS,
  buildProfilePayload,
  isProfileTextUnfinished,
  localProfile,
  parseProfileText,
  profileExcerpt,
  profileFingerprint,
  repairProfileJson,
} from "./ai-profile.js";

/**
 * 默认配置（profile 的 cordis.patch.yml 可覆盖 aiProfile）。
 *
 * 铁律：这里**不提供 maxTokens**。画像要求模型输出严格 JSON，一旦被输出上限截断，
 * finish.kind 会变成 length、JSON 不完整，旧版传 maxTokens:1600 正是现场
 * 「AI_NOT_STOPPED / 模型未正常结束」的根因。输出长度交给模型 / provider 的默认上限，
 * 真被截断时走 repairProfileJson() 补齐括号抢救；配置里即使写了 maxTokens 也忽略。
 */
export const AI_PROFILE_DEFAULTS = Object.freeze({
  /** 默认包含该功能；只有点击「生成画像」才调用模型。显式 false 才隐藏入口。 */
  enabled: true,
  provider: "",
  model: "",
  timeoutMs: 60000,
  cacheTtlMs: 86400000,
  /** 汇总窗口下限（天）：看板选 7 天时，画像仍按至少 30 天统计。 */
  minDays: 30,
});

/** 缓存文件格式版本（改字段时 +1；不影响索引 INDEX_VERSION）。v4 起带 truncated / diagnostic。 */
const PROFILE_CACHE_VERSION = 4;

/** 稳定错误码：前端按它显示原因，并一律降级为本地规则版。 */
export const PROFILE_CODES = Object.freeze({
  disabled: "AI_PROFILE_DISABLED",
  unavailable: "LLM_UNAVAILABLE",
  signIn: "ACCOUNT_SIGN_IN_REQUIRED",
  missingCredential: "MISSING_CREDENTIAL",
  timeout: "AI_TIMEOUT",
  notStopped: "AI_NOT_STOPPED",
  parse: "AI_PARSE_FAILED",
  empty: "AI_EMPTY_RESULT",
  failed: "AI_FAILED",
});

/** 带稳定 code / 失败阶段 的画像错误（路由只认 code，不向 UI 抛文本）。 */
export class ProfileError extends Error {
  constructor(code, message, stage = null) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
    if (typeof stage === "string" && stage !== "") this.stage = stage;
  }
}

/** 失败阶段（diagnostic.error.stage）；顺序即调用链。 */
export const PROFILE_STAGES = Object.freeze(["route", "precheck", "prepareCall", "stream", "parse", "finish"]);

/**
 * 这些 finish.kind 表示"输出被上限截断"（不同 provider 命名不一致）。
 * 截断时先尝试 JSON 修复，不直接判定失败。
 */
export const TRUNCATION_FINISH_KINDS = Object.freeze(["length", "max-tokens", "max_tokens", "maxTokens", "token-limit"]);

/** finish.kind 是否是输出截断。 */
export function isTruncationFinish(kind) {
  return TRUNCATION_FINISH_KINDS.includes(String(kind ?? ""));
}

/** 截断且无法修复：带 finish / textLength / excerpt，路由据此降级并写 diagnostic。 */
function truncatedProfileError(finishKind, textLength, excerpt, repaired = false) {
  const error = new ProfileError(PROFILE_CODES.notStopped, "模型未正常结束：" + finishKind, "finish");
  error.finishKind = finishKind;
  error.textLength = textLength;
  error.repaired = repaired;
  error.rawText = excerpt;
  return error;
}

/** 诊断 message 上限（字符数，按 Unicode 码点算）。 */
const MAX_DIAGNOSTIC_CHARS = 300;

/**
 * 诊断 message 脱敏：
 *   · 先抹掉 token / key / secret / bearer 等赋值与裸密钥；
 *   · 再把敏感**词本身**替换为 [redacted]（避免"有 key 但没值"也被当泄漏）；
 *   · 最后压到 300 字符（超出用省略号，仍不超过 300）。
 * 只用于 diagnostic，不参与 UI 文案。
 */
export function sanitizeDiagnosticMessage(value) {
  let text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "";
  text = text
    .replace(/(?:api[\s_-]*key|access[\s_-]*key|key|secret|token|password|credential|authorization)[\s_-]*[=:]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "[redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]{6,}/g, "[redacted]")
    .replace(/api[\s_-]*key|access[\s_-]*key|key|secret|token|password|credential|authorization|bearer/gi, "[redacted]");
  const chars = Array.from(text);
  if (chars.length > MAX_DIAGNOSTIC_CHARS) text = chars.slice(0, MAX_DIAGNOSTIC_CHARS - 1).join("") + "…";
  return text;
}

/** 底层错误码：优先保留 error.code（如 PROVIDER_NOT_FOUND），没有才退回映射码。 */
export function diagnosticErrorCode(error, fallback = PROFILE_CODES.failed) {
  const code = typeof error?.code === "string" ? error.code.trim() : "";
  if (code !== "") return code;
  return fallback;
}

/**
 * 构造失败诊断（/profile 的 diagnostic 与 /health 的 aiProfile.last* 同源）。
 * @param error - 底层异常（保留其 code / message / stage）。
 * @param fallbackStage - 异常没带 stage 时的阶段。
 */
export function buildProfileDiagnostic(error, fallbackStage = "route") {
  const code = profileCodeOf(error);
  const rawStage = typeof error?.stage === "string" && PROFILE_STAGES.includes(error.stage) ? error.stage : fallbackStage;
  const stage = PROFILE_STAGES.includes(rawStage) ? rawStage : "route";
  const diagnostic = {
    source: "local",
    code,
    error: {
      code: diagnosticErrorCode(error, code),
      message: sanitizeDiagnosticMessage(error?.message ?? error),
      stage,
    },
  };
  // 解析 / 截断失败时附上模型输出事实（只来自模型，不含会话数据）。
  //   finish.kind：模型侧结束原因；textLength：输出字符数；repaired：是否走 JSON 修复。
  if (typeof error?.finishKind === "string" && error.finishKind !== "") {
    diagnostic.finish = { kind: error.finishKind };
  }
  if (Number.isFinite(Number(error?.textLength))) diagnostic.textLength = Math.max(0, Math.round(Number(error.textLength)));
  if (typeof error?.repaired === "boolean") diagnostic.repaired = error.repaired;
  if (typeof error?.rawText === "string" && error.rawText !== "") diagnostic.excerpt = error.rawText;
  return diagnostic;
}

/** 合并调试用 provider/model 覆盖（空串 = 不覆盖）。 */
function normalizeOverrides(input = {}) {
  const raw = input !== null && typeof input === "object" ? input : {};
  return {
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
  };
}

/** listModels 返回值归一化为模型 id 列表（兼容字符串 / { id } / { model }）。 */
function modelIds(list) {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : item?.id ?? item?.model ?? item?.name))
    .filter((id) => typeof id === "string" && id !== "");
}

/** 给任意异常打上失败阶段与路由快照（不覆盖已有 stage）。 */
function tagStage(value, stage, trace) {
  const error = value instanceof Error ? value : new Error(String(value ?? "未知错误"));
  if (typeof error.stage !== "string" || error.stage === "") error.stage = stage;
  if (error.route === undefined) error.route = trace?.route ?? null;
  if (error.precheck === undefined) error.precheck = trace?.precheck ?? { providers: [], models: [] };
  return error;
}

/**
 * 汇总窗口下限：配置的 minDays（默认 30），非法值回落默认值。
 * 用户在看板选 7 天时，画像仍按 30 天统计；配置 minDays: 45 则用 45。
 */
export function profileWindowDays(days, minDays = AI_PROFILE_DEFAULTS.minDays) {
  const floor = Number(minDays);
  const minimum = Number.isFinite(floor) && floor > 0 ? Math.round(floor) : AI_PROFILE_DEFAULTS.minDays;
  const requested = Number.parseInt(String(days ?? ""), 10);
  return Math.max(Number.isFinite(requested) && requested > 0 ? requested : minimum, minimum);
}

/**
 * /profile 的聚合查询：天数抬到 minDays；all / from / to 仍由 handle 校正。
 *
 * `anchorToActivity: false`：画像是"固定窗口"语义（汇总窗口至少 minDays 天），
 * 不跟着看板把区间截短到最早活跃日——否则历史不足 minDays 的账号会退化成近几天，
 * 与「汇总窗口至少 30 天」的口径冲突，趋势字段也失去基线。
 */
export function profileWindowQuery(query = {}, minDays = AI_PROFILE_DEFAULTS.minDays) {
  const raw = query !== null && typeof query === "object" ? query : {};
  return { ...raw, days: profileWindowDays(raw.days, minDays), anchorToActivity: false };
}

/** 配置归一化：数值兜底、字符串裁剪；未知字段忽略。 */
export function normalizeAiProfile(config = {}) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const ttl = Number(raw.cacheTtlMs);
  // raw.maxTokens 被刻意忽略：输出上限会导致 JSON 截断，见 AI_PROFILE_DEFAULTS 的说明。
  return {
    // 只有显式 false 才关闭；缺省（无配置）默认包含该功能。
    enabled: raw.enabled !== false,
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    timeoutMs: Math.max(1, Math.round(positive(raw.timeoutMs, AI_PROFILE_DEFAULTS.timeoutMs))),
    cacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? Math.round(ttl) : AI_PROFILE_DEFAULTS.cacheTtlMs,
    minDays: Math.max(1, Math.min(3650, Math.round(positive(raw.minDays, AI_PROFILE_DEFAULTS.minDays)))),
  };
}

/** Token usage 归一化（只保留 input/output/total）。 */
function normalizeUsage(usage) {
  const input = Math.max(0, Math.round(Number(usage?.inputTokens) || 0));
  const output = Math.max(0, Math.round(Number(usage?.outputTokens) || 0));
  return { input, output, total: input + output };
}

/** costHint 只是本插件这次旁路调用的 token 数，不猜价格。 */
function costHintOf(usage) {
  return { inputTokens: Math.max(0, Math.round(Number(usage?.input) || 0)), outputTokens: Math.max(0, Math.round(Number(usage?.output) || 0)) };
}

/** 把任意异常收敛成稳定错误码。 */
export function profileCodeOf(error) {
  const code = String(error?.code ?? "");
  if (Object.values(PROFILE_CODES).includes(code)) return code;
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return PROFILE_CODES.timeout;
  const message = String(error?.message ?? "");
  if (message.includes(PROFILE_CODES.signIn)) return PROFILE_CODES.signIn;
  if (message.includes(PROFILE_CODES.missingCredential)) return PROFILE_CODES.missingCredential;
  if (message.includes("TimeoutError") || message.includes("aborted")) return PROFILE_CODES.timeout;
  return PROFILE_CODES.failed;
}

/** 给 Promise 加超时：即使 adapter 不响应 signal，路由也不会悬挂。 */
function withAbort(promise, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
      if (timer !== null) clearTimeout(timer);
    };
    const onAbort = () => {
      cleanup();
      reject(new ProfileError(PROFILE_CODES.timeout, "画像生成超时"));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    // AbortSignal.timeout 的计时器是 unref 的；这里再放一个普通 timer，
    // 保证路由调用方（包括离线测试）一定等到超时结果，而不是随事件循环退出。
    timer = setTimeout(onAbort, timeoutMs);
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

/** 可用键及单位说明：prompt 里显式列出，模型才知道哪些数字能用。 */
const PAYLOAD_KEY_HELP = PROFILE_PAYLOAD_KEYS.join(", ");

/**
 * 系统提示：只根据聚合统计，输出严格 JSON（不指定 reasoningEffort）。
 * 硬性要求写死在 prompt 里：引用数字、可用键、schema、空泛建议禁止。
 */
export function systemPrompt(lang) {
  if (lang === "en") {
    return [
      "You are a senior productivity analyst. Write a profile using ONLY the supplied aggregate numbers.",
      "Hard rules:",
      "1) Never invent projects, conversations, files, or experiences that are not in the payload.",
      "2) Every dimension insight MUST cite concrete numbers, e.g. \"afternoon 34%\" or \"42 m per conversation\". Insights without a number are invalid.",
      "3) No generic advice such as \"take more rest\" or \"stay focused\"; every advice item must cite its numeric basis in why.",
      "4) Be differentiated: lead with the 1-2 most distinctive facts instead of listing everything.",
      "Output exactly one strict JSON object; no Markdown, no code fence, no explanation.",
      'Schema: {"headline":"one-sentence profile, <=30 chars","dimensions":[{"key":"rhythm|focus|stack|collab|trend","title":"<=8 chars","insight":"<=60 chars, MUST contain a number","evidence":"<=40 chars, list the cited numbers"}],"advice":[{"text":"<=40 chars","why":"<=40 chars, numeric basis"}],"risk":"<=40 chars or null"}',
      "dimensions: 4-6 items, key chosen from rhythm / focus / stack / collab / trend; advice: 2-3 items; risk: only when the numbers show a real risk, otherwise null.",
      "Available keys (payload): " + PAYLOAD_KEY_HELP + ".",
      "Units: *Ms = milliseconds; *Tokens = token count; *Share / cacheHitRate = 0-1 ratio; *Count / sessions / conversations = counts; trend*DeltaPct = percent change (may be negative); null = not enough data.",
    ].join("\n");
  }
  return [
    "你是资深生产力分析师，只依据给定的聚合数字写画像。",
    "硬性规则：",
    "1) 禁止编造项目、对话、文件或经历；只能使用 payload 里的数字。",
    "2) 每条 insight 必须引用数字（如「午后 34%」「单会话 42 m」）；没有数字的结论视为不合格。",
    "3) 禁止空泛建议（如「注意休息」「保持专注」）；每条建议都要在 why 里给出数字依据。",
    "4) 要有差异化：先写最突出的 1–2 个事实，不要面面俱到。",
    "只输出一个严格 JSON 对象；不要 Markdown、不要代码围栏、不要解释。",
    'schema：{"headline":"一句话画像，≤30字","dimensions":[{"key":"rhythm|focus|stack|collab|trend","title":"≤8字","insight":"≤60字，必须含数字","evidence":"≤40字，列出引用的数字"}],"advice":[{"text":"≤40字","why":"≤40字，数字依据"}],"risk":"≤40字或 null"}',
    "dimensions 4–6 条，key 从 rhythm(节奏) / focus(专注) / stack(工具栈) / collab(协作) / trend(趋势) 中选；advice 2–3 条；risk 只在数字显示确有风险时填写，否则 null。",
    "可用键（payload）：" + PAYLOAD_KEY_HELP + "。",
    "单位：*Ms = 毫秒；*Tokens = Token 数；*Share / cacheHitRate = 0–1 占比；*Count / sessions / conversations = 计数；trend*DeltaPct = 环比百分比（可为负）；null = 数据不足。",
  ].join("\n");
}

/**
 * 画像服务：挂在 WorkloadIndex 上（index.profile），路由与测试共用。
 */
export class ProfileService {
  /**
   * @param ctx - Cordis 上下文（llm / agentDefaultModel 都用 ctx.get 可选获取）。
   * @param config - aiProfile 配置。
   * @param index - WorkloadIndex（用 index.snapshot 与 index.indexPath）。
   */
  constructor(ctx, config, index) {
    this.ctx = ctx;
    this.config = normalizeAiProfile(config);
    this.index = index;
    /** 同指纹并发请求共享一次生成（避免双击重复调用模型）。 */
    this.inflight = new Map();
    /** 测试用：真正发起模型准备的次数。 */
    this.calls = 0;
    /**
     * 最近一次生成诊断（/health.diagnostics.aiProfile 的数据源）：
     *   · code / stage / error 保留底层失败事实（error 已脱敏、≤300 字）；
     *   · route / precheck 记录路由与预检结果；
     *   · at 为毫秒时间戳（0 = 还没生成过）。
     */
    this.last = { code: null, stage: null, error: null, at: 0, route: null, precheck: null };
  }

  /** 记录最近一次生成结果（成功也记，成功时 code=null）。 */
  recordLast({ code = null, stage = null, error = null, route = null, precheck = null } = {}) {
    this.last = {
      code: typeof code === "string" && code !== "" ? code : null,
      stage: typeof stage === "string" && stage !== "" ? stage : null,
      error: typeof error === "string" && error !== "" ? error : null,
      at: Date.now(),
      route: route ?? null,
      precheck: precheck ?? { providers: [], models: [] },
    };
  }

  /** /health 用的精简快照（字段固定，方便一条命令看全）。 */
  healthState() {
    const last = this.last ?? {};
    return {
      enabled: this.config.enabled,
      lastCode: last.code ?? null,
      lastStage: last.stage ?? null,
      lastError: last.error ?? null,
      lastAt: last.at ?? 0,
      route: last.route ?? null,
    };
  }

  /** 可选服务：不存在 / 未提供时返回 undefined（不抛错、不阻塞）。 */
  service() {
    try {
      if (typeof this.ctx?.get !== "function") return undefined;
      return this.ctx.get("llm") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 默认模型选择（可选服务；老版 DSH 没有）。 */
  defaultSelection() {
    try {
      if (typeof this.ctx?.get !== "function") return undefined;
      const service = this.ctx.get("agentDefaultModel");
      if (typeof service?.currentSelection !== "function") return undefined;
      return service.currentSelection() ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 注册的 provider 列表（兼容字符串与 { id } 两种桩形状）。 */
  async providerIds(llm) {
    if (typeof llm?.listProviders !== "function") return [];
    const list = await llm.listProviders();
    if (!Array.isArray(list)) return [];
    return list.map((item) => (typeof item === "string" ? item : item?.id)).filter((id) => typeof id === "string" && id !== "");
  }

  /**
   * 解析调用路由：优先插件配置 provider/model，否则宿主默认模型；
   * 调试用 provider/model 查询参数只覆盖对应字段（不写配置）。
   * 调用前用 listProviders / listModels 预检；空列表即未登录 / 无 key。
   * @param overrides - 调试覆盖 { provider, model }（空串 = 不覆盖）。
   * @param trace - 诊断快照：写入 route / precheck，失败时随异常带回。
   * @returns { provider, model, origin }。
   */
  async resolveRoute(llm, providers, overrides = {}, trace = null) {
    const overrideProvider = typeof overrides?.provider === "string" ? overrides.provider : "";
    const overrideModel = typeof overrides?.model === "string" ? overrides.model : "";
    const overridden = overrideProvider !== "" || overrideModel !== "";
    const record = trace ?? { route: null, precheck: null };
    if (record !== null && typeof record === "object") record.stage = "route";
    // 1) 插件配置（query 只覆盖对应字段；origin 单独标 query 便于排查）
    const configProvider = overrideProvider !== "" ? overrideProvider : this.config.provider;
    const configModel = overrideModel !== "" ? overrideModel : this.config.model;
    let route;
    if (configProvider !== "" && configModel !== "") {
      route = { provider: configProvider, model: configModel, origin: overridden ? "query" : "config" };
    } else {
      // 2) 宿主默认模型
      const selection = this.defaultSelection();
      if (selection === undefined || typeof selection.provider !== "string" || typeof selection.model !== "string" || selection.provider === "" || selection.model === "") {
        throw new ProfileError(PROFILE_CODES.signIn, "没有默认模型选择（未登录）", "route");
      }
      route = {
        provider: overrideProvider !== "" ? overrideProvider : selection.provider,
        model: overrideModel !== "" ? overrideModel : selection.model,
        origin: overridden ? "query" : "agentDefaultModel",
      };
    }
    record.route = route;
    if (!providers.includes(route.provider)) {
      throw new ProfileError(
        PROFILE_CODES.missingCredential,
        (configProvider !== "" && configModel !== "" ? "配置的 provider 未注册：" : "默认 provider 未注册：") + route.provider,
        "route",
      );
    }
    let models;
    if (record !== null && typeof record === "object") record.stage = "precheck";
    try {
      models = await llm.listModels(route.provider);
    } catch (error) {
      throw tagStage(error, "precheck", record);
    }
    if (record !== null && typeof record === "object") record.stage = "route";
    const ids = modelIds(models);
    record.precheck = { providers, models: ids.slice(0, 10) };
    if (ids.length === 0) {
      throw new ProfileError(PROFILE_CODES.signIn, "provider " + route.provider + " 没有可用模型（未登录或无 key）", "precheck");
    }
    return route;
  }

  /**
   * 状态预检（probe）：不调用模型，只回答 enabled / 是否可生成 / 提示面板需要的模型与窗口。
   * 调试 provider/model 参数同样生效，用来确认"换一个网关是否能通"。
   * @param overrides - 调试覆盖 { provider, model }。
   * @param window - { days, all }；只用于计算提示面板的「基于近 N 天汇总」。
   */
  async status(overrides = {}, window = {}) {
    const parsed = normalizeOverrides(overrides);
    if (!this.config.enabled) return { enabled: false, code: PROFILE_CODES.disabled };
    // 「全部」区间在生成前无法轻量得知真实跨度：提示面板只承诺"至少 minDays 天"；
    // 生成后结果使用 payload.range.days 的真实 summaryDays。
    const summaryDays = window?.all === true ? this.config.minDays : profileWindowDays(window?.days, this.config.minDays);
    const trace = { route: null, precheck: { providers: [], models: [] } };
    const llm = this.service();
    if (llm === undefined) {
      return { enabled: true, available: false, signedIn: false, code: PROFILE_CODES.unavailable, provider: null, model: null, route: null, precheck: trace.precheck, summaryDays };
    }
    try {
      const providers = await this.providerIds(llm);
      trace.precheck.providers = providers;
      if (providers.length === 0) {
        return { enabled: true, available: false, signedIn: false, code: PROFILE_CODES.signIn, provider: null, model: null, route: null, precheck: trace.precheck, summaryDays };
      }
      const route = await this.resolveRoute(llm, providers, parsed, trace);
      return {
        enabled: true, available: true, signedIn: true, code: null,
        provider: route.provider, model: route.model, route: trace.route, precheck: trace.precheck, summaryDays,
      };
    } catch (error) {
      return {
        enabled: true, available: false, signedIn: false, code: profileCodeOf(error),
        provider: null, model: null, route: trace.route, precheck: trace.precheck,
        stage: typeof error?.stage === "string" ? error.stage : null, summaryDays,
      };
    }
  }

  /** 缓存文件名：与索引同目录，带索引基名 + 语言 + 指纹。 */
  cachePath(lang, fingerprint) {
    const indexPath = typeof this.index?.indexPath === "function" ? this.index.indexPath() : "";
    const directory = indexPath === "" ? "." : dirname(indexPath);
    const base = indexPath === "" ? "workload-report" : basename(indexPath).replace(/\.json$/i, "");
    return join(directory, base + "-ai-" + lang + "-" + fingerprint + ".json");
  }

  /** 读缓存（TTL 内且指纹 / 语言一致才命中；文件损坏当作未命中）。 */
  async readCache(lang, fingerprint) {
    if (!(this.config.cacheTtlMs > 0)) return null;
    try {
      const parsed = JSON.parse(await readFile(this.cachePath(lang, fingerprint), "utf8"));
      if (parsed?.version !== PROFILE_CACHE_VERSION) return null;
      if (parsed?.fingerprint !== fingerprint || parsed?.lang !== lang) return null;
      const profile = parsed?.profile;
      if (profile === null || typeof profile !== "object") return null;
      if (!(Date.now() - Number(profile.generatedAt) < this.config.cacheTtlMs)) return null;
      return profile;
    } catch {
      return null;
    }
  }

  /** 原子写缓存：同目录 .tmp → rename；失败只影响下次是否重算，不影响本次返回。 */
  async writeCache(lang, fingerprint, profile) {
    if (!(this.config.cacheTtlMs > 0)) return;
    try {
      const path = this.cachePath(lang, fingerprint);
      await mkdir(dirname(path), { recursive: true });
      const temp = path + "." + process.pid + "." + Date.now() + ".tmp";
      await writeFile(temp, JSON.stringify({ version: PROFILE_CACHE_VERSION, fingerprint, lang, profile }));
      await rename(temp, path);
    } catch {
      /* 缓存失败静默：画像本身照常返回 */
    }
  }

  /**
   * 路由入口。
   * @param options.query - /snapshot 同款查询（days / scope / all / tz）。
   * @param options.lang - zh | en。
   * @param options.force - 跳过缓存重新生成。
   * @param options.probe - 只返回 enabled / 登录状态，不生成、不读快照。
   * @param options.provider / options.model - 调试覆盖（仅 enabled 生效；不写配置、不需要重启）。
   * @returns 200 JSON 体（任何失败都不抛）。
   */
  async handle({ query, lang = "zh", force = false, probe = false, provider = "", model = "" } = {}) {
    if (!this.config.enabled) return { enabled: false, code: PROFILE_CODES.disabled };
    const overrides = normalizeOverrides({ provider, model });
    const debugRoute = overrides.provider !== "" || overrides.model !== "";
    if (probe) return this.status(overrides, query ?? {});

    // 汇总窗口至少 minDays（默认 30）：看板选 7 天时，画像仍用 30 天聚合数据。
    // all / from / to 可能把窗口压回 7 天，所以快照回来后再校正一次（见下）。
    const windowQuery = profileWindowQuery(query, this.config.minDays);
    let snapshot = await this.index.snapshot(windowQuery);
    if (!(Number(snapshot?.range?.days) >= this.config.minDays)) {
      snapshot = await this.index.snapshot({
        ...windowQuery,
        from: undefined,
        to: undefined,
        all: false,
        days: this.config.minDays,
      });
    }
    const payload = buildProfilePayload(snapshot);
    const fingerprint = profileFingerprint(payload);
    const summaryDays = Math.max(0, Math.round(Number(payload?.range?.days) || 0));

    // 调试覆盖不读也不写缓存：避免一次试跑污染正常路径的指纹缓存。
    if (!force && !debugRoute) {
      const cached = await this.readCache(lang, fingerprint);
      if (cached !== null) {
        this.recordLast({
          code: cached.code,
          stage: cached.diagnostic?.error?.stage ?? (cached.code === null || cached.code === undefined ? "finish" : null),
          error: cached.diagnostic?.error?.message ?? null,
          route: cached.route ?? null,
          precheck: cached.precheck ?? null,
        });
        return { enabled: true, ...cached, summaryDays, cached: true };
      }
    }

    const key = lang + ":" + fingerprint + (debugRoute ? ":" + overrides.provider + ":" + overrides.model : "");
    if (!force && this.inflight.has(key)) return this.inflight.get(key);
    const run = this.generate({ payload, fingerprint, lang, overrides, cache: !debugRoute, summaryDays });
    if (!force) this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 生成一次：模型失败一律回落到本地规则（source=local + code + diagnostic）。 */
  async generate({ payload, fingerprint, lang, overrides = {}, cache = true, summaryDays = 0 }) {
    let result;
    try {
      const generated = await this.callModel(payload, lang, overrides);
      result = {
        source: "llm",
        code: null,
        headline: generated.headline,
        dimensions: generated.dimensions,
        advice: generated.advice,
        risk: generated.risk,
        usage: generated.usage,
        costHint: costHintOf(generated.usage),
        model: generated.model,
        route: generated.route,
        precheck: generated.precheck,
        // 截断修复成功时保留 finish / textLength / repaired / excerpt，供 UI 与排查使用。
        truncated: generated.truncated === true,
        diagnostic: generated.diagnostic ?? null,
      };
      this.recordLast({ code: null, stage: "finish", error: null, route: generated.route, precheck: generated.precheck });
    } catch (error) {
      const code = profileCodeOf(error);
      const stage = typeof error?.stage === "string" && PROFILE_STAGES.includes(error.stage) ? error.stage : "route";
      const route = error?.route ?? null;
      const precheck = error?.precheck ?? { providers: [], models: [] };
      const diagnostic = buildProfileDiagnostic(error, stage);
      if (this.ctx?.logger?.warn !== undefined) {
        this.ctx.logger.warn(
          "[workload-report] AI 画像降级为本地规则：" + code + "（" + stage + "）— " + diagnostic.error.message,
        );
      }
      const local = localProfile(payload, lang);
      result = {
        source: "local",
        code,
        headline: local.headline,
        dimensions: local.dimensions,
        advice: local.advice,
        risk: local.risk,
        usage: { input: 0, output: 0, total: 0 },
        costHint: { inputTokens: 0, outputTokens: 0 },
        model: null,
        route,
        precheck,
        truncated: false,
        diagnostic,
      };
      this.recordLast({ code, stage, error: diagnostic.error.message, route, precheck });
    }
    const profile = { ...result, summaryDays, generatedAt: Date.now(), fingerprint, cached: false };
    if (cache) await this.writeCache(lang, fingerprint, profile);
    return { enabled: true, ...profile };
  }

  /** 真正调用 llm：precheck → route → prepareCall → stream → finish → parse。 */
  async callModel(payload, lang, overrides = {}) {
    // 超时覆盖整个调用链：预检（listProviders / listModels）→ prepareCall → stream。
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    /** 诊断快照：失败时随异常带回；stage 用于超时这类没有具体异常点的失败。 */
    const trace = { route: null, precheck: { providers: [], models: [] }, stage: "route" };
    const work = (async () => {
      trace.stage = "route";
      const llm = this.service();
      if (llm === undefined) throw new ProfileError(PROFILE_CODES.unavailable, "当前 DSH 没有 llm 服务", "route");
      trace.stage = "precheck";
      let providers = [];
      try {
        providers = await this.providerIds(llm);
      } catch (error) {
        throw tagStage(error, "precheck", trace);
      }
      trace.precheck.providers = providers;
      if (providers.length === 0) throw new ProfileError(PROFILE_CODES.signIn, "没有已登录的模型 provider", "precheck");
      trace.stage = "route";
      const route = await this.resolveRoute(llm, providers, normalizeOverrides(overrides), trace);
      trace.route = route;
      trace.stage = "prepareCall";
      this.calls += 1;
      let call;
      try {
        // 不传 maxTokens：画像输出是严格 JSON，任何输出上限都可能把 JSON 截断。
        // 旧版 maxTokens:1600 在长维度输出时会触发 finish.kind=length，正是现场
        // 「AI_NOT_STOPPED」的根因；截断时改由 repairProfileJson() 抢救。
        call = await llm.prepareCall(
          { provider: route.provider, model: route.model, temperature: 0.35 },
          signal,
        );
      } catch (error) {
        throw tagStage(error, "prepareCall", trace);
      }
      const options = {
        ...call.config,
        system: systemPrompt(lang),
        messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(payload) }] }],
        signal,
      };
      let text = "";
      let usage = { input: 0, output: 0, total: 0 };
      let finish = null;
      trace.stage = "stream";
      try {
        for await (const chunk of call.stream(options)) {
          if (chunk?.type === "text-delta") text += String(chunk.text ?? "");
          else if (chunk?.type === "usage") usage = normalizeUsage(chunk.usage);
          else if (chunk?.type === "finish") finish = chunk.reason;
        }
      } catch (error) {
        throw tagStage(error, "stream", trace);
      }
      trace.stage = "finish";
      const finishKind = finish === null ? "none" : String(finish?.kind ?? "unknown");
      const failureCode = finish?.failure?.code;
      const textLength = Array.from(text).length;
      const excerpt = profileExcerpt(text);
      /** 给任意异常补上本次模型输出事实（失败诊断 / parse 失败都用）。 */
      const attachFinish = (error) => {
        error.finishKind = finishKind;
        error.textLength = textLength;
        if (typeof error.repaired !== "boolean") error.repaired = false;
        if (typeof error.rawText !== "string" || error.rawText === "") error.rawText = excerpt;
        return error;
      };
      /**
       * 截断抢救：补齐未闭合的字符串 / 数组 / 对象括号后重新解析。
       * 成功返回带 truncated:true 的结果；JSON 修不好或 schema 不合格返回 null。
       */
      const parseTruncated = () => {
        const repair = repairProfileJson(text);
        if (repair === null) return null;
        let repaired;
        try {
          repaired = parseProfileText(repair.text);
        } catch {
          return null;
        }
        return {
          ...repaired,
          usage,
          model: { provider: route.provider, model: route.model },
          route,
          precheck: trace.precheck,
          truncated: true,
          diagnostic: {
            source: "llm",
            code: null,
            finish: { kind: finishKind },
            textLength,
            repaired: repair.repaired,
            excerpt,
          },
        };
      };

      if (finishKind !== "stop") {
        if (failureCode === PROFILE_CODES.signIn || failureCode === PROFILE_CODES.missingCredential) {
          throw attachFinish(new ProfileError(failureCode, "模型调用未完成：" + finishKind, "finish"));
        }
        // 截断（length / max-tokens）或文本明显未收尾 → 先尝试 JSON 修复，不直接失败。
        const salvageable = isTruncationFinish(finishKind) || isProfileTextUnfinished(text);
        if (!salvageable || text.trim() === "") {
          throw truncatedProfileError(finishKind, textLength, excerpt, false);
        }
        trace.stage = "parse";
        const salvaged = parseTruncated();
        if (salvaged !== null) return salvaged;
        throw truncatedProfileError(finishKind, textLength, excerpt, false);
      }

      // finish.kind=stop 但文本明显未收尾（个别 provider 会先 stop 再截断）：同样抢救一次。
      if (isProfileTextUnfinished(text)) {
        trace.stage = "parse";
        const salvaged = parseTruncated();
        if (salvaged !== null) return salvaged;
      }

      if (text.trim() === "") throw attachFinish(new ProfileError(PROFILE_CODES.empty, "模型输出为空", "finish"));
      trace.stage = "parse";
      let parsed;
      try {
        parsed = parseProfileText(text);
      } catch (error) {
        throw tagStage(attachFinish(error), "parse", trace);
      }
      trace.stage = "finish";
      return {
        ...parsed,
        usage,
        model: { provider: route.provider, model: route.model },
        route,
        precheck: trace.precheck,
        truncated: false,
        diagnostic: null,
      };
    })();

    try {
      return await withAbort(work, signal, this.config.timeoutMs);
    } catch (error) {
      throw tagStage(error, trace.stage, trace);
    }
  }
}
