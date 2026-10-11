# TimeMirror for DSH · 工作量报告

> 把「我的付出」和「Token 消耗」放在同一张图上：按**日期**与**工作区**看清时间投入到哪、Token 花在哪，含日历热力图、时刻分析、工作区占比，并能一键导出**一份可以直接发给客户的自包含 HTML 报告**。
> A DeepSeek Harness (DSH) plugin that shows your effort and token spend by date and workspace — calendar heatmap, time-of-day analysis, workspace share, and a shareable single-file HTML report.

> **TimeMirror** 是我在 Mac App Store 发布的 macOS 时间分布应用；这个插件把同一件事带到 AI 协作场景——**你和 AI 一起干活的时间与 Token，都能被看见**。
> 包名 / 仓库名用描述式的 `dsh-workload-report`，方便在 DSH 生态里被搜到；品牌沿用 TimeMirror。

[![npm](https://img.shields.io/npm/v/dsh-workload-report?style=flat-square&logo=npm)](https://www.npmjs.com/package/dsh-workload-report)
[![license](https://img.shields.io/github/license/tableau-China/dsh-workload-report?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/tableau-China/dsh-workload-report/ci.yml?branch=main&style=flat-square&label=CI)](../../actions)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933?style=flat-square&logo=node.js)](https://nodejs.org)

中文 · [English](./README.en.md)

## 它解决什么问题

你每天都在用 AI 干活，但**说不清楚干在哪、值多少**：

- 自我复盘：这 30 天我把时间花在哪个项目上？几点最在状态？
- 给客户/团队讲工作量：不是「我很忙」，而是「这个项目占了我 46.2% 的投入、3.74 B Token、30 天里有 18 天在场」。
- 写博客/月报：日历热力图 + 时刻分析，天生适合截图。

DSH 自己只提供**单会话**的统计行；跨会话、跨项目、跨时间的视角，就是这个插件。

## 特性

- ✅ **按工作区的工作量对照**：每行左侧「我的付出」（活跃时长 + 活跃天数 + 轮次/步骤），右侧「Token 消耗」（总量 + 输出/缓存），两条 bar 同口径可按占比直接比。
- ✅ **日历热力图**：纵轴周一～周日、横轴 Year-Week，颜色＝活跃时长；固定展示**全部历史**，右侧紧贴 7 条「周几累计」，一眼看出周几更忙。
- ✅ **时刻分析**：0–23 点谁更活跃，最活跃时段高亮（口径＝会话活跃窗口按墙钟比例分摊，严格守恒）。
- ✅ **工作区占比环形图**：Top 6 + 其他，可在「按时长 / 按 Token」之间切换。
- ✅ **可外发的 HTML 报告**：单文件、内联 CSS + 内联 SVG、无脚本无外链；支持浅/深色、自定义标题与备注、`anonymize=1` 匿名化工作区与会话标题。
- ✅ **KPI 一览**：活跃时长 / 总 Token（完整整数，可核对）/ 活跃天数 / 对话次数 / 轮次·步骤 / 缓存读取占比。
- ✅ **官方接口读数据**：不解析日志格式、不写业务数据、不联网；结果零 I/O 读投影检查点，冷读兜底 + 本地索引复用。
- ✅ **主题与语言自适应**：全部使用宿主主题 token（--dsw-*），自动跟随浅/深色与中/英文。

## 界面

**首页**：6 张 KPI + 日历热力图（可切柱状图）+ 并排的「时刻分析 / 工作区占比」+ 折叠的按日期明细

![dashboard](assets/dashboard-calendar.png)

**按工作区**：左「我的付出」右「Token 消耗」，两条 bar 同口径

![workspace](assets/dashboard-workspace.png)

**导出的报告**（单文件、可直接发客户）

![report light](assets/report-light.png)

<details>
<summary>深色主题报告</summary>

![report dark](assets/report-dark.png)

</details>

## 安装

### 方式一：从 GitHub 直接装（推荐）

```bash
dsh plugin --profile web add github:tableau-China/dsh-workload-report#main
```

构建产物 `lib/client.js` 已入库，**不需要本地构建**。装完重启 Web profile，侧边栏底部出现「工作量报告」。

### 方式二：本地源码 link

```bash
cd /path/to/dsh-workload-report
dsh plugin --profile web add link:$PWD     # 会让 profile 直接指向源码目录
```

### 方式三：npm

```bash
dsh plugin --profile web add dsh-workload-report
```

卸载：`dsh plugin --profile web remove dsh-workload-report`。

## 配置

在 profile 的 `cordis.patch.yml` 里覆盖（全部可选）：

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    apiPath: /workload-report/v1        # 只读接口前缀
    defaultDays: 30                     # 默认区间
    defaultScope: all                   # all | main | subagent
    defaultTitle: 工作量报告              # 报告标题
    workspaceAliases:                   # 工作区显示名（给客户看时非常有用）
      my-shop-app: 零售订单系统
      data-platform: 数据中台
```

## 只读接口

| 路由 | 说明 |
| --- | --- |
| `GET {apiPath}/snapshot?days=30&tz=Asia/Shanghai&scope=all` | 聚合快照 JSON（totals / byDay / byWorkspace / byHour / bySession / calendar / diagnostics） |
| `GET {apiPath}/export.json?...` | 同上，带 `content-disposition` 下载 |
| `GET {apiPath}/report.html?days=90&theme=dark&anonymize=1&title=...` | 自包含 HTML 报告 |
| `GET {apiPath}/health` | 索引诊断（会话数、检查点命中、冷读、读取失败、耗时） |

参数：`from`/`to`（YYYY-MM-DD，优先于 `days`）、`days`、`all=1`（＝最早的活跃日 → 今天）、`tz`（IANA 时区）、`scope`。

## 口径

完整定义见 **[docs/metrics.md](./docs/metrics.md)**；**界面里时长单位统一用 `H / M / S`**（与 Token 的 K/M/B 一样语言无关，中英文共用一份格式）。最容易误读的三条：

- **活跃时长** = 模型推理时间 + 工具执行时间，是**引擎累计工作时间**；并发会话与子代理各自累加，不等于墙钟时长。
- **对话次数** = 至少产生 1 个步骤的会话数；零步会话（只打开没交互）单列。
- **归属日期** = 会话创建时间在所选时区的自然日；跨天续聊的活动记在创建那天。

## 隐私

统计数据全部留在本机；插件只注册**只读** HTTP 路由，不联网、不采集任何用户内容。
唯一写入的是自己的索引缓存 `<DSH_HOME>/workload-report/index-v*.json`（删掉即回到冷读重建，不影响任何 Harness 数据）。
导出的 HTML 报告是否包含会话标题由你决定（`anonymize=1` 可隐藏）。

## 开发

| 命令 | 作用 |
| --- | --- |
| `pnpm add -D esbuild puppeteer-core` | 安装构建与 E2E 依赖（也可用 `ESBUILD_PATH` / `WL_PUPPETEER_DIR` 指向已有安装） |
| `node build.mjs` | 用 esbuild 把 `src/client/` 打成 `lib/client.js`（ModuleLoader 工厂格式） |
| `node test/verify.mjs` | 离线验证 124 项：聚合口径、时区、时刻分摊守恒、全部档起点、日历数据源、HTML 转义、token 两种形状、冷读兜底、inject 声明、宿主路由 |
| `./test/e2e-boot.sh 3299` | 起一个**隔离实例**（独立 DSH_HOME + 端口，复制真实投影数据），不影响正在用的 GUI |
| `EMDASH_TOKEN=… node scripts/publish-emdash.mjs --site https://vizwise.cn` | 把 `docs/blog.md` 发布到 EmDash 博客（Markdown → Portable Text，含图片上传与发布） |
| `node test/e2e-ui.mjs` | 真实浏览器 E2E 61 项：日历/柱状图切换、并排几何校验、周几条、环形图切换、明细折叠、导出报告 |

CI 会跑 `build.mjs` + `verify.mjs`，并校验入库的 `lib/client.js` 与源码一致。

文章：[介绍这个插件的博客文章](./docs/blog.md)（[English README](./README.en.md)）

## 兼容性

- DSH `0.2.x`，**含 `alpha` 预发布版**（开发与验证基于 `@deepseek-ai/dsh@0.2.1-alpha.2`）：
  插件只依赖官方接口（`sessionProjections` / `sessionProjectionCache` / `sessionQuery`）与 Node 内置模块，不碰内部文件格式，
  因此能跟着新版本走——**保持对最新 alpha 的兼容是本项目的目标之一**，遇到不兼容会在 issue/CHANGELOG 里跟进。
- 首次启动会对投影检查点未命中的历史会话做一次冷读（本机实测约 2 分钟，并发 8），期间接口返回**逐步填充**的数据并带 `indexing: true`；结果落盘后重启即复用。
- 极早期的 **v0 格式会话**可能无法被当前 Harness 迁移/读取，这类会话不计入统计，界面会写明数量。

## License

[MIT](./LICENSE)

---

## 作者

<table>
<tr>
<td width="40" valign="middle"><img src="https://avatars.githubusercontent.com/u/49810568?v=4" width="32" height="32" alt="XILEJUN" style="border-radius:50%"></td>
<td valign="middle">

**[XILEJUN](https://github.com/tableau-China)** · TimeMirror 作者 · [博客文章](./docs/blog.md) · [English README](./README.en.md)

</td>
</tr>
</table>

## License

[MIT](./LICENSE)
