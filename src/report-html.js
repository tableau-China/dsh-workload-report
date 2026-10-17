/**
 * 生成**自包含** HTML 报告：内联 CSS + 内联 SVG 图表，无任何外部资源、无脚本。
 * 目标用途：博客截图、给客户展示开发工作量、打印/导出 PDF、直接当文件发出去。
 *
 * 所有外部文本（工作区名、会话标题、备注）都经 escapeHtml 转义。
 */

import { escapeHtml, formatDuration, formatInt, formatPercent, formatTokens } from "./format.js";
import { sectorPath } from "./sector-path.js";

/** 主题色板（浅色/深色）。报告是独立文件，用不了宿主 token，因此自带一套与看板一致的色板。 */
const PALETTES = {
  light: {
    bg: "#f5f6f8", surface: "#ffffff", text: "#1a1d21", muted: "#6b7280", border: "#e5e7eb",
    input: "#3b82f6", output: "#10b981", cache: "#c7cbd1", accent: "#4f46e5", barBg: "#eef0f3",
    /** 周末柱：与看板同一个强调色（--dsw-static-amber-500 的浅色值）。 */
    weekend: "#f59e0b",
  },
  dark: {
    bg: "#15171c", surface: "#1d2026", text: "#e8eaed", muted: "#9aa1ac", border: "#2b2f37",
    input: "#60a5fa", output: "#34d399", cache: "#4b5563", accent: "#818cf8", barBg: "#282c34",
    weekend: "#f59e0b",
  },
};

/** 日期是否周末（与看板同口径：按该日历日的本地星期判定）。 */
function isWeekend(dateKey) {
  const weekday = new Date(`${dateKey}T00:00:00`).getDay();
  return weekday === 0 || weekday === 6;
}

/**
 * 渲染每日「活跃时长柱」SVG —— 与看板「柱状图」模式同构：
 * **单序列、无折线**，柱高＝净活跃时长（day.activeMs，聚合时已剔除等待用户），
 * 周六 / 周日换强调色，数值标在柱顶。
 * @param days - byDay 数组。
 * @param palette - 色板。
 * @returns SVG 字符串。
 */
