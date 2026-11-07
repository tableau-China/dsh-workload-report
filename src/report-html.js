/**
 * 生成**自包含** HTML 报告：内联 CSS + 内联 SVG 图表，无任何外部资源、无脚本。
 * 目标用途：博客截图、给客户展示开发工作量、打印/导出 PDF、直接当文件发出去。
 *
 * 口径与看板保持一致（见 docs/report-parity.md）：
 *   · 小时 / 时长一律走 formatHours（1 位小数）；
 *   · 卡片说明统一放标题右侧（11px muted），与看板 CardHead 同位置；
 *   · 表格比例条与看板 MetricBarCell 同规则（barPercent）；
 *   · 交互切换在静态报告里不伪造按钮：默认 Tokens 口径，轮次用第二张小图呈现；
 *   · 时刻图状态行复用 hourTokensNote（回填中 / 未计入 N 个会话）。
 *
 * 语言：`renderReport(snapshot, { lang })` 按 `lang` 渲染（8 种语言，见 docs/i18n.md）。
 * 服务端路由必须显式带语言（query `lang` → Accept-Language → en）；缺省 `lang`
 * 保持旧行为（zh），既有离线测试不需要改。所有文案走 `t(...)`，日期走 localeTag(lang)；
 * 数字 / Token / 金额仍用 src/format.js 的语言无关紧凑格式。
 *
 * 所有外部文本（工作区名、会话标题、备注）都经 escapeHtml 转义。
 */

import { barPercent } from "./client/bar-width.js";
import { hourTokensNote } from "./client/hour-status.js";
import { escapeHtml, formatHours, formatInt, formatPercent, formatProvider, formatSpeed, formatTtft, formatTokens } from "./format.js";
import { languageOf, localeTag, translator } from "./locales/index.js";
import { SEMANTIC, TABLEAU10, withAlpha } from "./palette.js";
import { sectorPath } from "./sector-path.js";
import { HOUR_CHART_TOP_SPACE, HOUR_DOT_TOP, hourDotRadius } from "./hour-scale.js";

/** 主题色板（浅色/深色）。报告是独立文件，用不了宿主 token，因此自带一套与看板一致的色板。 */
const PALETTES = {
  light: {
    bg: "#f5f6f8", surface: "#ffffff", text: "#1a1d21", muted: "#6b7280", border: "#e5e7eb",
    input: SEMANTIC.turns, output: SEMANTIC.tokens, cache: TABLEAU10[9], accent: SEMANTIC.turns, barBg: "#eef0f3",
    /** 周末柱：与看板同一语义色（我的付出 = 橙）。 */
    weekend: SEMANTIC.effort,
    /** 时刻图峰值柱：蓝的深阶，与人类消息点（橙）区分。 */
    peak: "#3f5a7d",
    /** 日历热力图 5 级色阶（由中性到 Tableau 蓝的深阶）。 */
    calendar: ["#eef0f3", "#dfe5f2", "#aebfd4", "#5778a4", "#3f5a7d"],
    /** 表格比例条填色：与看板 MetricBarCell 同色同透明度。 */
    barFill: {
      turns: withAlpha(SEMANTIC.turns, 0.22),
      steps: withAlpha(SEMANTIC.steps, 0.30),
      activeMs: withAlpha(SEMANTIC.effort, 0.26),
      conversations: withAlpha(SEMANTIC.conversations, 0.30),
      output: withAlpha(SEMANTIC.tokens, 0.22),
      tokens: withAlpha(SEMANTIC.tokens, 0.22),
    },
  },
  dark: {
    bg: "#15171c", surface: "#1d2026", text: "#e8eaed", muted: "#9aa1ac", border: "#2b2f37",
    input: "#8fa9c8", output: "#8fbf7e", cache: "#7c858f", accent: "#8fa9c8", barBg: "#282c34",
    weekend: "#eeb078",
    peak: "#8fa9c8",
    calendar: ["#282c34", "#2c374a", "#3f5372", "#5778a4", "#8fa9c8"],
    barFill: {
      turns: withAlpha("#8fa9c8", 0.30),
      steps: withAlpha(TABLEAU10[9], 0.34),
      activeMs: withAlpha("#eeb078", 0.32),
      conversations: withAlpha("#c3a0bd", 0.32),
      output: withAlpha("#8fbf7e", 0.30),
      tokens: withAlpha("#8fbf7e", 0.30),
    },
  },
};

