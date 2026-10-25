/**
 * 凭据仓库：把用户的 SecretId / SecretKey / Token 存进 **DSH 自带的加密凭据存储**
 * （`ctx.credentials`，即 `@deepseek-ai/dsh-credentials`），而不是自造一套加密。
 *
 * 为什么这么做：
 *   · DSH 的 credentials-local 用原子写入 + 0600 文件 + 文件锁，是官方维护的存储；
 *   · `describeRecord` 只回答 `{ configured, kind, writable }`，**从不返回值**，
 *     所以界面可以安全地展示「已配置 / 未配置」而不泄露内容；
 *   · 换机器、清缓存、卸载插件都不会把明文留在 profile 或 localStorage 里。
 *
 * 回退顺序（从高到低）：
 *   1. DSH 凭据存储（用户在 GUI 里填的；宿主以 0600 + 文件锁写入，非应用层加密）
 *   2. 插件自管的 0600 凭据文件 `<DSH_HOME>/workload-report/credentials.json`
 *      ——**新版 DSH 没有 credentials 服务时的兜底**，让 GUI 仍然能填凭据；
 *   3. 用户自己指定的凭据文件（`cos.secretIdFile` 等）
 *   4. 环境变量（CI / 脚本）
 *   5. 配置内联（不推荐，仅兼容旧配置）
 *
 * 插件不在 cordis 的 `inject` 里声明 credentials（老版 DSH 没有该服务会让插件挂起），
 * 而是用 `ctx.get("credentials")` 可选获取；服务不存在时自动退回自管文件 / 环境变量。
 */

import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { defaultHome } from "./sync-service.js";

/** 本插件在凭据库里的所有者标识（`<owner>/<id>` 的前半段）。 */
export const CREDENTIAL_OWNER = "dsh-workload-report";

/** 每种传输需要的凭据字段。 */
const FIELDS = {
  cos: [
    { id: "secret-id", envKeys: ["WR_COS_SECRET_ID", "COS_SECRET_ID", "TENCENTCLOUD_SECRET_ID"], describe: "SecretId" },
    { id: "secret-key", envKeys: ["WR_COS_SECRET_KEY", "COS_SECRET_KEY", "TENCENTCLOUD_SECRET_KEY"], describe: "SecretKey", secret: true },
  ],
  github: [
    { id: "token", envKeys: ["WR_SYNC_TOKEN", "GITHUB_TOKEN"], describe: "Access token", secret: true },
  ],
};
FIELDS.gitea = FIELDS.github;

/** 某个传输需要的字段定义（未知传输退回 github 那组）。 */
export function fieldsOf(transport) {
  return FIELDS[transport] ?? FIELDS.github;
}

/**
 * 凭据仓库。
 *
 * 只依赖 `ctx.get("credentials")`，服务缺失时所有操作都安全降级。
 */
export class CredentialVault {
  constructor(ctx) {
    this.ctx = ctx;
  }

  /** 可选服务：不存在时返回 undefined（不抛错、不阻塞）。 */
  service() {
    try {
      if (typeof this.ctx?.get !== "function") return undefined;
      return this.ctx.get("credentials") ?? undefined;
    } catch {
      return undefined;
    }
  }

  /** 是否有 DSH 官方凭据服务（有则优先用它；没有则退化为自管 0600 文件）。 */
  get hasService() {
    return typeof this.service()?.describeRecord === "function";
  }

  /**
   * GUI 是否应该渲染凭据表单。
   *
   * 2.0.0 起**恒为 true**：没有官方凭据服务时退化为插件自管的 0600 文件，
   * 用户不必再手改配置文件（旧版这里返回 false，新环境会只显示一句「改用文件」）。
   */
  get available() {
    return true;
  }

  /** 自管凭据文件路径（无官方服务时使用）；与索引文件同一个 DSH_HOME 解析规则。 */
  get fallbackPath() {
    const home = typeof this.ctx?.dshHome === "string" && this.ctx.dshHome.trim().length > 0
      ? this.ctx.dshHome.trim()
      : defaultHome();
    return join(home, "workload-report", "credentials.json");
  }

  /** 读自管凭据文件（不存在/损坏都返回 {}）。 */
  async readFallback() {
    try {
      const text = await readFile(this.fallbackPath, "utf8");
      const parsed = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }

  /** 写自管凭据文件（0600 + 原子替换；只允许字符串值）。 */
  async writeFallback(map) {
    const path = this.fallbackPath;
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(map, null, 2), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, path);
    await chmod(path, 0o600);
  }

  /** 记录 key：`dsh-workload-report/<transport>-<id>`。 */
  keyOf(transport, id) {
    return `${CREDENTIAL_OWNER}/${transport}-${id}`;
  }