function dailyChart(days, palette) {
  const width = 1040;
  const height = 260;
  const pad = { top: 20, right: 16, bottom: 30, left: 16 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  if (days.length === 0) return `<p class="empty">该区间没有数据</p>`;

  const maxActive = Math.max(1, ...days.map((d) => d.activeMs));
  const step = innerW / days.length;
  const barW = Math.max(1.5, Math.min(26, step * 0.62));
  // 数值标签：至少占 46px 才画，避免天数多时叠字（与看板同策略）
  const valueEvery = Math.max(1, Math.ceil(46 / step));

  const bars = days
    .map((day, index) => {
      const x = pad.left + step * index + step / 2;
      const h = (day.activeMs / maxActive) * innerH;
      const y = pad.top + innerH - h;
      const weekend = isWeekend(day.date);
      const fill = weekend ? palette.weekend : palette.input;
      const title = `${day.date}${weekend ? "（周末）" : ""}\n活跃 ${formatDuration(day.activeMs)}\nToken ${formatInt(day.tokensTotal)}\n对话 ${day.conversations} · 轮次 ${day.turns}`;
      // tooltip 必须挂在柱本身（<rect> 的直接子节点）：挂在 <g> 上时部分浏览器不弹
      // （原生 SVG tooltip 以实际命中的形状为准）；0 值日也保留 ≥1px 的柱，天天可悬停。
      const bar = `<rect x="${(x - barW / 2).toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(h, 1).toFixed(2)}" rx="2" fill="${fill}"><title>${escapeHtml(title)}</title></rect>`;
      const value =
        day.activeMs > 0 && index % valueEvery === 0
          ? `<text x="${x.toFixed(1)}" y="${(y - 5).toFixed(1)}" text-anchor="middle" font-size="10" fill="${palette.muted}">${escapeHtml(formatDuration(day.activeMs))}</text>`
          : "";
      return `<g>${bar}${value}</g>`;
    })
    .join("");

  const labelEvery = Math.max(1, Math.ceil(days.length / 10));
  const labels = days
    .map((day, index) =>
      index % labelEvery === 0 || index === days.length - 1
        ? `<text x="${(pad.left + step * index + step / 2).toFixed(1)}" y="${height - 10}" text-anchor="middle" font-size="11" fill="${palette.muted}">${escapeHtml(day.date.slice(5))}</text>`
        : "",
    )
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="每日活跃时长">
  <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="${palette.border}" stroke-width="1" />
  ${bars}
  ${labels}
</svg>`;
}

/**
 * 渲染工作区条形排行。
 * @param items - byWorkspace 数组。
 * @param palette - 色板。
 * @param metric - 排序指标。
 * @returns HTML 字符串。
 */
function workspaceBars(items, palette, metric, rangeDays = 0) {
  if (items.length === 0) return `<p class="empty">该区间没有数据</p>`;
  const dateOf = (ms) => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "—");
  return `<ul class="bars">${items
    .map((item) => {
      const activePct = Math.max(0, Math.min(1, item.activeShare ?? 0)) * 100;
      const tokenPct = Math.max(0, Math.min(1, item.tokenShare ?? 0)) * 100;
      return `<li>
  <div class="ws-head">
    <span class="ws-name">${escapeHtml(item.label)}</span>
    <span class="ws-meta">最近使用 ${escapeHtml(dateOf(item.lastUsedAt))}</span>
  </div>
  <div class="ws-metrics">
    <div class="ws-metric">
      <div class="m-label">我的付出</div>
      <div class="m-value">${escapeHtml(formatDuration(item.activeMs))}<span class="m-share">${escapeHtml(formatPercent(item.activeShare ?? 0))}</span></div>
      <div class="bar-track"><div class="bar-fill" style="width:${activePct.toFixed(2)}%"></div></div>
      <div class="m-sub">活跃 ${formatInt(item.activeDays ?? 0)}/${formatInt(rangeDays)} 天 · ${formatInt(item.turns)} 轮 · ${formatInt(item.steps)} 步</div>
    </div>
    <div class="ws-metric">
      <div class="m-label">Token 消耗</div>
      <div class="m-value">${escapeHtml(formatTokens(item.tokensTotal))}<span class="m-share">${escapeHtml(formatPercent(item.tokenShare ?? 0))}</span></div>
      <div class="bar-track"><div class="bar-fill is-tokens" style="width:${tokenPct.toFixed(2)}%"></div></div>
      <div class="m-sub">输出 ${escapeHtml(formatTokens(item.tokens.output))} · 缓存读取 ${escapeHtml(formatTokens(item.tokens.cacheRead))}</div>
    </div>
  </div>
  <div class="ws-foot">${formatInt(item.sessions)} 会话 · ${formatInt(item.conversations)} 次对话</div>
</li>`;
    })
    .join("")}</ul>`;
}


/**
 * 时刻分析：24 根柱，柱高＝以轮次开始时刻计的净活跃时长（不含等待用户），最高的一根高亮。
 * @param hours - byHour 数组。
 * @param palette - 色板。
 * @returns SVG 字符串。
 */
function hourChart(hours, palette) {
  const width = 520;
  const height = 170;
  const pad = { top: 14, right: 6, bottom: 22, left: 6 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = Math.max(1, ...hours.map((hour) => hour.activeMs));
  const peak = hours.reduce((best, hour) => (hour.activeMs > best.activeMs ? hour : best), hours[0]);
  const step = innerW / hours.length;
  const barW = Math.max(3, step * 0.68);
  const bars = hours
    .map((hour, index) => {
      const h = (hour.activeMs / max) * innerH;
      const x = pad.left + step * index + (step - barW) / 2;
      const y = pad.top + innerH - h;
      const fill = hour.hour === peak?.hour ? palette.accent : palette.input;
      const title = `${hour.hour}:00–${hour.hour}:59\n活跃 ${formatDuration(hour.activeMs)}\n覆盖 ${hour.sessions} 个会话 · ${hour.starts} 次开始`;
      // 柱自带 tooltip，且 24 根柱恒存在（0 值给 1px）：原来 h ≤ 0.5 时整根柱被删掉，
      // 该小时连可命中的形状都没有 → 悬停无任何提示。
      return `<g><rect x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${barW.toFixed(2)}" height="${Math.max(h, 1).toFixed(2)}" rx="2" fill="${fill}"><title>${escapeHtml(title)}</title></rect></g>`;
    })
    .join("");
  const labels = hours
    .map((hour, index) =>
      hour.hour % 3 === 0
        ? `<text x="${(pad.left + step * index + step / 2).toFixed(1)}" y="${height - 6}" text-anchor="middle" font-size="9" fill="${palette.muted}">${hour.hour}</text>`
        : "",
    )
    .join("");
  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="时刻分析">
  <line x1="${pad.left}" y1="${pad.top + innerH}" x2="${width - pad.right}" y2="${pad.top + innerH}" stroke="${palette.border}" />
  ${bars}
  ${labels}
