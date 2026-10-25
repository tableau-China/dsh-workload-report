/**
 * 多设备同步（docs/sync.md 的实现）。
 *
 * 设计原则（与插件其余部分一致）：
 *   · **默认零配置、零外发**：不配置 `sync.enabled` 时本模块**不构造任何网络请求**，
 *     行为与不含该功能的版本完全一致（离线断言覆盖，见 test/verify.mjs）。
 *   · **只同步统计行**：载荷是逐会话汇总行，不含对话内容、提示词、工具参数、附件。
 *   · **天然无冲突**：每台机器只写 path 模板指向的自己的对象/文件，key 不重叠，
 *     不需要任何三方合并；读端按 `row.id` 合并、`updatedAt` 大者胜，重复拉取不重复计数。
 *   · **失败隔离**：单个来源读失败只让该来源标记 stale，本机数据与其它来源不受影响。
 *   · **本机优先**：同一会话 id 在本机与远端都有时保留本机行（本机投影最准）。
 *
 * 传输层是可插拔的，四种实现共用同一组方法：
 *   list(prefix) / read(key) / write(key, text) / probe()
 *     · cos    —— 腾讯云对象存储（TC3-HMAC-SHA256 手写签名，零依赖）
 *     · github —— GitHub Contents API
 *     · gitea  —— 自建 Gitea（同 Contents API）
 *     · local  —— 共享目录（iCloud / Syncthing / NAS），零凭据
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

import { cosSign, cosUrlEncode } from "./cos-sign.js";
import { CredentialVault, fieldsOf, resolveField } from "./credential-vault.js";

/** 载荷 schema 版本：与 docs/sync.md §二 对应，改了形状就要升版。 */
export const PAYLOAD_SCHEMA = 1;
export const PAYLOAD_KIND = "dsh-workload-report/rows";

/** 支持的传输类型。 */
export const TRANSPORTS = ["cos", "github", "gitea", "local"];

/** 同步默认配置（全部关闭；enabled=false 时零外发）。 */
export const SYNC_DEFAULTS = {
  enabled: false,
  /** push+pull | push | pull。 */
  mode: "push+pull",
  /** cos | github | gitea | local。 */
  transport: "github",
  /** 仓库内 / 桶内的 key 前缀模板；{machineId} 每台机器不同 → key 不重叠。 */
  path: "machines/{machineId}.json",
  /** 本机展示名；缺省用 hostname 去掉 .local。 */
  machineName: "",
  /** 推送周期（毫秒）。 */
  pushEveryMs: 6 * 3600 * 1000,
  /** 拉取周期（毫秒）。 */
  pullEveryMs: 30 * 60 * 1000,
  /** 单次网络请求超时。 */
  timeoutMs: 15000,
  /** 来源多久没拉到算「过期」（只用于诊断展示，不自动丢弃数据）。 */
  staleAfterMs: 24 * 3600 * 1000,
  /** 抹掉 cwd 绝对路径（用别名或短哈希代替），发布到共享通道时建议开。 */
  redactPaths: false,
  /** 传输：Contents API（github / gitea）。 */
  github: {
    /** 自建 Gitea 填 origin，例如 https://git.example.com。 */
    baseUrl: "https://api.github.com",
    /** owner/name。 */
    repo: "",
    /** 分支。 */
    branch: "main",
    /** 凭据文件（0600）；也可用环境变量 WR_SYNC_TOKEN / GITHUB_TOKEN。 */
    tokenFile: "",
    /** 内联 token（不推荐：会明文落进 profile 配置）。 */
    token: "",
  },
  /** 传输：腾讯云 COS。 */
  cos: {
    /** 桶名，必须带 APPID 后缀，例如 my-sync-1250000000。 */
    bucket: "",
    /** 地域，例如 ap-guangzhou。 */
    region: "",
    /** 凭据文件（0600）。 */
    secretIdFile: "",
    secretKeyFile: "",
    /** 内联凭据（不推荐）。 */
    secretId: "",
    secretKey: "",
  },
  /** 传输：共享目录。 */
  local: {
    /** 目录路径；放 iCloud / Syncthing / NAS 的同步目录即可。 */
    dir: "",
  },
};

