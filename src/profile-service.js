/**
 * AI 用户画像的宿主编排：可选 llm 服务、白名单 payload、磁盘缓存、超时与降级。
 *
 * 铁律：
 *   · 默认关闭（enabled=false）：不探测 llm、不生成、零服务调用；
 *   · llm 用 ctx.get("llm") 可选获取（不写进 inject，缺失时插件照常加载）；
 *   · 只发送 buildProfilePayload() 的白名单聚合统计，绝不发对话正文 / 标题 / 路径；
 *   · 任何失败（服务缺失 / 未登录 / 超时 / 非 stop / 解析失败）都降级为本地规则，
 *     路由永远返回 200，不把异常抛给 UI；
 *   · 缓存按统计指纹 + 语言落盘（与索引同目录，原子写），指纹相同不重复调用模型。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  buildProfilePayload,
  localProfile,
  parseProfileText,
  profileFingerprint,
} from "./ai-profile.js";

/** 默认配置（profile 的 cordis.patch.yml 可覆盖 aiProfile）。 */
export const AI_PROFILE_DEFAULTS = Object.freeze({
  enabled: false,
  provider: "",
  model: "",
  maxTokens: 900,
  timeoutMs: 60000,
  cacheTtlMs: 86400000,
});

/** 缓存文件格式版本（改字段时 +1；不影响索引 INDEX_VERSION）。 */
const PROFILE_CACHE_VERSION = 1;

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

/** 带稳定 code 的画像错误（路由只认 code，不向 UI 抛文本）。 */
export class ProfileError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProfileError";
    this.code = code;
  }
}

