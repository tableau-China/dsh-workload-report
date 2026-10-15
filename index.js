/**
 * dsh-workload-report — 宿主（Node）半部。
 *
 * 职责：
 *   1. 作为 profile 里一行已加载的 Cordis 插件存在（客户端半部靠它被 client-modules 识别）。
 *   2. 用**官方接口**建立会话索引：
 *        ctx.sessionQuery.listSessions()                      → 逻辑语料（会话身份）
 *        ctx.sessionProjectionCache.cachedSnapshot(header)    → 零 I/O 读取投影检查点
 *        ctx.sessionProjections.snapshot(session)             → 活会话的实时投影
 *      （不解析日志、不读内部文件格式，投影口径由 Harness 自己维护。）
 *   3. 暴露只读 HTTP 接口：快照 JSON 与自包含 HTML 报告。
 *
 * 本插件不写任何文件、不发送任何网络请求；数据全部留在本机。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PROJECTION_KEYS, aggregate, present, rowFromSession } from "./src/aggregate.js";
import { renderReport } from "./src/report-html.js";
import { foldSessionModels, resolvePricing } from "./src/models.js";

/** 插件版本：getBalance 的客户端元数据（x-client-version）用它，避免手写常量与 package.json 漂移。 */
const PLUGIN_VERSION = createRequire(import.meta.url)("./package.json").version ?? "0.0.0";

export const name = "workload-report";

/**
 * 需要的宿主服务。
 *
 * 注意：cordis 里**访问未声明的服务会抛** `cannot get property "X" without inject`——
 * 漏声明不会让插件挂掉（异常被 catch 住），但会让整条实时路径静默失效，所以一个都不能漏：
 *   - sessionQuery          列举逻辑语料 + 冷读单个会话
 *   - sessionProjectionCache 零 I/O 读投影检查点
 *   - sessionProjections     活会话实时投影
 *   - sessions               取活会话对象（SessionStore）
 *   - webServer              注册只读路由
 */
export const inject = ["sessionQuery", "sessionProjectionCache", "sessionProjections", "sessions", "webServer"];

/** 默认配置（可在 profile 的 cordis.patch.yml 覆盖）。 */
const DEFAULTS = {
  apiPath: "/workload-report/v1",
  refreshMs: 30000,
  defaultDays: 7,
  defaultScope: "all",
  workspaceAliases: {},
  defaultTitle: "工作量报告",
  /** 冷读并发度（几百个会话同时折叠会压住服务器）。 */
  indexConcurrency: 8,
  /** 本地索引行的有效期：过期后重新冷读校验（续聊过的会话靠它纠正）。 */
  revalidateMs: 12 * 3600 * 1000,
  /** 索引文件路径；缺省 <DSH_HOME>/workload-report/index-v<版本>.json。 */
  indexPath: "",
  /** 模型维度：auto | off。off 时完全不读事件日志（行为与不含该功能一致）。 */
  modelUsage: "auto",
  /** 模型折叠并发（要读整份事件日志，比投影贵，默认低于 indexConcurrency）。 */
  modelFoldConcurrency: 4,
  /** 单会话事件数上限：超过则跳过该会话的模型维度并计入诊断（保护内存）。 */
  modelFoldMaxEvents: 200000,
  /** 模型归并自定义规则：{ group, match: [] }[] 或 { 组名: [模型…] }。 */
  modelGroups: [],
  /** 模型展示名别名（同 workspaceAliases）。 */
  modelAliases: {},
  /** 费用估算：{ currency, asOf, overrides, links }；缺省用官方公开价（不联网）。 */
  pricing: {},
  /** 聚合快照的内存缓存时长：面板反复打开时直接复用，避免重复聚合与序列化。 */
  snapshotCacheMs: 5000,
  /** 「最活跃模型」口径：requests（= step 数）| tokens | activeMs（= llmMs）。 */
  activeModelMetric: "requests",
  /** 同一会话两次模型折叠的最小间隔（续聊后重新折叠）。 */
  modelRefoldMs: 15 * 60 * 1000,
  /** 已折过的会话，事件水位领先多少才值得重折（活会话的 asOfSeq 每来一个事件 +1，必须给阈值）。 */
  modelRefoldDelta: 50,
  /** 折叠失败的会话隔多久再试一次（失败不算 pending，只影响重试节奏）。 */
  modelRetryMs: 15 * 60 * 1000,
  /**
   * 余额显示：**默认关闭**。
   * 关闭时宿主一次服务调用都不发（零外发请求），界面完全不渲染余额 chip；
   * 开启（enabled: true）后宿主会通过官方 deepseekAccount 服务访问 platform.deepseek.com，
   * 结果按 refreshMs 缓存。详见 README 的隐私章节。
   */
  balance: { enabled: false, refreshMs: 300000 },
};