</svg>
<p class="empty" style="margin:6px 0 0">最活跃：${peak ? peak.hour : 0}:00（${escapeHtml(formatDuration(peak ? peak.activeMs : 0))}）</p>`;
}

/**
 * 工作区环形图（Top 6 + others，按活跃时长）。
 * 与看板同构：同样的环形几何（外 74 / 内 50，viewBox 160）+ 主题背景色描边，
 * 扇区之间因此有可见缝隙（stroke-dasharray 画的圆描不出两条半径边，故用真实扇区 path）。
 * @param items - byWorkspace 数组。
 * @param palette - 色板。
 * @returns HTML 字符串。
 */
function workspacePie(items, palette) {
  const active = items.filter((item) => item.activeMs > 0);
  if (active.length === 0) return `<p class="empty">该区间没有数据</p>`;
  const colors = [palette.input, palette.output, palette.accent, "#f59e0b", "#f25a5a", "#a9b8ff", palette.cache];
  const top = active.slice(0, 6).map((item) => ({ label: item.label, value: item.activeMs, item }));
  const rest = active.slice(6);
  if (rest.length > 0) top.push({ label: "others", value: rest.reduce((sum, item) => sum + item.activeMs, 0), item: null });
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
      const arc = `<path d="${sectorPath(outer, inner, angle, angle + sweep)}" fill="${colors[index % colors.length]}" stroke="${palette.surface}" stroke-width="1.6" stroke-linejoin="round"><title>${escapeHtml(slice.label)}：${escapeHtml(formatDuration(slice.value))}（${escapeHtml(formatPercent(share))}）</title></path>`;
      angle += sweep;
      return arc;
    })
    .join("");
  const legend = top
    .map((slice, index) => {
      const share = slice.value / total;
      return `<li><i style="background:${colors[index % colors.length]}"></i><span class="pie-name">${escapeHtml(slice.label)}</span><span class="pie-value">${escapeHtml(formatDuration(slice.value))}</span><span class="pie-share">${escapeHtml(formatPercent(share))}</span></li>`;
    })
    .join("");
  return `<div class="pie-wrap">
  <svg viewBox="0 0 160 160" width="160" height="160" role="img" aria-label="工作区占比">
    <g transform="translate(80,80) rotate(-90)">${arcs}</g>
    <text x="80" y="76" text-anchor="middle" font-size="14" font-weight="650" fill="${palette.text}">${escapeHtml(formatDuration(total))}</text>
    <text x="80" y="92" text-anchor="middle" font-size="10" fill="${palette.muted}">总活跃时长</text>
  </svg>
  <ul class="pie-legend">${legend}</ul>