/** 日期是否周末（与看板同口径：按该日历日的本地星期判定）。 */
function isWeekend(dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00`).getDay();
  return weekday === 0 || weekday === 6;
}

/** ISO 周（周一为一周起点），返回 { year, week }；与看板同一算法。 */
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from ?? "") || !/^\d{4}-\d{2}-\d{2}$/.test(to ?? "")) return out;
  let cursor = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(cursor) || !Number.isFinite(end)) return out;
  while (cursor <= end && out.length < limit) {
    out.push(new Date(cursor).toISOString().slice(0, 10));
    cursor += 86400000;
  }
  return out;
}

/**
 * 卡片头：与看板 CardHead 同构 —— 左侧标题 + 紧右侧 11px muted 说明，右侧可选控件。
 * 报告没有交互控件，因此 actions 只用于静态标记（不伪造按钮）。
 * 标题 / 说明都传**词典键**（说明可带占位符取值），由本函数统一取词并转义。
 * @param t - 绑定语言的翻译函数。
 * @param titleKey - 标题词典键。
 * @param hintKey - 说明词典键（空串表示无说明）。
 * @param hintVars - 说明里的 `{name}` 占位符取值。
 * @returns 卡片头 HTML 字符串。
 */
function cardHead(t, titleKey, hintKey = "", hintVars = undefined) {
  const title = t(titleKey);
  const hint = hintKey === "" ? "" : t(hintKey, hintVars);
  return `<div class="card-head">
    <div class="card-head-text"><h2>${escapeHtml(title)}</h2>${hint === "" ? "" : `<span class="card-hint" title="${escapeHtml(hint)}">${escapeHtml(hint)}</span>`}</div>
  </div>`;
}

/** 顶部区间筛选器的选项（与看板 RANGES 的前三档 + 全部一致；文案走 range.* 词典键）。 */
const REPORT_RANGES = Object.freeze(["7", "30", "90", "all"]);

/**
 * 顶部区间筛选器的**静态外观**（打印 / 发客户时保留看板的视觉语汇）。
 *
 * 注意：这不是交互控件。报告是自包含静态文件（无脚本、外链仅官方计费页，见
 * docs/report-parity.md 铁律），因此这里用 `<span>` 而非 `<a>` / `<button>`：
 * 不伪造可点击性，导出文件不会有失效链接。当前区间以品牌色实底 + 白字突出，
 * 其余档位为浅底 + 边框（与看板 ChipGroup 同一套视觉）。
 *
 * @param t - 绑定语言的翻译函数。
 * @param rangeKey - 当前区间键（7 / 30 / 90 / all）。
 * @returns HTML 字符串。
 */
function rangeFilter(t, rangeKey) {
  const current = String(rangeKey ?? "7");
  const chips = REPORT_RANGES.map((range) => {
    const label = t(`range.${range}`);
    return `<span class="range-chip"${range === current ? ' data-active="true"' : ""}>${escapeHtml(label)}</span>`;
  }).join("");
  return `<div class="range-filter" aria-label="${escapeHtml(t("report.rangeFilter.aria"))}">${chips}</div>`;
}

/**
 * 表格比例条：与看板 MetricBarCell 同规则（宽度 = 本行 / 本列最大值），报告用内联 div 背景条。
 * @param value - 原始数值。
 * @param max - 本列最大值。
 * @param text - 展示文本。
 * @param kind - 语义 / 颜色标记。
 * @param palette - 色板。
 * @returns 单元格 HTML。
 */
function barCell(value, max, text, kind, palette) {
  const width = barPercent(value, max);
  const fill = palette.barFill[kind] ?? palette.barFill.turns;
  return `<span class="bar-cell" data-bar-cell data-kind="${escapeHtml(kind)}"><span class="bar-cell-fill" data-kind="${escapeHtml(kind)}" style="width:${width.toFixed(1)}%;background:${fill}"></span><span class="bar-cell-value">${escapeHtml(text)}</span></span>`;
}

/**
 * 日历热力图（静态版）：纵轴周一～周日，横轴 Year-Week，颜色深浅＝活跃时长；
 * 右侧紧贴每周几的累计活跃条。数据源是 snapshot.calendar（全部历史，与看板一致）。
 * @param calendar - snapshot.calendar。
 * @param palette - 色板。
 * @param t - 绑定语言的翻译函数（周几 / tooltip / aria 文案）。
 * @returns HTML 字符串。
 */
function calendarHeatmap(calendar, palette, t) {
  const byDate = new Map((calendar?.days ?? []).map((day) => [day.date, day]));
  const dates = eachDate(calendar?.from ?? "", calendar?.to ?? "");
  if (dates.length === 0) return `<p class="empty">${escapeHtml(t("state.empty"))}</p>`;
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
  const gap = 3;
  const leftPad = 30;
  const topPad = 18;
  const cell = 20;
  const barArea = 54;
  const valueArea = 46;
  const calendarWidth = leftPad + list.length * (cell + gap);
  const barX = calendarWidth + 8;
  const width = barX + barArea + valueArea;
  const height = topPad + 7 * (cell + gap) + 4;
  const level = (ms) => {
    if (!(ms > 0)) return 0;
    const ratio = ms / max;
    if (ratio > 0.75) return 4;
    if (ratio > 0.5) return 3;
    if (ratio > 0.25) return 2;
    return 1;
  };
  const weekdayLabels = [t("cal.mon"), t("cal.tue"), t("cal.wed"), t("cal.thu"), t("cal.fri"), t("cal.sat"), t("cal.sun")];
  const noRecord = t("tip.noRecord");
  const dayTip = (date, day, weekend) =>
    day === null || day === undefined
      ? `${date} · ${noRecord}${weekend}`
      : t("tip.daily", { date, active: formatHours(day.activeMs ?? 0), tokens: formatTokens(day.tokensTotal ?? 0), weekend });
  const weekdayLabelsSvg = weekdayLabels
    .map((label, row) => `<text x="0" y="${(topPad + row * (cell + gap) + cell * 0.72).toFixed(1)}" font-size="10" fill="${palette.muted}">${escapeHtml(label)}<title>${escapeHtml(t("tip.weekday", { weekday: label, total: formatHours(weekdayTotals[row]) }))}</title></text>`)
    .join("");
  const cells = list
    .map((column, index) => {
      const x = leftPad + index * (cell + gap);
      const showLabel = index === 0 || column.week === 1 || column.year !== list[index - 1]?.year || index % 4 === 0;
      const labelText = column.week === 1 || index === 0 || column.year !== list[index - 1]?.year
        ? `${column.year}W${String(column.week).padStart(2, "0")}`
        : `W${String(column.week).padStart(2, "0")}`;
      const columnTotal = [...column.cells.values()].reduce((sum, entry) => sum + (entry.day?.activeMs ?? 0), 0);
      const label = showLabel
        ? `<text x="${x}" y="11" font-size="9" fill="${palette.muted}">${escapeHtml(labelText)}<title>${escapeHtml(t("tip.week", { year: column.year, week: String(column.week).padStart(2, "0"), total: formatHours(columnTotal) }))}</title></text>`
        : "";
      const rects = [0, 1, 2, 3, 4, 5, 6]
        .map((row) => {
          const entry = column.cells.get(row);
          if (entry === undefined) return "";
          const activeMs = entry.day?.activeMs ?? 0;
          const weekend = row >= 5 ? t("tip.weekend") : "";
          return `<rect data-kind="calendar-cell" data-date="${escapeHtml(entry.date)}"${row >= 5 ? ' data-weekend="true"' : ""} x="${x}" y="${topPad + row * (cell + gap)}" width="${cell}" height="${cell}" rx="3" fill="${palette.calendar[level(activeMs)]}"><title>${escapeHtml(dayTip(entry.date, entry.day ?? null, weekend))}</title></rect>`;
        })
        .join("");
      return `<g>${label}${rects}</g>`;
    })
    .join("");
  const weekdayBars = weekdayTotals
    .map((total, row) => {
      const y = topPad + row * (cell + gap);
      const barWidth = (total / maxWeekday) * barArea;
      return `<g><rect data-kind="weekday-bar" data-weekday="${row}" x="${barX}" y="${(y + cell * 0.12).toFixed(1)}" width="${Math.max(barWidth, total > 0 ? 1.5 : 0).toFixed(1)}" height="${(cell * 0.76).toFixed(1)}" rx="2" fill="${palette.input}" opacity="0.9"><title>${escapeHtml(t("tip.weekday", { weekday: weekdayLabels[row], total: formatHours(total) }))}</title></rect><text x="${barX + barArea + 5}" y="${(y + cell * 0.78).toFixed(1)}" font-size="9" fill="${palette.muted}">${total > 0 ? escapeHtml(formatHours(total)) : ""}</text></g>`;
    })
    .join("");
  return `<div class="cal-scroll"><svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" style="max-width:100%;height:auto;display:block" role="img" aria-label="${escapeHtml(t("cal.title"))}">
  ${weekdayLabelsSvg}
  ${cells}
  <line x1="${barX - 4}" y1="${topPad}" x2="${barX - 4}" y2="${topPad + 7 * (cell + gap) - gap}" stroke="${palette.border}" />
  ${weekdayBars}
</svg></div>`;
}


/**
 * 渲染工作区条形排行。
 * @param items - byWorkspace 数组。
 * @param palette - 色板。
 * @param metric - 排序指标（保留参数，报告固定按时长排序）。
 * @param rangeDays - 区间天数（小字分母）。
 * @param t - 绑定语言的翻译函数。
 * @param langTag - 该语言的 BCP 47 标签（日期格式用）。
 * @returns HTML 字符串。
 */
function workspaceBars(items, palette, metric, rangeDays = 0, t, langTag = localeTag("zh")) {
  if (items.length === 0) return `<p class="empty">${escapeHtml(t("state.empty"))}</p>`;
  const dateOf = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString(langTag, { month: "2-digit", day: "2-digit" }) : "—");
  return `<ul class="bars">${items
    .map((item) => {
      const activePct = Math.max(0, Math.min(1, item.activeShare ?? 0)) * 100;
      const tokenPct = Math.max(0, Math.min(1, item.tokenShare ?? 0)) * 100;
      const footVars = {
        sessions: formatInt(item.sessions),
        conversations: formatInt(item.conversations),
        avg: formatHours(item.avgActiveMsPerConversation ?? 0),
      };
      const foot = item.waitMs > 0
        ? t("report.ws.foot.wait", { ...footVars, wait: formatHours(item.waitMs) })
        : t("report.ws.foot", footVars);
      return `<li>
  <div class="ws-head">
    <span class="ws-name">${escapeHtml(item.label || t("common.unknownWorkspace"))}</span>
    <span class="ws-days">${escapeHtml(t("ws.activeDays", { days: formatInt(item.activeDays ?? 0) }))}</span>
    <span class="ws-meta">${escapeHtml(t("ws.lastUsed", { date: dateOf(item.lastUsedAt) }))}</span>
  </div>
  <div class="ws-metrics">
    <div class="ws-metric">
      <div class="m-value">${escapeHtml(formatHours(item.activeMs))}<span class="m-share">${escapeHtml(formatPercent(item.activeShare ?? 0))}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${activePct.toFixed(2)}%"></div></div>
      <div class="m-sub">${escapeHtml(t("metric.effortSub", { days: formatInt(item.activeDays ?? 0), total: formatInt(rangeDays), turns: formatInt(item.turns), steps: formatInt(item.steps) }))}</div>
    </div>
    <div class="ws-metric">
      <div class="m-value">${escapeHtml(formatTokens(item.tokensTotal))}<span class="m-share">${escapeHtml(formatPercent(item.tokenShare ?? 0))}</span></div>
      <div class="bar-track"><div class="bar-fill is-tokens" style="width:${tokenPct.toFixed(2)}%"></div></div>
      <div class="m-sub">${escapeHtml(t("metric.tokensSub", { output: formatTokens(item.tokens.output), cache: formatTokens(item.tokens.cacheRead) }))}</div>
    </div>
  </div>
  <div class="ws-foot">${escapeHtml(foot)}</div>
</li>`;
    })
    .join("")}</ul>`;
}

/**
 * 时刻分析：24 根柱，柱高＝该小时按消息时间落桶的 Token 产出（静态报告固定 Tokens 口径），
 * 顶部圆点＝人类消息密度（半径 3.4 + ratio×5.0，上沿恒留 14px），最高的一根标数值。
 * 图例行：左侧三项解释颜色，右侧状态（回填中 / Token 未计入 N 个会话）。
 * @param hours - byHour 数组。
 * @param palette - 色板。
 * @param t - 绑定语言的翻译函数（图例 / tooltip / aria 文案）。
 * @param status - hourTokensNote 的结果（可为 null）。
 * @returns SVG + 图例 + 状态行的 HTML 字符串。
 */
function hourChart(hours, palette, t, status = null) {
  const width = 520;
  const height = 210;
  // 顶部 64px 留给密度点与峰值数值；柱形区从这之下开始
  const pad = { top: HOUR_CHART_TOP_SPACE, right: 6, bottom: 22, left: 6 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...hours.map((hour) => hour.tokensTotal ?? 0));
  const peak = hours.reduce((best, hour) => ((hour.tokensTotal ?? 0) > (best.tokensTotal ?? 0) ? hour : best), hours[0]);
  const maxHuman = Math.max(0, ...hours.map((hour) => hour.humanMsgs ?? 0));
  const step = innerW / hours.length;
  const barW = Math.max(3, step * 0.62);
  const bars = hours
    .map((hour, index) => {
      const tokens = hour.tokensTotal ?? 0;
      const humans = Math.round(hour.humanMsgs ?? 0);
      const h = (tokens / max) * innerH;
      const x = pad.left + step * index + (step - barW) / 2;
      const y = pad.top + innerH - h;
      const isPeak = hour.hour === peak?.hour && tokens > 0;
      // 峰值柱用深蓝（palette.peak），人类消息点用 amber（palette.weekend），两者不撞色
      const fill = isPeak ? palette.peak : palette.input;
      const title = t("hour.tip", { hour: hour.hour, tokens: formatInt(tokens), turns: formatInt(hour.starts ?? 0), humans: formatInt(humans) });
      // 柱自带 tooltip，且 24 根柱恒存在（0 值给 1px），悬停总有提示
      return `<g><rect data-kind="hour-bar" x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(h, 1).toFixed(2)}" rx="2" fill="${fill}"><title>${escapeHtml(title)}</title></rect></g>`;
    })
    .join("");
  // 只在最大柱上标数值（Token 整数，切到报告仍是 Tokens 口径）
  const peakLabel = (() => {
    const tokens = peak?.tokensTotal ?? 0;
    if (!(tokens > 0)) return "";
    const index = hours.indexOf(peak);
    const h = (tokens / max) * innerH;
    const x = pad.left + step * index + step / 2;
    const y = pad.top + innerH - h - 4;
    return `<text data-kind="hour-peak-label" x="${x.toFixed(1)}" y="${y.toFixed(1)}" text-anchor="middle" font-size="9" font-weight="650" fill="${palette.text}">${escapeHtml(formatInt(tokens))}</text>`;
  })();
  const dots = hours
    .map((hour, index) => {
      const humans = Math.round(hour.humanMsgs ?? 0);
      if (humans <= 0) return "";
      const r = hourDotRadius(maxHuman > 0 ? humans / maxHuman : 0);
      const cx = pad.left + step * index + step / 2;
      const cy = HOUR_DOT_TOP + r;
      return `<circle data-kind="hour-dot" cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${r.toFixed(1)}" fill="${palette.weekend}" opacity="0.9"><title>${escapeHtml(t("hour.dotTip", { hour: hour.hour, humans: formatInt(humans) }))}</title></circle>`;
    })
    .join("");
  const labels = hours
    .map((hour, index) =>
      hour.hour % 3 === 0
        ? `<text x="${(pad.left + step * index + step / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="${palette.muted}">${hour.hour}</text>`
        : "",
    )
    .join("");
  const legend = `<div class="legend hour-legend">
    <div class="legend-group">
      <span class="legend-item" data-kind="legend-measure"><i class="legend-bar" style="background:${palette.input}"></i>${escapeHtml(t("hour.legend.tokens"))}</span>
      <span class="legend-item" data-kind="legend-humans"><i class="legend-dot" style="background:${palette.weekend}"></i>${escapeHtml(t("hour.legend.humans"))}</span>
      <span class="legend-item" data-kind="legend-peak"><i class="legend-peak" style="background:${palette.peak}"></i>${escapeHtml(t("hour.legend.peak"))}</span>
    </div>
    ${status === null ? "" : `<span class="status" data-kind="hour-tokens-missing" data-state="${escapeHtml(status.state)}">${escapeHtml(status.text)}</span>`}
  </div>`;
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(t("report.hour.aria"))}">
  <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="${palette.border}" />
  ${bars}
  ${peakLabel}
  ${dots}
  ${labels}
