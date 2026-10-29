/**
 * 同步设置的 GUI 编辑：传输方式 + 各自参数，保存进 profile 的 patch 并**立即生效**。
 *
 * 为什么不用自己的配置文件：
 *   · 写 profile 走的是 DSH 官方 `configEditor.edit(entry, change)`——
 *     它会先校验完整候选值、加 profile 文件锁、原子替换，并保留 YAML 注释；
 *   · 保存后由 Loader 热应用，不需要用户手动改 YAML 或重启；
 *   · 用户的配置只有一份真相（profile），不会出现「GUI 改了但 YAML 没变」的分裂。
 *
 * 安全边界：
 *   · 这里**只处理非机密项**（bucket / region / repo / branch / path / machineName / 周期）；
 *   · 凭据（SecretId / SecretKey / Token）走 credential-vault.js，存 DSH 凭据存储（0600 + 文件锁）；
 *   · 任何机密字段都不会进入本模块的写入路径。
 */

import { SYNC_DEFAULTS, TRANSPORTS } from "./sync-service.js";
import { frequencyPlan, normalizeFrequency } from "./client/sync-state.js";

/** 传输方式的展示信息（GUI 用）。 */
export const TRANSPORT_META = {
  cos: { label: "腾讯云 COS", needsCredential: true, fields: ["bucket", "region"] },
  github: { label: "GitHub 仓库", needsCredential: true, fields: ["repo", "branch", "baseUrl"] },
  gitea: { label: "Gitea 仓库", needsCredential: true, fields: ["repo", "branch", "baseUrl"] },
  local: { label: "共享目录", needsCredential: false, fields: ["dir"] },
};

/** 各传输的已知 COS 地域（GUI 下拉候选项；允许自由填写）。 */
export const COS_REGIONS = [
  "ap-guangzhou", "ap-shanghai", "ap-beijing", "ap-chengdu", "ap-chongqing",
  "ap-nanjing", "ap-wuhan", "ap-shenzhen-fsi", "ap-hongkong", "ap-singapore",
  "ap-tokyo", "ap-seoul", "na-siliconvalley", "eu-frankfurt",
];

/** 平台预设：填一组就够用的默认值，减少用户输入。 */
export const PLATFORM_PRESETS = {
  github: { baseUrl: "https://api.github.com", branch: "main" },
  gitea: { baseUrl: "", branch: "master" },
};

/** 从配置里取出可编辑的字段（**不含任何机密**）。 */
export function editableView(config) {
  const transport = TRANSPORTS.includes(config.transport) ? config.transport : "github";
  return {
    enabled: config.enabled === true,
    transport,
    machineName: config.machineName ?? "",
    path: config.path ?? SYNC_DEFAULTS.path,
    syncFrequency: normalizeFrequency(config.syncFrequency),
    pushEveryMs: Number(config.pushEveryMs) || SYNC_DEFAULTS.pushEveryMs,
    pullEveryMs: Number(config.pullEveryMs) || SYNC_DEFAULTS.pullEveryMs,
    redactPaths: config.redactPaths === true,
    cos: {
      bucket: config.cos?.bucket ?? "",
      region: config.cos?.region ?? "",
    },
    github: {
      repo: config.github?.repo ?? "",
      branch: config.github?.branch ?? SYNC_DEFAULTS.github.branch,
      baseUrl: config.github?.baseUrl || SYNC_DEFAULTS.github.baseUrl,
    },
    local: {
      dir: config.local?.dir ?? "",
    },
  };
}

/** 把用户提交的值收敛成可写入的配置片段。 */
function sanitizeText(value, max = 200) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, max);
}

function clampInterval(value, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 60_000) return fallback;
  return Math.min(Math.round(number), 30 * 24 * 3600 * 1000);
}

/**
 * 把 GUI 提交的 patch 合并进现有配置。
 * @param current - 现有 sync 配置。
 * @param patch - 用户提交的字段（只允许白名单内的键）。
 * @returns {Promise<object>} 新的 sync 配置；校验失败抛错。
 */