</div>`;
}

/**
 * 生成完整报告 HTML。
 * @param snapshot - present(aggregate(...)) 的结果。
 * @param options - theme / title / note / anonymize / includeSessions / topSessions / generatedAt / timeZone。
 * @returns HTML 文本。
 */
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

/** 模型占比 treemap（面积 = 占比）。 */
function modelTreemap(models, palette, metric = "tokens") {
  const valueOf = (item) => (metric === "requests" ? item.requests : metric === "llmMs" ? item.llmMs : item.tokensTotal);
  const sorted = [...models].filter((item) => valueOf(item) > 0).sort((a, b) => valueOf(b) - valueOf(a));
  if (sorted.length === 0) return "";
  const series = modelSeries(palette);
  const top = sorted.slice(0, 8);
  const rest = sorted.slice(8);
  const cells = top.map((item, index) => ({ key: item.key, label: item.label, value: valueOf(item), color: series[index % series.length] }));
  if (rest.length > 0) {
    cells.push({ key: "__others", label: "others", value: rest.reduce((sum, item) => sum + valueOf(item), 0), color: palette.muted });
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
  return '<svg class="treemap" viewBox="0 0 100 56" width="100%" style="height:auto" role="img" aria-label="模型占比">' + parts.join("") + "</svg>";
}

/** 按日模型趋势（堆叠柱，取前 6 个模型）。 */
function modelTrend(daily, models, palette) {
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
      return '<rect x="' + (centerX - barWidth / 2).toFixed(2) + '" y="' + y.toFixed(2) + '" width="' + barWidth.toFixed(2) + '" height="' + h.toFixed(2) + '" rx="1.2" fill="' + s.color + '"/>';
    });
    return '<g><title>' + escapeHtml(day.date) + " · " + formatInt(totalsPerDay[index]) + " tokens</title>" + rects.join("") + "</g>";
  });
  const every = Math.max(1, Math.ceil(rows.length / 8));
  const labels = rows.map((day, index) =>
    index % every === 0 || index === rows.length - 1
      ? '<text x="' + (pad.left + step * index + step / 2).toFixed(2) + '" y="' + (height - 6) + '" text-anchor="middle" font-size="9" fill="' + palette.muted + '">' + escapeHtml(day.date.slice(5)) + "</text>"
      : "",
  );
  const legend = series.map((s) => '<span class="legend-item"><i style="background:' + s.color + '"></i>' + escapeHtml(s.label) + "</span>").join("");
  return '<svg viewBox="0 0 ' + width + " " + height + '" width="100%" height="' + height + '" role="img" aria-label="按日模型趋势">' + bars.join("") + labels.join("") + '</svg><div class="legend">' + legend + "</div>";
}

/** 模型用量明细表 + 官方计费链接。 */
function modelSection(snapshot, palette) {
  const models = snapshot.byModel ?? [];
  if (models.length === 0) return "";
  const pricing = snapshot.pricing ?? { currency: "CNY", links: [], costed: { covered: 0, total: 0 }, totalCost: null, asOf: "" };
  const symbol = pricing.currency === "USD" ? "$" : "¥";
  const cost = (value) => (value === null || value === undefined ? "—" : symbol + (value < 1 ? value.toFixed(4) : value.toFixed(2)));
  const rows = models
    .map(
      (item) => '<tr><td class="ws">' + escapeHtml(item.label) + "</td><td>" + formatPercent(item.share) + "</td><td>" + formatInt(item.requests) + "</td><td>" + formatTokens(item.tokens.input) + "</td><td>" + formatTokens(item.tokens.output) + "</td><td>" + formatTokens(item.tokens.cacheRead) + "</td><td>" + (item.cacheHitRate === null || item.cacheHitRate === undefined ? "—" : formatPercent(item.cacheHitRate)) + "</td><td>" + cost(item.cost) + "</td></tr>",
    )
    .join("");
  const links = (pricing.links ?? []).map((link) => '<a href="' + escapeHtml(link.url) + '">' + escapeHtml(link.label ?? link.provider) + "</a>").join(" · ");
  const totalText = pricing.totalCost === null || pricing.totalCost === undefined ? "" : " · 合计 " + cost(pricing.totalCost);
  return '<section class="card">\n  <h2>模型用量</h2>\n  <p class="hint">模型占比 · 面积 = Token 占比 ｜ 右：按日 Token 趋势</p>\n  <div class="two-col">\n    <div>' + modelTreemap(models, palette, "tokens") + "</div>\n    <div>" + modelTrend(snapshot.modelDaily, models, palette) + "</div>\n  </div>\n  <table>\n    <thead><tr><th>模型</th><th>占比</th><th>请求</th><th>输入</th><th>输出</th><th>缓存读</th><th>缓存命中</th><th>费用(估算)</th></tr></thead>\n    <tbody>" + rows + "</tbody>\n  </table>\n  <p class=\"note\">费用按官方公开单价估算（as-of " + escapeHtml(String(pricing.asOf ?? "")) + "，" + (pricing.costed?.covered ?? 0) + "/" + (pricing.costed?.total ?? 0) + " 个模型有官方价" + totalText + "）。官方计费标准：" + links + "</p>\n</section>";
}

/** 报告生成。 */
export function renderReport(snapshot, options = {}) {
  const {
    theme = "light",
    title = "工作量报告",
    note = "",
    anonymize = false,
    topSessions = 12,
    generatedAt = Date.now(),
  } = options;
  const palette = PALETTES[theme === "dark" ? "dark" : "light"];
  const totals = snapshot.totals;
  const derived = snapshot.derived;
  const range = snapshot.range;

  // 模型费用 KPI：与看板同口径 —— 只统计有官方单价的模型；一个都没有时显示 —（不编数字）
  const pricing = snapshot.pricing ?? { currency: "CNY", asOf: "", links: [], costed: { covered: 0, total: 0 }, totalCost: null };
  const symbol = pricing.currency === "USD" ? "$" : "¥";
  const money = (value) => (value === null || value === undefined ? "—" : symbol + (value < 1 ? value.toFixed(4) : value.toFixed(2)));
  const costed = pricing.costed ?? { covered: 0, total: 0 };

  // 活跃时长 KPI 用净活跃（totals.activeMs 是官方值，含等待用户）；等待在副标题里单列
  const netActiveMs = totals.netActiveMs ?? totals.activeMs;
  const kpis = [
    ["累计活跃时长", formatDuration(netActiveMs), `模型 ${formatDuration(totals.llmMs)} · 工具 ${formatDuration(totals.toolMs)} · 含等待用户 ${formatDuration(totals.waitMs ?? 0)}`],
    ["总 Token", formatTokens(totals.tokensTotal), `输入 ${formatTokens(totals.tokens.input)} · 输出 ${formatTokens(totals.tokens.output)} · 缓存 ${formatTokens(totals.tokens.cacheRead)}`],
    ["模型费用(估算)", money(pricing.totalCost), costed.total > 0 ? `${formatInt(costed.covered)}/${formatInt(costed.total)} 个模型有官方价 · as-of ${pricing.asOf ?? "—"}` : "无带官方价的模型"],
    ["对话次数", formatInt(totals.conversations), `会话总数 ${formatInt(totals.sessions)}（含空会话 ${formatInt(totals.emptySessions)}）`],
    ["轮次 / 步骤", `${formatInt(totals.turns)} / ${formatInt(totals.steps)}`, `主会话 ${formatInt(totals.mainSessions)} · 子代理 ${formatInt(totals.subagentSessions)}`],
    ["活跃天数", `${formatInt(totals.activeDays)} / ${formatInt(range.days)}`, `覆盖 ${formatInt(totals.workspaces)} 个工作区`],
    ["缓存读取占比", formatPercent(derived.cacheHitRate), `输出 ${formatTokens(derived.outputPerActiveHour)}/h`],
  ];

  const activeDays = snapshot.byDay.filter((day) => day.sessions > 0);
  const dailyRows = [...activeDays]
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 14)
    .map(
      (day) => `<tr><td>${escapeHtml(day.date)}</td><td>${day.conversations}</td><td>${formatInt(day.turns)}</td><td>${formatInt(day.steps)}</td><td>${formatDuration(day.activeMs)}</td><td>${formatTokens(day.tokens.input)}</td><td>${formatTokens(day.tokens.output)}</td><td>${formatTokens(day.tokens.cacheRead)}</td></tr>`,
    )
    .join("");

  const workspaceRows = snapshot.byWorkspace
    .map(
      (item) => `<tr><td class="ws">${escapeHtml(item.label)}</td><td>${formatInt(item.activeDays ?? 0)}</td><td>${formatInt(item.sessions)}</td><td>${formatInt(item.conversations)}</td><td>${formatInt(item.turns)}</td><td>${formatInt(item.steps)}</td><td>${formatDuration(item.activeMs)}</td><td>${formatTokens(item.tokensTotal)}</td><td>${formatPercent(item.activeShare ?? 0)}</td><td>${formatPercent(item.tokenShare ?? 0)}</td></tr>`,
    )
    .join("");

  const sessionSection =
    anonymize || topSessions <= 0
      ? ""
      : `<section class="card">
    <h2>主要会话</h2>
    <table>
      <thead><tr><th>会话</th><th>工作区</th><th>轮次</th><th>步骤</th><th>活跃时长</th><th>输出 Token</th></tr></thead>
      <tbody>${snapshot.bySession
        .slice(0, topSessions)
        .map(
          (item) => `<tr><td class="ws">${escapeHtml(item.title || "(无标题)")}</td><td>${escapeHtml(item.workspaceLabel)}</td><td>${formatInt(item.turns)}</td><td>${formatInt(item.steps)}</td><td>${formatDuration(item.activeMs)}</td><td>${formatTokens(item.tokens.output)}</td></tr>`,
        )
        .join("")}</tbody>
    </table>
  </section>`;

  return `<!doctype html>