</svg>
${legend}`;
}

/**
 * 环形图（Top 6 + others）。工作区（按活跃时长）与模型（按 Token）共用这一份几何实现，
 * 保证两图半径、描边、扇区缝隙完全一致。
 * 与看板同构：环形几何（外 74 / 内 50，viewBox 160）+ 主题背景色描边，
 * 扇区之间因此有可见缝隙（stroke-dasharray 画的圆描不出两条半径边，故用真实扇区 path）。
 * @param items - 数据数组（byWorkspace / byModel）。
 * @param palette - 色板。
 * @param options.valueOf - 取每项数值的函数。
 * @param options.format - 数值格式化函数（时长用 formatHours，Token 用 formatTokens）。
 * @param options.ariaLabel - 图形 aria-label。
 * @param options.centerLabel - 圆心下方小字（如「总活跃时长」「总 Token」）。
 * @param options.colors - 可选扇区色序。
 * @param t - 绑定语言的翻译函数（空态 / others / tooltip）。
 * @returns HTML 字符串。
 */
function sharePie(items, palette, { valueOf, format, ariaLabel, centerLabel, colors: customColors }, t) {
  const active = items.filter((item) => valueOf(item) > 0);
  if (active.length === 0) return `<p class="empty">${escapeHtml(t("state.empty"))}</p>`;
  const colors = customColors ?? [palette.input, palette.output, palette.accent, "#f59e0b", "#f25a5a", "#a9b8ff", palette.cache];
  const top = active.slice(0, 6).map((item) => ({ label: item.label, value: valueOf(item), item }));
  const rest = active.slice(6);
  if (rest.length > 0) top.push({ label: t("pie.others"), value: rest.reduce((sum, item) => sum + valueOf(item), 0), item: null });
  const total = top.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const radius = 62;
  const stroke = 24;
  const outer = radius + stroke / 2;
  const inner = radius - stroke / 2;
  let angle = 0;
  const arcs = top
    .map((slice, index) => {
      const share = slice.value / total;
      const sweep = share * Math.PI * 2;
      const arc = `<path d="${sectorPath(outer, inner, angle, angle + sweep)}" fill="${colors[index % colors.length]}" stroke="${palette.surface}" stroke-width="1.6" stroke-linejoin="round"><title>${escapeHtml(t("report.pie.tip", { label: slice.label, value: format(slice.value), share: formatPercent(share) }))}</title></path>`;
      angle += sweep;
      return arc;
    })
    .join("");
  const legend = top
    .map((slice, index) => {
      const share = slice.value / total;
      return `<li><i style="background:${colors[index % colors.length]}"></i><span class="pie-name">${escapeHtml(slice.label)}</span><span class="pie-value">${escapeHtml(format(slice.value))}</span><span class="pie-share">${escapeHtml(formatPercent(share))}</span></li>`;
    })
    .join("");
  return `<div class="pie-wrap">
  <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="${escapeHtml(ariaLabel)}">
    <g transform="translate(80,80) rotate(-90)">${arcs}</g>
    <text x="80" y="76" text-anchor="middle" font-size="14" font-weight="650" fill="${palette.text}">${escapeHtml(format(total))}</text>
    <text x="80" y="92" text-anchor="middle" font-size="10" fill="${palette.muted}">${escapeHtml(centerLabel)}</text>
  </svg>
  <ul class="pie-legend">${legend}</ul>