/** 把未知异常收敛成一行文本。 */
function reasonOf(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 行上记录的折叠失败原因上限（消息可能很长，避免把索引文件写胖）。 */
const MODEL_FOLD_ERROR_MAX = 200;

/**
 * 模型折叠结果在行上的字段。投影重建出来的行**不含**模型维度（模型来自事件日志，不是投影），
 * 所以每次用 fresh 行替换旧行时必须把这组字段整体搬过去；否则：
 *   · 活会话每来一个事件、每次 sync 命中检查点，折好的 models 都会当场丢失；
 *   · pending 永远 > 0 → 界面永远停在"模型维度正在回填…"；
 *   · 重启后又要从头折一遍。
 */
const MODEL_ROW_FIELDS = ["models", "modelFoldSeq", "modelFoldAt", "modelFoldSkipped", "modelFoldError", "modelFoldErrorAt"];

/** 把上一版行的模型折叠结果搬到新行上（新行缺的字段才补，不覆盖）。 */
function carryModelFields(row, previous) {
  if (previous === undefined || previous === row) return row;
  for (const field of MODEL_ROW_FIELDS) {
    if (row[field] === undefined && previous[field] !== undefined) row[field] = previous[field];
  }
  return row;
}

/** 读取系统时区。 */
function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 写 JSON 响应。 */
function sendJson(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
  });
  res.end(json);
}

/** 写 HTML 响应。 */
function sendHtml(res, status, html) {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    "cache-control": "no-store",
  });
  res.end(html);
}

/**
 * 会话索引。
 *
 * 取值优先级（先便宜后昂贵）：
 *   1. `cachedSnapshot`：零 I/O 读投影检查点——但**只在记录与当前会话生命周期身份匹配时**才返回值；
 *      会话格式迁移（v3→v4）后旧检查点会被官方接口拒绝，于是必须走第 2 步。
 *   2. 活会话 `sessionProjections.snapshot()` + `session/event` 增量：同步、精确。
 *   3. 冷读 `sessionQuery.observeSession(id, { projectionMode: "all" })`：官方折叠整份日志
 *      （内部仍以检查点做捷径），只对"缓存未命中且本地索引里没有"的会话执行一次。
 *   4. 本地索引文件 `<DSH_HOME>/workload-report/index-v3.json`：让进程重启后不必重跑冷读；
 *   5. 模型维度：`sessionQuery.readSession()` 读官方事件日志 → `src/models.js` 折叠（渐进回填，不阻塞首屏）；
 *      超过 `revalidateMs` 的行会重新校验一次（续聊过的冷会话靠这个纠正）。
 */
const INDEX_VERSION = 3;

/** 限制并发，避免几百个会话同时冷读把服务器压住。 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/**
 * 余额查询超时：宿主 getBalance 会出网（platform.deepseek.com），绝不能拖住 /balance 或 /snapshot。
 */
const BALANCE_TIMEOUT_MS = 8000;

/** 未启用 / 未查询时的空余额状态（形状 = 快照里的 balance 字段）。 */
function emptyBalance(enabled) {
  return {
    enabled,
    supported: false,
    loggedIn: false,
    currency: null,
    amount: null,
    bonus: null,
    updatedAt: 0,
    topUpUrl: null,
    usageUrl: null,
    error: null,
  };
}

/** 给 Promise 加超时；宿主服务卡住时按失败处理，请求绝不悬挂。 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** 挑主钱包：优先 CNY，其次第一个；空数组 → undefined。 */
function pickWallet(wallets) {
  if (!Array.isArray(wallets) || wallets.length === 0) return undefined;
  return wallets.find((wallet) => wallet?.currency === "CNY") ?? wallets[0];
}

/** 汇总赠送余额（同币种求和）；没有赠送返回 null（界面才能区分"没有"与"0"）。 */
function bonusTotal(wallets, currency) {
  if (!Array.isArray(wallets) || currency === null || currency === undefined) return null;
  const matching = wallets.filter((wallet) => wallet?.currency === currency);
  if (matching.length === 0) return null;
  const sum = matching.reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0);
  return Number.isFinite(sum) ? sum : null;
}

/** 系统语言（只用于 getBalance 的请求头）。 */
function systemLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

/**
 * 余额查询（宿主官方服务的**可选依赖**）。
 *
 * 铁律（与 README 的隐私章节一致）：
 *   · 默认关闭（DEFAULTS.balance.enabled === false）→ 一次服务调用都不发，界面完全不渲染；
 *   · 服务用 `ctx.get("deepseekAccount")` 取，**不写进 inject**——cordis 的 inject 是"必需依赖"，
 *     写进去会在老版 DSH（没有该服务）上让 fiber 挂起等待、甚至抛 "without inject"；
 *     ctx.get() 是官方 ReflectService.get 的混入方法（"without the inject requirement"），
 *     服务不存在时返回 undefined，插件照常加载；
 *   · 只有 enabled + 服务存在时才出网，带超时与 try/catch，失败只写进 balance.error，不影响快照。
 */
