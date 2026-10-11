/**
 * dsh-workload-report — 客户端（浏览器）半部。
 *
 * 在侧边栏底部加一个「工作量报告」按钮，点开一个全屏看板：KPI 卡片 + 按日期趋势 +
 * 按工作区排行 + 主要会话，并提供「导出 HTML 报告」。数据来自宿主半部的只读接口。
 * 图表是手写 SVG，不引第三方图表库；样式全部用宿主主题 token，自动适配浅色/深色。
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { STYLES } from "./styles.js";
import { NS, en, languageOf, translate, zh } from "./locales.js";
import { formatDuration, formatInt, formatPercent, formatTokens } from "../format.js";

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

/** 拉取聚合快照。 */
function useSnapshot({ days, scope, refreshKey, enabled, all }) {
  const [state, setState] = useState({ status: "loading", data: null, error: null });
  useEffect(() => {
    if (!enabled) return undefined;
    const abort = new AbortController();
    setState((previous) => ({ ...previous, status: previous.data === null ? "loading" : "refreshing" }));
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
      .then((data) => setState({ status: "ready", data, error: null }))
      .catch((error) => {
        if (error?.name === "AbortError") return;
        setState((previous) => ({ status: "error", data: previous.data, error: String(error?.message ?? error) }));
      });
    return () => abort.abort();
  }, [days, scope, refreshKey, enabled, all]);
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
function CalendarHeatmap({ calendar, t }) {
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
  const cell = model.list.length > 30 ? 11 : model.list.length > 14 ? 15 : 20;
  const gap = 3;
  const leftPad = 30;
  const topPad = 18;
  const barArea = 54;
  const valueArea = 44;
  const calendarWidth = leftPad + model.list.length * (cell + gap);
  const barX = calendarWidth + 8;
  const width = barX + barArea + valueArea;
  const height = topPad + 7 * (cell + gap) + 4;
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

  return (
    <div className="wl-cal-scroll">
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} role="img" aria-label={t("cal.title")}>
        {weekdayLabels.map((label, row) => (
          <text key={label} x={0} y={topPad + row * (cell + gap) + cell * 0.72} fontSize="10" fill="var(--dsw-alias-label-tertiary, #6b7280)">
            {label}
          </text>
        ))}
        {model.list.map((column, index) => {
          const x = leftPad + index * (cell + gap);
          const showLabel = index === 0 || column.week === 1 || column.year !== model.list[index - 1]?.year || index % 4 === 0;
          return (
            <g key={column.key}>
              {showLabel ? (
                <text x={x} y={11} fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
                  {column.week === 1 || index === 0 || column.year !== model.list[index - 1]?.year
                    ? `${column.year}W${String(column.week).padStart(2, "0")}`
                    : `W${String(column.week).padStart(2, "0")}`}
                </text>
              ) : null}
              {[0, 1, 2, 3, 4, 5, 6].map((row) => {
                const entry = column.cells.get(row);
                if (entry === undefined) return null;
                const activeMs = entry.day?.activeMs ?? 0;
                const title = entry.day
                  ? `${entry.date}\n活跃 ${formatDuration(activeMs)}\n对话 ${entry.day.conversations} · 轮次 ${entry.day.turns}`
                  : `${entry.date}\n无记录`;
                return (
                  <rect key={entry.date} x={x} y={topPad + row * (cell + gap)} width={cell} height={cell} rx="3" fill={fills[level(activeMs)]}>
                    <title>{title}</title>
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
                <title>{`${weekdayLabels[row]} 累计 ${formatDuration(total)}`}</title>
              </rect>
              <text x={barX + barArea + 5} y={y + cell * 0.78} fontSize="9" fill="var(--dsw-alias-label-tertiary, #6b7280)">
                {total > 0 ? formatDuration(total) : ""}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 24 小时时刻分析（横轴 0–23，柱＝分摊活跃时长）。 */
function HourChart({ hours, t }) {
  const max = Math.max(1, ...hours.map((hour) => hour.activeMs));
  const peak = hours.reduce((best, hour) => (hour.activeMs > best.activeMs ? hour : best), hours[0]);
  return (
    <>
      <div className="wl-hour-grid">
        {hours.map((hour) => {
          const ratio = hour.activeMs / max;
          return (
            <div className="wl-hour-col" key={hour.hour} data-peak={hour.hour === peak?.hour || undefined}>
              <div className="wl-hour-track">
                <div className="wl-hour-fill" style={{ height: `${Math.max(ratio * 100, hour.activeMs > 0 ? 3 : 0).toFixed(1)}%` }} />
              </div>
              <div className="wl-hour-label">{hour.hour}</div>
              <div className="wl-hour-tip">
                {t("hour.tip", {
                  hour: hour.hour,
                  active: formatDuration(hour.activeMs),
                  sessions: formatInt(hour.sessions),
                  starts: formatInt(hour.starts),
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="wl-legend">
        <span>{t("hour.peak", { hour: peak?.hour ?? 0, active: formatDuration(peak?.activeMs ?? 0) })}</span>
      </div>
    </>
  );
}

/** 工作区环形图（时长 / Token 可切换，Top N + 其他）。 */
function WorkspacePie({ items, range, t }) {
  const [metric, setMetric] = useState("activeMs");
  const slices = useMemo(() => {
    const valueOf = (item) => (metric === "activeMs" ? item.activeMs : item.tokensTotal);
    const sorted = [...items].filter((item) => valueOf(item) > 0).sort((a, b) => valueOf(b) - valueOf(a));
    const top = sorted.slice(0, 6);
    const rest = sorted.slice(6);
    const slicesOut = top.map((item) => ({ label: item.label, value: valueOf(item), item }));
    if (rest.length > 0) slicesOut.push({ label: t("pie.others", { count: rest.length }), value: rest.reduce((sum, item) => sum + valueOf(item), 0), item: null });
    const total = slicesOut.reduce((sum, slice) => sum + slice.value, 0);
    return { slices: slicesOut, total };
  }, [items, metric, t]);

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
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const arcs = slices.slices.map((slice, index) => {
    const share = slices.total > 0 ? slice.value / slices.total : 0;
    const dash = share * circumference;
    const arc = { ...slice, share, dash, offset, color: palette[index % palette.length] };
    offset += dash;
    return arc;
  });
  const formatValue = (value) => (metric === "activeMs" ? formatDuration(value) : formatInt(value));

  return (
    <>
      <div className="wl-chips wl-chips-inline">
        <button type="button" className="wl-chip" data-active={metric === "activeMs"} onClick={() => setMetric("activeMs")}>{t("pie.byTime")}</button>
        <button type="button" className="wl-chip" data-active={metric === "tokens"} onClick={() => setMetric("tokens")}>{t("pie.byTokens")}</button>
      </div>
      <div className="wl-pie-wrap">
        <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label={t("pie.title")}>
          <g transform="translate(80,80) rotate(-90)">
            {arcs.map((arc) => (
              <circle
                key={arc.label}
                r={radius}
                fill="none"
                stroke={arc.color}
                strokeWidth={stroke}
                strokeDasharray={`${arc.dash.toFixed(2)} ${(circumference - arc.dash).toFixed(2)}`}
                strokeDashoffset={-arc.offset}
              >
                <title>{`${arc.label}\n${formatValue(arc.value)}（${formatPercent(arc.share)}）`}</title>
              </circle>
            ))}
          </g>
          <text x="80" y="76" textAnchor="middle" fontSize="15" fontWeight="650" fill="var(--dsw-alias-label-primary, #1a1d21)">
            {metric === "activeMs" ? formatDuration(slices.total) : formatTokens(slices.total)}
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
    </>
  );
}

/** 每日「Token 堆叠柱 + 活跃时长折线」。 */
function DailyChart({ days, t }) {
  const geometry = useMemo(() => {
    const width = 1080;
    const height = 240;
    const pad = { top: 12, right: 8, bottom: 30, left: 8 };
    const innerW = width - pad.left - pad.right;
    const innerH = height - pad.top - pad.bottom;
    if (days.length === 0) return null;
    const maxTokens = Math.max(1, ...days.map((day) => day.tokensTotal));
    const maxActive = Math.max(1, ...days.map((day) => day.activeMs));
    const step = innerW / days.length;
    const barWidth = Math.max(1.5, Math.min(24, step * 0.62));
    const bars = [];
    const points = [];
    days.forEach((day, index) => {
      const centerX = pad.left + step * index + step / 2;
      const scale = (value, max) => (value / max) * innerH;
      const heights = [
        [day.tokens.cacheRead, "var(--dsw-static-neutral-300, #c7cbd1)"],
        [day.tokens.input, "var(--dsw-static-blue-500, #3b82f6)"],
        [day.tokens.output, "var(--dsw-static-green-500, #10b981)"],
      ];
      let y = pad.top + innerH;
      const rects = [];
      heights.forEach(([value, fill], series) => {
        const h = scale(value, maxTokens);
        if (h <= 0.4) return;
        y -= h;
        rects.push(<rect key={series} x={centerX - barWidth / 2} y={y} width={barWidth} height={h} rx="2" fill={fill} />);
      });
      bars.push(
        <g key={day.date}>
          <title>{`${day.date}\nToken ${formatInt(day.tokensTotal)}\n活跃 ${formatDuration(day.activeMs)}\n对话 ${day.conversations} · 轮次 ${day.turns}`}</title>
          {rects}
        </g>,
      );
      points.push(`${centerX.toFixed(2)},${(pad.top + innerH - scale(day.activeMs, maxActive) * 0.92).toFixed(2)}`);
    });
    const labelEvery = Math.max(1, Math.ceil(days.length / 12));
    const labels = days.map((day, index) =>
      index % labelEvery === 0 || index === days.length - 1 ? (
        <text key={day.date} x={pad.left + step * index + step / 2} y={height - 10} textAnchor="middle" fontSize="10" fill="var(--dsw-alias-label-tertiary, #6b7280)">
          {day.date.slice(5)}
        </text>
      ) : null,
    );
    return { width, height, pad, innerH, innerW, bars, points, labels };
  }, [days]);

  if (geometry === null) return <p className="wl-state">{t("state.empty")}</p>;
  const { width, height, pad, innerH, innerW, bars, points, labels } = geometry;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={t("chart.daily")}>
      <line x1={pad.left} y1={pad.top + innerH} x2={pad.left + innerW} y2={pad.top + innerH} stroke="var(--dsw-alias-border-l2, #e5e7eb)" />
      {bars}
      <polyline points={points.join(" ")} fill="none" stroke="var(--dsw-static-deepseek-500, #4d6bfe)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.85" />
      {labels}
    </svg>
  );
}

/** KPI 卡片组。 */
function Kpis({ data, t }) {
  const totals = data.totals;
  const derived = data.derived;
  const cards = [
    ["kpi.active", formatDuration(totals.activeMs), t("kpi.active.sub", { llm: formatDuration(totals.llmMs), tool: formatDuration(totals.toolMs) })],
    // 总 Token 直接给完整整数（可核对的真实值），小字里才用 K/M/B 缩写
    ["kpi.tokens", formatInt(totals.tokensTotal), t("kpi.tokens.sub", { input: formatTokens(totals.tokens.input), output: formatTokens(totals.tokens.output), cache: formatTokens(totals.tokens.cacheRead) })],
    ["kpi.activeDays", `${formatInt(totals.activeDays)} / ${formatInt(data.range.days)}`, t("kpi.activeDays.sub", { workspaces: formatInt(totals.workspaces) })],
    ["kpi.conversations", formatInt(totals.conversations), t("kpi.conversations.sub", { sessions: formatInt(totals.sessions), empty: formatInt(totals.emptySessions) })],
    ["kpi.turns", `${formatInt(totals.turns)} / ${formatInt(totals.steps)}`, t("kpi.turns.sub", { main: formatInt(totals.mainSessions), subagent: formatInt(totals.subagentSessions) })],
    ["kpi.cache", formatPercent(derived.cacheHitRate), t("kpi.cache.sub", { output: formatTokens(derived.outputPerActiveHour) })],
  ];
  return (
    <div className="wl-kpis">
      {cards.map(([key, value, sub]) => (
        <div className="wl-kpi" key={key}>
          <div className="wl-kpi-label">{t(key)}</div>
          <div className="wl-kpi-value">{value}</div>
          <div className="wl-kpi-sub">{sub}</div>
        </div>
      ))}
    </div>
  );
}

/**
 * 按日期视图（首页主视图）：
 *   1) 每日用量：默认「日历热力图」（周一~周日 × Year-Week，颜色＝活跃时长），可切「柱状图」
 *   2) 并排两图：左「时刻分析」（0–23 点谁更活跃） 右「工作区占比」（环形图，时长/Token 可切）
 *   3) 「按日期明细」默认折叠
 */
function ByDayView({ data, t }) {
  const [dailyMode, setDailyMode] = useState("calendar");
  const rows = [...data.byDay].filter((day) => day.sessions > 0).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 31);

  return (
    <>
      <div className="wl-card">
        <div className="wl-card-head">
          <div>
            <h3>{t("chart.daily")}</h3>
            <p className="wl-hint">{dailyMode === "calendar" ? t("cal.hint") : t("chart.hint")}</p>
          </div>
          <div className="wl-chips">
            <button type="button" className="wl-chip" data-active={dailyMode === "calendar"} onClick={() => setDailyMode("calendar")}>{t("daily.calendar")}</button>
            <button type="button" className="wl-chip" data-active={dailyMode === "bar"} onClick={() => setDailyMode("bar")}>{t("daily.bar")}</button>
          </div>
        </div>
        {dailyMode === "calendar" ? (
          <>
            <CalendarHeatmap calendar={data.calendar} t={t} />
            <div className="wl-legend">
              <span className="wl-metric-sub">{t("cal.scale")}</span>
              <span className="wl-cal-scale" aria-hidden="true">
                {[0, 1, 2, 3, 4].map((level) => (
                  <i
                    key={level}
                    className="wl-cal-swatch"
                    style={{
                      background: [
                        "var(--dsw-alias-bg-layer-2, #eef0f3)",
                        "var(--dsw-static-deepseek-100, #dfe5ff)",
                        "var(--dsw-static-deepseek-300, #a9b8ff)",
                        "var(--dsw-static-deepseek-500, #4d6bfe)",
                        "var(--dsw-static-deepseek-700, #2b3fa8)",
                      ][level],
                    }}
                  />
                ))}
                <span className="wl-metric-sub">{t("cal.less")} → {t("cal.more")}</span>
              </span>
            </div>
          </>
        ) : (
          <>
            <DailyChart days={data.byDay} t={t} />
            <div className="wl-legend">
              <span><i className="wl-dot" style={{ background: "var(--dsw-static-neutral-300, #c7cbd1)" }} />{t("legend.cache")}</span>
              <span><i className="wl-dot" style={{ background: "var(--dsw-static-blue-500, #3b82f6)" }} />{t("legend.input")}</span>
              <span><i className="wl-dot" style={{ background: "var(--dsw-static-green-500, #10b981)" }} />{t("legend.output")}</span>
              <span><i className="wl-dot" style={{ background: "var(--dsw-static-deepseek-500, #4d6bfe)" }} />{t("legend.active")}</span>
            </div>
          </>
        )}
      </div>

      <div className="wl-grid-2">
        <div className="wl-card">
          <h3>{t("hour.title")}</h3>
          <p className="wl-hint">{t("hour.sub")}</p>
          <HourChart hours={data.byHour} t={t} />
        </div>
        <div className="wl-card">
          <div className="wl-card-head">
            <div>
              <h3>{t("pie.title")}</h3>
              <p className="wl-hint">{t("pie.hint")}</p>
            </div>
          </div>
          <WorkspacePie items={data.byWorkspace} range={data.range} t={t} />
        </div>
      </div>

      <details className="wl-card wl-details">
        <summary>{t("detail.summary", { count: rows.length })}</summary>
        <table className="wl-table">
          <thead>
            <tr>
              <th>{t("table.date")}</th><th>{t("table.conversations")}</th><th>{t("table.turns")}</th><th>{t("table.steps")}</th>
              <th>{t("table.active")}</th><th>{t("table.input")}</th><th>{t("table.output")}</th><th>{t("table.cache")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={8} className="wl-state">{t("state.empty")}</td></tr>
            ) : (
              rows.map((day) => (
                <tr key={day.date}>
                  <td>{day.date}</td><td>{day.conversations}</td><td>{formatInt(day.turns)}</td><td>{formatInt(day.steps)}</td>
                  <td>{formatDuration(day.activeMs)}</td><td>{formatTokens(day.tokens.input)}</td>
                  <td>{formatTokens(day.tokens.output)}</td><td>{formatTokens(day.tokens.cacheRead)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </details>
    </>
  );
}

/**
 * 按工作区视图：每行左右两块——
 *   左「我的付出」= 活跃时长（bar 按占全部的比例）+ 活跃天数 / 轮次 / 步骤
 *   右「Token 消耗」= 总 Token（bar 同样按占比）+ 输出 / 缓存读取
 * 两条 bar 用同一口径（占全部的比例），所以任意两行、左右两块都可比。
 */
function ByWorkspaceView({ data, t }) {
  const items = data.byWorkspace;
  const pct = (share) => `${(Math.max(0, Math.min(1, share ?? 0)) * 100).toFixed(2)}%`;
  const dateOf = (ms) => (ms > 0 ? new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");

  return (
    <>
      <div className="wl-card">
        <h3>{t("tab.byWorkspace")}</h3>
        <p className="wl-hint">{t("ws.hint")}</p>
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
                <div className="wl-ws-head">
                  <span className="wl-ws-name" title={item.path}>{item.label}</span>
                  <span className="wl-ws-meta">{t("ws.lastUsed", { date: dateOf(item.lastUsedAt) })}</span>
                </div>
                <div className="wl-metrics">
                  <div className="wl-metric">
                    <div className="wl-metric-value">
                      {formatDuration(item.activeMs)}
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
                  {t("metric.chatsSub", { avg: formatDuration(item.avgActiveMsPerConversation) })}
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
                  <td>{formatInt(item.steps)}</td><td>{formatDuration(item.activeMs)}</td><td>{formatTokens(item.tokensTotal)}</td>
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

/** 主要会话视图。 */
function BySessionView({ data, t }) {
  const rows = data.bySession.slice(0, 40);
  return (
    <div className="wl-card">
      <h3>{t("tab.bySession")}</h3>
      <table className="wl-table">
        <thead>
          <tr>
            <th>{t("table.session")}</th><th>{t("table.workspace")}</th><th>{t("table.date")}</th>
            <th>{t("table.turns")}</th><th>{t("table.steps")}</th><th>{t("table.active")}</th><th>{t("table.output")}</th>
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
                <td>{row.date}</td><td>{formatInt(row.turns)}</td><td>{formatInt(row.steps)}</td>
                <td>{formatDuration(row.activeMs)}</td><td>{formatTokens(row.tokens.output)}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 全屏看板。 */
function Overlay({ control }) {
  const { t, lang } = useLocale();
  const open = useSyncExternalStore(control.subscribe, control.isOpen);
  const [rangeKey, setRangeKey] = useState("range.30");
  const activeRange = RANGES.find((range) => range.key === rangeKey) ?? RANGES[1];
  const days = activeRange.days;
  const allTime = activeRange.all === true;
  const [scope, setScope] = useState("all");
  const [refreshKey, setRefreshKey] = useState(0);
  const [tab, setTab] = useState("byDay");
  const [copied, setCopied] = useState(false);
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

  // 首次建索引要冷读历史会话（可能几分钟）：还在补齐时每 5 秒自动重拉一次
  useEffect(() => {
    if (!open || !indexing) return undefined;
    const timer = setTimeout(() => setRefreshKey((value) => value + 1), 5000);
    return () => clearTimeout(timer);
  }, [open, indexing, refreshKey]);

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

  const copyJson = useCallback(async () => {
    if (state.data === null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(state.data, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }, [state.data]);

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
          <div className="wl-chips">
            {RANGES.map((range) => (
              <button key={range.key} type="button" className="wl-chip" data-active={rangeKey === range.key} onClick={() => setRangeKey(range.key)}>
                {t(range.key)}
              </button>
            ))}
          </div>
          <select className="wl-select" value={scope} onChange={(event) => setScope(event.target.value)} aria-label={t("scope.all")}>
            {SCOPES.map((item) => (
              <option key={item} value={item}>{t(`scope.${item}`)}</option>
            ))}
          </select>
          <button type="button" className="wl-btn" onClick={() => setRefreshKey((value) => value + 1)}>{t("action.refresh")}</button>
          <button type="button" className="wl-btn" onClick={copyJson}>{copied ? t("action.copied") : t("action.copy")}</button>
          <button type="button" className="wl-btn" data-kind="primary" onClick={exportReport}>{t("action.export")}</button>
          <button type="button" className="wl-btn" onClick={close} aria-label={t("action.close")}>✕</button>
        </header>
        <div className="wl-body">
          {state.status === "error" ? <p className="wl-state">{t("state.failed", { message: state.error ?? "" })}</p> : null}
          {state.data === null ? (
            state.status === "error" ? null : <p className="wl-state">{t("state.loading")}</p>
          ) : (
            <>
              {indexing ? (
                <p className="wl-hint" data-kind="indexing">
                  {t("state.indexing", { done: formatInt(state.data.diagnostics?.sessions ?? 0) })}
                </p>
              ) : null}
              <Kpis data={state.data} t={t} />
              <div className="wl-tabs">
                {["byDay", "byWorkspace", "bySession"].map((key) => (
                  <button key={key} type="button" className="wl-tab" data-active={tab === key} onClick={() => setTab(key)}>
                    {t(`tab.${key}`)}
                  </button>
                ))}
              </div>
              {tab === "byDay" ? <ByDayView data={state.data} t={t} /> : null}
              {tab === "byWorkspace" ? <ByWorkspaceView data={state.data} t={t} /> : null}
              {tab === "bySession" ? <BySessionView data={state.data} t={t} /> : null}
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
}