</div>`;
}

/** 模型系列色（与工作区图区分开）。 */
function modelSeries(palette) {
  return [palette.accent, palette.output, "#f59e0b", palette.input, "#f25a5a", "#a9b8ff", palette.cache];
}

/** 简易 treemap 布局：按累计值二分，长边切分。 */
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

/**
 * 模型占比 treemap（面积 = 占比），自带「模型占比 · 面积 = Token」小标题。
 * @param models - byModel 数组（label 已由调用方做「未标注模型」兜底）。
 * @param palette - 色板。
 * @param metric - tokens / requests / llmMs。
 * @param t - 绑定语言的翻译函数。
 * @returns HTML 字符串。
 */
function modelTreemap(models, palette, metric = "tokens", t) {
  const valueOf = (item) => (metric === "requests" ? item.requests : metric === "llmMs" ? item.llmMs : item.tokensTotal);
  const sorted = [...models].filter((item) => valueOf(item) > 0).sort((a, b) => valueOf(b) - valueOf(a));
  if (sorted.length === 0) return "";
  const series = modelSeries(palette);
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const cells = top.map((item, index) => ({ key: item.key, label: item.label, value: valueOf(item), color: series[index % series.length] }));
  if (rest.length > 0) {
    cells.push({ key: "__others", label: t("pie.others"), value: rest.reduce((sum, item) => sum + valueOf(item), 0), color: palette.muted });
  }
  const total = cells.reduce((sum, cell) => sum + cell.value, 0);
  const rects = layoutTreemap(cells, 0, 0, 100, 56);
  const parts = rects.map((rect) => {
    const share = total > 0 ? rect.value / total : 0;
    const label = rect.label.length > 20 ? rect.label.slice(0, 19) + "…" : rect.label;
    const name = rect.w > 16 && rect.h > 9 ? '<text x="' + (rect.x + 1.6).toFixed(2) + '" y="' + (rect.y + 5.4).toFixed(2) + '" font-size="3.1" fill="#fff">' + escapeHtml(label) + "</text>" : "";
    const pct = rect.w > 16 && rect.h > 15 ? '<text x="' + (rect.x + 1.6).toFixed(2) + '" y="' + (rect.y + 9.4).toFixed(2) + '" font-size="2.8" fill="#fff" opacity="0.9">' + formatPercent(share) + "</text>" : "";
    return '<g><title>' + escapeHtml(rect.label) + " · " + formatPercent(share) + '</title><rect x="' + rect.x.toFixed(2) + '" y="' + rect.y.toFixed(2) + '" width="' + Math.max(0.4, rect.w).toFixed(2) + '" height="' + Math.max(0.4, rect.h).toFixed(2) + '" fill="' + rect.color + '" stroke="' + palette.surface + '" stroke-width="0.4"/>' + name + pct + "</g>";
  });
  // height:auto + viewBox 固有比例 → SVG 铺满容器宽度，不再等比缩放后在左右留空白带
  return `<h3 class="sub-title">${escapeHtml(t("model.treemapTitle"))}</h3><svg class="treemap" viewBox="0 0 100 56" width="100%" style="height:auto" role="img" aria-label="${escapeHtml(t("model.treemap"))}">${parts.join("")}</svg>`;
}

/**
 * 按日模型趋势（堆叠柱，取前 6 个模型）。
 * @param daily - snapshot.modelDaily。
 * @param models - byModel 数组（label 已兜底）。
 * @param palette - 色板。
 * @param t - 绑定语言的翻译函数。
 * @returns HTML 字符串。
 */
function modelTrend(daily, models, palette, t) {
  const rows = (daily ?? []).filter((day) => Object.values(day.values ?? {}).length > 0);
  if (rows.length === 0) return "";
  const paletteSeries = modelSeries(palette);
  const series = models.filter((item) => item.tokensTotal > 0).slice(0, 6).map((item, index) => ({ key: item.key, label: item.label, color: paletteSeries[index % paletteSeries.length] }));
  const width = 560;
  const height = 190;
  const pad = { top: 8, right: 6, bottom: 22, left: 6 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const totalsPerDay = rows.map((day) => series.reduce((sum, s) => sum + (day.values?.[s.key] ?? 0), 0));
  const max = Math.max(1, ...totalsPerDay);
  const step = innerW / rows.length;
  const barWidth = Math.max(1.4, Math.min(20, step * 0.66));
  const bars = rows.map((day, index) => {
    const centerX = pad.left + step * index + step / 2;
    let y = pad.top + innerH;
    const rects = series.map((s) => {
      const value = day.values?.[s.key] ?? 0;
      const h = (value / max) * innerH;
      if (h <= 0.3) return "";
      y -= h;
      // 每段 rect 自己有 title（父 <g> 的 title 在多数浏览器不弹）
      return `<rect x="${(centerX - barWidth / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barWidth.toFixed(2)}" height="${h.toFixed(2)}" rx="1.2" fill="${s.color}"><title>${escapeHtml(t("report.modelTrend.tip", { date: day.date, label: s.label, tokens: formatInt(value) }))}</title></rect>`;
    });
    return `<g>${rects.join("")}<rect data-kind="model-trend-hit" x="${(centerX - step / 2).toFixed(2)}" y="${pad.top}" width="${Math.max(step, 1).toFixed(2)}" height="${innerH}" fill="transparent"><title>${escapeHtml(t("report.modelTrend.total", { date: day.date, tokens: formatInt(totalsPerDay[index]) }))}</title></rect></g>`;
  });
  const every = Math.max(1, Math.ceil(rows.length / 8));
  const labels = rows.map((day, index) =>
    index % every === 0 || index === rows.length - 1
      ? '<text x="' + (pad.left + step * index + step / 2).toFixed(2) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="9" fill="' + palette.muted + '">' + escapeHtml(day.date.slice(5)) + "</text>"
      : "",
  );
  const legend = series.map((s) => '<span class="legend-item"><i style="background:' + s.color + '"></i>' + escapeHtml(s.label) + "</span>").join("");
  return `<h3 class="sub-title">${escapeHtml(t("model.trend"))}</h3><svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(t("model.trend"))}">${bars.join("")}${labels.join("")}</svg><div class="legend">${legend}</div>`;
}