class BalanceTracker {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.enabled = config.enabled === true;
    this.refreshMs = Number.isFinite(config.refreshMs) && config.refreshMs > 0 ? config.refreshMs : 300000;
    this.value = emptyBalance(this.enabled);
    this.lastAt = 0;
    this.inflight = null;
    /** 供离线断言：真正调用宿主 getBalance 的次数（默认关闭时必须为 0）。 */
    this.calls = 0;
  }

  /** 可选服务：不存在 / 未提供时返回 undefined（不抛错、不阻塞）。 */
  service() {
    try {
      if (typeof this.ctx?.get !== "function") return undefined;
      return this.ctx.get("deepseekAccount") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 当前余额状态（同步；快照直接读取）。 */
  state() {
    return this.value;
  }

  /** 本地链接（getState 只读本地凭据，不出网；未登录也拿得到）。 */
  async linksOf(service) {
    if (typeof service?.getState !== "function") return { topUpUrl: null, usageUrl: null };
    try {
      const view = await service.getState();
      return {
        topUpUrl: typeof view?.links?.topUpUrl === "string" ? view.links.topUpUrl : null,
        usageUrl: typeof view?.links?.usageUrl === "string" ? view.links.usageUrl : null,
      };
    } catch {
      return { topUpUrl: null, usageUrl: null };
    }
  }

  /** 确保余额可用（refreshMs 内复用缓存；force 时强制刷新；并发共享同一次查询）。 */
  ensure({ force = false } = {}) {
    if (!this.enabled) return Promise.resolve(this.value);
    if (!force && this.lastAt > 0 && Date.now() - this.lastAt < this.refreshMs) return Promise.resolve(this.value);
    if (this.inflight === null) this.inflight = this.refresh();
    return this.inflight;
  }

  /** 真正查询：先取本地链接，再（可选）出网取余额。 */
  async refresh() {
    let links = { topUpUrl: null, usageUrl: null };
    try {
      if (!this.enabled) {
        this.value = emptyBalance(false);
        return this.value;
      }
      const service = this.service();
      if (service === undefined || typeof service.getBalance !== "function") {
        // 服务不存在（老版 DSH）：只报"不支持"，不报错、不外发请求。
        this.value = { ...emptyBalance(true), supported: false, updatedAt: Date.now() };
        return this.value;
      }
      links = await this.linksOf(service);
      const base = { ...emptyBalance(true), supported: true, ...links, updatedAt: Date.now() };
      this.calls += 1;
      const result = await withTimeout(
        service.getBalance({ version: PLUGIN_VERSION, locale: systemLocale(), timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 }),
        BALANCE_TIMEOUT_MS,
        "余额查询",
      );
      if (result === null || result === undefined) {
        // 未登录：宿主官方接口返回 null（不是错误）
        this.value = { ...base, loggedIn: false };
      } else if (result.status === "ready") {
        const wallet = pickWallet(result.value);
        this.value = {
          ...base,
          loggedIn: true,
          currency: wallet?.currency ?? null,
          amount: wallet === undefined ? null : Number(wallet.balance),
          bonus: bonusTotal(result.bonusWallets, wallet?.currency),
        };
      } else {
        this.value = { ...base, loggedIn: false, error: "余额查询失败" };
      }
      return this.value;
    } catch (error) {
      // 出错也要给出本地链接，界面显示 "—" + 充值入口（不弹错）
      this.value = { ...emptyBalance(true), supported: true, ...links, updatedAt: Date.now(), error: reasonOf(error) };
      return this.value;
    } finally {
      this.lastAt = Date.now();
      this.inflight = null;
    }
  }
}

class WorkloadIndex {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config;
    /** @type {Map<string, object>} sessionId → 聚合行 */
    this.rows = new Map();
    /** 本地索引里每行的时间戳，用于 revalidate 判断。 */
    this.rowSavedAt = new Map();
    this.syncing = null;
    this.loadedFromDisk = false;
    /** 落盘串行队列（见 saveToDisk）。 */
    this.saveQueue = null;
    /** 模型维度回填状态（渐进：首屏先出总量，模型区随后补齐）。 */
    this.modelFold = {
      running: false, done: 0, total: 0, folded: 0, skipped: 0, failed: 0,
      pending: 0, refold: 0, lastAt: 0, lastError: null, lastErrorAt: null,
    };
    /** 余额（默认关闭；可选依赖 deepseekAccount，见 BalanceTracker）。 */
    this.balance = new BalanceTracker(ctx, config.balance ?? {});
    this.resolvedPricing = undefined;
    this.diagnostics = {
      sessions: 0, cached: 0, reused: 0, live: 0, cold: 0, missing: 0,
      buildMs: 0, lastSyncAt: 0, lastError: null, persisted: false,
      modelsFolded: 0, modelPending: 0, modelStale: 0, modelFailed: 0, modelSkipped: 0,
    };
  }

  /** 索引文件路径（可用 config.indexPath 覆盖）。 */
  indexPath() {
    if (typeof this.config.indexPath === "string" && this.config.indexPath.length > 0) return this.config.indexPath;
    const home = (typeof process.env.DSH_HOME === "string" && process.env.DSH_HOME.trim().length > 0)
      ? process.env.DSH_HOME.trim()
      : join(homedir(), ".dsh");
    return join(home, "workload-report", `index-v${INDEX_VERSION}.json`);
  }

  /** 读本地索引（失败就当作没有，冷读会补回来）。 */
  async loadFromDisk() {
    if (this.loadedFromDisk) return;
    this.loadedFromDisk = true;
    try {
      const text = await readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(text);
      if (parsed?.version !== INDEX_VERSION || typeof parsed.rows !== "object" || parsed.rows === null) return;
      for (const [id, row] of Object.entries(parsed.rows)) {
        this.rows.set(id, row);
        this.rowSavedAt.set(id, typeof parsed.savedAt?.[id] === "number" ? parsed.savedAt[id] : parsed.savedAt ?? 0);
      }
    } catch {
      /* 首次运行或文件损坏：忽略 */
    }
  }

  /** 写本地索引：sync 与模型回填会并发触发，排队执行，避免两次写同一个 .tmp 互踩（rename ENOENT）。 */
  async saveToDisk() {
    const previous = this.saveQueue ?? Promise.resolve();
    const next = previous.then(() => this.writeIndex());
    this.saveQueue = next.catch(() => {});
    return next;
  }

  /** 真正落盘（原子替换）。 */
  async writeIndex() {
    try {
      const path = this.indexPath();
      await mkdir(dirname(path), { recursive: true });
      const rows = {};
      const savedAt = {};
      for (const [id, row] of this.rows) {
        rows[id] = row;
        savedAt[id] = this.rowSavedAt.get(id) ?? Date.now();
      }
      const payload = JSON.stringify({ version: INDEX_VERSION, savedAt, rows });
      const temp = `${path}.tmp`;
      await writeFile(temp, payload);
      await rename(temp, path);
      this.diagnostics.persisted = true;
    } catch (error) {
      this.diagnostics.lastError = reasonOf(error);
    }
  }

  /** 零 I/O 读投影检查点（命中返回行，未命中返回 undefined）。 */
  cachedRow(header) {
    try {
      const snapshot = this.ctx.sessionProjectionCache.cachedSnapshot(header, PROJECTION_KEYS);
      if (snapshot === undefined) return undefined;
      return rowFromSession(header, snapshot.values ?? {}, snapshot.asOfSeq ?? null);
    } catch (error) {
      this.diagnostics.lastError = reasonOf(error);
      return undefined;
    }
  }

  /** 活会话的实时投影快照。 */
  liveRow(session, header) {
    try {
      const projections = this.ctx.sessionProjections;
      if (projections === undefined || typeof projections.snapshot !== "function") return undefined;
      const snapshot = projections.snapshot(session, PROJECTION_KEYS);
      return rowFromSession(header ?? session.header ?? { id: session.id }, snapshot.values ?? {}, snapshot.asOfSeq ?? null);
    } catch (error) {
      this.diagnostics.lastError = reasonOf(error);
      return undefined;
    }
  }

  /** 冷读兜底：官方折叠整份日志（可带检查点捷径）。 */
  async coldRow(record) {
    const observation = await this.ctx.sessionQuery.observeSession(record.header.id, { projectionMode: "all" });
    try {
      const values = observation.projections?.values ?? {};
      return rowFromSession(observation.header ?? record.header, values, observation.projections?.asOfSeq ?? null);
    } finally {
      if (typeof observation.dispose === "function") observation.dispose();
    }
  }

  /** 该会话 id 当前是否活着。 */
  liveSession(id) {
    try {
      const store = this.ctx.sessions;
      if (store === undefined || typeof store.get !== "function") return undefined;
      return store.get(id) ?? undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * 同步索引：列举语料 → 逐条按"先便宜后昂贵"取值。
   * @param options - cold 是否允许冷读；concurrency 并发度。
   */
  async sync({ cold = true, concurrency = this.config.indexConcurrency } = {}) {
    const started = Date.now();
    await this.loadFromDisk();
    const records = await this.ctx.sessionQuery.listSessions();
    const diagnostics = {
      sessions: 0, cached: 0, reused: 0, live: 0, cold: 0, missing: 0,
      buildMs: 0, lastSyncAt: Date.now(), lastError: this.diagnostics.lastError, persisted: this.diagnostics.persisted,
    };
    // 实时可见：这里就挂上，前端在补齐过程中也能看到进度
    this.diagnostics = diagnostics;
    const nextRows = new Map();
    const nextSavedAt = new Map();
    const previousRows = this.rows;
    const previousSavedAt = this.rowSavedAt;
    // 首次建索引（可能要冷读几分钟）才渐进换表，避免长时间空白；
    // 之后的增量重扫**保持旧表可用**，同步完成后一次性原子替换——
    // 否则同步期间进来的请求会读到只有部分会话的残缺数据。
    const firstBuild = this.firstBuildDone !== true;
    if (firstBuild) {
      this.rows = nextRows;
      this.rowSavedAt = nextSavedAt;
    }
    const settle = (id, row, savedAt) => {
      if (!nextRows.has(id)) diagnostics.sessions += 1;
      // 新行来自投影，不带模型维度：把上一版行的折叠结果搬过来（否则每次同步都会丢）
      nextRows.set(id, carryModelFields(row, previousRows.get(id)));
      nextSavedAt.set(id, savedAt);
    };
    const revalidateMs = this.config.revalidateMs;
    let coldPerformed = 0;

    await mapLimit(records, concurrency, async (record) => {
      const id = String(record.header.id);
      // 1) 活会话：实时投影最准
      if (record.live) {
        const session = this.liveSession(id);
        const live = session === undefined ? undefined : this.liveRow(session, record.header);
        if (live !== undefined) {
          settle(id, live, Date.now());
          diagnostics.live += 1;
          return;
        }
      }
      // 2) 投影检查点（零 I/O）
      const cached = this.cachedRow(record.header);
      if (cached !== undefined) {
        settle(id, cached, Date.now());
        diagnostics.cached += 1;
        return;
      }
      // 3) 本地索引里的旧值：未过期就直接复用（从交换前的表里取）
      const stored = previousRows.get(id) ?? (nextRows.size > 0 ? nextRows.get(id) : undefined);
      const storedAt = previousSavedAt.get(id) ?? 0;
      if (stored !== undefined && Date.now() - storedAt < revalidateMs) {
        settle(id, stored, storedAt);
        diagnostics.reused += 1;
        return;
      }
      // 4) 冷读（首次全量、或本地值过期后的重新校验）
      if (cold) {
        try {
          const row = await this.coldRow(record);
          settle(id, row, Date.now());
          diagnostics.cold += 1;
          coldPerformed += 1;
          return;
        } catch (error) {
          diagnostics.lastError = reasonOf(error);
        }
      }
      // 5) 全都失败：留空行（宁可少算，也不算错）
      if (stored !== undefined) {
        settle(id, stored, storedAt);
        diagnostics.reused += 1;
      } else {
        settle(id, rowFromSession(record.header, {}), Date.now());
        diagnostics.missing += 1;
      }
    });

    this.firstBuildDone = this.firstBuildDone === true || nextRows.size > 0;
    if (!firstBuild && nextRows.size > 0) {
      // 原子替换：请求要么看到旧表，要么看到新表，不会看到半成品
      this.rows = nextRows;
      this.rowSavedAt = nextSavedAt;
    }
    if (nextRows.size === 0 && previousRows.size > 0) {
      // 列举失败等异常情况：保留上一份可用数据
      this.rows = previousRows;
      this.rowSavedAt = previousSavedAt;
      diagnostics.sessions = previousRows.size;
      diagnostics.missing = this.diagnostics.missing;
    } else {
      diagnostics.sessions = nextRows.size;
    }
    diagnostics.buildMs = Date.now() - started;
    this.diagnostics = diagnostics;
    this.refreshModelDiagnostics();
    this.snapshotCache = undefined; // 索引刷新后缓存作废
    if (coldPerformed > 0) await this.saveToDisk();
    // 投影数据已可用 → 立刻放行首屏；模型维度在后台渐进补齐
    this.scheduleModelFold();
    return this;
  }

  /** 生效价目（内置官方公开价 + 用户覆盖；纯本地，不联网）。 */
  pricingTable() {
    if (this.resolvedPricing === undefined) this.resolvedPricing = resolvePricing(this.config.pricing);
    return this.resolvedPricing;
  }

  /**
   * 模型折叠队列（三档互斥，0.4.1 起 pending 只认"从未折过"）：
   *   · pending —— 从未折过（`models === undefined` 且没记过失败）。界面「回填中」只跟它同步；
   *   · refold  —— 折过、但事件水位显著前进（> modelRefoldDelta）或会话已非 live（收尾补齐）。
   *                这类行已经有数据可用，重折不打扰界面；
   *   · failed  —— 折过但失败、且已过重试窗口（modelRetryMs），再试一次；失败不算 pending。
   * 活会话的 asOfSeq 每来一个事件就 +1：若"水位前进就重折"，pending 会永远 > 0，
   * 界面就永远停在"模型维度正在回填…"——这正是 0.4.0 的线上缺陷。
   * @returns {{pending: Array, refold: Array, failed: Array}}
   */
  modelFoldQueue() {
    const queue = { pending: [], refold: [], failed: [] };
    if (this.config.modelUsage === "off") return queue;
    const now = Date.now();
    for (const [id, row] of this.rows) {
      if (row.models === undefined) {
        const failedAt = typeof row.modelFoldErrorAt === "number" ? row.modelFoldErrorAt : 0;
        if (typeof row.modelFoldError !== "string" || row.modelFoldError === "") queue.pending.push({ id, row });
        else if (now - failedAt >= this.config.modelRetryMs) queue.failed.push({ id, row });
        continue;
      }
      const foldedSeq = typeof row.modelFoldSeq === "number" ? row.modelFoldSeq : -1;
      const asOf = typeof row.asOfSeq === "number" ? row.asOfSeq : 0;
      if (asOf - foldedSeq > this.config.modelRefoldDelta) queue.refold.push({ id, row });
      else if (asOf > foldedSeq && this.liveSession(id) === undefined) queue.refold.push({ id, row });
    }
    return queue;
  }

  /** 需要本次折叠的会话（pending + refold + failed）。 */
  modelFoldTargets() {
    const queue = this.modelFoldQueue();
    return [...queue.pending, ...queue.refold, ...queue.failed];
  }

  /** 当前处于"折叠失败"状态的行数（不参与 pending，界面上单独提示原因）。 */
  modelFoldFailedRows() {
    let count = 0;
    for (const row of this.rows.values()) {
      if (row.models === undefined && typeof row.modelFoldError === "string" && row.modelFoldError !== "") count += 1;
    }
    return count;
  }

  /** 行级失败里最近的一条（重启后运行级 lastError 是空的，但失败状态是从索引读回来的）。 */
  lastRowFoldError() {
    let newest = null;
    for (const row of this.rows.values()) {
      if (typeof row.modelFoldError !== "string" || row.modelFoldError === "") continue;
      const at = typeof row.modelFoldErrorAt === "number" ? row.modelFoldErrorAt : 0;
      if (newest === null || at > newest.at) newest = { at, message: row.modelFoldError };
    }
    return newest;
  }

  /** 模型维度诊断（/health、/snapshot 与 sync 共用同一份口径）。 */
  modelFoldDiagnostics() {
    const queue = this.modelFoldQueue();
    const failedRows = this.modelFoldFailedRows();
    const rowError = this.modelFold.lastError === null ? this.lastRowFoldError() : null;
    return {
      ...this.modelFold,
      pending: queue.pending.length,
      refold: queue.refold.length,
      failedRows,
      lastError: this.modelFold.lastError ?? rowError?.message ?? null,
      lastErrorAt: this.modelFold.lastErrorAt ?? rowError?.at ?? null,
    };
  }

  /** 把模型折叠进度写回诊断字段。 */
  refreshModelDiagnostics() {
    const fold = this.modelFoldDiagnostics();
    this.diagnostics.modelsFolded = this.modelFold.folded;
    this.diagnostics.modelSkipped = this.modelFold.skipped;
    this.diagnostics.modelPending = fold.pending;
    this.diagnostics.modelStale = fold.refold;
    this.diagnostics.modelFailed = fold.failedRows;
    return fold;
  }

  /**
   * 后台折叠模型维度：官方 `readSession()` 读整份事件日志 → src/models.js 折叠。
   * 结果写回**当前**行（折叠期间行可能被投影重建，写回抓到的旧行等于白折），并在结束时落盘。
   */
  async runModelFold() {
    if (this.config.modelUsage === "off" || this.modelFold.running) return;
    const queue = this.modelFoldQueue();
    const targets = [...queue.pending, ...queue.refold, ...queue.failed];
    if (targets.length === 0) return;
    this.modelFold = {
      running: true, done: 0, total: targets.length, folded: 0, skipped: 0, failed: 0,
      pending: queue.pending.length, refold: queue.refold.length,
      lastAt: Date.now(), lastError: null, lastErrorAt: null,
    };
    try {
      await mapLimit(targets, Math.max(1, this.config.modelFoldConcurrency), async ({ id, row }) => {
        // 水位在开读前取：折叠期间行换代也不至于把"没读到的新事件"当成已折
        const asOf = typeof row.asOfSeq === "number" ? row.asOfSeq : 0;
        try {
          const snapshot = await this.ctx.sessionQuery.readSession(id);
          const events = Array.isArray(snapshot?.events) ? snapshot.events : [];
          const target = this.rows.get(id) ?? row; // 行可能已被 patchLive/sync 换代 → 写回当前行
          if (events.length > this.config.modelFoldMaxEvents) {
            // 巨型会话：跳过并标记，避免把整份日志常驻内存
            this.modelFold.skipped += 1;
            target.models = target.models ?? {};
            target.modelFoldSeq = asOf;
            target.modelFoldSkipped = events.length;
            delete target.modelFoldError;
            delete target.modelFoldErrorAt;
            this.modelFold.done += 1;
            return;
          }
          const folded = foldSessionModels(events, { groups: this.config.modelGroups, sessionLlmMs: target.llmMs });
          target.models = folded.models;
          target.modelFoldSeq = asOf;
          target.modelFoldAt = Date.now();
          delete target.modelFoldSkipped;
          delete target.modelFoldError;
          delete target.modelFoldErrorAt;
          this.modelFold.folded += 1;
        } catch (error) {
          // 失败记在行上：重启后不必立刻重试，但过了重试窗口会再试；pending 不因它常驻
          const message = reasonOf(error);
          const target = this.rows.get(id) ?? row;
          this.modelFold.failed += 1;
          this.modelFold.lastError = message;
          this.modelFold.lastErrorAt = Date.now();
          target.modelFoldError = message.slice(0, MODEL_FOLD_ERROR_MAX);
          target.modelFoldErrorAt = Date.now();
        }
        this.modelFold.done += 1;
        // 边折边落盘：进度可见，且重启后不白折
        if (this.modelFold.done % 25 === 0) {
          this.refreshModelDiagnostics();
          await this.saveToDisk();
        }
      });
    } finally {
      this.modelFold.running = false;
      this.refreshModelDiagnostics();
      this.snapshotCache = undefined; // 模型数据变了，缓存作废
      await this.saveToDisk();
    }
  }

  /**
   * 需要时后台启动模型回填（不 await，绝不阻塞请求）。
   * 节流只约束"重折 / 重试"：**从未折过的会话不受节流影响**，否则首屏后新出现的会话
   * 要等满一个 modelRefoldMs 才会被折，界面就得挂 15 分钟的"回填中"。
   */
  scheduleModelFold({ force = false } = {}) {
    if (this.config.modelUsage === "off" || this.modelFold.running) return;
    const queue = this.modelFoldQueue();
    if (queue.pending.length === 0) {
      if (!force && this.modelFold.lastAt > 0 && Date.now() - this.modelFold.lastAt < this.config.modelRefoldMs) return;
      if (queue.refold.length + queue.failed.length === 0) return;
    }
    void this.runModelFold();
  }

  /**
   * 确保有同步在跑（**不等待**整次同步完成）：同步过程渐进式填表，
   * 请求立即拿到当前进度，前端靠 `indexing` 标记决定要不要过几秒再拉。
   */
  ensureIndex({ force = false } = {}) {
    const fresh = Date.now() - this.diagnostics.lastSyncAt < this.config.refreshMs;
    if (!force && this.diagnostics.lastSyncAt > 0 && fresh) return;
    if (this.syncing === null) {
      this.syncing = this.sync({ cold: true })
        .catch((error) => {
          this.diagnostics.lastError = reasonOf(error);
        })
        .finally(() => {
          this.syncing = null;
        });
    }
  }

  /** 活会话事件增量更新（同步、便宜；不触发冷读）。 */
  patchLive(session) {
    try {
      const row = this.liveRow(session, session.header ?? { id: session.id });
      if (row === undefined) return;
      const key = String(session.id);
      carryModelFields(row, this.rows.get(key));
      this.rows.set(key, row);
      this.rowSavedAt.set(String(session.id), Date.now());
      // 行变了 → 快照缓存立即作废：否则 5s TTL 内仍会返回旧值，活会话事件"看起来没生效"
      this.snapshotCache = undefined;
    } catch (error) {
      this.diagnostics.lastError = reasonOf(error);
    }
  }

  /** 生成聚合快照（不阻塞：索引进度随诊断字段一起返回）。 */
  async snapshot(query) {
    this.ensureIndex({ force: query.refresh === true });
    this.scheduleModelFold();
    // 余额：只在启用时真的查询；不 await（快照绝不因出网变慢），结果下次请求即生效
    void this.balance.ensure();
    // 同参数短 TTL 复用：面板反复打开时省掉"聚合 + 大 JSON 序列化"
    const cacheKey = JSON.stringify({ from: query.from, to: query.to, days: query.days, tz: query.timeZone, scope: query.scope, all: query.all === true });
    const cached = this.snapshotCache;
    if (cached !== undefined && cached.key === cacheKey && Date.now() - cached.at < this.config.snapshotCacheMs) {
      return { ...cached.value, balance: this.balanceState(), diagnostics: this.diagnosticsFor() };
    }
    const rows = [...this.rows.values()];
    const result = present(
      aggregate(rows, {
        from: query.from,
        to: query.to,
        days: query.days,
        timeZone: query.timeZone,
        scope: query.scope,
        all: query.all === true,
        aliases: this.config.workspaceAliases,
        pricing: this.pricingTable(),
        modelAliases: this.config.modelAliases,
        activeModelMetric: this.config.activeModelMetric,
      }),
    );
    this.snapshotCache = { key: cacheKey, at: Date.now(), value: result };
    return { ...result, balance: this.balanceState(), diagnostics: this.diagnosticsFor() };
  }

  /** 余额状态（快照的 balance 字段；未启用时 enabled=false，客户端据此完全不渲染）。 */
  balanceState() {
    return this.balance.state();
  }

  /** 诊断信息（含索引进度与模型回填进度）；顶层 modelPending/Stale/Failed 与 modelFold 同源刷新。 */
  diagnosticsFor() {
    this.refreshModelDiagnostics();
    return {
      ...this.diagnostics,
      // syncing 是"后台正在重扫"的诊断事实；indexing 才是给用户看的"首次补齐中"
      syncing: this.syncing !== null,
      // 只有"首次全量建索引"才算补齐中；之后的增量重扫很快，不必打扰用户
      indexing: this.syncing !== null && this.firstBuildDone !== true,
      modelUsage: this.config.modelUsage !== "off",
      modelFold: this.modelFoldDiagnostics(),
    };
  }
}

/**
 * 安装插件：建索引、订阅活会话、注册只读路由。
 * @param ctx - Cordis 上下文。
 * @param config - 可选配置。
 */
export function apply(ctx, config = {}) {
  const merged = { ...DEFAULTS, ...config };
  // 嵌套配置浅合并：只写 balance.enabled 时不能把默认 refreshMs 丢掉
  if (config.balance !== undefined && config.balance !== null) {
    merged.balance = { ...DEFAULTS.balance, ...config.balance };
  }
  const apiPath = typeof merged.apiPath === "string" && merged.apiPath.startsWith("/") ? merged.apiPath.replace(/\/+$/, "") : DEFAULTS.apiPath;
  const index = new WorkloadIndex(ctx, { ...merged, apiPath });

  index.ensureIndex({ force: true });
  const ready = (async () => {
    while (index.syncing !== null) await index.syncing;
    const d = index.diagnostics;
    ctx.logger.info(
      `[workload-report] 索引就绪：${d.sessions} 个会话（检查点 ${d.cached} · 活会话 ${d.live} · 冷读 ${d.cold} · 复用 ${d.reused} · 读取失败 ${d.missing}），耗时 ${d.buildMs}ms`,
    );
  })().catch((error) => {
    index.diagnostics.lastError = reasonOf(error);
    ctx.logger.warn(`[workload-report] 初次建索引失败: ${reasonOf(error)}`);
  });

  ctx.effect(
    () => ctx.on("session/event", (session) => index.patchLive(session)),
    "workload-report: live session updates",
  );

  const handle = async (req, res) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD") {
        sendJson(res, 405, { error: "只支持 GET / HEAD" });
        return;
      }
      const url = new URL(req.url ?? "/", "http://workload-report.invalid");
      const route = url.pathname.slice(apiPath.length) || "/";
      const params = url.searchParams;
      const timeZone = params.get("tz") ?? systemTimeZone();
      const scopeParam = params.get("scope");
      const scope = scopeParam === "main" || scopeParam === "subagent" ? scopeParam : merged.defaultScope;
      const daysParam = Number.parseInt(params.get("days") ?? "", 10);
      const query = {
        from: params.get("from") ?? undefined,
        to: params.get("to") ?? undefined,
        days: Number.isFinite(daysParam) && daysParam > 0 ? daysParam : merged.defaultDays,
        timeZone,
        scope,
        all: params.get("all") === "1",
        refresh: params.get("refresh") === "1",
      };

      if (route === "/balance") {
        // 轻量路由：顶部工具栏 chip 专用（不触发索引同步）；默认关闭时立即返回 enabled:false。
        const balance = await index.balance.ensure({ force: params.get("refresh") === "1" });
        sendJson(res, 200, { balance });
        return;
      }
      if (route === "/health") {
        // 非阻塞：同步可能持续数分钟（首次要冷读历史会话），只报进度。
        // diagnostics 与 /snapshot 用同一份口径（indexing / syncing / modelUsage / modelFold 都在里面）。
        const diagnostics = index.diagnosticsFor();
        sendJson(res, 200, { ok: true, apiPath, indexing: diagnostics.indexing, syncing: diagnostics.syncing, diagnostics });
        return;
      }
      if (route === "/snapshot" || route === "/export.json") {
        const snapshot = await index.snapshot(query);
        if (route === "/export.json") {
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-disposition": `attachment; filename="workload-${snapshot.range.from}_${snapshot.range.to}.json"`,
            "cache-control": "no-store",
          });
          res.end(JSON.stringify({ generatedAt: Date.now(), ...snapshot }, null, 2));
          return;
        }
        sendJson(res, 200, { generatedAt: Date.now(), diagnostics: index.diagnostics, ...snapshot });
        return;
      }
      if (route === "/report.html") {
        const snapshot = await index.snapshot(query);
        const html = renderReport(snapshot, {
          theme: params.get("theme") === "dark" ? "dark" : "light",
          title: params.get("title") ?? merged.defaultTitle,
          note: params.get("note") ?? "",
          anonymize: params.get("anonymize") === "1",
          topSessions: Number.parseInt(params.get("sessions") ?? "12", 10),
          generatedAt: Date.now(),
        });
        if (req.method === "HEAD") {
          sendHtml(res, 200, "");
          return;
        }
        sendHtml(res, 200, html);
        return;
      }
      sendJson(res, 404, { error: `未知路由 ${route}`, routes: ["/snapshot", "/export.json", "/report.html", "/health", "/balance"] });
    } catch (error) {
      sendJson(res, 500, { error: reasonOf(error) });
    }
  };

  ctx.effect(
    () => ctx.webServer.register({ kind: "prefix", path: apiPath, handler: (req, res) => void handle(req, res) }),
    "workload-report: read-only API",
  );

  ctx.logger.info(`[workload-report] 只读接口就绪: ${apiPath}`);
  ctx.logger.info(
    merged.balance.enabled === true
      ? "[workload-report] 余额显示已启用：宿主将访问 platform.deepseek.com（可在配置里设 balance.enabled=false 关闭）"
      : "[workload-report] 余额显示默认关闭：不查询、不外发请求",
  );
}
