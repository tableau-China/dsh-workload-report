---
title: 我给 DeepSeek Harness 写了个「工作量报告」：把「我的付出」和 Token 消耗放进同一张图
date: 2026-10-11
tags: [DeepSeek Harness, DSH, 插件, 效率工具]
repo: https://github.com/tableau-China/dsh-workload-report
---

> 用 AI 干活的第 N 个月，我最怕两个问题：「你最近在忙什么？」和「这东西到底花了多少？」
> 前者我答得含糊，后者我根本没有数——不是没数据，而是数据散在几百个会话里，
> 而 Harness 只给我看**当前这一个会话**的统计行。

于是我写了 [dsh-workload-report](https://github.com/tableau-China/dsh-workload-report)：一个把**「我的付出」与「Token 消耗」按日期、按工作区摊开**的 DSH 插件，并且能一键导出**一份可以直接发给客户的自包含 HTML 报告**。

## 它长什么样

侧边栏底部多一个入口，点开是全屏看板。首页六张 KPI：

- **活跃时长**（模型时间 + 工具执行时间）
- **总 Token**（完整整数，可核对，例如 2,690,929,214；K/M/B 只出现在小字里）
- **活跃天数** / **对话次数** / **轮次·步骤** / **缓存读取占比**

![看板首页](../assets/dashboard-calendar.png)

往下是三块图：

1. **日历热力图**（默认）：纵轴周一～周日、横轴 Year-Week，颜色深浅＝活跃时长。它**固定展示全部历史**，不随顶部区间筛选变化；最后一列右侧紧贴着 7 条横条，是各周几的累计活跃时长——一眼能看出「我哪几天在真的干活」。
2. **时刻分析**（左）：0–23 点，柱高＝该时段分摊到的活跃时长，最高的那根高亮。我自己最活跃的是 20:00 一带。
3. **工作区占比**（右）：Top 6 + 其他，可在「按时长 / 按 Token」之间切换。

而「按工作区」这个页签，是我最想给你看的部分：

![按工作区](../assets/dashboard-workspace.png)

每一行是**左「我的付出」右「Token 消耗」**：左边是活跃时长（小字给活跃天数 / 轮次 / 步骤），右边是 Token 总量（小字拆输出与缓存读取）。两条 bar 用**同一个口径**绘制——都按"占全部的比例"，所以旁边的百分比和 bar 长度说的是同一件事，横向、纵向都能直接比。

给客户解释工作量时，我终于可以不说"我很忙"，而是说："这个项目占了我 46% 的投入、30 天里有 18 天在场、消耗了 3.7 B Token。"

## 一份能直接发出去的报告

看板右上角「导出 HTML 报告」，产出的是**一个文件**：

- 内联 CSS + 内联 SVG，**没有任何外链、没有脚本**，双击就能开，可以直接发微信/邮件，也可以打印成 PDF；
- 支持浅色/深色两套配色，标题、备注可自定义；
- 加 `anonymize=1` 会匿名化工作区名并隐藏会话标题——给外部看时不必暴露项目代号。

报告里同样是「时刻分析 + 工作区占比 + 每日趋势 + 明细表」，还带了口径说明。对做月报、写博客的人来说，它天生适合截图。

## 数据从哪来：不解析日志，只读官方投影

DSH 已经把每个会话的统计算好了（`sessionStats`、`tokenUsage` 等投影）。插件的宿主半部只做一件事：**用官方接口把这些值取出来并聚合**，四层取值，先便宜后昂贵：

| 顺序 | 来源 | 成本 | 说明 |
| --- | --- | --- | --- |
| 1 | `ctx.sessionProjections.snapshot(session, keys)` | 同步、极低 | 活会话最准；订阅 `session/event` 增量更新 |
| 2 | `ctx.sessionProjectionCache.cachedSnapshot(header, keys)` | **零 I/O** | 读持久化投影检查点 |
| 3 | 本地索引 `<DSH_HOME>/workload-report/index-v*.json` | 一次磁盘读 | 覆盖第 2 层未命中的会话 |
| 4 | `ctx.sessionQuery.observeSession(id, { projectionMode: "all" })` | 冷读日志 | 官方折叠整份日志兜底，结果落盘复用 |

我刻意**没有**去解析 `session.jsonl.zstd`：格式会随版本演进，而投影的语义由 Harness 自己维护。代价是首次建索引要冷读历史会话（我这边 300+ 会话约 2 分钟，并发 8），换来的是后续重启亚秒级复用，以及「口径永远和 Harness 自己算的一致」。

## 过程中踩的四个坑（这才是我想写下来的部分）

### 坑 1：Token 全是 0——同一个投影有两种形状

我最初这样读 Token：

```js
const totals = values.tokenUsage.totals;   // 只认这一种
```

结果所有走官方接口拿到的 Token 都是 0，而**时长却完全正常**——因为 `sessionStats` 的两种形状字段名刚好一致，把问题掩盖了。真相是：

| 来源 | 形状 |
| --- | --- |
| 官方 wire view（`snapshot` / `cachedSnapshot` 的返回值） | `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`，**直接就是桶** |
| 持久化 state（检查点文件里的 `val`） | `{ totals: {...}, last: {...} }` |

`dsh-token-meter` 的投影定义写得很清楚：`wire.view = (state) => state.totals`。修法是两种形状都认（`usage.totals ?? usage`），并给"官方 wire 形状"补了一条回归断言。

**教训**：读第三方内部值之前，先看它的 wire/view 定义，别照着文件结构猜。

### 坑 2：历史会话读不到——检查点会被格式迁移作废

装上真实 profile 后发现：300+ 个会话里，只有一部分能从检查点读到值。原因是官方按**会话生命周期身份**（formatVersion / createdAt / cwd / isSeeded）校验检查点，会话格式从 v3 迁到 v4 之后，旧检查点会被**有意拒绝**——这是设计，不是 bug。

于是我加了第 4 层：官方冷读 `observeSession(id, { projectionMode: "all" })`，把整份日志折叠出投影（内部仍以检查点做捷径），并把结果落到本地索引。绝大部分历史会话这样就补齐了；**极早期 v0 格式**的一小部分，当前 Harness 版本无法迁移，冷读会失败——我把它们单列为"读取失败"并在界面写明数量，而不是静默当 0。

### 坑 3：一个没声明的服务，让整条实时路径静默失效

DSH 用的是 cordis 插件系统。**访问未声明的服务会抛错**：

```
cannot get property "sessionProjections" without inject
```

我把这行错误 catch 掉了，于是插件照常工作、历史数据也正常——但**活会话的实时更新一次都没跑过**（诊断里的 `live` 恒为 0）。是我在 `/health` 里看到 `lastError` 才发现的。

修法是把用到的服务全写进 `inject`，并加了一条**静态断言**：扫描 `index.js` 里访问的每个 `ctx.X`，必须在 `inject` 里列明。这类"漏声明"以后跑测试就会红。

### 坑 4：渐进式填充带来的数据竞态

首次建索引要两分钟，所以我做成"边解析边可见"。但这个换表逻辑在**后续的增量重扫**里成了 bug：请求会读到只有部分会话的残缺数据（表现为日历格子数莫名抖动）。改成——**首次**渐变换表（避免长时间空白），**之后的增量重扫原子替换**（请求要么看到旧表，要么看到新表）。

顺带把重扫间隔从 2 秒放宽到 30 秒：实时性由事件增量保证，没必要每两秒全量重扫。

### 一个小细节：时刻分析的口径与守恒

"我哪个时间段更活跃"并不好答：投影里只有会话级聚合值，没有逐事件时间戳。我选的近似口径是——**会话活跃窗口 = 开始时间 → 最后一次用户提问时间**（`sessionListMetadata.lastPromptAt`），把该会话的引擎时长按**墙钟重叠比例**分摊到覆盖的小时。

写分摊循环时我用了 `cursor <= end` 配 `end + 1`，结果切片比例之和 = 跨度 + 1ms，总时长多出 5.5ms。改成半开区间 `[start, end)` 后严格守恒，并把"分摊总和 == 总活跃时长"写成了常驻断言。

## 口径与已知限制（我也写在插件里）

- **活跃时长是引擎累计工作时间**（模型 + 工具），并发会话与子代理各自累加，**不等于墙钟时长**；
- **对话次数** = 至少产生 1 个步骤的会话数，零步会话（只打开没交互）单列；
- **归属日期**按会话创建时间在所选时区计算，跨天续聊的活动记在创建那天；
- 时刻分析是**近似**（长窗口会被摊薄），日历固定全历史不跟筛选；
- 极早期格式的会话可能读不到，界面会写明数量。

这些都写进了仓库的 [`docs/metrics.md`](https://github.com/tableau-China/dsh-workload-report/blob/main/docs/metrics.md)——给客户看的数字，口径必须先说清楚。

## 安装

```bash
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

构建产物 `lib/client.js` 已入库，**不需要本地构建**。装完重启 Web profile，侧边栏底部出现「工作量报告」。

想给客户看时改个名字（配置在 profile 的 `cordis.patch.yml`）：

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    workspaceAliases:
      my-shop-app: 零售订单系统
      data-platform: 数据中台
```

## 测试策略

插件类项目最难的不是写功能，而是**改完敢不敢重启**。这里堆了两层：

- **离线 124 项断言**：聚合口径、时区归属、时刻分摊守恒、"全部"档起点、日历数据源、HTML 转义、Token 两种形状、冷读兜底与复用、`inject` 声明检查、宿主路由 200/404/405、以及 **i18n 一致性**（中英键集一致、引用键必须存在、无死键、无超长文案）。
- **真实浏览器 E2E 61 项**：在**隔离实例**（独立 `DSH_HOME` + 端口，复制真实投影数据，不碰正在用的 GUI）里跑，含 DOM 断言与**几何断言**——比如"左块右边界 ≤ 右块左边界"来证明两块确实是左右并排而不是上下两行。

CI 每次 push 都会：安装依赖 → 构建 → **校验入库的 `lib/client.js` 与源码一致** → 跑离线断言。

## 最后

这个插件解决的不是"看数据"，而是**把付出说清楚**。对我而言，它顺手解决了三件事：写月报有数、给客户报价有据、以及——看到日历上那些空白的格子时，知道自己上周确实该休息了。

- 仓库：[tableau-China/dsh-workload-report](https://github.com/tableau-China/dsh-workload-report)
- 口径文档：[docs/metrics.md](https://github.com/tableau-China/dsh-workload-report/blob/main/docs/metrics.md)
- 许可：MIT

> 附：这个插件与我之前在 Mac App Store 发布的 **TimeMirror**（macOS 时间分布应用）是同一个想法——把时间照出来。包名用描述式的 `dsh-workload-report` 是为了在 DSH 生态里能被搜到，品牌沿用 TimeMirror。