/**
 * 模型用量明细表 + 官方计费链接。
 * @param snapshot - 快照。
 * @param palette - 色板。
 * @param t - 绑定语言的翻译函数。
 * @returns HTML 字符串。
 */
function modelSection(snapshot, palette, t) {
  // 数据层的未知模型 label 是空串（语言无关），展示层用词典兜底。
  const models = (snapshot.byModel ?? []).map((item) => ({ ...item, label: item.label || t("common.unknownModel") }));
  if (models.length === 0) return "";
  const pricing = snapshot.pricing ?? { currency: "CNY", links: [], costed: { covered: 0, total: 0 }, totalCost: null, asOf: "" };
  const symbol = pricing.currency === "USD" ? "$" : "¥";
  const cost = (value) => (value === null || value === undefined ? "—" : symbol + (value < 1 ? value.toFixed(4) : value.toFixed(2)));
  const linkText = (link) => (link.labelKey ? t(link.labelKey) : (link.label ?? link.provider));
  const rows = models
    .map(
      (item) => '<tr><td class="ws">' + escapeHtml(item.label) + "</td><td>" + formatSpeed(item.speed) + "</td><td>" + formatTtft(item.ttft) + "</td><td title=\"" + escapeHtml(item.provider || "—") + "\">" + escapeHtml(formatProvider(item.provider)) + "</td><td>" + formatPercent(item.share) + "</td><td>" + formatInt(item.requests) + "</td><td>" + formatTokens(item.tokens.input) + "</td><td>" + formatTokens(item.tokens.output) + "</td><td>" + formatTokens(item.tokens.cacheRead) + "</td><td>" + (item.cacheHitRate === null || item.cacheHitRate === undefined ? "—" : formatPercent(item.cacheHitRate)) + "</td><td>" + cost(item.cost) + "</td></tr>",
    )
    .join("");
  const links = (pricing.links ?? []).map((link) => '<a href="' + escapeHtml(link.url) + '">' + escapeHtml(linkText(link)) + "</a>").join(" · ");
  const costVars = { asOf: String(pricing.asOf ?? ""), covered: pricing.costed?.covered ?? 0, total: pricing.costed?.total ?? 0 };
  const costNote = pricing.totalCost === null || pricing.totalCost === undefined
    ? t("report.model.costNote", costVars)
    : t("report.model.costNote.total", { ...costVars, totalCost: cost(pricing.totalCost) });
  return `<section class="card">
  ${cardHead(t, "tab.model", "model.hint")}
  <div class="two-col">
    <div>${modelTreemap(models, palette, "tokens", t)}</div>
    <div>${modelTrend(snapshot.modelDaily, models, palette, t)}</div>
  </div>
  <table>
    <thead><tr><th>${escapeHtml(t("model.col.model"))}</th><th>${escapeHtml(t("model.col.speed"))}</th><th>${escapeHtml(t("model.col.ttft"))}</th><th>${escapeHtml(t("model.col.provider"))}</th><th>${escapeHtml(t("model.col.share"))}</th><th>${escapeHtml(t("model.col.requests"))}</th><th>${escapeHtml(t("table.input"))}</th><th>${escapeHtml(t("table.output"))}</th><th>${escapeHtml(t("table.cache"))}</th><th>${escapeHtml(t("model.col.hitRate"))}</th><th>${escapeHtml(t("model.col.cost"))}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="note-line">${escapeHtml(costNote)}</p>
  <p class="note-line">${escapeHtml(t("model.priceLinks"))} ${links}</p>
</section>`;
}

/**
 * 「主要会话」卡片：与看板同一套比例条（轮次 / 步骤 / 活跃时长 / 输出 Token）。
 * 匿名化或 topSessions<=0 时整块不渲染（与旧行为一致）。
 * @param snapshot - 快照。
 * @param palette - 色板。
 * @param t - 绑定语言的翻译函数。
 * @param options.topSessions - 最多展示多少条会话。
 * @param options.anonymize - 匿名化时不展示会话标题。
 * @returns HTML 字符串。
 */
function sessionSection(snapshot, palette, t, { topSessions = 12, anonymize = false } = {}) {
  if (anonymize || topSessions <= 0) return "";
  const sessionRowsData = snapshot.bySession.slice(0, Math.max(0, topSessions));
  const sessionColumns = [
    { key: "turns", label: t("table.turns"), value: (row) => row.turns ?? 0, format: formatInt, kind: "turns" },
    { key: "steps", label: t("table.steps"), value: (row) => row.steps ?? 0, format: formatInt, kind: "steps" },
    { key: "activeMs", label: t("table.active"), value: (row) => row.activeMs ?? 0, format: formatHours, kind: "activeMs" },
    { key: "output", label: t("report.session.outputToken"), value: (row) => row.tokens?.output ?? 0, format: formatTokens, kind: "output" },
  ];
  const sessionMaxima = Object.fromEntries(
    sessionColumns.map((column) => [column.key, Math.max(1, ...sessionRowsData.map((row) => column.value(row)))]),
  );
  return `<section class="card">
    ${cardHead(t, "tab.bySession", "report.session.hint")}
    <table>
      <thead><tr><th>${escapeHtml(t("table.session"))}</th><th>${escapeHtml(t("table.workspace"))}</th><th>${escapeHtml(t("table.date"))}</th>${sessionColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
      <tbody>${sessionRowsData
        .map(
          (row) => `<tr><td class="ws">${escapeHtml(row.title || t("common.untitled"))}</td><td class="ws">${escapeHtml(row.workspaceLabel || t("common.unknownWorkspace"))}</td><td>${escapeHtml(row.date)}</td>${sessionColumns
            .map((column) => {
              const value = column.value(row);
              return `<td>${barCell(value, sessionMaxima[column.key], column.format(value), column.kind, palette)}</td>`;
            })
            .join("")}</tr>`,
        )
        .join("")}</tbody>
    </table>
  </section>`;
}

/**
 * 生成完整报告 HTML。
 *
 * 语言：`options.lang` 缺省保持 zh（既有离线测试 / 老调用方不改也能过）；
 * 服务端路由与客户端导出会显式传 `lang`（query → Accept-Language → en）。
 * 标题 `options.title` 留空时回落词典 `report.title`，因此配置里 defaultTitle 为空
 * 也能得到本地化标题。
 * @param snapshot - 快照（口径与看板一致）。
 * @param options - `{ lang, theme, title, note, anonymize, topSessions, generatedAt, rangeKey }`。
 * @returns 自包含 HTML 字符串。
 */
