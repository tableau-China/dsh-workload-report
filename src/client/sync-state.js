/**
 * 「设备同步」弹窗的纯逻辑（不依赖 React，便于离线断言直接 import）。
 *
 *   · FREQUENCY_OPTIONS / FREQUENCY_TEXT_KEYS —— 同步频率候选（2.0.3 先预留界面，后台周期下一版上线）；
 *   · ICON_TEXT_KEYS —— 配置状态图标的文案键（对号 / 圆圈 / 感叹号）；
 *   · configureIconState —— 由「是否开启 / 是否配齐 / 自检结果」推出图标语义。
 */

/** 同步频率候选（2.0.2 起界面预留；开关随后台同步周期上线）。 */
export const FREQUENCY_OPTIONS = [
  { id: "6h", hours: 6, ready: true },
  { id: "12h", hours: 12, ready: false },
  { id: "boot", hours: 0, ready: false },
];

/**
 * 配置状态 → 图标语义（「对号 / 圆圈 / 感叹号」）。
 *
 *   configured —— 已配置且最近一次自检通过 → ✓（对号，绿色）
 *   failed     —— 配了但连不上（自检失败 / 同步报错）→ !（感叹号，琥珀色）
 *   off        —— 已配置但用户没开同步 → 圆圈（空心，muted）
 *   unchecked  —— 已开启但还没自检过 → 圆圈（虚线，说明"待测试"）
 *   none       —— 没配置 → 圆圈（空心，muted）
 */
export function configureIconState({ enabled = false, configured = false, probeOk = null } = {}) {
  if (probeOk === false) return "failed";
  if (enabled !== true) return configured ? "off" : "none";
  if (probeOk === true) return "configured";
  return "unchecked";
}

/** 配置状态图标 → 文案键（显式表：避免模板拼接，i18n 死键检查才能扫到每个键）。 */
export const ICON_TEXT_KEYS = {
  configured: "set.icon.configured",
  failed: "set.icon.failed",
  off: "set.icon.off",
  unchecked: "set.icon.unchecked",
  none: "set.icon.none",
};

/** 同步频率 → 文案键（同上，显式表）。 */
export const FREQUENCY_TEXT_KEYS = {
  "6h": "set.freq.6h",
  "12h": "set.freq.12h",
  boot: "set.freq.boot",
};


/** 设备 id 缩略：只展示前 8 位，避免一长串 UUID 占满一行。 */
export function shortDeviceId(id) {
  const text = typeof id === "string" ? id.trim() : "";
  if (text.length === 0) return "";
  // sha1 兜底是 40 位 hex、DSH 的是 UUID：都取前 8 位 + 省略号
  return text.length <= 10 ? text : `${text.slice(0, 8)}…`;
}

/**
 * 名字变了数据还在吗？——把「本机」与其它设备按**设备 id**做前后对照。
 *
 * 设备身份用的是 `<DSH_HOME>/.anonymous-user-id`（每台安装一个随机 UUID，与名字无关），
 * 所以改「本机显示名」只是换标签，`{machineId}` 模板、远端对象 key、合并去重全都不受影响。
 * 这个函数用于在界面上**把这件事说清楚**，并在真的换了一台机器（id 不同）时提醒。
 *
 * @param devices - /sync 的 status.devices（[{key,id,name,local}]）。
 * @param previousName - 保存前的显示名（用于显示"从 X 改成了 Y"）。
 * @param nextName - 保存后的显示名（空串表示跟随 hostname）。
 * @returns {{ renamed: boolean, local: object|null, others: object[], sameCount: number, previousName: string, nextName: string }}
 */
export function deviceRenameReport(devices, previousName, nextName) {
  const list = Array.isArray(devices) ? devices : [];
  const local = list.find((item) => item.local === true) ?? null;
  const others = list.filter((item) => item.local !== true);
  const before = typeof previousName === "string" ? previousName.trim() : "";
  const after = typeof nextName === "string" ? nextName.trim() : "";
  return {
    renamed: before !== after,
    local,
    others,
    sameCount: others.filter((item) => typeof item.id === "string" && item.id.length > 0).length,
    previousName: before,
    nextName: after,
  };
}

/** 只读路径的预览：key 模板 → 人类可读的「本次会写到哪」。 */
export function pathPreview(template, { machineId = "", machineName = "" } = {}) {
  const pattern = typeof template === "string" && template.trim().length > 0 ? template.trim() : "machines/{machineId}.json";
  return pattern
    .replaceAll("{machineId}", machineId || "{machineId}")
    .replaceAll("{machineName}", machineName || "{machineName}");
}

/**
 * key 模板 → 目录前缀（同步服务与客户端共用同一份实现，避免两处规则漂移）。
 * 这里是**纯函数**，不依赖 node: 模块，所以客户端也能 import。
 *
 * @param path - key 模板，如 `machines/{machineId}.json` / `dsh-workload-sync/machines/{machineId}.json`。
 * @returns 目录前缀，如 `machines/` / `dsh-workload-sync/machines/`；模板无目录段时返回 ""。
 */
export function prefixOf(path) {
  const template = typeof path === "string" && path.trim().length > 0 ? path.trim() : "machines/{machineId}.json";
  const withoutPlaceholders = template.replace(/\{machineId\}/g, "_").replace(/\{machineName\}/g, "_");
  const cut = withoutPlaceholders.lastIndexOf("/");
  if (cut < 0) return "";
  return withoutPlaceholders.slice(0, cut + 1).replace(/^\/+/, "");
}

/**
 * 设备身份防回归：保存设置时对比「基准 id」与「现在解析出的 id」。
 *
 * 设备身份 = `<DSH_HOME>/.anonymous-user-id`，与显示名无关；唯一会变的情况是
 * 换了 DSH 账户 / DSH_HOME 或删了该文件。没有基准（首次保存）时不算冲突。
 *
 * @returns {{ ok: boolean, previous: string, current: string }}
 */
export function checkMachineIdentity(previousId, currentId) {
  const before = typeof previousId === "string" ? previousId.trim() : "";
  const now = typeof currentId === "string" ? currentId.trim() : "";
  if (before.length === 0 || now.length === 0) return { ok: true, previous: before, current: now };
  return { ok: before === now, previous: before, current: now };
}

/** 设备 id 的人读形式（与 shortDeviceId 同口径，供同步服务复用）。 */
export function shortMachineId(id) {
  return shortDeviceId(id);
}