function reasonOf(error) {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** DSH home：环境变量优先，其次 ~/.dsh。 */
export function defaultHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === "string" && env.trim().length > 0) return env.trim();
  return join(homedir(), ".dsh");
}

/**
 * 稳定机器 id：优先 DSH 自带的 <DSH_HOME>/.anonymous-user-id（每台安装一个随机 UUID，
 * 不含机器或账户信息），读不到时退回 sha1(hostname + home)。
 */
export async function machineIdOf(dshHome = defaultHome()) {
  try {
    const text = await readFile(join(dshHome, ".anonymous-user-id"), "utf8");
    const trimmed = text.trim();
    if (trimmed.length > 0) return trimmed;
  } catch {
    /* 没有就用兜底 */
  }
  return createHash("sha1").update(`${hostname()}|${dshHome}`).digest("hex");
}

/** 展示名：配置优先，否则 hostname 去掉 .local 后缀。 */
export function machineNameOf(configured) {
  if (typeof configured === "string" && configured.trim().length > 0) return configured.trim();
  return hostname().replace(/\.local$/, "");
}

/** 解码 URI 路径；非法编码时原样返回（不让签名环节抛错）。 */
function safeDecode(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** 读凭据文件（0600）。返回 null 表示没配。 */
async function readSecretFile(path) {
  if (typeof path !== "string" || path.trim().length === 0) return null;
  const resolved = path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
  try {
    const text = await readFile(resolved, "utf8");
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

/** 凭据解析：文件 > 环境变量 > 内联。返回 null 表示未配置。 */
async function resolveSecret({ file, envKeys = [], inline }) {
  const fromFile = await readSecretFile(file);
  if (fromFile !== null) return fromFile;
  for (const key of envKeys) {
    const value = process.env[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  if (typeof inline === "string" && inline.trim().length > 0) return inline.trim();
  return null;
}

// —— 传输层 ————————————————————————————————————————————

/**
 * 腾讯云 COS 传输。
 *
 * 签名用 COS 自有的 **q-sign-algorithm=sha1**（不是通用云 API 的 TC3-HMAC-SHA256——
 * 后者对 cos.<region>.myqcloud.com 会一律返回 403 AccessDenied）。
 * 手写实现以避免引入腾讯云 SDK（插件保持 0 runtime dependencies）。
 * 算法与官方测试向量逐段对齐：SignKey、HttpHeaders、HttpString 的 SHA1 全部命中。
 *
 * 参考：https://cloud.tencent.com/document/product/436/7778
 */
export class CosTransport {
  constructor(config, { timeoutMs = 15000, pluginVersion = null, vault = null } = {}) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.pluginVersion = pluginVersion;
    this.vault = vault;
  }

  get configured() {
    return Boolean(this.config?.bucket && this.config?.region);
  }

  get host() {
    return `${this.config.bucket}.cos.${this.config.region}.myqcloud.com`;
  }

  /**
   * 取 COS 凭据：加密凭据库 > 文件 > 环境变量 > 内联。
   * @returns {Promise<{ secretId, secretKey, sources } | null>} 缺任一项返回 null。
   */
  async credentials() {
    const id = await resolveField({
      vault: this.vault, transport: "cos", id: "secret-id",
      fileValue: await readSecretFile(this.config.secretIdFile),
      envKeys: ["WR_COS_SECRET_ID", "COS_SECRET_ID", "TENCENTCLOUD_SECRET_ID"],
      inline: this.config.secretId,
    });
    const key = await resolveField({
      vault: this.vault, transport: "cos", id: "secret-key",
      fileValue: await readSecretFile(this.config.secretKeyFile),
      envKeys: ["WR_COS_SECRET_KEY", "COS_SECRET_KEY", "TENCENTCLOUD_SECRET_KEY"],
      inline: this.config.secretKey,
    });
    if (id === null || key === null) return null;
    return { secretId: id.value, secretKey: key.value, sources: { secretId: id.source, secretKey: key.source } };
  }

  /**
   * 发一个已签名的 COS 请求。
   * @param method - HTTP 方法。
   * @param uriPath - 已编码的请求路径（"/" 或 "/key"）。
   * @param options - { query: 对象, headers: 对象, body: 字符串 }。
   */
  async request(method, uriPath, { query = {}, headers = {}, body = "" } = {}) {
    const secret = await this.credentials();
    if (secret === null) throw new Error("COS 凭据缺失（secretId/secretKey）");
    // COS 规范：HttpString 里的 UriPathname 是**解码后**的路径；
    // 实际发请求时用编码后的路径。两者不同，混用会导致 SignatureDoesNotMatch。
    const decodedPath = safeDecode(uriPath);
    const signed = cosSign({
      method,
      uriPath: decodedPath,
      query,
      headers: { host: this.host, ...headers },
      secretId: secret.secretId,
      secretKey: secret.secretKey,
    });
    const encodedQuery = Object.entries(query)
      .map(([key, value]) => `${cosUrlEncode(key)}=${cosUrlEncode(value)}`)
      .join("&");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`https://${this.host}${uriPath}${encodedQuery ? `?${encodedQuery}` : ""}`, {
        method,
        headers: {
          host: this.host,
          ...headers,
          Authorization: signed.authorization,
          ...(body ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
        body: method === "GET" || method === "HEAD" ? undefined : body,
        signal: controller.signal,
      });
      const text = await response.text();
      return { status: response.status, text, ok: response.ok };
    } finally {
      clearTimeout(timer);
    }
  }

  /** COS 的 key 需要逐段 UrlEncode（保留分隔用的 "/"）。 */
  static encodeKey(key) {
    return `/${String(key).split("/").map(cosUrlEncode).join("/")}`;
  }

  /** 从 COS XML 错误体里抽 <Code>，用于把 403 翻成人话。 */
  static errorCode(text) {
    const match = /<Code>([^<]+)<\/Code>/.exec(text ?? "");
    return match === null ? null : match[1];
  }

  async read(key) {
    const result = await this.request("GET", CosTransport.encodeKey(key));
    if (result.status === 404) return null;
    if (!result.ok) throw new Error(`COS GET ${key} → ${result.status} ${CosTransport.errorCode(result.text) ?? result.text.slice(0, 120)}`);
    return result.text;
  }

  async write(key, content) {
    const result = await this.request("PUT", CosTransport.encodeKey(key), {
      headers: { "content-type": "application/json" },
      body: content,
    });
    if (!result.ok) throw new Error(`COS PUT ${key} → ${result.status} ${CosTransport.errorCode(result.text) ?? result.text.slice(0, 120)}`);
    return true;
  }

  /** 列前缀下的对象 key。COS 用 ListObjects（v1）+ prefix。 */
  async list(prefix) {
    const query = { "max-keys": "1000" };
    if (prefix) query.prefix = prefix;
    const result = await this.request("GET", "/", { query });
    if (!result.ok) {
      throw new Error(`COS ListObjects → ${result.status} ${CosTransport.errorCode(result.text) ?? result.text.slice(0, 120)}`);
    }
    return [...result.text.matchAll(/<Key>([^<]+)<\/Key>/g)].map((match) => match[1]);
  }

  /** 连通性自检：能读自己的 key 就算通（不写脏数据）。返回诊断信息。 */
  async probe() {
    if (!this.configured) return { ok: false, code: "NOT_CONFIGURED", message: "未配置 cos.bucket / cos.region" };
    const secret = await this.credentials();
    if (secret === null) return { ok: false, code: "NO_CREDENTIALS", message: "未找到 COS 凭据（secretId/secretKey 文件或环境变量）" };
    try {
      const listed = await this.list(this.config.keyPrefix ?? "");
      return { ok: true, code: "OK", message: `可列对象（${listed.length} 个）`, objects: listed.length };
    } catch (error) {
      const message = reasonOf(error);
      const code = /→ 403/.test(message) ? "FORBIDDEN" : /→ 404/.test(message) ? "NOT_FOUND" : "ERROR";
      return { ok: false, code, message };
    }
  }
}

/** GitHub / Gitea 共用的 Contents API 传输。 */
export class ContentsTransport {
  constructor(config, { timeoutMs = 15000, vault = null } = {}) {
    this.config = config;
    this.timeoutMs = timeoutMs;
    this.vault = vault;
  }

  get configured() {
    return Boolean(this.config?.repo);
  }

  get api() {
    const origin = (this.config.baseUrl || "https://api.github.com").replace(/\/+$/, "");
    // github.com 的 API 前缀是 /api/v1 之外的 api.github.com；自建 Gitea 需 /api/v1
    return /api\.github\.com$/.test(origin) ? origin : `${origin}/api/v1`;
  }

  /** 取 access token：加密凭据库 > 文件 > 环境变量 > 内联。 */
  async credentials() {
    const field = await resolveField({
      vault: this.vault,
      transport: this.config.transportKind ?? "github",
      id: "token",
      fileValue: await readSecretFile(this.config.tokenFile),
      envKeys: ["WR_SYNC_TOKEN", "GITHUB_TOKEN"],
      inline: this.config.token,
    });
    return field === null ? null : field.value;
  }

  async request(path, { method = "GET", body } = {}) {
    const token = await this.credentials();
    if (token === null) throw new Error("同步凭据缺失（tokenFile 或 WR_SYNC_TOKEN）");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(`${this.api}${path}`, {
        method,
        headers: {
          Authorization: `token ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${method} ${path} → ${response.status} ${text.slice(0, 160)}`);
      try { return JSON.parse(text); } catch { return text; }
    } finally {
      clearTimeout(timer);
    }
  }

  async read(key) {
    const branch = this.config.branch || "main";
    const json = await this.request(`/repos/${this.config.repo}/contents/${key}?ref=${encodeURIComponent(branch)}`);
    if (json === null) return null;
    if (typeof json === "string") return json;
    if (typeof json?.content === "string") return Buffer.from(json.content, "base64").toString("utf8");
    throw new Error(`${key}: 无法解析 contents 响应`);
  }

  async write(key, content) {
    const branch = this.config.branch || "main";
    const existing = await this.request(`/repos/${this.config.repo}/contents/${key}?ref=${encodeURIComponent(branch)}`);
    const body = {
      content: Buffer.from(content, "utf8").toString("base64"),
      message: `workload: ${key}`,
      branch,
    };
    if (existing?.sha) body.sha = existing.sha;
    const result = await this.request(`/repos/${this.config.repo}/contents/${key}`, { method: "PUT", body });
    if (result?.commit === undefined && result?.content === undefined) throw new Error(`写入 ${key} 失败`);
    return true;
  }

  async list(prefix) {
    const branch = this.config.branch || "main";
    // Contents API 只能列目录，不能按前缀过滤 → prefix 取末级目录
    const dir = (prefix ?? "").replace(/\/[^/]*$/, "").replace(/\/+$/, "");
    const url = dir
      ? `/repos/${this.config.repo}/contents/${dir}?ref=${encodeURIComponent(branch)}`
      : `/repos/${this.config.repo}/contents/?ref=${encodeURIComponent(branch)}`;
    const json = await this.request(url);
    if (!Array.isArray(json)) return [];
    return json.filter((item) => item?.type === "file").map((item) => (dir ? `${dir}/${item.name}` : item.name));
  }

  async probe() {
    if (!this.configured) return { ok: false, code: "NOT_CONFIGURED", message: "未配置 github.repo" };
    const token = await this.credentials();
    if (token === null) return { ok: false, code: "NO_CREDENTIALS", message: "未找到同步凭据（tokenFile 或 WR_SYNC_TOKEN）" };
    try {
      const files = await this.list(this.config.keyPrefix ?? "");
      return { ok: true, code: "OK", message: `可访问（${files.length} 个文件）`, objects: files.length };
    } catch (error) {
      const message = reasonOf(error);
      const code = /→ 401/.test(message) ? "UNAUTHORIZED" : /→ 403/.test(message) ? "FORBIDDEN" : /→ 404/.test(message) ? "NOT_FOUND" : "ERROR";
      return { ok: false, code, message };
    }
  }
}

/** 共享目录传输：不需要任何凭据，配合 iCloud / Syncthing / NAS 使用。 */
export class LocalTransport {
  constructor(config) {
    this.config = config;
  }

  get configured() {
    return typeof this.config?.dir === "string" && this.config.dir.trim().length > 0;
  }

  resolve(key) {
    const base = this.config.dir.startsWith("~") ? join(homedir(), this.config.dir.slice(1)) : this.config.dir;
    return join(base, key);
  }

  async read(key) {
    try {
      return await readFile(this.resolve(key), "utf8");
    } catch {
      return null;
    }
  }

  async write(key, content) {
    const path = this.resolve(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
    return true;
  }

  async list(prefix) {
    const dirPrefix = (prefix ?? "").replace(/\/[^/]*$/, "");
    const dir = this.resolve(dirPrefix);
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map((entry) => (dirPrefix ? `${dirPrefix}/${entry.name}` : entry.name));
    } catch {
      return [];
    }
  }

  async probe() {
    if (!this.configured) return { ok: false, code: "NOT_CONFIGURED", message: "未配置 local.dir" };
    try {
      const files = await this.list(this.config.keyPrefix ?? "");
      return { ok: true, code: "OK", message: `目录可读（${files.length} 个文件）`, objects: files.length };
    } catch (error) {
      return { ok: false, code: "ERROR", message: reasonOf(error) };
    }
  }
}

/** 按配置构造传输实例。 */
export function createTransport(config, { vault = null } = {}) {
  const timeoutMs = Number(config.timeoutMs) || 15000;
  switch (config.transport) {
    case "cos": return new CosTransport(config.cos ?? {}, { timeoutMs, vault });
    case "local": return new LocalTransport(config.local ?? {});
    case "gitea":
    case "github": return new ContentsTransport({ ...(config.github ?? {}), transportKind: config.transport }, { timeoutMs, vault });
    default: return new ContentsTransport({ ...(config.github ?? {}), transportKind: "github" }, { timeoutMs, vault });
  }
}

// —— 载荷 ————————————————————————————————————————————————

/** cwd 抹权：能配别名就显示别名，否则用「目录名#短哈希」（不可逆，不暴露完整路径）。 */
function redactCwd(cwd, aliases) {
  if (typeof cwd !== "string" || cwd.length === 0) return "";
  for (const [from, to] of Object.entries(aliases ?? {})) {
    if (cwd.includes(from)) return to;
  }
  const base = cwd.split("/").filter(Boolean).pop() ?? "";
  return `${base}#${createHash("sha1").update(cwd).digest("hex").slice(0, 6)}`;
}

/**
 * 把本地索引行整理成传输载荷。
 * 行结构与插件内部 rows 一致，因此合并端无需转换（docs/sync.md §二）。
 */
export function buildPayload(rows, machine, { redactPaths = false, aliases = {} } = {}) {
  const list = [...rows.values()].map((row) => ({
    id: row.id,
    cwd: redactPaths ? redactCwd(row.cwd, aliases) : (row.cwd ?? ""),
    createdAt: row.createdAt,
    isSubagent: row.isSubagent === true,
    isSeeded: row.isSeeded === true,
    agentPreset: row.agentPreset ?? null,
    title: row.title ?? "",
    turns: row.turns ?? 0,
    steps: row.steps ?? 0,
    llmMs: row.llmMs ?? 0,
    toolMs: row.toolMs ?? 0,
    waitMs: row.waitMs ?? 0,
    decodeTokens: row.decodeTokens ?? 0,
    tokens: row.tokens ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    lastPromptAt: row.lastPromptAt ?? null,
    asOfSeq: row.asOfSeq ?? null,
    // 模型维度随行同步，对端也能看到时刻 / 模型分析
    models: row.models ?? null,
    hours: Array.isArray(row.hours) ? row.hours : null,
    hoursSource: row.hoursSource ?? null,
    hourTokens: Array.isArray(row.hourTokens) ? row.hourTokens : null,
    hourTokensSource: row.hourTokensSource ?? null,
    hourHumanMsgs: Array.isArray(row.hourHumanMsgs) ? row.hourHumanMsgs : null,
    updatedAt: Date.now(),
  }));
  return {
    schema: PAYLOAD_SCHEMA,
    kind: PAYLOAD_KIND,
    generatedAt: Date.now(),
    machine: { ...machine, plugin: machine.plugin ?? null },
    totals: {
      sessions: list.length,
      activeMs: list.reduce((sum, row) => sum + (row.llmMs ?? 0) + (row.toolMs ?? 0), 0),
    },
    rows: list,
  };
}

/** 校验载荷；不合法抛错，调用方据此跳过该来源。 */
export function validatePayload(payload, source) {
  if (payload?.schema !== PAYLOAD_SCHEMA || payload?.kind !== PAYLOAD_KIND || !Array.isArray(payload.rows)) {
    throw new Error(`${source}: 载荷格式不符（schema/kind/rows）`);
  }
  if (!payload.machine?.id) throw new Error(`${source}: 缺少 machine.id`);
  return payload;
}

// —— 同步服务 ————————————————————————————————————————————

/**
 * 同步服务：推、拉、合并、设备筛选、来源诊断。
 * 拉到的来源只放内存（进程重启后按 pullEveryMs 重新拉一次即可）。
 */
export class SyncService {
  /**
   * @param ctx - Cordis ctx（只用 logger）。
   * @param config - 合并后的 sync 配置。
   * @param options - { home, pluginVersion }。
   */
  constructor(ctx, config, { home = defaultHome(), pluginVersion = null } = {}) {
    this.ctx = ctx;
    /** 加密凭据仓库（DSH 自带的 credentials 服务；不存在时自动降级到文件/环境变量）。 */
    this.vault = new CredentialVault(ctx);
    this.config = { ...SYNC_DEFAULTS, ...(config ?? {}) };
    for (const key of ["github", "cos", "local"]) {
      if (this.config[key] !== undefined && this.config[key] !== null) {
        this.config[key] = { ...SYNC_DEFAULTS[key], ...this.config[key] };
      }
    }
    this.home = home;
    this.pluginVersion = pluginVersion;
    this.identity = null;
    /** key(machine.id) → { payload, fetchedAt, key } */
    this.sources = new Map();
    this.stats = {
      lastPushAt: 0, lastPushError: null, lastPushRows: 0,
      lastPullAt: 0, lastPullError: null, lastPullFetched: 0,
      pushing: false, pulling: false,
      lastProbe: null,
    };
    this.pushingPromise = null;
    this.pullingPromise = null;
  }

  get enabled() {
    return this.config.enabled === true;
  }

  get canPush() {
    return this.enabled && (this.config.mode === "push+pull" || this.config.mode === "push");
  }

  get canPull() {
    return this.enabled && (this.config.mode === "push+pull" || this.config.mode === "pull");
  }

  transport() {
    return createTransport(this.config, { vault: this.vault });
  }

  /**
   * 各凭据字段的状态（不含值），供 GUI 渲染表单与「已配置」标记。
   * @returns {Promise<Array<{ id, label, secret, configured, writable, source }>>}
   */
  async credentialStatus() {
    const transport = this.config.transport;
    const files = transport === "cos"
      ? { "secret-id": (await readSecretFile(this.config.cos?.secretIdFile)) !== null, "secret-key": (await readSecretFile(this.config.cos?.secretKeyFile)) !== null }
      : { token: (await readSecretFile(this.config.github?.tokenFile)) !== null };
    return this.vault.status(transport, files);
  }

  /**
   * 保存凭据到加密凭据库。值只在此函数内出现，绝不进日志或响应。
   * @param values - { 'secret-id': '…', 'secret-key': '…' } 或 { token: '…' }。
   */
  async saveCredentials(values) {
    const transport = this.config.transport;
    if (transport === "local") throw new Error("共享目录传输不需要凭据");
    const allowed = new Set(fieldsOf(transport).map((field) => field.id));
    const saved = [];
    for (const [id, value] of Object.entries(values ?? {})) {
      if (!allowed.has(id)) continue;
      const text = typeof value === "string" ? value.trim() : "";
      if (text.length === 0) continue; // 空值不覆盖已存值
      await this.vault.write(transport, id, text);
      saved.push(id);
    }
    if (saved.length === 0) throw new Error("没有可保存的凭据字段");
    this.ctx?.logger?.info?.(`[workload-report] 已保存 ${saved.length} 项同步凭据到加密凭据库（不记录内容）`);
    return { saved };
  }

  /** 清空本插件的同步凭据（加密库中的记录）。 */
  async clearCredentials() {
    const transport = this.config.transport;
    if (transport === "local") return { cleared: [] };
    const cleared = [];
    for (const field of fieldsOf(transport)) {
      await this.vault.delete(transport, field.id);
      cleared.push(field.id);
    }
    return { cleared };
  }

  /** 机器身份：id 稳定、name 可变，两者都进载荷。 */
  async identify() {
    if (this.identity) return this.identity;
    this.identity = {
      id: await machineIdOf(this.home),
      name: machineNameOf(this.config.machineName),
      host: hostname(),
      platform: process.platform,
      arch: process.arch,
      plugin: this.pluginVersion,
    };
    this.config.keyPrefix = (this.config.path ?? "machines/{machineId}.json").replace(/\{machineId\}/g, "").replace(/\/[^/]*$/, "");
    return this.identity;
  }

  /** 本机对象 key（每台机器只写自己这一个 → 天然无冲突）。 */
  async localKey() {
    const { id, name } = await this.identify();
    return (this.config.path || "machines/{machineId}.json")
      .replace(/\{machineId\}/g, id)
      .replace(/\{machineName\}/g, encodeURIComponent(name));
  }

  /** 推送本机索引行。 */
  async push(rows) {
    if (!this.canPush) return { skipped: true };
    if (this.pushingPromise !== null) return this.pushingPromise;
    this.stats.pushing = true;
    this.pushingPromise = (async () => {
      try {
        const machine = await this.identify();
        const payload = buildPayload(rows, machine, {
          redactPaths: this.config.redactPaths === true,
          aliases: this.config.aliases ?? {},
        });
        const key = await this.localKey();
        await this.transport().write(key, JSON.stringify(payload));
        this.stats.lastPushAt = Date.now();
        this.stats.lastPushRows = payload.rows.length;
        this.stats.lastPushError = null;
        this.ctx?.logger?.info?.(`[workload-report] 已同步 ${payload.rows.length} 个会话 → ${key}`);
        return { ok: true, rows: payload.rows.length, key };
      } catch (error) {
        this.stats.lastPushError = reasonOf(error);
        this.ctx?.logger?.warn?.(`[workload-report] 同步推送失败: ${this.stats.lastPushError}`);
        return { ok: false, error: this.stats.lastPushError };
      } finally {
        this.stats.pushing = false;
        this.pushingPromise = null;
      }
    })();
    return this.pushingPromise;
  }

  /** 拉取其他设备的载荷。 */
  async pull() {
    if (!this.canPull) return { skipped: true };
    if (this.pullingPromise !== null) return this.pullingPromise;
    this.stats.pulling = true;
    this.pullingPromise = (async () => {
      try {
        const self = await this.identify();
        const transport = this.transport();
        const prefix = (this.config.path ?? "").replace(/\{machineId\}/g, "").replace(/\/[^/]*$/, "");
        const keys = (await transport.list(prefix)).filter((key) => key.endsWith(".json"));
        const seen = new Set();
        let fetched = 0;
        for (const key of keys) {
          let text = null;
          try {
            text = await transport.read(key);
          } catch (error) {
            this.ctx?.logger?.warn?.(`[workload-report] 拉取 ${key} 失败: ${reasonOf(error)}`);
            continue;
          }
          if (text === null) continue;
          let payload;
          try {
            payload = validatePayload(JSON.parse(text), key);
          } catch (error) {
            this.ctx?.logger?.warn?.(`[workload-report] 跳过 ${key}: ${reasonOf(error)}`);
            continue;
          }
          if (payload.machine.id === self.id) continue; // 自己的对象跳过
          this.sources.set(payload.machine.id, { payload, fetchedAt: Date.now(), key });
          seen.add(payload.machine.id);
          fetched += 1;
        }
        // 远端已删除的来源同步移除，避免残留
        for (const existing of [...this.sources.keys()]) {
          if (!seen.has(existing)) this.sources.delete(existing);
        }
        this.stats.lastPullAt = Date.now();
        this.stats.lastPullFetched = fetched;
        this.stats.lastPullError = null;
        this.ctx?.logger?.info?.(`[workload-report] 拉到 ${fetched} 个其他设备（共 ${this.sources.size} 个来源）`);
        return { ok: true, fetched, total: this.sources.size };
      } catch (error) {
        this.stats.lastPullError = reasonOf(error);
        this.ctx?.logger?.warn?.(`[workload-report] 同步拉取失败: ${this.stats.lastPullError}`);
        return { ok: false, error: this.stats.lastPullError };
      } finally {
        this.stats.pulling = false;
        this.pullingPromise = null;
      }
    })();
    return this.pullingPromise;
  }

  /** 连通性自检（不会写任何数据）。 */
  async probe() {
    const transport = this.transport();
    if (typeof transport.probe !== "function") {
      return { ok: false, code: "UNSUPPORTED", message: "该传输不支持自检" };
    }
    await this.identify();
    const result = await transport.probe();
    this.stats.lastProbe = { ...result, at: Date.now() };
    return result;
  }

  /**
   * 合并本机行与来源行。
   *
   * 返回 { rows, origin, dropped }：
   *   · rows   —— 合并后的 Map，可直接喂给 aggregate()；
   *   · origin —— row.id → 来源 key（本机行是 "local"），供设备筛选诊断；
   *   · dropped —— 被设备筛选丢掉的行数。
   *
   * 合并的是**逐会话行**而非已聚合报告：否则「两台机器同一天做同一项目」
   * 会把活跃天数从 1 天算成 2 天（docs/sync.md §四）。
   */
  merge(localRows, { machines = null } = {}) {
    const local = localRows instanceof Map
      ? localRows
      : (Array.isArray(localRows)
        ? new Map(localRows.map((row) => [row.id, row]))
        : new Map(Object.entries(localRows ?? {})));
    const merged = new Map(local);
    const origin = new Map([...local.keys()].map((id) => [id, "local"]));
    let dropped = 0;
    // 设备筛选：只在显式选择了设备时生效；空数组 / null 表示「全部设备」
    const selected = Array.isArray(machines) && machines.length > 0 && !machines.includes("all") ? new Set(machines) : null;

    for (const [key, source] of this.sources) {
      const name = source.payload.machine.name;
      if (selected !== null && !selected.has(key) && !selected.has(name) && !selected.has("local")) {
        dropped += source.payload.rows.length;
        continue;
      }
      // 「只看本机」：选了 local 且没选其它来源
      if (selected !== null && selected.size === 1 && selected.has("local")) {
        dropped += source.payload.rows.length;
        continue;
      }
      for (const row of source.payload.rows) {
        const current = merged.get(row.id);
        if (current === undefined) {
          merged.set(row.id, row);
          origin.set(row.id, key);
          continue;
        }
        // 同一会话本机与远端都有：本机行最准，保留本机
        if (origin.get(row.id) === "local") continue;
        const mine = current.updatedAt ?? 0;
        const theirs = row.updatedAt ?? source.payload.generatedAt ?? 0;
        if (theirs > mine) {
          merged.set(row.id, row);
          origin.set(row.id, key);
        }
      }
    }
    return { rows: merged, origin, dropped };
  }

  /** 设备清单（看板选择器 / 诊断用）。 */
  devices() {
    const list = [];
    if (this.identity !== null) {
      list.push({ key: "local", id: this.identity.id, name: this.identity.name, local: true, rows: null, fetchedAt: 0, stale: false });
    }
    for (const [key, source] of this.sources) {
      const ageMs = Date.now() - source.fetchedAt;
      list.push({
        key,
        id: source.payload.machine.id,
        name: source.payload.machine.name,
        local: false,
        rows: source.payload.rows.length,
        fetchedAt: source.fetchedAt,
        stale: ageMs > Math.max(0, Number(this.config.staleAfterMs) || 0),
        platform: source.payload.machine.platform ?? null,
        plugin: source.payload.machine.plugin ?? null,
      });
    }
    return list;
  }

  /** 诊断（/health 与快照 diagnostics 同源）。 */
  diagnostics() {
    return {
      enabled: this.enabled,
      mode: this.config.mode,
      transport: this.config.transport,
      sources: this.sources.size,
      ...this.stats,
      devices: this.devices(),
    };
  }
}