export function applySettingsPatch(current, patch = {}) {
  const base = { ...SYNC_DEFAULTS, ...(current ?? {}) };
  for (const key of ["github", "cos", "local"]) {
    base[key] = { ...SYNC_DEFAULTS[key], ...(current?.[key] ?? {}) };
  }
  const next = {
    ...base,
    cos: { ...base.cos },
    github: { ...base.github },
    local: { ...base.local },
  };

  if (patch.enabled !== undefined) next.enabled = patch.enabled === true;
  if (patch.transport !== undefined) {
    if (!TRANSPORTS.includes(patch.transport)) throw new Error(`不支持的传输方式：${patch.transport}`);
    next.transport = patch.transport;
  }
  if (patch.machineName !== undefined) next.machineName = sanitizeText(patch.machineName, 60);
  if (patch.path !== undefined) {
    const path = sanitizeText(patch.path, 200);
    // 必须含 {machineId}，否则多台机器会互相覆盖
    if (path.length > 0 && !path.includes("{machineId}")) {
      throw new Error("路径模板必须包含 {machineId}，否则多台设备会写到同一个文件");
    }
    if (path.length > 0) next.path = path;
  }
  if (patch.syncFrequency !== undefined) {
    const freq = normalizeFrequency(patch.syncFrequency);
    if (freq !== patch.syncFrequency) throw new Error(`不支持的同步频率：${patch.syncFrequency}`);
    next.syncFrequency = freq;
    // 频率决定推送周期（拉取恒 30 分钟）；两者一起写，避免出现「选了 12h 但周期还是 6h」
    const plan = frequencyPlan(freq);
    next.pushEveryMs = plan.pushEveryMs > 0 ? plan.pushEveryMs : next.pushEveryMs;
    next.pullEveryMs = plan.pullEveryMs;
  }
  if (patch.pushEveryMs !== undefined) next.pushEveryMs = clampInterval(patch.pushEveryMs, next.pushEveryMs);
  if (patch.pullEveryMs !== undefined) next.pullEveryMs = clampInterval(patch.pullEveryMs, next.pullEveryMs);
  if (patch.redactPaths !== undefined) next.redactPaths = patch.redactPaths === true;

  // 传输专属字段
  if (patch.cos !== undefined && patch.cos !== null) {
    if (patch.cos.bucket !== undefined) next.cos.bucket = sanitizeText(patch.cos.bucket, 120);
    if (patch.cos.region !== undefined) next.cos.region = sanitizeText(patch.cos.region, 60);
  }
  if (patch.github !== undefined && patch.github !== null) {
    if (patch.github.repo !== undefined) {
      const repo = sanitizeText(patch.github.repo, 200).replace(/^https?:\/\/[^/]+\//, "").replace(/\.git$/, "");
      if (repo.length > 0 && !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new Error("仓库要写成 owner/name");
      if (repo.length > 0) next.github.repo = repo;
    }
    if (patch.github.branch !== undefined) {
      const branch = sanitizeText(patch.github.branch, 80);
      if (branch.length > 0) next.github.branch = branch;
    }
    if (patch.github.baseUrl !== undefined) {
      const url = sanitizeText(patch.github.baseUrl, 200).replace(/\/+$/, "");
      if (url.length > 0 && !/^https?:\/\//.test(url)) throw new Error("服务地址必须以 http:// 或 https:// 开头");
      if (url.length > 0) next.github.baseUrl = url;
    }
  }
  if (patch.local !== undefined && patch.local !== null) {
    if (patch.local.dir !== undefined) next.local.dir = sanitizeText(patch.local.dir, 400);
  }

  // 当前传输是否配齐（只校验「必填」，不校验凭据——凭据在加密库里）
  const meta = TRANSPORT_META[next.transport];
  if (next.enabled === true) {
    const missing = [];
    if (next.transport === "cos") {
      if (next.cos.bucket.length === 0) missing.push("桶名");
      if (next.cos.region.length === 0) missing.push("地域");
    } else if (next.transport === "github" || next.transport === "gitea") {
      if (next.github.repo.length === 0) missing.push("仓库");
    } else if (next.transport === "local") {
      if (next.local.dir.length === 0) missing.push("目录");
    }
    if (missing.length > 0) throw new Error(`开启同步前请先填写：${missing.join("、")}`);
  }
  void meta;
  return next;
}

/**
 * 把完整配置瘦身成「只保留非默认值」的形状，避免把一堆默认值堆进用户的 YAML。
 * 数组/对象按值比较；空串与空对象视为默认。
 */
export function slimConfig(config) {
  const out = {};
  const isDefault = (value, fallback) => {
    if (value === undefined) return true;
    if (JSON.stringify(value) === JSON.stringify(fallback)) return true;
    if (value === "" && (fallback === "" || fallback === undefined)) return true;
    return false;
  };
  for (const [key, value] of Object.entries(config ?? {})) {
    if (key === "github" || key === "cos" || key === "local") {
      const section = {};
      for (const [sub, subValue] of Object.entries(value ?? {})) {
        if (!isDefault(subValue, SYNC_DEFAULTS[key]?.[sub])) section[sub] = subValue;
      }
      // 当前传输的必填字段即使等于默认也要保留（例如 branch: main）
      if (Object.keys(section).length > 0) out[key] = section;
      continue;
    }
    if (!isDefault(value, SYNC_DEFAULTS[key])) out[key] = value;
  }
  return out;
}

/**
 * 通过 DSH 的 configEditor 保存（会热应用）。
 *
 * @param ctx - Cordis ctx。
 * @param buildNext - (currentSyncConfig) => 新配置；抛错即中止保存。
 * @returns {Promise<{ ok: boolean, status: string, message?: string }>}
 */
export async function saveViaConfigEditor(ctx, buildNext) {
  let editor;
  try {
    if (typeof ctx?.get !== "function") throw new Error("没有 ctx.get");
    editor = ctx.get("configEditor");
  } catch {
    editor = undefined;
  }
  if (typeof editor?.edit !== "function") {
    return { ok: false, status: "unavailable", message: "当前 DSH 版本不支持从界面保存配置，请手动编辑 profile 的 cordis.patch.yml" };
  }
  const entry = ctx?.fiber?.entry;
  if (entry === undefined) {
    return { ok: false, status: "no-entry", message: "拿不到本插件的配置条目，无法保存" };
  }
  try {
    await editor.edit(entry, (raw) => {
      const current = raw?.sync ?? {};
      const next = buildNext(current);
      return { ...(raw ?? {}), sync: slimConfig(next) };
    });
    return { ok: true, status: "saved" };
  } catch (error) {
    return { ok: false, status: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}
