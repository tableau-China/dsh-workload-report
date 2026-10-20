# TimeMirror for DSH · 工作量报告

> **把「我的付出」和「Token 消耗」放在同一张图上**——按**日期**与**工作区**看清时间投入到哪、Token 花在哪：日历热力图、时刻分析、工作区占比、模型用量，以及一键导出**可直接发给客户的自包含 HTML 报告**。
> DeepSeek Harness（DSH）插件。当前版本：**0.6.6**。

> **TimeMirror** 是我在 Mac App Store 发布的 macOS 时间分布应用；这个插件把同一件事带到 AI 协作场景。包名 / 仓库名沿用描述式的 `dsh-workload-report`，方便在 DSH 生态里被搜到；品牌仍是 TimeMirror。

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/tableau-China/dsh-workload-report/actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

中文 · [English](./README.md)

## 它是什么

DSH 自己只提供**当前会话**的统计行。这个插件补上跨会话、跨项目、跨时间的视角：日期与工作区分别投入了多少、几点最在状态、Token 被哪些模型消耗、大概花了多少钱，并能导出一份适合给客户 / 团队 / 月报的静态报告。

**不只看花了多少，更看做了什么。** 活跃时长、活跃天数与轮次回答「我做了什么」；Token 与费用估算回答「消耗了多少」。所有页面与导出报告使用同一套口径，数字互相对得上。

## 安装与入口

```bash
# npm（已发布）
dsh plugin add dsh-workload-report

# 或从 GitHub 直接装
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main

# 或链接本地源码
dsh plugin --profile web add link:$PWD
```

装完重启 Web profile，入口在**侧边栏底部**：**工作量报告**（英文界面为 **Workload report**）。构建产物 `lib/client.js` 已入库，从 GitHub / npm 安装**不需要本地构建**。

卸载：`dsh plugin --profile web remove dsh-workload-report`。

## 数据来源与原则

- **只用官方接口。** 会话身份来自 `sessionQuery.listSessions()`；统计来自官方投影（`sessionProjections`、`sessionProjectionCache`），必要时用官方 `sessionQuery.observeSession()` 冷读兜底；模型与小时 Token 维度使用官方 `sessionQuery.readSession()` 事件日志。
- **不解析存储格式。** 插件从不打开 `*.jsonl.zstd`，不解析 zstd / JSONL，也不读 Harness 内部的投影缓存文件。格式会随版本演进，官方接口才是稳定契约。
- **默认零外发网络请求。** 统计数据全部留在本机；插件只注册只读 HTTP 路由，唯一写入的是自己的本地索引 `<DSH_HOME>/workload-report/index-v7.json`（删掉会自动重建）。
- **唯一需显式开启的例外**是可选余额 chip（`balance.enabled: true`，默认关闭），由**宿主**调用官方 `deepseekAccount` 服务，见「隐私」。
- **不编数字。** 读不出的早期会话会被排除并在界面写明数量；没有官方价的模型费用显示 **—**，不猜。

## 功能清单（0.6.6）

- **8 张 KPI**：累计活跃时长（**净活跃**，等待用户单列）、总 Token（完整整数，可核对）、模型费用、活跃天数、对话次数、轮次 / 步骤、缓存读取占比、最活跃模型。
- **每日用量趋势**：日历热力图（纵轴周一～周日、横轴 Year-Week，颜色与柱高＝活跃时长）或柱状图；周末异色，峰值柱始终标数值，日历格 / 每日柱 / 周几累计条 / 坐标轴都有各自的 tooltip。
- **时刻分析**：柱默认 **Token 产出**（可切 **轮次**）；顶部圆点＝**人类消息密度**。峰值柱高亮并标数值，图例单行显示。
- **工作区占比**：Top 6 + 其他的环形图，可在**按时长 / 按 Token**之间切换。
- **模型 Token 占比**：首页紧凑环形图；完整模型信息在独立页签。
- **模型用量页签**：treemap（面积＝Token 占比，Top 8 + 其他）、按日堆叠趋势（前 6 个模型）、明细表（占比 / 请求 / 输入 / 输出 / 缓存读 / 缓存命中 / 费用估算）、三口径 chips（Token / 请求数 / 模型耗时）、点击筛选，以及官方计费链接。费用只为有官方公开价的模型估算。
- **主要会话与按日期明细**：主要数值列都有比例条（会话：轮次 / 步骤 / 活跃 / 输出；日期明细：对话 / 轮次 / 活跃 / Token）；主要会话表头可排序；日期明细覆盖最近 31 天。
- **导出自包含 HTML 报告**：单文件、内联 CSS + 内联 SVG，**无脚本、无外部资源**；支持浅 / 深色、自定义标题与备注、`anonymize=1` 匿名化工作区与会话标题。报告与看板同口径：8 张 KPI、日历 + 柱状、小时密度点 + 轮次小图、表格比例条，外链仅官方计费页。
- **主题与语言自适应**：颜色全部使用宿主主题 token（`--dsw-*`），自动跟随浅 / 深色；中英文文案逐键对齐。

## 界面截图

**按日期**：8 张 KPI + 日历热力图 + 含人类消息密度点的时刻分析 + 工作区占比

