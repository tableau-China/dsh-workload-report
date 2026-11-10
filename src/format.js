/** 展示层格式化：宿主、报告与客户端共用（客户端由 esbuild 打包进来）。 */

// 单位统一用小写 h/m/s：与 Token 的 K/M/B 一样是语言无关的写法，
// 中英文界面共用同一份格式，避免每个语言各写一套"小时/分/秒"。
const HOUR_MS = 3600000;
const MINUTE_MS = 60000;

/** 去掉 toFixed 产生的 ".0" 尾零，但保留 1 位有效小数（1.50 → 1.5，3.0 → 3）。 */
function trimZero(text) {
  return text.replace(/\.0$/, "");
}

/**
 * 人类可读时长（毫秒）——**全站唯一**的小时 / 分钟换算入口。
 * 规则：不足 1 小时用分钟（不足 1 分钟用秒）；1 小时及以上固定保留 1 位小数（去掉 .0），
 * 例如 1.63 h → "1.6 h"、20 min → "20 m"。看板、图例、KPI 副文本、工作区、会话表、
 * 导出报告都走这里，不允许各自 toFixed。
 * @param ms - 毫秒。
 * @returns 例如 "1.6 h" / "20 m" / "800 s"。
 */
export function formatHours(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value === 0) return "0";
  if (value >= HOUR_MS) return `${trimZero((value / HOUR_MS).toFixed(1))} h`;
  if (value >= MINUTE_MS) return `${trimZero((value / MINUTE_MS).toFixed(1))} m`;
  return `${Math.max(1, Math.round(value / 1000))} s`;
}

/** 紧凑 token 数：1234 → 1.23K，1234567 → 1.23M。 */
export function formatTokens(value) {
  const n = Number.isFinite(value) && value > 0 ? value : 0;
  if (n < 1000) return String(Math.round(n));
  for (const [limit, suffix] of [[1e6, "K"], [1e9, "M"], [1e12, "B"]]) {
    if (n < limit) {
      const scaled = n / (limit / 1000);
      return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(2)} ${suffix}`;
    }
  }
  return `${(n / 1e12).toFixed(1)} T`;
}

/** 千分位整数。 */
export function formatInt(value) {
  return Math.round(Number.isFinite(value) ? value : 0).toLocaleString("en-US");
}

/** 百分比：0.1234 → "12.3%"。 */
export function formatPercent(value, digits = 1) {
  const n = Number.isFinite(value) ? value : 0;
  return `${(n * 100).toFixed(digits)}%`;
}

/**
 * 金额显示：CNY 用 ¥、USD 用 $；金额 ≥1 保留 2 位、<1 保留 4 位小数；没有值时显示 —（不编数字）。
 * 看板的费用 KPI 与余额 chip 共用这一份口径。
 * @param value - 金额（number）；null / undefined / 非数字 → "—"。
 * @param currency - "CNY" | "USD"。
 * @returns 例如 "¥12.34" / "$0.1500" / "—"。
 */
export function formatMoney(value, currency) {
  const n = Number(value);
  if (value === null || value === undefined || !Number.isFinite(n)) return "\u2014";
  return `${currency === "USD" ? "$" : "\u00a5"}${n < 1 ? n.toFixed(4) : n.toFixed(2)}`;
}

/**
 * 输出速度（tok/s）：≥100 取整，<100 保留 1 位小数。
 * null / 非数字 → "—"：官方没上报 decode 窗口时不能显示 0（那会被读成「真的很慢」）。
 * @param tps - 每秒输出 token 数。
 * @returns 例如 "121" / "98.4" / "—"。
 */
export function formatSpeed(tps) {
  const n = Number(tps);
  if (tps === null || tps === undefined || !Number.isFinite(n) || n <= 0) return "\u2014";
  return n >= 100 ? String(Math.round(n)) : trimZero(n.toFixed(1));
}

/**
 * 首字延迟（毫秒）：不足 1 分钟用秒（1 位小数），1 分钟以上交给 formatHours。
 * @param ms - 毫秒；null / 非数字 → "—"。
 * @returns 例如 "6.5 s" / "1.2 m" / "—"。
 */
export function formatTtft(ms) {
  const n = Number(ms);
  if (ms === null || ms === undefined || !Number.isFinite(n) || n <= 0) return "\u2014";
  if (n >= MINUTE_MS) return formatHours(n);
  return `${trimZero((n / 1000).toFixed(1))} s`;
}

/**
 * 供应商短名：只取路径最后一段（`magpie/workbuddy-ai` → `workbuddy-ai`）。
 * 表格里同模型的多条链路靠它区分；完整路径由调用方放进 title 提示。
 * @param provider - 供应商全路径；空值 → "—"。
 */
export function formatProvider(provider) {
  const text = typeof provider === "string" ? provider.trim() : "";
  if (text === "") return "\u2014";
  const parts = text.split("/").filter((part) => part !== "");
  return parts.length > 0 ? parts[parts.length - 1] : text;
}

/**
 * 已知凭据路由 → 本地化文案键（数据层只给键，文案由词典提供，不写死中文）。
 * `deepseek-account` = 官方 DeepSeek 账户登录态；`deepseek-official` = 用户配置的 DeepSeek API Key。
 * 两者都用 `deepseek-flash` / `deepseek-v4-pro`，靠 provider 区分（见 docs/models.md）。
 */
export const PROVIDER_LABEL_KEYS = {
  "deepseek-account": "model.provider.deepseekAccount",
  "deepseek-official": "model.provider.deepseekApiKey",
};

/** 生成本地化供应商名映射（供 disambiguateModelLabels / providerLabel 复用）。 */
export function providerDisplayNames(t) {
  const names = {};
  for (const [id, key] of Object.entries(PROVIDER_LABEL_KEYS)) names[id] = t(key);
  return names;
}

/** 供应商展示名：官方账户 / API Key 换成可读文案，其它沿用短名（完整路径由调用方放进 title）。 */
export function providerLabel(provider, t) {
  const key = PROVIDER_LABEL_KEYS[provider];
  return key === undefined ? formatProvider(provider) : t(key);
}

/**
 * 同名模型消歧：同一模型走多条链路时，在显示名后补供应商短名。
 *
 * 看板（趋势图例 / treemap / 明细表）与 HTML 报告共用这一份，避免各写一套、
 * 导出后名称不一致。只在**重名**时补后缀，单个模型保持原名不变。
 *
 * @param models - byModel 行数组。
 * @param unknownLabel - 未知模型的本地化兜底文案。
 * @param providerLabels - 可选的 `{ provider: 本地化名 }` 映射（缺省用 formatProvider 短名）。
 * @returns 新数组（不改原行）。
 */
export function disambiguateModelLabels(models, unknownLabel, providerLabels = null) {
  const counts = new Map();
  for (const item of models) counts.set(item.label, (counts.get(item.label) ?? 0) + 1);
  return models.map((item) => {
    const label = item.label || unknownLabel;
    if (!(counts.get(item.label) > 1 && item.provider)) return { ...item, label };
    const short = providerLabels?.[item.provider] ?? formatProvider(item.provider);
    return { ...item, label: `${label} · ${short}` };
  });
}

/** HTML 转义（报告是字符串拼接生成，必须转义一切外部文本）。 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
