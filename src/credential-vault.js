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
 *   1. 加密凭据库（用户在 GUI 里填的）
 *   2. 凭据文件（0600，高级用户 / 无 GUI 场景）
 *   3. 环境变量（CI / 脚本）
 *   4. 配置内联（不推荐，仅兼容旧配置）
 *
 * 插件不在 cordis 的 `inject` 里声明 credentials（老版 DSH 没有该服务会让插件挂起），
 * 而是用 `ctx.get("credentials")` 可选获取；服务不存在时自动退回文件 / 环境变量。
 */

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

  /** 加密凭据库是否可用（GUI 表单据此决定是否渲染）。 */
  get available() {
    return typeof this.service()?.describeRecord === "function";
  }

  /** 记录 key：`dsh-workload-report/<transport>-<id>`。 */
  keyOf(transport, id) {
    return `${CREDENTIAL_OWNER}/${transport}-${id}`;
  }

  /** 读一个字段的值；不存在返回 null。值只在调用方内部使用，绝不进响应体。 */
  async read(transport, id) {
    const service = this.service();
    if (typeof service?.readRecord !== "function") return null;
    try {
      const record = await service.readRecord(this.keyOf(transport, id));
      if (record?.kind !== "api-key") return null;
      const value = typeof record.key === "string" ? record.key.trim() : "";
      return value.length > 0 ? value : null;
    } catch {
      return null;
    }
  }

  /**
   * 写入（或删除）一个字段。
   * @param value - 非空字符串则写入；null 表示删除该记录。
   */
  async write(transport, id, value) {
    const service = this.service();
    if (typeof service?.modifyRecord !== "function") {
      throw new Error("当前 DSH 版本没有加密凭据存储，无法在界面中保存凭据。请改用凭据文件或环境变量。");
    }
    const key = this.keyOf(transport, id);
    if (value === null) {
      await service.deleteRecord(key);
      return { deleted: true };
    }
    const text = String(value).trim();
    // 空字符串既不写入也不删除：避免用户误提交空表单把已存凭据清掉。
    // 删除请显式传 null（GUI 的「清除凭据」按钮走这条路）。
    if (text.length === 0) return { skipped: true };
    await service.modifyRecord(key, async () => ({ kind: "api-key", key: text }));
    return { saved: true };
  }

  /** 删除一个字段的记录（不存在时无操作）。 */
  async delete(transport, id) {
    const service = this.service();
    if (typeof service?.deleteRecord !== "function") return { deleted: false };
    try {
      await service.deleteRecord(this.keyOf(transport, id));
      return { deleted: true };
    } catch {
      return { deleted: false };
    }
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
