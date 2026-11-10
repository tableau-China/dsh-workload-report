/**
 * KPI sparkline 的逐日序列（纯数值，看板与报告共用）。
 *
 * 数据源：present(aggregate(...)) 快照里的 byDay —— 它是**当前筛选区间**的逐日桶，
 * ≤180 天时已补齐空白日，>180 天的「全部」档只含有活动的日子。
 * 因此 spark 天然跟随 7 / 30 / 90 / 全部 筛选，不需要额外状态或请求。
 *
 * 口径见 docs/metrics.md；比例类用固定 0–1 轴，绝对值类用 0 起点轴。
 */
const ratio = (numerator, denominator) => (denominator > 0 ? numerator / denominator : 0);

/** 8 张 KPI 的 sparkline 序列；key 与 KPI_KEYS 一一对应。 */
export function kpiSeries(snapshot) {
  const days = snapshot?.byDay ?? [];
  return {
    "kpi.active": days.map((day) => day.activeMs ?? 0),
    "kpi.tokens": days.map((day) => day.tokensTotal ?? 0),
    "kpi.modelShare": days.map((day) => ratio(day.llmMs ?? 0, day.activeMs ?? 0)),
    // 每轮自主步骤：steps（一次 assistant/message = 一个 step）/ turns（对话轮次）
    "kpi.autonomy": days.map((day) => ratio(day.steps ?? 0, day.turns ?? 0)),
    "kpi.conversations": days.map((day) => day.conversations ?? 0),
    // byDay 没有「模型请求数」，用 steps 作分母的代理口径
    "kpi.modelOutput": days.map((day) => ratio(day.tokens?.output ?? 0, day.steps ?? 0)),
    // decodeMs = 0 的日子没有速度数据 → null（断开线段），不画 0
    "kpi.speed": days.map((day) => ((day.decodeMs ?? 0) > 0 ? (day.decodeTokens ?? 0) / (day.decodeMs / 1000) : null)),
    "kpi.cache": days.map((day) => ratio(day.tokens?.cacheRead ?? 0, (day.tokens?.input ?? 0) + (day.tokens?.cacheRead ?? 0))),
  };
}

/** 每张卡的坐标轴：比例类固定 0–100%，其余 0 起点，避免自适应轴夸大微小波动。 */
export const KPI_SPARK_DOMAINS = Object.freeze({
  "kpi.active": "zero",
  "kpi.tokens": "zero",
  "kpi.modelShare": "ratio",
  "kpi.autonomy": "zero",
  "kpi.conversations": "zero",
  "kpi.modelOutput": "zero",
  "kpi.speed": "zero",
  "kpi.cache": "ratio",
});