export function renderReport(snapshot, options = {}) {
  const lang = languageOf(options?.lang ?? "zh");
  const t = translator(lang);
  const langTag = localeTag(lang);
  const {
    theme = "light",
    note = "",
    anonymize = false,
    topSessions = 12,
    generatedAt = Date.now(),
    // 顶部区间筛选器：只做视觉呈现（报告无脚本、无失效链接）。rangeKey 决定哪一档高亮。
    rangeKey = "7",
  } = options;
  /** 标题：显式传入优先（trim 后非空），否则走词典（配置 defaultTitle 可为空串）。 */
  const title = String(options.title ?? "").trim() || t("report.title");
  const palette = PALETTES[theme === "dark" ? "dark" : "light"];
  const totals = snapshot.totals;
  const derived = snapshot.derived;
  const range = snapshot.range;
  const scope = snapshot.scope;
  // 顶部区间说明：整句一个键（带范围后缀的是另一个变体，避免拼接句子）。
  // scope 只取 all / main / subagent，展示文案复用 scope.* 词典键。
  const rangeVars = { from: range.from, to: range.to, days: range.days, timeZone: range.timeZone };
  const rangeSummary = scope === undefined || scope === null || scope === "all"
    ? t("report.range.summary", rangeVars)
    : t("report.range.summary.scope", { ...rangeVars, scope: t(`scope.${scope}`) });
  const generatedAtText = t("report.generatedAt", { time: new Date(generatedAt).toLocaleString(langTag, { hour12: false }) });

  // 时刻图状态行：复用看板同一判据（回填中 → 正在计算中……；空闲 → 未计入 N 个会话）
  const diagnostics = {
    ...(snapshot.diagnostics ?? {}),
    hourTokensSource:
      snapshot.diagnostics?.hourTokensSource ?? snapshot.hourTokensSource ?? { missing: 0 },
  };
  const hourStatus = hourTokensNote(diagnostics, t, formatInt);

  // 模型性能 KPI（2.3.0 起替代「模型费用」，与看板同口径、不依赖价目表）
  const modelList = (snapshot.byModel ?? []).filter((item) => (item.requests ?? 0) > 0);
  const modelRequests = modelList.reduce((sum, item) => sum + (item.requests ?? 0), 0);
  const modelOutput = modelList.reduce((sum, item) => sum + (item.tokens?.output ?? 0), 0);
  const modelLlmMs = modelList.reduce((sum, item) => sum + (item.llmMs ?? 0), 0);
  const modelOutputPerRequest = modelRequests > 0 ? modelOutput / modelRequests : 0;
  const modelLlmShare = (totals.activeMs ?? 0) > 0 ? modelLlmMs / totals.activeMs : 0;

  // 活跃时长 KPI 用净活跃（totals.activeMs 是官方值，含等待用户）；等待在副标题里单列
  const netActiveMs = totals.netActiveMs ?? totals.activeMs;
  const topModel = snapshot.topModel ?? null;
  // 最活跃模型的「口径」是展示文案：请求 / Token / 模型耗时（短名复用词典）。
  const topModelMetric = { requests: t("model.requests"), tokens: t("table.tokens"), llmMs: t("report.metric.llmMs") }[topModel?.metric] ?? t("model.requests");
  const kpis = [
    ["kpi.active", formatHours(netActiveMs), t("report.kpi.active.sub", { llm: formatHours(totals.llmMs), tool: formatHours(totals.toolMs), wait: formatHours(totals.waitMs ?? 0) })],
    ["kpi.tokens", formatInt(totals.tokensTotal), t("kpi.tokens.sub", { input: formatTokens(totals.tokens.input), output: formatTokens(totals.tokens.output), cache: formatTokens(totals.tokens.cacheRead) })],
    [
      "kpi.modelShare",
      modelRequests > 0 ? formatPercent(modelLlmShare) : "—",
      modelRequests > 0 ? t("report.kpi.modelShare.sub", { llm: formatHours(modelLlmMs), models: formatInt(modelList.length) }) : t("kpi.modelShare.none"),
    ],
    ["kpi.activeDays", `${formatInt(totals.activeDays)} / ${formatInt(range.days)}`, t("kpi.activeDays.sub", { workspaces: formatInt(totals.workspaces) })],
    // 对话次数与轮次合并（与看板一致，2.3.3）：步骤不再展示
    ["kpi.conversations", `${formatInt(totals.conversations)} / ${formatInt(totals.turns)}`, t("report.kpi.conversations.sub", { sessions: formatInt(totals.sessions), empty: formatInt(totals.emptySessions) })],
    [
      "kpi.modelOutput",
      modelRequests > 0 ? formatInt(Math.round(modelOutputPerRequest)) : "—",
      modelRequests > 0 ? t("kpi.modelOutput.sub", { requests: formatInt(modelRequests) }) : t("kpi.modelOutput.none"),
    ],
    ["kpi.speed", formatSpeed(derived.outputSpeed), t("kpi.speed.sub", { ttft: formatTtft(derived.ttftMean) })],
    ["kpi.cache", formatPercent(derived.cacheHitRate), t("kpi.cache.sub", { output: formatTokens(derived.outputPerActiveHour) })],
    [
      "kpi.topModel",
      topModel === null ? "—" : (topModel.label || t("common.unknownModel")),
      topModel === null ? t("kpi.topModel.none") : t("report.kpi.topModel.sub", { metric: topModelMetric, share: formatPercent(topModel.metricShare) }),
    ],
  ];

  // 按日期明细：与看板同一套列（日期 / 对话 / 轮次 / 活跃 / Token 合计 / 输入 / 输出 / 缓存），最近 31 天。
  const dailyColumns = [
    { key: "date", label: t("table.date"), text: (day) => day.date },
    { key: "conversations", label: t("table.conversations"), value: (day) => day.conversations ?? 0, format: formatInt, kind: "conversations" },
    { key: "turns", label: t("table.turns"), value: (day) => day.turns ?? 0, format: formatInt, kind: "turns" },
    { key: "activeMs", label: t("table.active"), value: (day) => day.activeMs ?? 0, format: formatHours, kind: "activeMs" },
    { key: "tokens", label: t("table.tokens"), value: (day) => day.tokensTotal ?? 0, format: formatTokens, kind: "tokens" },
    { key: "input", label: t("table.input"), text: (day) => formatTokens(day.tokens?.input ?? 0) },
    { key: "output", label: t("table.output"), text: (day) => formatTokens(day.tokens?.output ?? 0) },
    { key: "cache", label: t("table.cache"), text: (day) => formatTokens(day.tokens?.cacheRead ?? 0) },
  ];
  const dailyRowsData = [...snapshot.byDay]
    .filter((day) => day.sessions > 0)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 31);
  const dailyMaxima = Object.fromEntries(
    dailyColumns.filter((column) => column.value !== undefined).map((column) => [column.key, Math.max(1, ...dailyRowsData.map((day) => column.value(day)))]),
  );
  const dailyRows = dailyRowsData
    .map(
      (day) => `<tr>${dailyColumns
        .map((column) => {
          if (column.value === undefined) return `<td>${escapeHtml(column.text(day))}</td>`;
          const value = column.value(day);
          const text = column.format(value);
          return `<td>${barCell(value, dailyMaxima[column.key], text, column.kind, palette)}</td>`;
        })
        .join("")}</tr>`,
    )
    .join("");

  const workspaceRows = snapshot.byWorkspace
    .map(
      (item) => `<tr><td class="ws">${escapeHtml(item.label || t("common.unknownWorkspace"))}</td><td>${formatInt(item.activeDays ?? 0)}</td><td>${formatInt(item.sessions)}</td><td>${formatInt(item.conversations)}</td><td>${formatInt(item.turns)}</td><td>${formatInt(item.steps)}</td><td>${formatHours(item.activeMs)}</td><td>${formatTokens(item.tokensTotal)}</td><td>${formatPercent(item.activeShare ?? 0)}</td><td>${formatPercent(item.tokenShare ?? 0)}</td></tr>`,
    )
    .join("");

  // 数据层的未知标签是空串（语言无关），饼图 / 表格展示时统一用词典兜底。
  const workspacePieItems = snapshot.byWorkspace.map((item) => ({ ...item, label: item.label || t("common.unknownWorkspace") }));
  const modelPieItems = (snapshot.byModel ?? []).map((item) => ({ ...item, label: item.label || t("common.unknownModel") }));

  // 页脚口径长文：按段落拆成 report.footer.* 整句键；链接列表单独渲染。
  const footerLinks = (snapshot.pricing?.links ?? [])
    .map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.labelKey ? t(link.labelKey) : (link.label ?? link.provider))}</a>`)
    .join(" · ");
  const footerTexts = {
    active: t("report.footer.active", { wait: formatHours(totals.waitMs ?? 0) }),
    // 字段名 <code> 是静态可信标记，作为占位符值原样插入（不是用户数据）。
    officialField: t("report.footer.officialField", { field: "<code>totals.activeMs</code>" }),
    wait: t("report.footer.wait"),
    hour: t("report.footer.hour"),
    sessions: t("report.footer.sessions", { timeZone: range.timeZone }),
    model: t("report.footer.model"),
    cost: t("report.footer.cost"),
    priceLinks: t("report.footer.priceLinks"),
    docs: t("report.footer.docs"),
  };

  return `<!doctype html>
