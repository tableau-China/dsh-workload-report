/**
 * 日历图标题后的总结：活跃天数 / 当前连续 / 最长连续。
 *
 * 口径刻意与日历热力图一致 —— 用 snapshot.calendar 的**全历史**（from → to），
 * 不用 byDay（当前筛选区间），否则「图展示全历史、总结写近 30 天」会自相矛盾。
 * calendar.days 只含有活动的日子，所以连续天数要按完整日期序列枚举后判断。
 */
export function calendarSummary(calendar) {
  const from = calendar?.from ?? "";
  const to = calendar?.to ?? "";
  const dates = [];
  if (from && to) {
    let cursor = Date.parse(`${from}T00:00:00Z`);
    const end = Date.parse(`${to}T00:00:00Z`);
    // 与 aggregate 的 enumerateDays 上限一致，避免异常数据撑爆内存
    while (cursor <= end && dates.length < 4000) {
      dates.push(new Date(cursor).toISOString().slice(0, 10));
      cursor += 86400000;
    }
  }

  const activeSet = new Set(
    (calendar?.days ?? [])
      .filter((day) => (day.activeMs ?? 0) > 0 || (day.sessions ?? 0) > 0)
      .map((day) => day.date),
  );

  let longest = 0;
  let run = 0;
  for (const date of dates) {
    if (activeSet.has(date)) {
      run += 1;
      longest = Math.max(longest, run);
    } else {
      run = 0;
    }
  }

  // 当前连续：从最后一个有活动的日子往回数（今天没活动也不把连续清零）。
  let lastActive = -1;
  for (let i = dates.length - 1; i >= 0; i -= 1) {
    if (activeSet.has(dates[i])) { lastActive = i; break; }
  }
  let current = 0;
  for (let i = lastActive; i >= 0 && activeSet.has(dates[i]); i -= 1) current += 1;

  return { active: activeSet.size, total: dates.length, current, longest, from, to };
}
