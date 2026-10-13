/** 展示层格式化：宿主、报告与客户端共用（客户端由 esbuild 打包进来）。 */

// 单位统一用小写 h/m/s：与 Token 的 K/M/B 一样是语言无关的写法，
// 中英文界面共用同一份格式，避免每个语言各写一套"小时/分/秒"。
const DURATION_UNITS = [
  { limit: 60000, suffix: "s", scale: 1000, digits: 1 },
  { limit: 3600000, suffix: "m", scale: 60000, digits: 1 },
  { limit: Infinity, suffix: "h", scale: 3600000, digits: 2 },
];

/**
 * 人类可读时长（毫秒）。表格、tooltip、报告等"信息密度高"的地方用它。
 * @param ms - 毫秒。
 * @returns 例如 "3.4 h" / "12.5 m" / "800 s"。
 */
export function formatDuration(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value === 0) return "0";
  const unit = DURATION_UNITS.find((u) => value < u.limit) ?? DURATION_UNITS[DURATION_UNITS.length - 1];
  const scaled = value / unit.scale;
  const digits = scaled >= 100 ? 0 : unit.digits;
  // 去掉多余尾零：1.50 → 1.5，3.00 → 3
  const text = scaled.toFixed(digits).replace(/\.?0+$/, "");
  return `${text} ${unit.suffix}`;
}

/**
 * KPI 卡专用时长：数值大、只扫一眼，所以固定精度——
 * ≥1 小时保留一位小数（223.2 h），不足 1 小时用整数 m / s（45 m / 12 s）。
 * 与 formatDuration 的区别只在精度，不在口径。
 * @param ms - 毫秒。
 * @returns 例如 "223.2 h" / "45 m" / "12 s"。
 */
export function formatKpiDuration(ms) {
  const value = Number.isFinite(ms) && ms > 0 ? ms : 0;
  if (value === 0) return "0";
  if (value >= 3600000) return `${(value / 3600000).toFixed(1)} h`;
  if (value >= 60000) return `${Math.round(value / 60000)} m`;
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

/** HTML 转义（报告是字符串拼接生成，必须转义一切外部文本）。 */
export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