![看板按日期](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-calendar.png)

**按工作区**：左「我的付出」、右「Token 消耗」，两条 bar 同一比例尺

![看板按工作区](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/dashboard-workspace.png)

**导出的报告**：单文件，可直接发客户

![报告浅色](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-light.png)

<details>
<summary>深色主题报告</summary>

![报告深色](https://raw.githubusercontent.com/tableau-China/dsh-workload-report/main/assets/report-dark.png)

</details>

## 口径说明

完整定义见 **[docs/metrics.md](./docs/metrics.md)**；时长统一使用语言无关的 `H / M / S` 格式（与 Token 的 K/M/B 同理）。最容易被误读的几条：

### 活跃时长

- **活跃时长 = 模型时间 + 工具时间 − 等待用户**，是**引擎累计工作时间**，不是墙钟时长；并发会话与子代理各自累加，也不等于你坐在屏幕前的时间。
- **等待用户**单列为 `waitMs`，不计入活跃时长，并随索引持久化。官方 `totals.activeMs` 保留供核对：`netActiveMs + waitMs === activeMs`（±1 ms）。
- **等待三层判定**（单次工具区间必须 ≥ `waitMinMs`，且满足任一条件，才整段计为等待）：
  1. 工具名在 `waitTools` 白名单（默认 `ask_user_question`、`exit_plan_mode`）；
  2. `tool/call` → `tool/result` 之间夹着 `user/message`（人类输入夹层，任意工具适用）。
- **长任务豁免**：不在白名单、也没有人类输入夹层的长工具（编译 / 跑批）照常算工作；短于 `waitMinMs` 的交互不剔除，避免把正常确认切碎。
- 设 `excludeWait: false` 可完全关闭等待判定（行为与 0.6.0 一致）。

### 时刻分析

卡片有两种口径，另外叠一层人类消息：

- **Tokens（默认）**：每条 `assistant/message` 的 usage 按**消息时间**落到所选时区的小时桶；24 个桶之和等于会话官方 Token 总量（事件合计不一致时按整数回正）。
- **轮次**：该小时**开始**的会话数（看板其余部分的活跃时长仍按轮次开始时刻落桶）。
- **顶部人类消息密度点**：每小时 `user/message` 条数，圆点半径表示相对密度。
- 读不出事件日志的会话（极早期 v0、未回填、或 `modelUsage: off`）**不会伪造小时分布**：它们不计入 Token 时间图，卡片会写 **「Token 未计入 N 个会话」**；总量仍计入 KPI。

### Token、对话与日期

- **总 Token** = 未命中输入 + 输出 + 缓存读 + 缓存写。缓存读通常占绝大多数、单价最低，不要按输入价估算。
- **对话次数** = 至少产生 1 个 step 的会话数；零步会话（只打开没交互）单列，不计入该 KPI。
- **归属日期** = 会话创建时间在所选时区的自然日；跨天续聊仍记在创建那天。
- **模型费用**按内置官方公开价估算（DeepSeek 峰 / 谷两档，as-of 2026-10-13）。只有有官方价的模型才给数字，无价显示 **—**；运行时不联网取价。它是估算，不是账单。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（全部可选）：

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    defaultDays: 7                 # 初始区间：7 | 30 | 90 | all
    refreshMs: 30000               # 索引刷新间隔（毫秒）
    snapshotCacheMs: 15000         # 同参数快照缓存（事件/索引/折叠完成立即失效）
    modelFoldWarmupMs: 2000        # 索引就绪后预热折叠；打开面板不触发
    modelFoldIntervalMs: 720000    # 例行折叠维护（12 分钟）
    modelFoldIdleMs: 600000        # 活会话空闲 10 分钟才重折
    modelRetryMs: 1800000          # 失败行 30 分钟后低频重试（不改状态行）
    defaultScope: all              # all | main | subagent
    modelUsage: auto               # auto | off（off = 不读事件日志，不做模型/小时维度）
    excludeWait: true              # false = 回到 0.6.0 行为（不判定等待）
    waitTools:                     # 视为「等人」的工具
      - ask_user_question
      - exit_plan_mode
    waitMinMs: 60000               # 判定等待的最小区间（毫秒）
    activeModelMetric: requests    # requests | tokens | activeMs
    workspaceAliases:              # 工作区显示名，给客户看时很有用
      my-shop-app: 零售订单系统
    balance:                       # 可选余额 chip —— 默认关闭
      enabled: false               # true 时宿主会访问 platform.deepseek.com（见「隐私」）
      refreshMs: 300000            # 余额缓存时长（毫秒）
```

默认价目内置、离线可用；如合同价不同，可用 `pricing.overrides` / `pricing.asOf` / `pricing.links` 覆盖，详见 [docs/models.md](./docs/models.md)。

## 只读接口

| 路由 | 说明 |
| --- | --- |
| `GET {apiPath}/snapshot?days=30&tz=Asia/Shanghai&scope=all` | 聚合快照 JSON（totals / byDay / byWorkspace / byHour / bySession / calendar / byModel / modelDaily / diagnostics） |
| `GET {apiPath}/export.json?...` | 同上，带 `content-disposition` 下载 |
| `GET {apiPath}/report.html?days=90&theme=dark&anonymize=1&title=...` | 自包含 HTML 报告 |
| `GET {apiPath}/health` | 索引诊断（会话数、检查点命中、冷读、读取失败、耗时） |
| `GET {apiPath}/balance` | 顶部工具栏 chip 用的余额状态；不触发索引 |

参数：`from`/`to`（YYYY-MM-DD，优先于 `days`）、`days`、`all=1`（最早的活跃日 → 今天）、`tz`（IANA 时区）、`scope`。

## 索引与升级注意

- 索引文件：`<DSH_HOME>/workload-report/index-v7.json`；`INDEX_VERSION = 7`。
- 从 0.6.5 及更早版本升级，**首次启动会重建索引并重折事件**（小时桶、小时 Token / 人类消息字段都带版本）；重建期间接口返回逐步填充的数据并带 `indexing: true`。
- 删除索引是安全的：插件会重新冷读历史会话。冷读走官方接口、并发 8（作者本机 300+ 会话约 2 分钟）。
- 极早期的 **v0 格式会话**可能完全读不出：它们不计入统计，界面会写明数量；无法得到 Token 小时分布时，时刻卡会写 **「Token 未计入 N 个会话」**。

## 文档索引

| 文档 | 内容 |
| --- | --- |
| [docs/metrics.md](./docs/metrics.md) | 口径：活跃 / 净活跃 / 等待、时刻分析、Token、日历、工作区 |
| [docs/models.md](./docs/models.md) | 模型归属、归并、缓存命中率、峰谷价与费用估算 |
| [docs/ui-conventions.md](./docs/ui-conventions.md) | 共享 UI 组件、卡片头、图例 / 状态、tooltip 约定 |
| [docs/report-parity.md](./docs/report-parity.md) | 看板 → 报告对齐清单、有意差异、结构断言 |
| [CHANGELOG.md](./CHANGELOG.md) | 版本变更与测试记录 |
| [PROGRESS.md](./PROGRESS.md) | 决策、量测、环境坑与发布记录 |

## 隐私

统计数据全部留在本机；插件只注册**只读** HTTP 路由，**默认不联网**、不采集任何用户内容。唯一写入的是自己的索引缓存，不改动任何 Harness 数据。导出的 HTML 报告默认包含会话标题，可用 `anonymize=1` 隐藏。

**可选余额 chip —— 默认关闭。** 只有显式设置 `balance.enabled: true` 后，宿主才会调用官方 `deepseekAccount` 服务：`getBalance()` 会让**宿主**请求 `https://platform.deepseek.com/api/v0/users/get_user_summary`（账户余额接口）。这是本插件唯一可能触发的出网请求，默认关闭、按 `balance.refreshMs` 缓存；充值 / 用量链接来自服务的本地 `getState()`，不需要网络。查询失败或超时只在 chip 上显示「—」+ 充值链接，不弹错误。余额只渲染在你本机的工具栏 chip 里，**绝不写入**导出的 HTML 报告。

## 开发

| 命令 | 作用 |
| --- | --- |
| `pnpm add -D esbuild puppeteer-core` | 安装构建与浏览器测试依赖（也可用 `ESBUILD_PATH` / `WL_PUPPETEER_DIR` 指向已有安装） |
| `node build.mjs` | 用 esbuild 把 `src/client/` 打成 `lib/client.js`（ModuleLoader 工厂格式） |
| `node test/verify.mjs` | **595 项离线断言**：聚合口径、时区、轮次落桶与守恒、按消息时间的小时 Token、人类消息密度、等待剔除（三层判定 + 长任务豁免 + `excludeWait:false` 回归）、索引 / 冷读兜底、报告结构对齐、i18n 逐键对齐、余额状态 |
| `./test/e2e-boot.sh 3299` | 起一个**隔离实例**（独立 DSH_HOME + 端口），不影响正在用的 GUI |
| `node test/e2e-ui.mjs` | 真实浏览器 E2E：日历 / 柱状切换、几何校验、环形图、报告导出、时刻卡 |

CI 会跑 `build.mjs` + `verify.mjs`，并校验入库的 `lib/client.js` 与源码一致。

## 兼容性

- DSH `0.2.x`，**含 `alpha` 预发布版**（开发与验证基于 `@deepseek-ai/dsh@0.2.1-alpha.2`）。插件只依赖官方接口（`sessionProjections` / `sessionProjectionCache` / `sessionQuery`）与 Node 内置模块，不碰内部文件格式。
- 首次启动会对投影检查点未命中的历史会话做一次冷读；期间接口返回逐步填充的数据并带 `indexing: true`，结果落盘后重启即复用。
- 极早期的 **v0 格式会话**可能无法被当前 Harness 迁移 / 读取；这类会话不计入统计，界面会写明数量。

## 作者

**[XILEJUN](https://github.com/tableau-China)** · TimeMirror 作者 · [博客文章](https://github.com/tableau-China/dsh-workload-report/blob/main/docs/blog.md)

## License

[MIT](./LICENSE)
