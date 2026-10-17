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

/** HTML 转义（报告是字符串拼接生成，必须转义一切外部文本）。 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