/** 配置归一化：数值兜底、字符串裁剪；未知字段忽略。 */
export function normalizeAiProfile(config = {}) {
  const raw = config !== null && typeof config === "object" ? config : {};
  const positive = (value, fallback) => {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const ttl = Number(raw.cacheTtlMs);
  return {
    enabled: raw.enabled === true,
    provider: typeof raw.provider === "string" ? raw.provider.trim() : "",
    model: typeof raw.model === "string" ? raw.model.trim() : "",
    maxTokens: Math.max(1, Math.round(positive(raw.maxTokens, AI_PROFILE_DEFAULTS.maxTokens))),
    timeoutMs: Math.max(1, Math.round(positive(raw.timeoutMs, AI_PROFILE_DEFAULTS.timeoutMs))),
    cacheTtlMs: Number.isFinite(ttl) && ttl >= 0 ? Math.round(ttl) : AI_PROFILE_DEFAULTS.cacheTtlMs,
  };
}

/** Token usage 归一化（只保留 input/output/total）。 */
function normalizeUsage(usage) {
  const input = Math.max(0, Math.round(Number(usage?.inputTokens) || 0));
  const output = Math.max(0, Math.round(Number(usage?.outputTokens) || 0));
  return { input, output, total: input + output };
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

/** 系统提示：只根据聚合统计，输出严格 JSON（不指定 reasoningEffort）。 */
function systemPrompt(lang) {
  if (lang === "en") {
    return [
      "You are a work-style profiler. Use only the supplied aggregate statistics.",
      "Do not infer conversation content, titles, file paths, or any fact not provided; do not invent project details.",
      'Output one JSON object: {"traits": ["..."], "advice": "..."}.',
      "traits: 3-5 items covering work rhythm, task preference, tech-stack leaning, and collaboration.",
      "advice: exactly 1 item. Each line must be at most 40 characters.",
      "Write in English. Output nothing except the JSON.",
    ].join("\n");
  }
  return [
    "你是用户工作方式的画像分析师，只能依据给定的聚合统计生成画像。",
    "不得臆测对话内容、标题、文件路径或任何未给出的事实；不要编造具体项目细节。",
    "输出必须是单个 JSON 对象：{\"traits\": [\"...\"], \"advice\": \"...\"}。",
    "traits 3-5 条，覆盖工作节奏、任务偏好、技术栈倾向、协作模式；",
    "advice 恰好 1 条。每条不超过 40 个字符。",
    "用简体中文输出；不要输出 JSON 之外的任何文字。",
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
   * 解析调用路由：优先插件配置 provider/model，否则宿主默认模型。
   * 调用前用 listProviders / listModels 预检；空列表即未登录 / 无 key。
   * @returns { provider, model }。
   */
  async resolveRoute(llm, providers) {
    const provider = this.config.provider;
    const model = this.config.model;
    if (provider !== "" && model !== "") {
      if (!providers.includes(provider)) {
        throw new ProfileError(PROFILE_CODES.missingCredential, "配置的 provider 未注册：" + provider);
      }
      const models = await llm.listModels(provider);
      if (!Array.isArray(models) || models.length === 0) {
        throw new ProfileError(PROFILE_CODES.signIn, "provider " + provider + " 没有可用模型（未登录或无 key）");
      }
      return { provider, model };
    }

    const selection = this.defaultSelection();
    if (selection === undefined || typeof selection.provider !== "string" || typeof selection.model !== "string" || selection.provider === "" || selection.model === "") {
      throw new ProfileError(PROFILE_CODES.signIn, "没有默认模型选择（未登录）");
    }
    if (!providers.includes(selection.provider)) {
      throw new ProfileError(PROFILE_CODES.missingCredential, "默认 provider 未注册：" + selection.provider);
    }
    const models = await llm.listModels(selection.provider);
    if (!Array.isArray(models) || models.length === 0) {
      throw new ProfileError(PROFILE_CODES.signIn, "provider " + selection.provider + " 没有可用模型（未登录或无 key）");
    }
    return { provider: selection.provider, model: selection.model };
  }

  /** 状态预检（probe）：不调用模型，只回答 enabled / 是否可生成。 */
  async status() {
    if (!this.config.enabled) return { enabled: false, code: PROFILE_CODES.disabled };
    const llm = this.service();
    if (llm === undefined) {
      return { enabled: true, available: false, signedIn: false, code: PROFILE_CODES.unavailable, provider: null, model: null };
    }
    try {
      const providers = await this.providerIds(llm);
      if (providers.length === 0) {
        return { enabled: true, available: false, signedIn: false, code: PROFILE_CODES.signIn, provider: null, model: null };
      }
      const route = await this.resolveRoute(llm, providers);
      return { enabled: true, available: true, signedIn: true, code: null, provider: route.provider, model: route.model };
    } catch (error) {
      return { enabled: true, available: false, signedIn: false, code: profileCodeOf(error), provider: null, model: null };
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
   * @returns 200 JSON 体（任何失败都不抛）。
   */
  async handle({ query, lang = "zh", force = false, probe = false } = {}) {
    if (!this.config.enabled) return { enabled: false, code: PROFILE_CODES.disabled };
    if (probe) return this.status();

    const snapshot = await this.index.snapshot(query);
    const payload = buildProfilePayload(snapshot);
    const fingerprint = profileFingerprint(payload);

    if (!force) {
      const cached = await this.readCache(lang, fingerprint);
      if (cached !== null) return { enabled: true, ...cached, cached: true };
    }

    const key = lang + ":" + fingerprint;
    if (!force && this.inflight.has(key)) return this.inflight.get(key);
    const run = this.generate({ payload, fingerprint, lang });
    if (!force) this.inflight.set(key, run);
    try {
      return await run;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 生成一次：模型失败一律回落到本地规则（source=local + code）。 */
  async generate({ payload, fingerprint, lang }) {
    const generatedAt = Date.now();
    let result;
    try {
      const generated = await this.callModel(payload, lang);
      result = { source: "llm", code: null, traits: generated.traits, advice: generated.advice, usage: generated.usage, model: generated.model };
    } catch (error) {
      const code = profileCodeOf(error);
      if (this.ctx?.logger?.warn !== undefined) {
        this.ctx.logger.warn("[workload-report] AI 画像降级为本地规则：" + code + " — " + String(error?.message ?? error));
      }
      result = { source: "local", code, ...localProfile(payload, lang), usage: { input: 0, output: 0, total: 0 }, model: null };
    }
    const profile = { ...result, generatedAt: Date.now(), fingerprint, cached: false };
    await this.writeCache(lang, fingerprint, profile);
    return { enabled: true, ...profile };
  }

  /** 真正调用 llm：prepareCall → stream，累积 text-delta / usage / finish。 */
  async callModel(payload, lang) {
    // 超时覆盖整个调用链：预检（listProviders / listModels）→ prepareCall → stream。
    const signal = AbortSignal.timeout(this.config.timeoutMs);
    const work = (async () => {
      const llm = this.service();
      if (llm === undefined) throw new ProfileError(PROFILE_CODES.unavailable, "当前 DSH 没有 llm 服务");
      const providers = await this.providerIds(llm);
      if (providers.length === 0) throw new ProfileError(PROFILE_CODES.signIn, "没有已登录的模型 provider");
      const route = await this.resolveRoute(llm, providers);
      this.calls += 1;
      const call = await llm.prepareCall(
        { provider: route.provider, model: route.model, temperature: 0.4, maxTokens: this.config.maxTokens },
        signal,
      );
      const options = {
        ...call.config,
        system: systemPrompt(lang),
        messages: [{ role: "user", content: [{ type: "text", text: JSON.stringify(payload) }] }],
        signal,
      };
      let text = "";
      let usage = { input: 0, output: 0, total: 0 };
      let finish = null;
      for await (const chunk of call.stream(options)) {
        if (chunk?.type === "text-delta") text += String(chunk.text ?? "");
        else if (chunk?.type === "usage") usage = normalizeUsage(chunk.usage);
        else if (chunk?.type === "finish") finish = chunk.reason;
      }
      if (finish === null || finish?.kind !== "stop") {
        const failureCode = finish?.failure?.code;
        if (failureCode === PROFILE_CODES.signIn || failureCode === PROFILE_CODES.missingCredential) {
          throw new ProfileError(failureCode, "模型调用未完成：" + finish.kind);
        }
        throw new ProfileError(PROFILE_CODES.notStopped, "模型未正常结束：" + String(finish?.kind ?? "unknown"));
      }
      if (text.trim() === "") throw new ProfileError(PROFILE_CODES.empty, "模型输出为空");
      const parsed = parseProfileText(text);
      return { ...parsed, usage, model: { provider: route.provider, model: route.model } };
    })();

    return withAbort(work, signal, this.config.timeoutMs);
  }
}