<html lang="zh-CN">
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
  .page { max-width: 1120px; margin: 0 auto; padding: 40px 28px 56px; }
  .hero { display: flex; align-items: flex-end; justify-content: space-between; gap: 24px; margin-bottom: 24px; flex-wrap: wrap; }
  h1 { font-size: 28px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .range { margin: 0; color: ${palette.muted}; font-size: 14px; }
  .hero-meta { color: ${palette.muted}; font-size: 12px; text-align: right; line-height: 1.6; }
  .note { margin: 0 0 24px; padding: 12px 16px; background: ${palette.surface}; border: 1px solid ${palette.border};
    border-radius: 10px; font-size: 13px; color: ${palette.muted}; }
  .kpis { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 14px; margin-bottom: 24px; }
  .kpi { background: ${palette.surface}; border: 1px solid ${palette.border}; border-radius: 12px; padding: 16px 18px; }
  .kpi .label { font-size: 12px; color: ${palette.muted}; margin-bottom: 8px; }
  .kpi .value { font-size: 24px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
  .kpi .sub { font-size: 12px; color: ${palette.muted}; margin-top: 8px; line-height: 1.5; }
  .card { background: ${palette.surface}; border: 1px solid ${palette.border}; border-radius: 12px; padding: 20px 22px; margin-bottom: 20px; }
  .card h2 { font-size: 15px; margin: 0 0 4px; }
  .card .hint { font-size: 12px; color: ${palette.muted}; margin: 0 0 16px; }
  .legend { display: flex; gap: 16px; font-size: 12px; color: ${palette.muted}; margin-top: 10px; flex-wrap: wrap; }
  .legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; margin-right: 6px; vertical-align: middle; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 6px; }
  th, td { text-align: right; padding: 8px 10px; border-bottom: 1px solid ${palette.border}; font-variant-numeric: tabular-nums; }
  th:first-child, td:first-child { text-align: left; }
  th { color: ${palette.muted}; font-weight: 500; font-size: 12px; }
  td.ws { max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  tbody tr:last-child td { border-bottom: none; }
  .bars { list-style: none; margin: 8px 0 18px; padding: 0; display: grid; gap: 14px; }
  .bar-head { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
  .bar-value { font-variant-numeric: tabular-nums; color: ${palette.muted}; }
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
  .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  .two-col .card { margin-bottom: 20px; }
  .pie-wrap { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
  .pie-legend { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; flex: 1 1 200px; font-size: 12px; }
  .pie-legend li { display: grid; grid-template-columns: 10px 1fr auto auto; align-items: center; gap: 8px; }
  .pie-legend i { display: inline-block; width: 9px; height: 9px; border-radius: 2px; }
  .pie-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .pie-value { font-variant-numeric: tabular-nums; }
  .pie-share { color: ${palette.muted}; font-variant-numeric: tabular-nums; min-width: 42px; text-align: right; }
  @media (max-width: 760px) { .two-col { grid-template-columns: 1fr; } }
  .bar-sub { font-size: 11px; color: ${palette.muted}; margin-top: 4px; }
  .empty { color: ${palette.muted}; font-size: 13px; margin: 12px 0; }
  footer { color: ${palette.muted}; font-size: 12px; line-height: 1.7; margin-top: 28px; }
  @media (max-width: 760px) { .kpis { grid-template-columns: repeat(2, minmax(0, 1fr)); } .page { padding: 24px 16px 40px; } }
  @media print { body { background: #fff; } .card, .kpi { break-inside: avoid; box-shadow: none; } }
</style>
</head>
<body>
<main class="page">
  <header class="hero">
    <div>
      <h1>${escapeHtml(title)}</h1>
      <p class="range">${escapeHtml(range.from)} ~ ${escapeHtml(range.to)} · ${range.days} 天 · ${escapeHtml(range.timeZone)}${snapshot.scope === "all" ? "" : ` · 范围 ${escapeHtml(snapshot.scope)}`}</p>
    </div>
    <div class="hero-meta">DeepSeek Harness<br />生成于 ${escapeHtml(new Date(generatedAt).toLocaleString("zh-CN", { hour12: false }))}</div>
  </header>
  ${note === "" ? "" : `<p class="note">${escapeHtml(note)}</p>`}
  <section class="kpis">
    ${kpis
      .map(
        ([label, value, sub]) => `<div class="kpi"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div></div>`,
      )
      .join("")}
  </section>

  <section class="card">
    <h2>每日用量趋势</h2>
    <p class="hint">柱＝活跃时长，周六 / 周日用强调色；数值标在柱顶</p>
    ${dailyChart(snapshot.byDay, palette)}
    <div class="legend">
      <span><i style="background:${palette.input}"></i>工作日</span>
      <span><i style="background:${palette.weekend}"></i>周末</span>
    </div>
  </section>

  <div class="two-col">
    <section class="card">
      <h2>时刻分析</h2>
      <p class="hint">0–23 点分摊活跃时长</p>
      ${hourChart(snapshot.byHour, palette)}
    </section>
    <section class="card">
      <h2>工作区占比</h2>
      ${workspacePie(snapshot.byWorkspace, palette)}
    </section>
  </div>

  <section class="card">
    <h2>按日期明细</h2>
    <p class="hint">最近 14 天</p>
    <table>
      <thead><tr><th>日期</th><th>对话</th><th>轮次</th><th>步骤</th><th>活跃时长</th><th>输入</th><th>输出</th><th>缓存读取</th></tr></thead>
      <tbody>${dailyRows || `<tr><td colspan="8" class="empty">该区间没有数据</td></tr>`}</tbody>
    </table>
  </section>

  <section class="card">
    <h2>按工作区分布</h2>
    <p class="hint">左＝付出 · 右＝消耗；bar＝占全部比例</p>
    ${workspaceBars(snapshot.byWorkspace, palette, "activeMs", range.days)}
    <table>
      <thead><tr><th>工作区</th><th>活跃天数</th><th>会话</th><th>对话</th><th>轮次</th><th>步骤</th><th>活跃时长</th><th>Token</th><th>时长占比</th><th>Token 占比</th></tr></thead>
      <tbody>${workspaceRows || `<tr><td colspan="10" class="empty">该区间没有数据</td></tr>`}</tbody>
    </table>
  </section>
  ${modelSection(snapshot, palette)}
  ${sessionSection}

  <footer>
    活跃时长＝净活跃（模型＋工具时间，已剔除等待用户 ${escapeHtml(formatDuration(totals.waitMs ?? 0))}；累计，非墙钟）。
    官方 activeMs 保留在接口字段 <code>totals.activeMs</code> 供核对：净活跃 + 等待用户 = 官方 activeMs（守恒）。
    等待用户＝交互工具（ask_user_question / exit_plan_mode 白名单）或工具调用期间夹着 user/message、且单次 ≥ 60s 的区间；
    没有人类输入的长任务（编译 / 跑批）照常算工作。每日 / 时刻图同样用净活跃。
    对话＝有步骤的会话数；Token 取自官方投影；按会话创建日在 ${escapeHtml(range.timeZone)} 归属。
    模型口径：一次 assistant/message = 一次请求；模型取自事件的 provider/model；各模型耗时按流式窗口占比分摊会话模型时间（守恒）。
    费用＝按官方公开单价估算（DeepSeek 峰谷价：峰时 01:00-04:00 与 06:00-10:00 UTC 周一至周五，谷价为其半；中国法定节假日按峰价计入，略微高估），非官方账单。
    官方计费标准：${(snapshot.pricing?.links ?? []).map((link) => `<a href="${escapeHtml(link.url)}">${escapeHtml(link.label ?? link.provider)}</a>`).join(" · ")}
    口径详见仓库 docs/metrics.md。数据全部来自本机。
  </footer>
</main>
</body>
</html>
`;
}
