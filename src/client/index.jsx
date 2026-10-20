/**
 * dsh-workload-report — 客户端（浏览器）半部。
 *
 * 在侧边栏底部加一个「工作量报告」按钮，点开一个全屏看板：KPI 卡片 + 按日期趋势 +
 * 按工作区排行 + 主要会话，并提供「导出 HTML 报告」。数据来自宿主半部的只读接口。
 * 图表是手写 SVG，不引第三方图表库；样式全部用宿主主题 token，自动适配浅色/深色。
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { STYLES } from "./styles.js";
import { NS, en, languageOf, translate, zh } from "./locales.js";
import { formatHours, formatInt, formatMoney, formatPercent, formatTokens } from "../format.js";
import { balanceChip } from "./balance.js";
import { MetricBarCell } from "./bar-cell.jsx";
import { Chip, ChipGroup } from "./chips.jsx";
import { CardHead } from "./card-head.jsx";
import { ProfileCard } from "./profile-card.jsx";
import { SESSION_PAGE_SECTIONS } from "./session-layout.js";
import { hourTokensNote } from "./hour-status.js";
import { sectorPath } from "../sector-path.js";
import {
  HOUR_DOT_TOP,
  hourBarPercent,
  hourDotRatio,
  hourDotRadius,
  hourMeasureMax,
  hourMeasureValue,
} from "../hour-scale.js";

/** 宿主半部注册的只读接口前缀（与 index.js 的默认 apiPath 一致）。 */
const API_PATH = "/workload-report/v1";

/** 时间范围预设（近 N 天 / 全部）。 */
const RANGES = [
  { days: 7, key: "range.7" },
  { days: 30, key: "range.30" },
  { days: 90, key: "range.90" },
  // 「全部」不写死天数：由宿主按"最早的活跃日 → 今天"决定区间
  { days: 3650, key: "range.all", all: true },
];

/** 统计范围。 */
const SCOPES = ["all", "main", "subagent"];

/**
 * 「按日期明细」的列（骨架屏与真实表格共用，列顺序不会漂）。
 * 带 value 的列渲染比例条（与「主要会话」共用 MetricBarCell）；日期明细用
 * 「Token 合计」替代「步骤」，8 列在窄屏也放得下。
 */
const DETAIL_COLUMNS = [
  { key: "date", labelKey: "table.date", text: (day) => day.date },
  { key: "conversations", labelKey: "table.conversations", value: (day) => day.conversations ?? 0, format: formatInt },
  { key: "turns", labelKey: "table.turns", value: (day) => day.turns ?? 0, format: formatInt },
  { key: "active", labelKey: "table.active", kind: "activeMs", value: (day) => day.activeMs ?? 0, format: formatHours },
  { key: "tokens", labelKey: "table.tokens", kind: "tokens", value: (day) => day.tokensTotal ?? 0, format: formatTokens },
  { key: "input", labelKey: "table.input", text: (day) => formatTokens(day.tokens?.input ?? 0) },
  { key: "output", labelKey: "table.output", text: (day) => formatTokens(day.tokens?.output ?? 0) },
  { key: "cache", labelKey: "table.cache", text: (day) => formatTokens(day.tokens?.cacheRead ?? 0) },
];

/** KPI 卡片顺序（骨架屏与真实卡片共用，卡片数量/顺序不会漂）。 */
const KPI_KEYS = ["kpi.active", "kpi.tokens", "kpi.modelCost", "kpi.activeDays", "kpi.conversations", "kpi.turns", "kpi.cache", "kpi.topModel"];

/** 需要 inject 的服务：插槽注册表 + 国际化。 */
export const inject = ["slots", "locale"];

/** 面板开关：一个极小的外部 store，两个插槽组件共享。 */
function createPanelControl() {
  let open = false;
  const listeners = new Set();
  const set = (next) => {
    if (open === next) return;
    open = next;
    for (const listener of listeners) listener();
  };
  return {
    isOpen: () => open,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    open: () => set(true),
    close: () => set(false),
  };
}

/** 模块级 locale 运行时（与宿主 locale 服务订阅）。 */
let localeRuntime = null;

/** 读取当前语言并给出翻译函数。 */
const FALLBACK_LOCALE = { active: "zh", revision: 0 };

function useLocale() {
  const snapshot = useSyncExternalStore(
    (callback) => (typeof localeRuntime?.subscribe === "function" ? localeRuntime.subscribe(callback) : () => {}),
    () => (typeof localeRuntime?.getSnapshot === "function" ? localeRuntime.getSnapshot() : FALLBACK_LOCALE),
  );
  const lang = languageOf(snapshot.active);
  return { lang, t: (key, vars) => translate(lang, key, vars) };
}

/** 本机时区。 */
function localTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** 当前是否深色主题（宿主在 body 上打标记）。 */
function isDarkTheme() {
  return document.body?.hasAttribute("data-ds-dark-theme") === true;
}

/** 费用显示（与金额同口径；保留历史导出名，实现见 src/format.js 的 formatMoney）。 */
export const formatCost = formatMoney;

/** 拉取聚合快照。 */
/**
 * 快照内存缓存（面板关闭后仍保留）：再次打开时**先用上次结果立即渲染**，随后后台刷新。
 * 这是"每次打开都要等一会儿"的主要解法——数据通常没变，先渲染旧值体感就是秒开。
 */
const SNAPSHOT_CACHE = new Map();
const snapshotKey = ({ days, scope, all }) => `${days}|${scope}|${all === true ? "all" : "range"}`;

function useSnapshot({ days, scope, refreshKey, enabled, all }) {
  const key = snapshotKey({ days, scope, all });
  const [state, setState] = useState(() => {
    const cached = SNAPSHOT_CACHE.get(key);
    return cached === undefined
      ? { status: "loading", data: null, error: null, key }
      : { status: "refreshing", data: cached, error: null, key };
  });
  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    const cached = SNAPSHOT_CACHE.get(key);
    setState((previous) => {
      if (previous.key === key && previous.data !== null) return { ...previous, status: "refreshing" };
      if (cached === undefined) return { status: "loading", data: null, error: null, key };
      return { status: "refreshing", data: cached, error: null, key };
    });
    const query = new URLSearchParams({
      days: String(days),
      scope,
      tz: localTimeZone(),
    });
    if (all) query.set("all", "1");
    fetch(`${API_PATH}/snapshot?${query.toString()}`, { signal: abort.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((data) => {
        SNAPSHOT_CACHE.set(key, data);
        setState({ status: "ready", data, error: null, key });
      })
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setState((previous) => ({ status: "error", data: previous.data, error: String(error?.message ?? error) }));
      });
    return () => abort.abort();
  }, [days, scope, refreshKey, enabled, all, key]);
  return state;
}

/** 图表图标。 */
function ChartIcon({ size = 16 }) {
  return (
    <svg className="wl-icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
      <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
    </svg>
  );
}

/** 侧边栏底部按钮。 */
function FooterAction({ control, wide }) {
  const { t } = useLocale();
  return (
    <button type="button" className="wl-footer-item" title={t("action.title")} onClick={() => control.open()}>
      <ChartIcon size={wide ? 16 : 18} />
      {wide ? <span>{t("action.label")}</span> : null}
    </button>
  );
}

/** 余额轮询间隔：宿主按 refreshMs 缓存，客户端 5 分钟拉一次足够（打的是本机路由，不是外网）。 */
const BALANCE_POLL_MS = 5 * 60 * 1000;

/**
 * 顶部工具栏余额数据：只打宿主本机 /balance。
 * 默认关闭时宿主立即返回 enabled:false → balanceChip 返回 null → 完全不渲染；
 * 本机路由失败时保持上一次结果（不制造假状态）。
 */
function useBalance() {
  const [balance, setBalance] = useState(null);
  useEffect(() => {
    const abort = new AbortController();
    const load = () => {
      fetch(`${API_PATH}/balance?tz=${encodeURIComponent(localTimeZone())}`, { signal: abort.signal, headers: { accept: "application/json" } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data) => setBalance(data?.balance ?? null))
        .catch(() => { /* 本机路由失败：保持上一次结果，chip 不弹错 */ });
    };
    load();
    const timer = setInterval(load, BALANCE_POLL_MS);
    return () => {
      abort.abort();
      clearInterval(timer);
    };
  }, []);
  return balance;
}

/**
 * 顶部工具栏的紧凑余额 chip。
 * 四种状态由 balanceChip（src/client/balance.js）统一决定，组件只负责渲染；
 * 未启用时 balanceChip 返回 null，整个 chip 不渲染（含外壳）。
 */
function BalanceChip() {
  const { t } = useLocale();
  const balance = useBalance();
  const chip = balanceChip(balance, t);
  if (chip === null) return null;
  return (
    <div className="wl-balance" data-kind={chip.kind} title={t("balance.title")}>
      <span className="wl-balance-text">{chip.text}</span>
      {chip.sub === null ? null : <span className="wl-balance-sub">{chip.sub}</span>}
      {chip.link === null ? null : (
        <a className="wl-balance-link" href={chip.link.href} target="_blank" rel="noreferrer noopener">{chip.link.label}</a>
      )}
    </div>
  );
}

/** ISO 周（周一为一周起点），返回 { year, week }。 */
function isoWeek(dateKey) {
  const date = new Date(`${dateKey}T00:00:00Z`);
  const weekday = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - weekday + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  firstThursday.setUTCDate(firstThursday.getUTCDate() - ((firstThursday.getUTCDay() + 6) % 7) + 3);
  return { year: date.getUTCFullYear(), week: 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400000)) };
}