<html lang="${langTag}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)} · ${escapeHtml(range.from)} ~ ${escapeHtml(range.to)}</title>
<style>
  :root { color-scheme: ${theme === "dark" ? "dark" : "light"}; }
  * { box-sizing: border-box; }
  body { margin: 0; background: ${palette.bg}; color: ${palette.text};
    font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased; }
  /* 页宽：自适应视口（窄屏占满），宽屏最多 1450px（2.1.0 从 1600 收到 1450，与看板同一口径）。
     左右留白随视口在 20–44px 之间收缩，保证 1240 / 1512 / 1728 / 1920 下都不横滑。 */
  .page { width: 100%; max-width: 1450px; margin: 0 auto; padding: 40px clamp(20px, 2.4vw, 44px) 56px; }
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .range { margin: 0; color: ${palette.muted}; font-size: 14px; }
  .hero-meta { color: ${palette.muted}; font-size: 12px; text-align: right; line-height: 1.6; }
  /* 顶部区间筛选器：**纯视觉**，不是交互控件。
     与看板 ChipGroup 同一套视觉语汇（浅底 + 边框；当前区间品牌色实底 + 白字），
     但报告是无脚本的静态文件，所以它们是 <span>：不可点、无指针手型、无失效链接。
     打印时保留（客户 / 打印稿也能看出统计区间）。 */
  .range-filter { display: flex; gap: 6px; flex-wrap: wrap; margin: 0 0 20px; }
  .range-chip {
    display: inline-flex; align-items: center; height: 26px; padding: 0 12px;
    border-radius: 8px; border: 1px solid ${palette.border};
    background: color-mix(in srgb, ${palette.input} 7%, ${palette.surface});
    color: ${palette.muted}; font-size: 12px; line-height: 1;
    font-variant-numeric: tabular-nums;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .range-chip[data-active="true"] {
    background: ${palette.input}; border-color: ${palette.input};
    color: #ffffff; font-weight: 600;
  }
  .note { margin: 0 0 24px; padding: 12px 16px; background: ${palette.surface}; border: 1px solid ${palette.border};
    border-radius: 10px; font-size: 13px; color: ${palette.muted}; }
  .kpis { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 10px; margin-bottom: 24px; align-items: stretch; }
  /* KPI 卡等高：同一行某格的值换行（如「最活跃模型」长模型名）会把整行撑高，
     其它卡要跟着撑满，否则边框高度参差。flex 列 + 副标题吸底即可。 */
  .kpi { background: ${palette.surface}; border: 1px solid ${palette.border}; border-radius: 12px; padding: 12px 14px; min-width: 0; display: flex; flex-direction: column; }
  .kpi .sub { margin-top: auto; }
  .kpi[data-kpi="kpi.tokens"] { grid-column: span 2; }
  .kpi .label { font-size: 11px; color: ${palette.muted}; margin-bottom: 6px; }
  .kpi .value { font-size: 20px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .kpi[data-kpi="kpi.topModel"] .value { white-space: normal; overflow-wrap: anywhere; }
  .kpi .sub { font-size: 11px; color: ${palette.muted}; margin-top: 6px; line-height: 1.45; }
  .card { background: ${palette.surface}; border: 1px solid ${palette.border}; border-radius: 12px; padding: 16px 18px; margin-bottom: 20px; }
  .card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin-bottom: 6px; }
  .card-head-text { display: flex; align-items: baseline; gap: 8px; flex: 0 1 auto; min-width: 0; }
  .card-head h2 { font-size: 14px; margin: 0; flex: 0 0 auto; }
  .card-hint { flex: 0 1 auto; min-width: 0; font-size: 11px; font-weight: 400; color: ${palette.muted}; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sub-title { font-size: 11px; font-weight: 500; color: ${palette.muted}; margin: 14px 0 6px; }
  .legend { display: flex; gap: 16px; font-size: 11px; color: ${palette.muted}; margin-top: 8px; flex-wrap: wrap; align-items: center; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  .legend-group { display: inline-flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .hour-legend { justify-content: space-between; }
  .hour-legend .status { margin-left: auto; text-align: right; white-space: nowrap; }
  .status { font-size: 11px; line-height: 1.5; color: ${palette.muted}; }
  .status[data-state="running"] { color: ${palette.input}; }
  /* 日历在窄区间（如 7 天只有少数几周）时 SVG 自然宽度小于卡片：
     居中摆放，右侧不留一大块空白；数据多时仍可横向滚动。 */
  .cal-scroll { overflow-x: auto; overflow-y: hidden; display: flex; justify-content: center; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid ${palette.border}; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: ${palette.muted}; font-weight: 500; font-size: 12px; }
  /* 工作区 / 会话名列表头：原为写死的 max-width: 320px。实测该值从未生效 ——
     table-layout:auto 下单元格的 min-content 会把列顶到 431~557px（页宽 1120→1600 时），
     320px 上限形同虚设，且页面放宽后这一列与数字列的此消彼长完全不可控。
     改成随视口伸缩的上限：窄屏 240px 起、宽屏最多 520px，既不挤成一条缝、
     也不会把右侧数字列压到放不下；超出部分仍由 ellipsis 兜底。 */
  td.ws { max-width: clamp(240px, 32vw, 520px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  .bar-cell { position: relative; display: block; min-width: 56px; height: 20px; border-radius: 5px; background: ${palette.barBg}; overflow: hidden; }
  .bar-cell-fill { position: absolute; top: 0; bottom: 0; left: 0; border-radius: 5px; }
  .bar-cell-value { position: relative; z-index: 1; display: block; padding: 0 7px; line-height: 20px; text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bars { list-style: none; margin: 8px 0 18px; padding: 0; display: grid; gap: 14px; }
  .bar-track { height: 8px; background: ${palette.barBg}; border-radius: 999px; overflow: hidden; }
  .bar-fill { height: 100%; background: ${palette.accent}; border-radius: 999px; }
  .bar-fill.is-tokens { background: ${palette.output}; }
  .ws-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .ws-name { font-size: 13px; font-weight: 600; }
  .ws-meta { font-size: 11px; color: ${palette.muted}; white-space: nowrap; }
  .ws-metrics { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
  .ws-metric { min-width: 0; }
  .m-label { font-size: 11px; color: ${palette.muted}; margin-bottom: 3px; }
  .m-value { font-size: 15px; font-weight: 650; font-variant-numeric: tabular-nums; margin-bottom: 5px; }
  .m-share { font-size: 11px; font-weight: 400; color: ${palette.muted}; margin-left: 7px; }
  .m-sub { font-size: 11px; color: ${palette.muted}; margin-top: 5px; line-height: 1.5; }
  .ws-foot { font-size: 11px; color: ${palette.muted}; margin-top: 9px; padding-top: 7px; border-top: 1px dashed ${palette.border}; }
    /* 每日用量趋势（左）与模型 Token 占比（右）是两张独立卡片。
       列宽与下方 .two-col 完全一致（1fr 1fr），使「每日用量趋势」= 「时刻分析」的宽度、
       「模型 Token 占比」= 「工作区占比」的宽度，整页左右两列对齐成一条竖线。 */
    .daily-plus-model { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 20px; align-items: stretch; }
    .daily-plus-model > .card { margin: 0; min-width: 0; display: flex; flex-direction: column; }
    .daily-plus-model svg { max-width: 100%; height: auto; }
    @media (max-width: 760px) { .daily-plus-model { grid-template-columns: 1fr; } }
  /* 卡片内容区：四张并排图卡（每日趋势 / 模型占比 / 时刻分析 / 工作区占比）共用同一份上下留白，
     图卡内容垂直居中，两侧卡片高度差不再导致顶部参差。 */
  .card-body { display: flex; flex-direction: column; justify-content: center; padding: 14px 4px 18px; min-height: 0; }
  .two-col > .card { display: flex; flex-direction: column; }
  .two-col > .card > .card-body { flex: 1 1 auto; }
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    /* 左列（工作区名 + 活跃天数 + 最近使用）原为定宽 168px：页宽 1120→1600 后
       左列纹丝不动（实测 li 1143→1474px，左列始终 168px），多出来的宽度全给了指标列。
       改成随卡片宽度伸缩：22% 在 1600 页宽下约 280px、1240 下约 200px，
       clamp 下限 140px 保证窄屏放得下省略号、上限 280px 避免超宽屏把名称区拉得过散。 */
    .bars li { display: grid; grid-template-columns: clamp(140px, 22%, 280px) minmax(0, 1fr); column-gap: 14px; row-gap: 4px; align-items: start; }
    .bars li > .ws-head { grid-column: 1; grid-row: 1 / span 2; display: flex; flex-direction: column; gap: 3px; }
    .bars li > .ws-metrics { grid-column: 2; }
    .bars li > .ws-foot { grid-column: 2; }
    .ws-head .ws-days { font-size: 11px; color: ${palette.muted}; }
  .two-col .card { margin-bottom: 20px; }
  .pie-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .pie-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; flex: 1 1 200px; font-size: 12px; }
  .pie-legend li { display: grid; grid-template-columns: 10px 1fr auto auto; align-items: center; gap: 8px; }
  .pie-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
  .pie-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pie-value { font-variant-numeric: tabular-nums; }
  .pie-share { color: ${palette.muted}; font-variant-numeric: tabular-nums; min-width: 42px; text-align: right; }
  .note-line { font-size: 11px; color: ${palette.muted}; margin: 10px 0 0; line-height: 1.6; }
  .note-line a { color: ${palette.input}; text-decoration: none; }
  .empty { color: ${palette.muted}; font-size: 13px; margin: 12px 0; }
  footer { color: ${palette.muted}; font-size: 12px; line-height: 1.7; margin-top: 28px; }
  footer a { color: ${palette.input}; text-decoration: none; }
  @media (max-width: 1080px) { .kpis { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @media (max-width: 760px) { .two-col { grid-template-columns: 1fr; } .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .kpi[data-kpi="kpi.tokens"] { grid-column: auto; } .page { padding: 24px 16px 40px; } }
  @media print { body { background: #fff; } .card, .kpi { break-inside: avoid; box-shadow: none; } }
</style>
</head>
<body>
<main class="page">
  <header class="hero">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p class="range">${escapeHtml(rangeSummary)}</p>
    </div>
    <div class="hero-meta">DeepSeek Harness<br />${escapeHtml(generatedAtText)}</div>
  </header>
  ${rangeFilter(t, rangeKey)}
  ${note === "" ? "" : `<p class="note">${escapeHtml(note)}</p>`}
  <section class="kpis">
    ${kpis
      .map(
        ([key, value, sub]) => `<div class="kpi" data-kpi="${escapeHtml(key)}"><div class="label">${escapeHtml(t(key))}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`,
      )
      .join("")}
  </section>

  <div class="daily-plus-model">
    <section class="card">
      ${cardHead(t, "chart.daily", "report.daily.hint")}
      <div class="card-body">
        <h3 class="sub-title">${escapeHtml(t("report.cal.subtitle"))}</h3>
        ${calendarHeatmap(snapshot.calendar, palette, t)}
      </div>
    </section>
    <section class="card">
      ${cardHead(t, "pie.model", "pie.modelHint")}
      <div class="card-body">
        ${sharePie(modelPieItems, palette, {
          valueOf: (item) => item.tokensTotal ?? 0,
          format: formatTokens,
          ariaLabel: t("pie.model"),
          centerLabel: t("pie.totalTokens"),
          colors: modelSeries(palette),
        }, t)}
      </div>
    </section>
  </div>

  <div class="two-col">
    <section class="card">
      ${cardHead(t, "hour.title", "report.hour.hint")}
      <div class="card-body">${hourChart(snapshot.byHour, palette, t, hourStatus)}</div>
    </section>
    <section class="card">
      ${cardHead(t, "pie.title", "report.workspacePie.hint")}
      <div class="card-body">
        ${sharePie(workspacePieItems, palette, {
          valueOf: (item) => item.activeMs ?? 0,
          format: formatHours,
          ariaLabel: t("pie.title"),
          centerLabel: t("pie.totalTime"),
        }, t)}
      </div>
    </section>
  </div>

  <section class="card">
    ${cardHead(t, "report.daily.title", "report.daily.detailHint", { days: dailyRowsData.length })}
    <table>
      <thead><tr>${dailyColumns.map((column) => `<th>${escapeHtml(column.label)}</th>`).join("")}</tr></thead>
      <tbody>${dailyRows || `<tr><td colspan="8" class="empty">${escapeHtml(t("state.empty"))}</td></tr>`}</tbody>
    </table>
  </section>

  <section class="card">
    ${cardHead(t, "report.workspace.title")}
    ${workspaceBars(snapshot.byWorkspace, palette, "activeMs", range.days, t, langTag)}
    <table>
      <thead><tr><th>${escapeHtml(t("table.workspace"))}</th><th>${escapeHtml(t("table.activeDays"))}</th><th>${escapeHtml(t("table.sessions"))}</th><th>${escapeHtml(t("table.conversations"))}</th><th>${escapeHtml(t("table.turns"))}</th><th>${escapeHtml(t("table.steps"))}</th><th>${escapeHtml(t("table.active"))}</th><th>${escapeHtml(t("table.tokens"))}</th><th>${escapeHtml(t("table.activeShare"))}</th><th>${escapeHtml(t("table.tokenShare"))}</th></tr></thead>
      <tbody>${workspaceRows || `<tr><td colspan="10" class="empty">${escapeHtml(t("state.empty"))}</td></tr>`}</tbody>
    </table>
  </section>
  ${modelSection(snapshot, palette, t)}
  ${sessionSection(snapshot, palette, t, { topSessions, anonymize })}

  <footer>
    ${escapeHtml(footerTexts.active)}
    ${footerTexts.officialField}
    ${escapeHtml(footerTexts.wait)}
    ${escapeHtml(footerTexts.hour)}
    ${escapeHtml(footerTexts.sessions)}
    ${escapeHtml(footerTexts.model)}
    ${escapeHtml(footerTexts.cost)}
    ${escapeHtml(footerTexts.priceLinks)}${footerLinks}
    ${escapeHtml(footerTexts.docs)}
  </footer>
</main>
</body>
</html>
`;
}