  /** 读一个字段的值；不存在返回 null。值只在调用方内部使用，绝不进响应体。 */
  async read(transport, id) {
    const service = this.service();
    if (typeof service?.readRecord === "function") {
      try {
        const record = await service.readRecord(this.keyOf(transport, id));
        if (record?.kind === "api-key") {
          const value = typeof record.key === "string" ? record.key.trim() : "";
          if (value.length > 0) return value;
        }
      } catch {
        /* 服务异常：继续看自管文件 */
      }
    }
    const map = await this.readFallback();
    const value = map[`${transport}/${id}`];
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
  }

  /**
   * 写入（或删除）一个字段。
   * @param value - 非空字符串则写入；null 表示删除该记录。
   */
  async write(transport, id, value) {
    const service = this.service();
    const hasService = typeof service?.modifyRecord === "function";
    const text = value === null ? null : String(value).trim();
    // 空字符串既不写入也不删除：避免用户误提交空表单把已存凭据清掉。
    // 删除请显式传 null（GUI 的「清除凭据」按钮走这条路）。
    if (text !== null && text.length === 0) return { skipped: true };

    if (hasService) {
      const key = this.keyOf(transport, id);
      if (text === null) {
        await service.deleteRecord(key);
        return { deleted: true };
      }
      await service.modifyRecord(key, async () => ({ kind: "api-key", key: text }));
      return { saved: true };
    }

    // 没有官方凭据服务：退化为插件自管 0600 文件，界面仍然可用
    const map = await this.readFallback();
    const slot = `${transport}/${id}`;
    if (text === null) {
      if (!(slot in map)) return { deleted: false };
      delete map[slot];
      await this.writeFallback(map);
      return { deleted: true };
    }
    map[slot] = text;
    await this.writeFallback(map);
    return { saved: true, storage: "file" };
  }

  /** 删除一个字段的记录（不存在时无操作）。 */
  async delete(transport, id) {
    const service = this.service();
    if (typeof service?.deleteRecord === "function") {
      try {
        await service.deleteRecord(this.keyOf(transport, id));
        return { deleted: true };
      } catch {
        /* 继续尝试自管文件 */
      }
    }
    return this.write(transport, id, null);
  }

  /**
   * 每个字段的存在性状态（**不含值**），供 GUI 展示。
   * @returns {Promise<Array<{ id, label, secret, configured, writable, source }>>}
   */
  async status(transport, fileFields = {}) {
    const service = this.service();
    const list = [];
    for (const field of fieldsOf(transport)) {
      let configured = false;
      let writable = false;
      if (typeof service?.describeRecord === "function") {
        try {
          const described = await service.describeRecord(this.keyOf(transport, field.id));
          configured = described?.configured === true;
          writable = described?.writable !== false;
        } catch {
          /* 服务异常：当作未配置 */
        }
      }
      // 无官方服务（或服务里没有）时，自管 0600 文件里的值也算「已配置」
      if (!configured) {
        const fallback = await this.readFallback();
        if (typeof fallback[`${transport}/${field.id}`] === "string") {
          configured = true;
          writable = true;
        }
      }
      // 值也可能来自文件 / 环境变量；用来告诉用户「已经能用了」但不必回填
      let source = configured ? "vault" : null;
      if (!configured) {
        const fromFile = fileFields[field.id];
        if (fromFile === true) source = "file";
        else if (field.envKeys.some((name) => typeof process.env[name] === "string" && process.env[name].length > 0)) source = "env";
      }
      list.push({
        id: field.id,
        label: field.describe,
        secret: field.secret === true,
        configured: configured || source !== null,
        writable,
        source,
        // 清除「加密库」后仍可能由文件/环境变量提供：界面据此提示「仍在用环境变量」
        vaultOnly: configured,
        fallbackSource: configured ? null : source,
      });
    }
    return list;
  }
}

/**
 * 解析一个字段的最终值：加密库 > 文件 > 环境变量 > 内联。
 * @returns {Promise<{ value: string, source: string } | null>}
 */
export async function resolveField({ vault, transport, id, fileValue, envKeys = [], inline }) {
  if (vault !== undefined && vault !== null) {
    const fromVault = await vault.read(transport, id);
    if (fromVault !== null) return { value: fromVault, source: "vault" };
  }
  if (typeof fileValue === "string" && fileValue.length > 0) return { value: fileValue, source: "file" };
  for (const name of envKeys) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim().length > 0) return { value: value.trim(), source: "env" };
  }
  if (typeof inline === "string" && inline.trim().length > 0) return { value: inline.trim(), source: "config" };
  return null;
}