/** 从 from 起逐日遍历到 to（UTC 日期算术，避免夏令时干扰）。 */
function eachDate(from, to, limit = 1000) {
  const out = [];
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  while (cursor <= end && out.length < limit) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return out;
}

/**
 * 日历热力图：纵轴周一～周日，横轴 Year-Week，颜色深浅＝活跃时长（受顶部区间筛选控制）。
 */
function CalendarHeatmap({ calendar, t, availableHeight = 0 }) {
  const model = useMemo(() => {
    const byDate = new Map((calendar?.days ?? []).map((day) => [day.date, day]));
    const dates = eachDate(calendar?.from ?? "", calendar?.to ?? "");
    if (dates.length === 0) return null;
    const columns = new Map();
    const weekdayTotals = Array.from({ length: 7 }, () => 0);
    for (const date of dates) {
      const { year, week } = isoWeek(date);
      const key = `${year}-W${String(week).padStart(2, "0")}`;
      if (!columns.has(key)) columns.set(key, { key, year, week, cells: new Map() });
      const weekday = (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
      const day = byDate.get(date) ?? null;
      columns.get(key).cells.set(weekday, { date, day });
      weekdayTotals[weekday] += day?.activeMs ?? 0;
    }
    const list = [...columns.values()];
    const max = Math.max(1, ...[...byDate.values()].map((day) => day.activeMs));
    const maxWeekday = Math.max(1, ...weekdayTotals);
    return { list, max, weekdayTotals, maxWeekday, dayCount: byDate.size };
  }, [calendar]);

  if (model === null) return <p className="wl-state">{t("state.empty")}</p>;
  const gap = 3;
  const leftPad = 30;
  const topPad = 18;
  const barArea = 54;
  const valueArea = 44;
  // cell 从容器真实高度反解：日历始终填满卡片剩余高度（不再在下方留大片空白）。
  // 不按可用宽度压缩格子——列数多时 SVG 自然变宽，交给 .wl-cal-scroll 横向滚动；
  // 纵向必须完整可见：填不满只会缩短，绝不溢出裁切（上限 30 保持格子不过分夸张）。
  const columns = Math.max(1, model.list.length);
  const fallback = columns > 30 ? 11 : columns > 14 ? 15 : 20;
  // 7 行之间有 7 个 (cell+gap) 步长（含底部一格间距），故预留 7*gap
  const byHeight = availableHeight > 0 ? (availableHeight - topPad - 4 - 7 * gap) / 7 : fallback;
  const cell = Math.max(6, Math.min(30, byHeight));
  const calendarWidth = leftPad + columns * (cell + gap);
  const barX = calendarWidth + 8;
  const width = barX + barArea + valueArea;
  // 兜底：绝不超过容器高度（正常 byHeight 已让高度正好等于容器高度）
  const height = availableHeight > 0 ? Math.min(topPad + 7 * (cell + gap) + 4, availableHeight) : topPad + 7 * (cell + gap) + 4;
  const level = (ms) => {
    if (!(ms > 0)) return 0;
    const ratio = ms / model.max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  const fills = [
    "var(--dsw-alias-bg-layer-2, #eef0f3)",
    "var(--dsw-static-deepseek-100, #dfe5ff)",
    "var(--dsw-static-deepseek-300, #a9b8ff)",
    "var(--dsw-static-deepseek-500, #4d6bfe)",
    "var(--dsw-static-deepseek-700, #2b3fa8)",
  ];
  const weekdayLabels = [t("cal.mon"), t("cal.tue"), t("cal.wed"), t("cal.thu"), t("cal.fri"), t("cal.sat"), t("cal.sun")];
  /** 周末后缀（含前导分隔符）；由行号判定，周一行号为 0。 */
  const weekendOf = (row) => (row >= 5 ? t("tip.weekend") : "");
  /** 单行可读提示：日期 · 活跃 x · Token y [· 周末]；无记录也保留日期与周末标记。 */
  const dayTip = (date, day, weekend) =>
    day === null || day === undefined
      ? `${date} · ${t("tip.noRecord")}${weekend}`
      : t("tip.daily", { date, active: formatHours(day.activeMs ?? 0), tokens: formatTokens(day.tokensTotal ?? 0), weekend });

  return (
    <div className="wl-cal-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("cal.title")}>
        {/* 周几轴：每个标签也带累计提示，避免悬停到轴文字时完全没有反馈 */}
        {weekdayLabels.map((label, row) => (
          <text key={label} x={0} y={topPad + row * (cell + gap) + cell * 0.72} fontSize="10" fill="var(--dsw-alias-label-tertiary, #6b7280)">
            {label}
            <title>{t("tip.weekday", { weekday: label, total: formatHours(model.weekdayTotals[row]) })}</title>
          </text>
        ))}
        {model.list.map((column, index) => {
          const x = leftPad + index * (cell + gap);
          const showLabel = index === 0 || column.week === 1 || column.year !== model.list[index - 1]?.year || index % 4 === 0;
          const labelText = column.week === 1 || index === 0 || column.year !== model.list[index - 1]?.year
            ? `${column.year}W${String(column.week).padStart(2, "0")}`
            : `W${String(column.week).padStart(2, "0")}`;
          const columnTotal = [...column.cells.values()].reduce((sum, entry) => sum + (entry.day?.activeMs ?? 0), 0);
          return (
            <g key={column.key}>
              {showLabel ? (
                <text x={x} y={11} fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
                  {labelText}
                  <title>{t("tip.week", { year: column.year, week: String(column.week).padStart(2, "0"), total: formatHours(columnTotal) })}</title>
                </text>
              ) : null}
              {[0, 1, 2, 3, 4, 5, 6].map((row) => {
                const entry = column.cells.get(row);
                if (entry === undefined) return null;
                const activeMs = entry.day?.activeMs ?? 0;
                const weekend = weekendOf(row);
                // title 必须直接挂在可 hover 的 rect 上（不能挂在 <g> 上，多数浏览器不弹）
                return (
                  <rect
                    key={entry.date}
                    data-kind="calendar-cell"
                    data-date={entry.date}
                    data-weekend={row >= 5 ? "true" : undefined}
                    x={x}
                    y={topPad + row * (cell + gap)}
                    width={cell}
                    height={cell}
                    rx="3"
                    fill={fills[level(activeMs)]}
                  >
                    <title>{dayTip(entry.date, entry.day ?? null, weekend)}</title>
                  </rect>
                );
              })}
            </g>
          );
        })}
        {/* 紧贴最后一列：每周几的累计活跃时长（横向条），一眼看出周几更活跃 */}
        <line x1={barX - 4} y1={topPad} x2={barX - 4} y2={topPad + 7 * (cell + gap) - gap} stroke="var(--dsw-alias-border-l2, #e5e7eb)" />
        {model.weekdayTotals.map((total, row) => {
          const y = topPad + row * (cell + gap);
          const barWidth = (total / model.maxWeekday) * barArea;
          return (
            <g key={row}>
              <rect
                data-kind="weekday-bar"
                data-weekday={row}
                x={barX}
                y={y + cell * 0.12}
                width={Math.max(barWidth, total > 0 ? 1.5 : 0)}
                height={cell * 0.76}
                rx="2"
                fill="var(--dsw-static-deepseek-400, #6b83ff)"
                opacity="0.9"
              >
                <title>{t("tip.weekday", { weekday: weekdayLabels[row], total: formatHours(total) })}</title>
              </rect>
              <text x={barX + barArea + 5} y={y + cell * 0.78} fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
                {total > 0 ? formatHours(total) : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/**
 * 24 小时时刻分析（横轴 0–23）。
 *
 * · 柱高＝当前 measure：Tokens（默认，该小时 assistant/message 的 Token 合计）或轮次（starts）。
 * · 只在最大柱上标数值（切 measure 时同步换数值与格式）。
 * · 顶部圆点＝人类消息密度（user/message 条数）：半径 3.4 + ratio×5.0，上沿恒留 14px。
 * · 图例只解释颜色，不写"(点越大越多)"之类的解释。
 */
function HourChart({ hours, t, measure = "tokens", status = null }) {
  const max = hourMeasureMax(hours, measure);
  const maxHuman = Math.max(0, ...hours.map((hour) => hour.humanMsgs ?? 0));
  const peak = hours.reduce(
    (best, hour) => (hourMeasureValue(hour, measure) > hourMeasureValue(best, measure) ? hour : best),
    hours[0],
  );
  const peakValue = hourMeasureValue(peak, measure);
  const valueText = (value) => (measure === "turns" ? formatInt(value) : formatTokens(value));
  const tip = (hour) =>
    t("hour.tip", {
      hour: hour.hour,
      tokens: formatTokens(hour.tokensTotal ?? 0),
      turns: formatInt(hour.starts ?? 0),
      humans: formatInt(hour.humanMsgs ?? 0),
    });
  return (
    <>
      <div className="wl-hour-grid" data-measure={measure}>
        {hours.map((hour) => {
          const value = hourMeasureValue(hour, measure);
          const isPeak = hour.hour === peak?.hour && value > 0;
          const ratio = hourDotRatio(hour.humanMsgs, maxHuman);
          const radius = hourDotRadius(ratio);
          return (
            // 原生 title 提示跟随鼠标；密度点另有自己的 title（小时 + 人类消息条数）
            <div className="wl-hour-col" key={hour.hour} data-peak={isPeak || undefined} title={tip(hour)}>
              {hour.humanMsgs > 0 ? (
                <span
                  className="wl-hour-dot"
                  data-kind="hour-dot"
                  title={t("hour.dotTip", { hour: hour.hour, humans: formatInt(hour.humanMsgs) })}
                  style={{
                    width: `${(radius * 2).toFixed(1)}px`,
                    height: `${(radius * 2).toFixed(1)}px`,
                    top: `${HOUR_DOT_TOP}px`,
                  }}
                />
              ) : null}
              <div className="wl-hour-track">
                {isPeak ? (
                  <div className="wl-hour-value" style={{ bottom: `calc(${hourBarPercent(value, max).toFixed(1)}% + 3px)` }}>
                    {valueText(peakValue)}
                  </div>
                ) : null}
                <div className="wl-hour-fill" style={{ height: `${hourBarPercent(value, max).toFixed(1)}%` }} />
              </div>
              <div className="wl-hour-label">{hour.hour}</div>
            </div>
          );
        })}
      </div>
      {/* 图例行：左侧三项解释颜色，右侧一条状态（靠右对齐） */}
      <div className="wl-legend wl-hour-legend">
        <div className="wl-legend-group">
          <span className="wl-legend-item" data-kind="legend-measure">
            <i className="wl-legend-bar" />
            {t(measure === "turns" ? "hour.legend.turns" : "hour.legend.tokens")}
          </span>
          <span className="wl-legend-item" data-kind="legend-humans">
            <i className="wl-legend-dot" />
            {t("hour.legend.humans")}
          </span>
          <span className="wl-legend-item" data-kind="legend-peak">
            <i className="wl-legend-peak" />
            {t("hour.legend.peak")}
          </span>
        </div>
        {status === null ? null : (
          <span
            className="wl-status"
            data-kind="hour-tokens-missing"
            data-state={status.state}
          >
            {status.text}
          </span>
        )}
      </div>
    </>
  );
}

// 扇区几何在 ../sector-path.js：看板与报告必须共用同一实现（否则白描边缝隙不一致）。
// 这里保留既有导出，客户端模块的对外形状不变。
export { sectorPath };

/**
 * 环形占比图（Top N + others）：工作区按时长 / Token 可切换；模型固定 Token（不切换）。
 * 首页「模型 Token 占比」直接复用本组件——几何、色板、描边只有这一份实现。
 */
function WorkspacePie({ items, t, metric = "activeMs", ariaLabel = null }) {
  const slices = useMemo(() => {
    const valueOf = (item) => (metric === "activeMs" ? item.activeMs : item.tokensTotal);
    const sorted = [...items].filter((item) => valueOf(item) > 0).sort((a, b) => valueOf(b) - valueOf(a));
    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6);
    const slicesOut = top.map((item) => ({ label: item.label, value: valueOf(item), item }));
    if (rest.length > 0) slicesOut.push({ label: "others", value: rest.reduce((sum, item) => sum + valueOf(item), 0), item: null });
    const total = slicesOut.reduce((sum, slice) => sum + slice.value, 0);
    return { slices: slicesOut, total };
  }, [items, metric]);

  const palette = [
    "var(--dsw-static-deepseek-500, #4d6bfe)",
    "var(--dsw-static-green-500, #10b981)",
    "var(--dsw-static-amber-500, #f59e0b)",
    "var(--dsw-static-blue-400, #60a5fa)",
    "var(--dsw-static-red-400, #f25a5a)",
    "var(--dsw-static-deepseek-300, #a9b8ff)",
    "var(--dsw-static-neutral-300, #c7cbd1)",
  ];

  const radius = 62;
  const stroke = 24;
  const outer = radius + stroke / 2;
  const inner = radius - stroke / 2;
  let angle = 0;
  const arcs = slices.slices.map((slice, index) => {
    const share = slices.total > 0 ? slice.value / slices.total : 0;
    const sweep = share * Math.PI * 2;
    const arc = { ...slice, share, from: angle, to: angle + sweep, color: palette[index % palette.length] };
    angle += sweep;
    return arc;
  });
  const formatValue = (value) => (metric === "activeMs" ? formatHours(value) : formatInt(value));

  return (
    <div className="wl-pie-wrap">
        <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={ariaLabel ?? t("pie.title")}>
          <g transform="translate(80,80) rotate(-90)">
            {arcs.map((arc) => (
              <path
                key={arc.label}
                d={sectorPath(outer, inner, arc.from, arc.to)}
                fill={arc.color}
                stroke="var(--dsw-alias-bg-base, #ffffff)"
                strokeWidth="1.6"
                strokeLinejoin="round"
              >
                <title>{t("tip.slice", { label: arc.label, value: formatValue(arc.value), share: formatPercent(arc.share) })}</title>
              </path>
            ))}
          </g>
          <text x="80" y="76" textAnchor="middle" fontSize="15" fontWeight="650" fill="var(--dsw-alias-label-primary, #1a1d21)">
            {metric === "activeMs" ? formatHours(slices.total) : formatTokens(slices.total)}
          </text>
          <text x="80" y="93" textAnchor="middle" fontSize="10" fill="var(--dsw-alias-label-tertiary, #6b7280)">
            {metric === "activeMs" ? t("pie.totalTime") : t("pie.totalTokens")}
          </text>
        </svg>
        <ul className="wl-pie-legend">
          {arcs.map((arc) => (
            <li key={arc.label}>
              <i className="wl-dot" style={{ background: arc.color }} />
              <span className="wl-pie-name" title={arc.item?.path}>{arc.label}</span>
              <span className="wl-pie-value">{formatValue(arc.value)}</span>
              <span className="wl-pie-share">{formatPercent(arc.share)}</span>
            </li>
          ))}
          {arcs.length === 0 ? <li className="wl-metric-sub">{t("state.empty")}</li> : null}
        </ul>
    </div>
  );
}

/**
 * 日期轴刻度：数量随可用宽度自适应，首尾刻度必选，相邻刻度保持最小间距（不叠字）。
 * @param count - 数据点个数。
 * @param step - 每个数据点的横向步长（viewBox 单位）。
 * @param minGap - 相邻刻度最小间距（viewBox 单位，约等于一个日期标签的宽度）。
 * @returns 需要显示标签的下标（升序）。
 */
export function dailyAxisTickIndices(count, step, minGap = 46) {
  if (!(count > 0)) return [];
  if (count === 1) return [0];
  const maxTicks = Math.max(2, Math.floor((count * step) / minGap));
  const every = Math.max(1, Math.ceil((count - 1) / (maxTicks - 1)));
  const picked = new Set();
  for (let index = 0; index < count; index += every) picked.add(index);
  picked.add(count - 1); // 末尾（最近一天）始终显示
  const sorted = [...picked].sort((a, b) => a - b);
  const last = sorted[sorted.length - 1];
  const previous = sorted[sorted.length - 2];
  // 末尾与倒数第二个刻度挨得太近时，去掉左边那个
  if (previous !== undefined && (last - previous) * step < minGap) picked.delete(previous);
  return [...picked].sort((a, b) => a - b);
}

/**
 * 观测容器的真实像素尺寸：viewBox 直接用 CSS 像素，SVG 因而正好铺满容器
 * —— 不会再出现"等比缩放后在图形上下留出空白带"的问题，字号也是屏幕上的真实字号。
 */
function useChartSize(ref) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (node === null) return undefined;
    const measure = () => {
      const width = Math.round(node.clientWidth);
      const height = Math.round(node.clientHeight);
      if (width <= 0 || height <= 0) return; // 未布局 / 隐藏时保留上一次尺寸
      setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
    };
    measure();
    if (typeof ResizeObserver !== "function") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [ref]);
  return size;
}

/**
 * 每日趋势：只有柱（无折线），柱高取 day.activeMs（**单一序列**：活跃时长）。
 * 柱顶用小字号标数值（h/m/s），点数多时隔点标注避免叠字；周六 / 周日用强调色区分。
 */
function DailyChart({ days, t }) {
  const box = useRef(null);
  const { width, height } = useChartSize(box);
  const geometry = useMemo(() => {
    if (days.length === 0 || width <= 0 || height <= 0) return null;
    // 日期轴 9px、基线离底 6px：下边距压到 20px 就够，其余高度全给图形（图与图例之间不留空白带）
    const pad = { top: 20, right: 8, bottom: 20, left: 8 };
    const innerW = width - pad.left - pad.right;
    const innerH = Math.max(1, height - pad.top - pad.bottom);
    const maxActive = Math.max(1, ...days.map((day) => day.activeMs));
    const step = innerW / days.length;
    const barWidth = Math.max(1.5, Math.min(24, step * 0.62));
    // 隔点标注：每个数值至少占 30px，相邻数值才不会叠在一起
    const labelStep = Math.max(1, Math.ceil(30 / step));
    // 最大的那根柱始终标数值（即使落在隔点之外），一眼就能读到峰值
    const peakIndex = days.reduce((best, day, index) => (day.activeMs > days[best].activeMs ? index : best), 0);
    const peakDate = days[peakIndex]?.activeMs > 0 ? days[peakIndex].date : null;
    const labeled = new Set();
    days.forEach((day, index) => {
      if (day.activeMs > 0 && index % labelStep === 0) labeled.add(index);
    });
    if (peakDate !== null) {
      labeled.add(peakIndex);
      // 峰值标签与邻近的隔点标签会叠字：撤掉峰值 30px 以内的其它标签
      for (const index of [...labeled]) {
        if (index !== peakIndex && Math.abs(index - peakIndex) * step < 30) labeled.delete(index);
      }
    }
    const bars = [];
    const hits = [];
    const values = [];
    days.forEach((day, index) => {
      const centerX = pad.left + step * index + step / 2;
      const y = pad.top + innerH - (day.activeMs / maxActive) * innerH;
      // 星期由本地日期串判定：补 T00:00:00 按本地时区解析，不会整体偏移一天
      const weekday = new Date(`${day.date}T00:00:00`).getDay();
      const weekend = weekday === 0 || weekday === 6;
      const peak = index === peakIndex && peakDate !== null;
      // 单行提示：日期 · 活跃 x · Token y [· 周末]
      const title = t("tip.daily", {
        date: day.date,
        active: formatHours(day.activeMs),
        tokens: formatTokens(day.tokensTotal ?? 0),
        weekend: weekend ? t("tip.weekend") : "",
      });
      // 每天都画柱（0 也留 1px）：柱 rect 数 = 天数，title 直接挂在 rect 上
      bars.push(
        <rect
          key={day.date}
          data-kind="active-bar"
          data-date={day.date}
          data-weekend={weekend ? "true" : undefined}
          x={centerX - barWidth / 2}
          y={y}
          width={barWidth}
          height={Math.max(pad.top + innerH - y, 1)}
          rx="2"
          fill={weekend ? "var(--dsw-static-amber-500, #f59e0b)" : "var(--dsw-static-deepseek-500, #4d6bfe)"}
        >
          <title>{title}</title>
        </rect>,
      );
      // 每根柱一根全高透明命中区：0 值柱只有 1px 高也能悬停；title 同样挂在命中区上，
      // 悬停柱间空白 / 柱顶数值时都有提示（不是挂在父 <g> 上）。
      hits.push(
        <rect
          key={`hit-${day.date}`}
          data-kind="active-bar-hit"
          data-date={day.date}
          x={centerX - step / 2}
          y={pad.top}
          width={Math.max(step, 1)}
          height={innerH}
          fill="transparent"
          style={{ pointerEvents: "all" }}
        >
          <title>{title}</title>
        </rect>,
      );
      // 0 不标：柱就落在轴上，标 "0" 只会和日期挤在一起；数值标在柱顶（h/m/s 小字号）
      if (labeled.has(index)) {
        values.push(
          <text key={day.date} data-kind={peak ? "peak-label" : "bar-label"} data-date={day.date} x={centerX} y={y - 5} textAnchor="middle" fontSize="9" fontWeight={peak ? "650" : undefined} fill={peak ? "var(--dsw-alias-label-primary, #1a1d21)" : "var(--dsw-alias-label-secondary, #4b5563)"}>
            {formatHours(day.activeMs)}
          </text>,
        );
      }
    });
    // 刻度数量自适应 + 首尾必显；贴边的标签向内收，避免被 viewBox 裁掉
    const tickIndices = new Set(dailyAxisTickIndices(days.length, step));
    const axis = days.map((day, index) => {
      if (!tickIndices.has(index)) return null;
      const text = day.date.slice(5);
      const half = text.length * 2.8; // 字号 9：日期字符宽约 5.6
      const centerX = pad.left + step * index + step / 2;
      // 日期轴刻度也带提示：悬停到坐标轴文字时仍能读到当天口径
      const weekday = new Date(`${day.date}T00:00:00`).getDay();
      const tip = t("tip.daily", {
        date: day.date,
        active: formatHours(day.activeMs),
        tokens: formatTokens(day.tokensTotal ?? 0),
        weekend: weekday === 0 || weekday === 6 ? t("tip.weekend") : "",
      });
      return (
        <text key={day.date} x={Math.min(Math.max(centerX, half), width - half)} y={height - 6} textAnchor="middle" fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
          {text}
          <title>{tip}</title>
        </text>
      );
    });
    return { width, height, pad, innerH, innerW, bars, hits, values, axis };
  }, [days, width, height, t]);

  if (geometry === null) {
    return (
      <div className="wl-chart-fill" ref={box} data-kind="daily-chart">
        {days.length === 0 ? <p className="wl-state">{t("state.empty")}</p> : null}
      </div>
    );
  }
  const { pad, innerH, innerW, bars, hits, values, axis } = geometry;
  return (
    <div className="wl-chart-fill" ref={box} data-kind="daily-chart">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("chart.daily")}>
        <line x1={pad.left} y1={pad.top + innerH} x2={pad.left + innerW} y2={pad.top + innerH} stroke="var(--dsw-alias-border-l2, #e5e7eb)" />
        {bars}
        {hits}
        {values}
        {axis}
      </svg>
    </div>
  );
}

/**
 * 模型折叠状态。**「回填中」只看 pending（从未折过的行数）**：活会话的 asOfSeq
 * 每来一个事件就 +1，若把"已折过的行"也算进 pending，提示就会永远挂着（0.4.0 的缺陷）。
 * refold（旧数据按新水位重算）与 failedRows（读日志失败的会话）都不该打扰界面。
 */
function modelFoldState(data) {
  const fold = data?.diagnostics?.modelFold ?? {};
  const lastError = typeof fold.lastError === "string" && fold.lastError !== "" ? fold.lastError : null;
  const running = fold.running === true;
  const phase = fold.phase ?? (running ? "first-fold" : "idle");
  return {
    pending: typeof fold.pending === "number" ? fold.pending : 0,
    refold: typeof fold.refold === "number" ? fold.refold : 0,
    failedRows: typeof fold.failedRows === "number" ? fold.failedRows : 0,
    done: typeof fold.done === "number" ? fold.done : 0,
    total: typeof fold.total === "number" ? fold.total : 0,
    running,
    phase,
    lastError,
  };
}

/** 是否在首次回填（从未折过）——只在真的算时显示「回填中」，空闲排队不显示。 */
function isModelFolding(data) {
  return modelFoldState(data).phase === "first-fold";
}

/**
 * 模型用量视图（独立页签「模型用量」，0.4.0）：
 *   左 = 模型 treemap（面积 = 占比，口径可切：Token / 请求数 / 模型耗时）
 *   右 = 按日模型趋势（堆叠柱）；点击左侧任一模型 → 右侧只显示该模型（可多选，再点取消）
 *   下 = 模型明细表（请求、输入/输出/缓存、命中率、费用）+ 官方计费链接
 * 会话记录里没有机器字段，模型的"机器归属"不在此处体现（多机方案见 docs/sync.md，已暂缓）。
 */
function ModelSection({ data, t }) {
  const models = data.byModel ?? [];
  const [metric, setMetric] = useState("tokens");
  const [selected, setSelected] = useState([]);
  const palette = [
    "var(--dsw-static-deepseek-500, #4d6bfe)",
    "var(--dsw-static-green-500, #10b981)",
    "var(--dsw-static-amber-500, #f59e0b)",
    "var(--dsw-static-blue-400, #60a5fa)",
    "var(--dsw-static-red-400, #f25a5a)",
    "var(--dsw-static-deepseek-300, #a9b8ff)",
    "var(--dsw-static-neutral-300, #c7cbd1)",
  ];
  const metricValue = (item) =>
    metric === "requests" ? item.requests : metric === "llmMs" ? item.llmMs : item.tokensTotal;
  const fmtMetric = (value) => (metric === "requests" ? formatInt(value) : metric === "llmMs" ? formatHours(value) : formatTokens(value));

  const ranked = useMemo(() => [...models].sort((a, b) => metricValue(b) - metricValue(a)), [models, metric]);
  const totalMetric = ranked.reduce((sum, item) => sum + metricValue(item), 0);
  const colorOf = (key) => palette[Math.max(0, ranked.findIndex((item) => item.key === key)) % palette.length];

  // 面积分布：Top 8 + others（保证 treemap 可读）
  const cells = useMemo(() => {
    const top = ranked.filter((item) => metricValue(item) > 0).slice(0, 8);
    const rest = ranked.filter((item) => metricValue(item) > 0).slice(8);
    const list = top.map((item) => ({ key: item.key, label: item.label, value: metricValue(item), item }));
    if (rest.length > 0) {
      list.push({ key: "__others", label: "others", value: rest.reduce((sum, item) => sum + metricValue(item), 0), item: null });
    }
    return list;
  }, [ranked, metric, t]);

  // treemap 的 viewBox 用容器的**真实像素**：默认 preserveAspectRatio="xMidYMid meet"
  // 会等比缩放并在左右留出大片空白（矩形没铺满容器）；量测口径是最左/最右矩形到容器边缘 ≤ 8px。
  const treemapBox = useRef(null);
  const treemapSize = useChartSize(treemapBox);
  const rects = useMemo(
    () => layoutTreemap(cells, 0, 0, Math.max(1, treemapSize.width), Math.max(1, treemapSize.height)),
    [cells, treemapSize.width, treemapSize.height],
  );

  // 按日趋势：默认全部模型堆叠；选中后只显示选中的
  const active = selected.length > 0 ? selected : null;
  const trend = useMemo(() => {
    const days = data.modelDaily ?? [];
    const visibleKeys = active === null ? ranked.slice(0, 6).map((item) => item.key) : active;
    const series = visibleKeys.map((key) => ({
      key,
      label: models.find((item) => item.key === key)?.label ?? key,
      color: colorOf(key),
    }));
    const rows = days.map((day) => {
      const values = series.map((s) => ({ ...s, value: active === null || active.includes(s.key) ? (day.values?.[s.key] ?? 0) : 0 }));
      return { date: day.date, values, total: values.reduce((sum, v) => sum + v.value, 0) };
    });
    return { series, rows };
  }, [data.modelDaily, models, ranked, selected, active]);

  const toggle = (key) => {
    if (key === "__others" || key === UNKNOWN_KEY) return;
    setSelected((prev) => (prev.includes(key) ? prev.filter((item) => item !== key) : [...prev, key]));
  };

  const pricing = data.pricing ?? { currency: "CNY", links: [], costed: { covered: 0, total: 0 }, totalCost: null };
  const fmtCost = (value) => formatCost(value, pricing.currency);
  const fold = modelFoldState(data);
  // 读日志失败：界面只给可读短句 + 简化原因；原始英文异常只留在 /health，不在界面暴露
  const foldErrorReason = t("model.foldError.why");
  const foldError = fold.lastError === null ? null : t("model.foldError", { count: formatInt(fold.failedRows) });

  if (models.length === 0) {
    return (
      <div className="wl-card">
        <p className="wl-state">{fold.pending > 0 ? t("model.folding") : t("model.empty")}</p>
        {foldError === null ? null : (
          <p className="wl-status" data-kind="model-fold-error" data-tone="error" title={foldErrorReason}>
            {foldError}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="wl-card">
      {/* 与其它卡片同构：标题 + 右上控件（页签是页面导航，卡片仍保留标题） */}
      <CardHead title={t("tab.model")} hint={t("model.hint")}>
        {fold.pending > 0 ? (
          <span className="wl-status" data-kind="model-folding">{t("model.foldingShort", { done: fold.done, total: fold.total })}</span>
        ) : null}
        <ChipGroup label={t("tab.model")}>
          {[["tokens", "model.metric.tokens"], ["requests", "model.metric.requests"], ["llmMs", "model.metric.llmMs"]].map(([value, key]) => (
            <Chip key={value} active={metric === value} onClick={() => setMetric(value)}>
              {t(key)}
            </Chip>
          ))}
          {selected.length > 0 ? (
            <Chip onClick={() => setSelected([])}>{t("model.clear")}</Chip>
          ) : null}
        </ChipGroup>
      </CardHead>

      <div className="wl-model-grid">
        <div>
          <h4 className="wl-model-subtitle">{t("model.treemapTitle")}</h4>
          <div className="wl-treemap-fill" ref={treemapBox} data-kind="model-treemap">
            {treemapSize.width > 0 && treemapSize.height > 0 ? (
              <svg viewBox={`0 0 ${treemapSize.width} ${treemapSize.height}`} width={treemapSize.width} height={treemapSize.height} role="img" aria-label={t("model.treemap")}>
                {rects.map((rect) => {
                  const isSelected = selected.includes(rect.key);
                  const dimmed = selected.length > 0 && !isSelected;
                  const share = totalMetric > 0 ? rect.value / totalMetric : 0;
                  return (
                    <g key={rect.key} onClick={() => toggle(rect.key)} style={{ cursor: rect.key === "__others" ? "default" : "pointer", opacity: dimmed ? 0.35 : 1 }}>
                      {/* title 挂在 rect（实际 hover 目标）而不是 <g>：父节点 title 在多数浏览器不弹 */}
                      <rect
                        x={rect.x} y={rect.y} width={Math.max(0.5, rect.w)} height={Math.max(0.5, rect.h)}
                        fill={rect.key === "__others" ? "var(--dsw-static-neutral-300, #c7cbd1)" : colorOf(rect.key)}
                        stroke={isSelected ? "var(--dsw-alias-label-primary, #111827)" : "var(--dsw-alias-bg-base, #fff)"}
                        strokeWidth={isSelected ? 1.4 : 0.5}
                        data-model={rect.key}
                        data-kind={rect.item === null ? "others" : "model"}
                      >
                        <title>{`${rect.label}\n${t("model.requests")} ${formatInt(rect.item?.requests ?? 0)}\nToken ${formatInt(rect.item?.tokensTotal ?? rect.value)}\n${t("model.share")} ${formatPercent(share)}`}</title>
                      </rect>
                      {rect.w > 56 && rect.h > 26 ? (
                        <text x={rect.x + 8} y={rect.y + 18} fontSize="12" fill="var(--dsw-alias-label-primary-inverted, #fff)" style={{ pointerEvents: "none" }}>
                          {rect.label.length > 22 ? `${rect.label.slice(0, 21)}\u2026` : rect.label}
                        </text>
                      ) : null}
                      {rect.w > 56 && rect.h > 52 ? (
                        <text x={rect.x + 8} y={rect.y + 34} fontSize="11" fill="var(--dsw-alias-label-primary-inverted, #fff)" opacity="0.92" style={{ pointerEvents: "none" }}>
                          {formatPercent(share)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </svg>
            ) : null}
          </div>
          <p className="wl-hint wl-hint-spaced">{t("model.clickHint")}</p>
        </div>

        <div>
          <h4 className="wl-model-subtitle">{t("model.trend")}</h4>
          <ModelTrend trend={trend} t={t} />
          <div className="wl-legend">
            {trend.series.map((s) => (
              <span key={s.key} className="wl-legend-item">
                <i style={{ background: s.color }} /> {s.label}
              </span>
            ))}
          </div>
        </div>
      </div>

      <table className="wl-table wl-model-table">
        <thead>
          <tr>
            <th>{t("model.col.model")}</th><th>{t("model.col.share")}</th><th>{t("model.col.requests")}</th>
            <th>{t("table.input")}</th><th>{t("table.output")}</th><th>{t("table.cache")}</th>
            <th>{t("model.col.hitRate")}</th><th>{t("model.col.cost")}</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((item) => (
            <tr key={item.key} style={{ opacity: selected.length > 0 && !selected.includes(item.key) ? 0.5 : 1 }}>
              <td>
                <button type="button" className="wl-model-name" onClick={() => toggle(item.key)}>
                  <i style={{ background: colorOf(item.key) }} />
                  {item.label}
                </button>
                {Object.keys(item.raw ?? {}).length > 1 ? (
                  <span className="wl-hint wl-hint-block">{t("model.merged", { list: Object.keys(item.raw).map((k) => k.split("/").pop()).join(" + ") })}</span>
                ) : null}
              </td>
              <td>{formatPercent(item.share)}</td>
              <td>{formatInt(item.requests)}</td>
              <td>{formatTokens(item.tokens.input)}</td>
              <td>{formatTokens(item.tokens.output)}</td>
              <td>{formatTokens(item.tokens.cacheRead)}</td>
              <td>{item.cacheHitRate === null || item.cacheHitRate === undefined ? "\u2014" : formatPercent(item.cacheHitRate)}</td>
              <td>{fmtCost(item.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="wl-hint wl-hint-spaced">
        {t("model.costNote", { asOf: pricing.asOf ?? "\u2014", covered: pricing.costed?.covered ?? 0, total: pricing.costed?.total ?? 0 })}
        {pricing.totalCost === null || pricing.totalCost === undefined ? "" : ` · ${t("model.totalCost")} ${fmtCost(pricing.totalCost)}`}
      </p>
      <p className="wl-hint wl-hint-spaced">
        {t("model.priceLinks")}{" "}
        {(pricing.links ?? []).map((link, index) => (
          <span key={link.url}>
            {index > 0 ? " · " : ""}
            <a href={link.url} target="_blank" rel="noreferrer noopener">{link.label ?? link.provider}</a>
          </span>
        ))}
      </p>
      {/* 读取失败的会话：卡片底部的小字说明，不占顶部醒目位置；原因只给简化版（原文在 /health） */}
      {foldError === null ? null : (
        <p className="wl-status" data-kind="model-fold-error" data-tone="error" title={foldErrorReason}>
          {foldError}
        </p>
      )}
    </div>
  );
}

/** 按日模型趋势（堆叠柱，最多 6 个系列 + 其他）。 */
function ModelTrend({ trend, t }) {
  const geometry = useMemo(() => {
    const width = 560;
    const height = 210;
    const pad = { top: 10, right: 6, bottom: 24, left: 6 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    const rows = trend.rows;
    if (rows.length === 0) return null;
    const max = Math.max(1, ...rows.map((row) => row.total));
    const step = innerW / rows.length;
    const barWidth = Math.max(1.5, Math.min(22, step * 0.66));
    const bars = rows.map((row, index) => {
      const centerX = pad.left + step * index + step / 2;
      let y = pad.top + innerH;
      const rects = [];
      // 每段 rect 自己有 title（父 <g> 的 title 在多数浏览器不弹）
      row.values.forEach((value, series) => {
        const h = (value.value / max) * innerH;
        if (h <= 0.3) return;
        y -= h;
        rects.push(
          <rect key={series} x={centerX - barWidth / 2} y={y} width={barWidth} height={h} rx="1.5" fill={value.color}>
            <title>{`${row.date} · ${value.label} ${formatInt(value.value)} tokens`}</title>
          </rect>,
        );
      });
      return (
        <g key={row.date}>
          {rects}
          {/* 整列命中区：0 值日期也能读到当日合计 */}
          <rect
            data-kind="model-trend-hit"
            x={centerX - step / 2}
            y={pad.top}
            width={Math.max(step, 1)}
            height={innerH}
            fill="transparent"
            style={{ pointerEvents: "all" }}
          >
            <title>{`${row.date} · ${formatInt(row.total)} tokens`}</title>
          </rect>
        </g>
      );
    });
    const every = Math.max(1, Math.ceil(rows.length / 8));
    const labels = rows.map((row, index) =>
      index % every === 0 || index === rows.length - 1 ? (
        <text key={row.date} x={pad.left + step * index + step / 2} y={height - 8} textAnchor="middle" fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
          {row.date.slice(5)}
        </text>
      ) : null,
    );
    return { width, height, bars, labels, baseline: pad.top + innerH, left: pad.left, innerW };
  }, [trend]);

  if (geometry === null) return <p className="wl-state">{t("state.empty")}</p>;
  return (
    <svg viewBox={`0 0 ${geometry.width} ${geometry.height}`} width="100%" height={geometry.height} role="img" aria-label={t("model.trend")}>
      <line x1={geometry.left} y1={geometry.baseline} x2={geometry.left + geometry.innerW} y2={geometry.baseline} stroke="var(--dsw-alias-border-l2, #e5e7eb)" />
      {geometry.bars}
      {geometry.labels}
    </svg>
  );
}

/**
 * 简易 treemap 布局：按累计值二分为两半，长边切分（交替方向）。
 * 比 squarified 简单，但对"少数几个模型占绝大多数"的数据足够可读。
 */
function layoutTreemap(items, x, y, w, h, out = []) {
  if (items.length === 0) return out;
  if (items.length === 1) {
    out.push({ ...items[0], x, y, w, h });
    return out;
  }
  const total = items.reduce((sum, item) => sum + item.value, 0);
  let acc = 0;
  let split = 0;
  for (let i = 0; i < items.length; i += 1) {
    acc += items[i].value;
    split = i + 1;
    if (acc >= total / 2) break;
  }
  const first = items.slice(0, split);
  const second = items.slice(split);
  if (second.length === 0) {
    out.push({ ...items[0], x, y, w, h });
    return out;
  }
  const firstSum = first.reduce((sum, item) => sum + item.value, 0);
  const ratio = total > 0 ? firstSum / total : 0.5;
  if (w >= h) {
    layoutTreemap(first, x, y, w * ratio, h, out);
    layoutTreemap(second, x + w * ratio, y, w - w * ratio, h, out);
  } else {
    layoutTreemap(first, x, y, w, h * ratio, out);
    layoutTreemap(second, x, y + h * ratio, w, h - h * ratio, out);
  }
  return out;
}

/** 未标注模型的 key（与宿主 src/models.js 保持一致）。 */
const UNKNOWN_KEY = "(\u672a\u6807\u6ce8\u6a21\u578b)";

/** KPI 卡片组；data 为 null 时渲染骨架（标签先就位，只有数值位显示「加载中…」）。 */
function Kpis({ data, t }) {
  if (data === null || data === undefined) {
    return (
      <div className="wl-kpis" data-kind="kpi-skeleton">
        {KPI_KEYS.map((key) => (
          <div className="wl-kpi" key={key} data-kpi={key}>
            <div className="wl-kpi-label">{t(key)}</div>
            <div className="wl-kpi-value wl-pending">{t("state.loading")}</div>
            <div className="wl-kpi-sub" />
          </div>
        ))}
      </div>
    );
  }
  const totals = data.totals;
  const derived = data.derived;
  // 模型费用：只统计有官方单价的模型；一个都没有时显示 —（不编数字），副标题给出覆盖度与价目日期
  const pricing = data.pricing;
  const costed = pricing?.costed ?? { covered: 0, total: 0 };
  const costValue = formatCost(pricing?.totalCost, pricing?.currency);
  const costSub =
    costed.total > 0
      ? t("kpi.modelCost.sub", { covered: formatInt(costed.covered), total: formatInt(costed.total), asOf: pricing?.asOf ?? "\u2014" })
      : t("kpi.modelCost.none");
  // 动态拼接会让"引用键必须存在 / 无死键"的静态校验看不到这些键，所以用字面量映射
  const metricLabelKey = {
    requests: "kpi.topModel.metric.requests",
    tokens: "kpi.topModel.metric.tokens",
    llmMs: "kpi.topModel.metric.llmMs",
  };
  // KPI 里的时长统一走「一位小数的小时 / 整数分钟 / 整数秒」（223.2 h），比明细表更短更好扫。
  // 活跃时长展示**净活跃**（totals.activeMs 是官方值，含等待用户）；等待单独写在副标题里。
  const netActive = totals.netActiveMs ?? totals.activeMs;
  const activeWait = totals.waitMs ?? 0;
  const cards = [
    [
      "kpi.active",
      formatHours(netActive),
      `${t("kpi.active.sub", { llm: formatHours(totals.llmMs), tool: formatHours(totals.toolMs) })} · ${t("kpi.active.waitSub", { wait: formatHours(activeWait) })}`,
    ],
    // 总 Token 直接给完整整数（可核对的真实值），小字里才用 K/M/B 缩写
    ["kpi.tokens", formatInt(totals.tokensTotal), t("kpi.tokens.sub", { input: formatTokens(totals.tokens.input), output: formatTokens(totals.tokens.output), cache: formatTokens(totals.tokens.cacheRead) })],
    // 第 8 张：模型费用（插在活跃天数前，与 Tokens 卡一样跨 2 列，两行正好排满）
    ["kpi.modelCost", costValue, costSub],
    ["kpi.activeDays", `${formatInt(totals.activeDays)} / ${formatInt(data.range.days)}`, t("kpi.activeDays.sub", { workspaces: formatInt(totals.workspaces) })],
    ["kpi.conversations", formatInt(totals.conversations), t("kpi.conversations.sub", { sessions: formatInt(totals.sessions), empty: formatInt(totals.emptySessions) })],
    // 步骤数字比轮次小 2px，整行不换行（与 Tokens 卡一样靠栅格给足宽度）
    [
      "kpi.turns",
      (
        <>
          {formatInt(totals.turns)} / <span className="wl-kpi-steps">{formatInt(totals.steps)}</span>
        </>
      ),
      t("kpi.turns.sub", { main: formatInt(totals.mainSessions), subagent: formatInt(totals.subagentSessions) }),
    ],
    ["kpi.cache", formatPercent(derived.cacheHitRate), t("kpi.cache.sub", { output: formatTokens(derived.outputPerActiveHour) })],
    // 第 8 张：最活跃模型（默认按请求数口径，可在配置里切换 tokens / activeMs）
    data.topModel === null || data.topModel === undefined
      ? ["kpi.topModel", "\u2014", t("kpi.topModel.none")]
      : [
          "kpi.topModel",
          data.topModel.label,
          t("kpi.topModel.sub", {
            share: formatPercent(data.topModel.metricShare),
            metric: t(metricLabelKey[data.topModel.metric] ?? "kpi.topModel.metric.requests"),
          }),
        ],
  ];
  return (
    <div className="wl-kpis">
      {cards.map(([key, value, sub]) => (
        <div className="wl-kpi" key={key} data-kpi={key}>
          <div className="wl-kpi-label">{t(key)}</div>
          <div className="wl-kpi-value">{value}</div>
          <div className="wl-kpi-sub">{sub}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * 骨架屏：内存缓存未命中时**立即**把整块卡片布局摆出来（KPI / 图表容器 / 表格框），
 * 只有数值位显示「加载中…」；数据到达后由真实视图原地替换（不整屏转圈、不跳版）。
 */
function SkeletonBody({ t }) {
  return (
    <div className="wl-skeleton" data-kind="skeleton" aria-busy="true">
      <Kpis data={null} t={t} />
      <div className="wl-tabs" aria-hidden="true">
        {["byDay", "model", "byWorkspace", "bySession"].map((key, index) => (
          <span key={key} className="wl-tab" data-active={index === 0}>{t(`tab.${key}`)}</span>
        ))}
      </div>
      <div className="wl-grid-daily-model">
        <div className="wl-card">
          <CardHead title={t("chart.daily")} hint={t("chart.hint")} />
          <div className="wl-daily-body"><div className="wl-chart-fill wl-skeleton-area" /></div>
        </div>
        <div className="wl-card">
          <CardHead title={t("pie.model")} hint={t("pie.modelHint")} />
          <div className="wl-skeleton-area wl-skeleton-mid" />
        </div>
      </div>
      <div className="wl-grid-2">
        <div className="wl-card">
          <CardHead title={t("hour.title")} hint={t("hour.hint")} />
          <div className="wl-skeleton-area wl-skeleton-mid" />
        </div>
        <div className="wl-card">
          <CardHead title={t("pie.title")} />
          <div className="wl-skeleton-area wl-skeleton-mid" />
        </div>
      </div>
      <div className="wl-card">
        <table className="wl-table">
          <thead>
            <tr>{DETAIL_COLUMNS.map((column) => <th key={column.key}>{t(column.labelKey)}</th>)}</tr>
          </thead>
          <tbody>
            <tr><td colSpan={DETAIL_COLUMNS.length} className="wl-state">{t("state.loading")}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * 按日期视图（首页主视图）：
 *   1) 每日用量：默认「日历热力图」（周一~周日 × Year-Week，颜色＝活跃时长），可切「柱状图」
 *   2) 右列「模型 Token 占比」：紧凑环形图（复用 WorkspacePie，固定 Token 口径）
 *   3) 并排两图：左「时刻分析」（0–23 点谁更活跃） 右「工作区占比」（环形图，时长/Token 可切）
 *   4) 「按日期明细」默认折叠
 * 模型明细 / treemap / 按日趋势已移到独立页签「模型用量」。
 */
function ByDayView({ data, t }) {
  const [dailyMode, setDailyMode] = useState("calendar");
  // 时刻分析口径：默认 Tokens（Token 产出），可切「轮次」（该小时 starts）
  const [hourMeasure, setHourMeasure] = useState("tokens");
  // 工作区占比口径：默认按时长，可切「按 Token」；chips 在卡片头右上角（与时刻卡同位置）
  const [pieMetric, setPieMetric] = useState("activeMs");
  // 回填 / 重折进行中：legend 右侧显示「正在计算中……」；判据集中在 hour-status.js
  const hourNote = hourTokensNote(data.diagnostics, t, formatInt);
  const dailyBodyRef = useRef(null);
  const dailyBody = useChartSize(dailyBodyRef);
  const models = data.byModel ?? [];
  const rows = useMemo(
    () => [...data.byDay].filter((day) => day.sessions > 0).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 31),
    [data.byDay],
  );
  // 比例条按「本列最大值」归一：与「主要会话」四列同一套规则，宽度由 MetricBarCell 计算。
  const maxima = useMemo(
    () => Object.fromEntries(
      DETAIL_COLUMNS.filter((column) => column.value !== undefined).map((column) => [
        column.key,
        Math.max(1, ...rows.map((day) => column.value(day))),
      ]),
    ),
    [rows],
  );

  return (
    <>
      <div className="wl-grid-daily-model">
      <div className="wl-card">
        <CardHead title={t("chart.daily")} hint={t("chart.hint")}>
          <ChipGroup label={t("chart.daily")}>
            <Chip active={dailyMode === "calendar"} onClick={() => setDailyMode("calendar")}>{t("daily.calendar")}</Chip>
            <Chip active={dailyMode === "bar"} onClick={() => setDailyMode("bar")}>{t("daily.bar")}</Chip>
          </ChipGroup>
        </CardHead>
        {/* 图表容器固定高度：日历与柱状图切换时卡片高度不跳 */}
        <div className="wl-daily-body" ref={dailyBodyRef}>
          {dailyMode === "calendar" ? (
            <CalendarHeatmap calendar={data.calendar} t={t} availableHeight={dailyBody.height} />
          ) : (
            <DailyChart days={data.byDay} t={t} />
          )}
        </div>
      </div>

      {/* 本卡会被左卡等高拉伸：图形区在卡内垂直居中（见 styles.js 的 .wl-pie-card） */}
      <div className="wl-card wl-pie-card">
        <CardHead title={t("pie.model")} hint={t("pie.modelHint")} />
        {models.length === 0 ? (
          <p className="wl-state">{isModelFolding(data) ? t("model.folding") : t("state.empty")}</p>
        ) : (
          <WorkspacePie items={models} t={t} metric="tokens" ariaLabel={t("pie.model")} />
        )}
      </div>
      </div>

      <div className="wl-grid-2">
        <div className="wl-card wl-hour-card">
          {/* 说明随口径切换：柱＝当前 measure，点＝人类消息密度（文案只解释"看什么"） */}
          <CardHead title={t("hour.title")} hint={t(hourMeasure === "turns" ? "hour.hintTurns" : "hour.hint")}>
            <ChipGroup label={t("hour.title")}>
              <Chip
                data-measure="tokens"
                active={hourMeasure === "tokens"}
                onClick={() => setHourMeasure("tokens")}
              >
                {t("hour.measure.tokens")}
              </Chip>
              <Chip
                data-measure="turns"
                active={hourMeasure === "turns"}
                onClick={() => setHourMeasure("turns")}
              >
                {t("hour.measure.turns")}
              </Chip>
            </ChipGroup>
          </CardHead>
          <HourChart
            hours={data.byHour}
            t={t}
            measure={hourMeasure}
            status={hourNote}
          />
        </div>
        <div className="wl-card wl-pie-card">
          <CardHead title={t("pie.title")}>
            <ChipGroup label={t("pie.title")}>
              <Chip active={pieMetric === "activeMs"} onClick={() => setPieMetric("activeMs")}>{t("pie.byTime")}</Chip>
              <Chip active={pieMetric === "tokens"} onClick={() => setPieMetric("tokens")}>{t("pie.byTokens")}</Chip>
            </ChipGroup>
          </CardHead>
          <WorkspacePie items={data.byWorkspace} t={t} metric={pieMetric} />
        </div>
      </div>

      <details className="wl-card wl-details">
        <summary>{t("detail.summary", { count: rows.length })}</summary>
        <div className="wl-table-scroll">
          <table className="wl-table">
            <thead>
              <tr>
                {DETAIL_COLUMNS.map((column) => <th key={column.key}>{t(column.labelKey)}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={DETAIL_COLUMNS.length} className="wl-state">{t("state.empty")}</td></tr>
              ) : (
                rows.map((day) => (
                  <tr key={day.date}>
                    {DETAIL_COLUMNS.map((column) => {
                      const value = column.value === undefined ? null : column.value(day);
                      const text = column.value === undefined ? column.text(day) : column.format(value);
                      return (
                        <td key={column.key}>
                          {column.value === undefined ? text : (
                            <MetricBarCell
                              value={value}
                              max={maxima[column.key]}
                              kind={column.kind ?? column.key}
                              text={text}
                              title={`${day.date} · ${t(column.labelKey)} ${text}`}
                            />
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </details>
    </>
  );
}

/**
 * 按工作区视图：每行 =
 *   左「独立名称列」= 工作区名（窄屏省略号，title 保留全路径）+ 活跃总天数 + 最近使用
 *   右「我的付出 / Token 消耗」= 两条同口径 bar（各占全部的比例）+ 明细小字
 * 名称不占用 bar 上方的纵向空间，项目名更突出；两条 bar 口径一致，可比较性不变。
 */
function ByWorkspaceView({ data, t }) {
  const items = data.byWorkspace;
  const pct = (share) => `${(Math.max(0, Math.min(1, share ?? 0)) * 100).toFixed(2)}%`;
  const dateOf = (ms) => (ms > 0 ? new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");

  return (
    <>
      <div className="wl-card">
        {items.length === 0 ? (
          <p className="wl-state">{t("state.empty")}</p>
        ) : (
          <>
            {/* 列头只出现一次；每一行不再重复"我的付出 / Token 消耗" */}
            <div className="wl-metrics-head" aria-hidden="true">
              <span>{t("metric.effort")}</span>
              <span>{t("metric.tokens")}</span>
            </div>
            <ul className="wl-bars">
            {items.map((item) => (
              <li key={item.key}>
                {/* 名称独立成左列：与右侧两条 bar 同处一行，名称不再压在 bar 上方 */}
                <div className="wl-ws-row" data-kind="ws-row">
                  <div className="wl-ws-left">
                    <span className="wl-ws-name" title={item.path}>{item.label}</span>
                    <span className="wl-ws-days">{t("ws.activeDays", { days: formatInt(item.activeDays ?? 0) })}</span>
                    <span className="wl-ws-meta">{t("ws.lastUsed", { date: dateOf(item.lastUsedAt) })}</span>
                  </div>
                  <div className="wl-metric">
                    <div className="wl-metric-value">
                      {formatHours(item.activeMs)}
                      <span className="wl-metric-share">{formatPercent(item.activeShare)}</span>
                    </div>
                    <div className="wl-bar-track">
                      <div className="wl-bar-fill" style={{ width: pct(item.activeShare) }} />
                    </div>
                    <div className="wl-metric-sub">
                      {t("metric.effortSub", {
                        days: formatInt(item.activeDays ?? 0),
                        total: formatInt(data.range.days),
                        turns: formatInt(item.turns),
                        steps: formatInt(item.steps),
                      })}
                    </div>
                  </div>
                  <div className="wl-metric">
                    <div className="wl-metric-value" title={formatInt(item.tokensTotal)}>
                      {formatTokens(item.tokensTotal)}
                      <span className="wl-metric-share">{formatPercent(item.tokenShare)}</span>
                    </div>
                    <div className="wl-bar-track">
                      <div className="wl-bar-fill" data-kind="tokens" style={{ width: pct(item.tokenShare) }} />
                    </div>
                    <div className="wl-metric-sub">
                      {t("metric.tokensSub", {
                        output: formatTokens(item.tokens.output),
                        cache: formatTokens(item.tokens.cacheRead),
                      })}
                    </div>
                  </div>
                </div>
                <div className="wl-ws-foot">
                  {formatInt(item.sessions)} {t("table.sessions")} · {formatInt(item.conversations)} {t("table.conversations")} ·{" "}
                  {t("metric.chatsSub", { avg: formatHours(item.avgActiveMsPerConversation) })}
                  {item.waitMs > 0 ? ` · ${t("ws.wait", { wait: formatHours(item.waitMs) })}` : ""}
                </div>
              </li>
            ))}
            </ul>
          </>
        )}
      </div>
      <div className="wl-card">
        <h3>{t("table.workspace")}</h3>
        <table className="wl-table">
          <thead>
            <tr>
              <th>{t("table.workspace")}</th><th>{t("table.activeDays")}</th><th>{t("table.sessions")}</th><th>{t("table.conversations")}</th><th>{t("table.turns")}</th>
              <th>{t("table.steps")}</th><th>{t("table.active")}</th><th>{t("table.tokens")}</th><th>{t("table.activeShare")}</th><th>{t("table.tokenShare")}</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={10} className="wl-state">{t("state.empty")}</td></tr>
            ) : (
              items.map((item) => (
                <tr key={item.key}>
                  <td className="wl-name" title={item.path}>{item.label}</td><td>{formatInt(item.activeDays ?? 0)}</td>
                  <td>{formatInt(item.sessions)}</td><td>{formatInt(item.conversations)}</td><td>{formatInt(item.turns)}</td>
                  <td>{formatInt(item.steps)}</td><td>{formatHours(item.activeMs)}</td><td>{formatTokens(item.tokensTotal)}</td>
                  <td>{formatPercent(item.activeShare)}</td><td>{formatPercent(item.tokenShare)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** 主要会话表格里带条形图的列（顺序 = 表格列顺序）。 */
const SESSION_METRICS = [
  { key: "turns", labelKey: "table.turns", format: (value) => formatInt(value) },
  { key: "steps", labelKey: "table.steps", format: (value) => formatInt(value) },
  { key: "activeMs", labelKey: "table.active", format: (value) => formatHours(value) },
  { key: "output", labelKey: "table.output", format: (value) => formatTokens(value) },
];

/** 取会话行在某个可排序指标上的原始数值。 */
function sessionMetric(row, key) {
  if (key === "turns") return row.turns ?? 0;
  if (key === "steps") return row.steps ?? 0;
  if (key === "activeMs") return row.activeMs ?? 0;
  return row.tokens?.output ?? 0;
}

/**
 * 主要会话视图：
 *   轮次 / 步骤 / 活跃时长 / 输出 四列带浅色条形图（宽度 ＝ 该行数值占本列最大值的比例），
 *   数字显示在条形图内；这四列的表头可点击排序（降序 → 升序 → 恢复默认），排序只是视图内状态。
 */
function BySessionView({ data, t, lang = "zh", days = 0, scope = "all", allTime = false }) {
  const [sort, setSort] = useState(null);
  const rows = useMemo(() => {
    const list = [...(data.bySession ?? [])];
    if (sort !== null) {
      const direction = sort.dir === "asc" ? 1 : -1;
      list.sort((a, b) => direction * (sessionMetric(a, sort.key) - sessionMetric(b, sort.key)));
    }
    return list.slice(0, 40);
  }, [data.bySession, sort]);
  const maxima = useMemo(
    () => Object.fromEntries(SESSION_METRICS.map(({ key }) => [key, Math.max(1, ...rows.map((row) => sessionMetric(row, key)))])),
    [rows],
  );
  const toggleSort = (key) =>
    setSort((previous) => {
      if (previous === null || previous.key !== key) return { key, dir: "desc" };
      return previous.dir === "desc" ? { key, dir: "asc" } : null;
    });

  // 区块顺序由 SESSION_PAGE_SECTIONS 决定（与 verify 的 DOM 顺序断言同源）：
  // 会话表在前，AI 画像卡紧随其后，同一滚动流。
  return (
    <>
      {SESSION_PAGE_SECTIONS.map((section) => {
        if (section === "sessions") {
          return (
            <div className="wl-card" key="sessions" data-section="sessions">
              <h3>{t("tab.bySession")}</h3>
              <table className="wl-table">
                <thead>
                  <tr>
                    <th>{t("table.session")}</th><th>{t("table.workspace")}</th><th>{t("table.date")}</th>
                    {SESSION_METRICS.map(({ key, labelKey }) => (
                      <th key={key} aria-sort={sort?.key === key ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}>
                        <button type="button" className="wl-th-sort" data-active={sort?.key === key || undefined} title={t("table.sortHint")} onClick={() => toggleSort(key)}>
                          {t(labelKey)}
                          <span className="wl-sort-mark" aria-hidden="true">{sort?.key === key ? (sort.dir === "asc" ? "▲" : "▼") : "↕"}</span>
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 ? (
                    <tr><td colSpan={7} className="wl-state">{t("state.empty")}</td></tr>
                  ) : (
                    rows.map((row) => (
                      <tr key={row.id}>
                        <td className="wl-name" title={row.title}>{row.title || "(无标题)"}</td>
                        <td className="wl-name">{row.workspaceLabel}</td>
                        <td>{row.date}</td>
                        {SESSION_METRICS.map(({ key, labelKey, format }) => {
                          const value = sessionMetric(row, key);
                          return (
                            <td key={key}>
                              <MetricBarCell
                                value={value}
                                max={maxima[key]}
                                kind={key}
                                text={format(value)}
                                title={`${t(labelKey)} ${format(value)}`}
                              />
                            </td>
                          );
                        })}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          );
        }
        return (
          <ProfileCard
            key="profile"
            t={t}
            lang={lang}
            days={days}
            scope={scope}
            allTime={allTime}
            tz={localTimeZone()}
          />
        );
      })}
    </>
  );
}

/** 全屏看板。 */
function Overlay({ control }) {
  const { t, lang } = useLocale();
  const open = useSyncExternalStore(control.subscribe, control.isOpen);
  // 默认近 7 天：打开即见"最近一周"，与宿主 DEFAULTS.defaultDays 保持一致
  const [rangeKey, setRangeKey] = useState("range.7");
  const activeRange = RANGES.find((range) => range.key === rangeKey) ?? RANGES[0];
  const days = activeRange.days;
  const allTime = activeRange.all === true;
  const [scope, setScope] = useState("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState("byDay");
  // 关闭时不请求，避免白跑一次接口
  const state = useSnapshot({ days, scope, refreshKey, enabled: open, all: allTime });
  const indexing = state.data?.diagnostics?.indexing === true;

  const close = useCallback(() => control.close(), [control]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") control.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, control]);

  // 首次建索引要冷读历史会话（可能几分钟）、模型折叠正在跑时要跟进进度：
  // 只在**后台确实在跑**时每 5 秒重拉；pending 但没在跑（等定时器）不轮询——
  // 打开面板本身绝不启动读日志，也不该让页面一直空转请求。
  const modelFold = modelFoldState(state.data);
  const modelRunning = modelFold.running;
  useEffect(() => {
    if (!open || (!indexing && !modelRunning)) return undefined;
    const timer = setTimeout(() => setRefreshKey((value) => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [open, indexing, modelRunning, refreshKey]);

  const exportReport = useCallback(() => {
    const query = new URLSearchParams({
      days: String(days),
      scope,
      tz: localTimeZone(),
      theme: isDarkTheme() ? "dark" : "light",
      title: lang === "zh" ? "工作量报告" : "Workload Report",
    });
    if (allTime) query.set("all", "1");
    window.open(`${API_PATH}/report.html?${query.toString()}`, "_blank", "noopener");
  }, [days, scope, lang, allTime]);

  if (!open) return null;

  return (
    <div className="wl-overlay" role="dialog" aria-modal="true" aria-label={t("panel.title")} onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div className="wl-panel">
        <header className="wl-head">
          <div>
            <h2 className="wl-title">{t("panel.title")}</h2>
            <p className="wl-subtitle">
              {state.data === null ? t("panel.subtitle") : `${state.data.range.from} ~ ${state.data.range.to} · ${t("panel.subtitle")}`}
            </p>
          </div>
          <div className="wl-spacer" />
          <ChipGroup label={t("panel.title")}>
            {RANGES.map((range) => (
              <Chip key={range.key} active={rangeKey === range.key} onClick={() => setRangeKey(range.key)}>
                {t(range.key)}
              </Chip>
            ))}
          </ChipGroup>
          <select className="wl-select" value={scope} onChange={(event) => setScope(event.target.value)} aria-label={t("scope.all")}>
            {SCOPES.map((item) => (
              <option key={item} value={item}>{t(`scope.${item}`)}</option>
            ))}
          </select>
          <button type="button" className="wl-btn" onClick={() => setRefreshKey((value) => value + 1)}>{t("action.refresh")}</button>
          <button type="button" className="wl-btn" data-kind="primary" onClick={exportReport}>{t("action.export")}</button>
          <button type="button" className="wl-btn" onClick={close} aria-label={t("action.close")}>✕</button>
        </header>
        <div className="wl-body">
          {state.status === "error" ? <p className="wl-state">{t("state.failed", { message: state.error ?? "" })}</p> : null}
          {state.data === null ? (
            // 缓存未命中：先渲染完整骨架（卡片/图表容器/表格框都在），数据到了原地填充
            state.status === "error" ? null : <SkeletonBody t={t} />
          ) : (
            <>
              {indexing ? (
                <p className="wl-hint" data-kind="indexing">
                  {t("state.indexing", { done: formatInt(state.data.diagnostics?.sessions ?? 0) })}
                </p>
              ) : null}
              <Kpis data={state.data} t={t} />
              <div className="wl-tabs">
                {["byDay", "model", "byWorkspace", "bySession"].map((key) => (
                  <button key={key} type="button" className="wl-tab" data-active={tab === key} onClick={() => setTab(key)}>
                    {t(`tab.${key}`)}
                  </button>
                ))}
              </div>
              {tab === "byDay" ? <ByDayView data={state.data} t={t} /> : null}
              {tab === "model" ? <ModelSection data={state.data} t={t} /> : null}
              {tab === "byWorkspace" ? <ByWorkspaceView data={state.data} t={t} /> : null}
              {tab === "bySession" ? (
                <BySessionView data={state.data} t={t} lang={lang} days={days} scope={scope} allTime={allTime} />
              ) : null}
              <p className="wl-note">
                <strong>{t("note.title")}</strong>：{t("note.body")}
                {state.data.diagnostics?.missing > 0 ? t("note.unavailable", { count: formatInt(state.data.diagnostics.missing) }) : ""}
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * 安装客户端半部：注入样式、注册文案、注册两个插槽。
 * @param ctx - 客户端 Cordis 上下文。
 */
export function apply(ctx) {
  const style = document.createElement("style");
  style.dataset.plugin = "workload-report";
  style.textContent = STYLES;
  document.head.appendChild(style);
  ctx.effect(() => () => style.remove(), "workload-report: styles");

  ctx.effect(() => {
    localeRuntime = ctx.locale;
    const unregister = ctx.locale.register(NS, { zh, en });
    return () => {
      unregister();
      if (localeRuntime === ctx.locale) localeRuntime = null;
    };
  }, "workload-report: locale");

  const control = createPanelControl();
  // 注意：插槽的 inject.hooks 只接受 store 形状（getSnapshot/subscribe）的「可观察源」，
  // 不是 React hook；这里直接把控制对象当作普通属性传入，组件内部自行 useSyncExternalStore。
  const injectProps = () => ({ control });

  ctx.slots.inject("sidebar.footer.action", () =>
    ctx.slots.register({ name: "sidebar.footer.action", id: "workload-report", order: 30, inject: injectProps }, FooterAction),
  );
  ctx.slots.inject("shell.overlay", () =>
    ctx.slots.register({ name: "shell.overlay", id: "workload-report", order: 30, inject: injectProps }, Overlay),
  );
  // 顶部工具栏（会话头部右侧动作区）的余额 chip：默认配置下不渲染
  ctx.slots.inject("conversation.session.header.actions", () =>
    ctx.slots.register({ name: "conversation.session.header.actions", id: "workload-report-balance", order: 40, inject: () => ({}) }, BalanceChip),
  );
}
