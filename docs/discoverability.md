# 可发现性 / 分发手册（Discoverability）

> 目标：让**更多国家、更多语言**的 DSH 用户在搜「DeepSeek Harness 插件 / Token 用量 / 工作量报告」时找到这个项目。
> 本文只讨论「被搜到、被看到、被点开」；产品质量与口径另见 [metrics.md](./metrics.md)。
> 最后更新：2026-11-07（对应 v2.5.0，8 语言版本）。

## 0. 结论先行（按投入产出排序）

| 优先级 | 动作 | 谁来做 | 预期效果 | 状态 |
| --- | --- | --- | --- | --- |
| **P0** | `git push origin main`（当前远端落后 12 个提交，还停在 v1.0.5） | 需你确认 | GitHub 首页/搜索内容变成 2.5.0 | ⏳ 待确认 |
| **P0** | npm 发布 2.5.0（npm 首页 README 会变成英文，见 §4.2） | 需你确认（2FA） | npm 搜索 + `dsh plugin add` 首页内容更新，8 语言可被发现 | ⏳ 待确认 |
| **P0** | 向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提 1 个 YAML 文件的 PR | 需你确认 | 其 23.3k★ 列表 + dsh-market / dshmarket.com / dsh-plugin.org / dsh-get / Discover 索引**自动收录** | 文件已备好 |
| **P0** | GitHub Release v2.5.0（多语言 release notes + 截图） | 需你确认 | Release 页/搜索可索引；为社区发布提供链接 | 待发布 |
| **P1** | 官方插件市场 / 创作者扶持计划（2026-11-05 官方宣布将建） | 关注公告 + 申报 | 官方流量推荐 | 等待开放 |
| **P1** | 自建 format-1 market index（`docs/distribution/marketplace-index.json`） | 需你确认部署位置 | 用户可在 **Plugins → Discover → Index sources** 添加，直接看到本插件 | 文件已备好 |
| **P1** | 博客英文版 + 6 语言摘要（`vizwise.cn`），加 hreflang 与互链 | 需你确认发布 | Google/Bing 长尾词入口 | 待写/待发 |
| **P1** | 社区发布（Show HN / Reddit / X / dev.to / 掘金 / V2EX / 知乎 / 小红书 / 少数派） | 需你账号 | 首波 star 与反向链接 | 文案已备好 |
| **P2** | dshbase.com / dsh-get / alternativeto / Product Hunt 收录 | 需你确认 | 长尾目录流量 | 待做 |
| **P2** | 每月复盘（star / 下载 / 搜索词 / 渠道来源） | 我或你 | 迭代关键词与渠道 | 未开始 |

## 1. 为什么「关键词」本身不等于被搜到

搜索可见性 = **被收录** × **排名** × **点击率**：

- **被收录**：npm registry、GitHub（topic/描述/README）、awesome 列表、第三方市场、搜索引擎。缺一条就少一个入口。
- **排名**：GitHub topic 与 dsh-find-plugin 等工具按 **star** 排序；npm 按关键词/下载/维护度；Google 按内容质量 + 外链。
- **点击率**：标题 + 一句话描述 + 截图 + 语言是否匹配。8 语言界面是天然优势，但需要**8 语言的落地页/市场文案**才吃到。

所以下面的动作 = 补收录 + 做排名（star/外链）+ 提点击率（多语言标题/截图）。

## 2. 渠道地图（2026-11-07 调研）

| 渠道 | 规模/机制 | 我们当前状态 | 一句话动作 |
| --- | --- | --- | --- |
| **npm 搜索 / `dsh plugin add`** | npm 搜索按 name/description/keywords；插件管理器 `inspect` 读 registry | 最新 2.4.1，README 竟是**中文版**（原因见 §4.2），关键词较全但缺国际化词 | 发布 2.5.0 + 新 keywords/description（已改好） |
| **GitHub 搜索 + topic** | `dsh-plugin` topic 有 **28,199** 个公开仓库；社区工具按 star 排序 | 已有 topic（`dsh-plugin`、`deepseek-harness`、`dsh`…）、0★/0 fork；**远端 main 还停在 v1.0.5** | push + Release + 攒首批 star |
| **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin)** | 23,346★ 的精选列表；**一个插件一个 YAML**（`data/plugins/<owner>__<repo>.yml`）；合并后自动生成 README、发布 npm `dsh-plugin-catalog`、喂给 dsh-market / dshmarket.com / awesome-dsh-plugin.com / dsh-plugin.org / dsh-get / Discover 索引 | **未被收录** | 提 1 个 YAML PR（文件已备好） |
| **[dsh-market](https://github.com/dsh-market/dsh-market) / dshmarket** | 11k★；插件页内市场，4200+ 插件；数据来自 awesome-dsh-plugin registry；按 star/新收录排序 | 未收录（等 awesome PR 合并后自动出现） | 无需单独 PR（其 README 明确说去 awesome 仓库提） |
| **[dsh-plugin.org](https://dsh-plugin.org)** | 收录 21,711 个标注 `dsh-plugin` topic 的仓库，人工核验；435k 累计 star | topic 已具备 → 大概率已被自动抓取；需去站点确认/补中文描述 | 搜一下自己，确认/认领条目 |
| **dsh-find-plugin** | 18k 月下载；在对话里按 GitHub `dsh-plugin` topic **按 star 排序**推荐 | star 为 0 → 排在 28k 仓库末尾 | 同上：star 是硬通货 |
| **[DSH 官方插件市场](https://www.deepseek.com/en/harness/)** | 官方 2026-11-05 宣布将建市场 + 创作者扶持（Token 激励、技术交流、流量推荐）；官方提问站为全球公开预览 | 未申报（入口未开放） | 关注公告，用 `docs/distribution/marketplace-index.json` 的元数据申报 |
| **自定义 market index（format-1）** | DSH 0.2.1+：Plugins → Discover → Index sources 可加任意 JSON 索引（15s 超时，建议走 npm/CDN） | 可自制一个只含本插件的索引，用户添加后直接可见 | 部署 `marketplace-index.json`（需你选位置：vizwise.cn 或 jsDelivr/npm） |
| **博客 vizwise.cn** | 现有中文文章（2026-10）；首页被 GitHub `homepage` 引用 | 只有中文、内容停留在 2.4 之前 | 写英文版 + 8 语言摘要，标题覆盖长尾词 |
| **开发者社区** | HN、Reddit（r/LocalLLaMA、r/DeepSeek）、X、dev.to；中文掘金/V2EX/知乎/小红书/少数派/Bilibili | 未发布 | 用 `docs/distribution/community-posts.md` 的草稿，按节奏发 |

> 官方表态：DSH 要求社区插件打 `dsh-plugin` topic 方便发现（我们已打）；官方不运营插件 registry，这正是 community registry（awesome-dsh-plugin）成为事实入口的原因。

## 3. 关键词矩阵（8 语言）

定位原则：**避开「token usage / 费用面板」红海**（该品类已有多个 100+★ 插件），主打差异化词
**「workload / effort report + 客户可直接看的快照（PNG 规划中）+ 8 语言 + 多设备」**，同时覆盖基础词
（DeepSeek Harness / DSH plugin / token usage）保证不漏需求。

| 语言 | 主关键词（title/描述/README H1） | 长尾（FAQ/博客标题/帖子） |
| --- | --- | --- |
| **English** | DeepSeek Harness plugin, DSH plugin, token usage dashboard, AI coding workload report | how to see DeepSeek Harness token usage, track AI coding time by project, client-ready AI usage report, export AI usage report as HTML, AI coding productivity report, multi-device token usage |
| **中文** | DeepSeek Harness 插件, DSH 插件, Token 用量统计, 工作量报告, AI 编程效率 | 怎么看 DeepSeek Harness 总 Token 用量, AI 编程时间花在哪, 给客户的 AI 用量报告, 导出 HTML 工作量报告, 多台电脑用量合并, DSH 插件推荐 |
| **日本語** | DeepSeek Harness プラグイン, DSH プラグイン, トークン使用量, ワークロードレポート, 作業時間の可視化 | DeepSeek Harness の使用量を確認する方法, AI コーディングの作業時間を記録, クライアントに送れる使用量レポート, 複数 PC の使用量をまとめる |
| **Deutsch** | DeepSeek Harness Plugin, DSH Plugin, Token-Nutzung, Workload-Report, Arbeitszeit-Auswertung | Token-Nutzung von DeepSeek Harness anzeigen, KI-Coding-Arbeitszeit pro Projekt, Kundenbericht zur KI-Nutzung, Nutzung mehrerer Geräte zusammenführen |
| **Français** | plugin DeepSeek Harness, plugin DSH, utilisation des tokens, rapport de charge de travail, temps de travail | voir l'utilisation des tokens de DeepSeek Harness, suivre le temps de coding IA par projet, rapport d'usage IA pour un client, fusionner l'usage de plusieurs machines |
| **Español** | plugin DeepSeek Harness, plugin DSH, uso de tokens, informe de carga de trabajo, tiempo de trabajo | ver el uso de tokens de DeepSeek Harness, registrar tiempo de coding con IA por proyecto, informe de uso de IA para clientes, unir uso de varios equipos |
| **Русский** | плагин DeepSeek Harness, плагин DSH, использование токенов, отчёт о нагрузке, рабочее время | посмотреть расход токенов DeepSeek Harness, учёт времени ИИ-кодинга по проектам, отчёт об использовании ИИ для клиента, объединить данные с нескольких машин |
| **Português (BR)** | plugin DeepSeek Harness, plugin DSH, uso de tokens, relatório de carga de trabalho, tempo de trabalho | ver o uso de tokens do DeepSeek Harness, registrar tempo de coding com IA por projeto, relatório de uso de IA para clientes, juntar uso de vários computadores |

**放置位置**（避免堆砌，全部放在有语义的位置）：

1. npm `description` + `keywords`（英文词为主；`keywords` 里可放少量本地化词，生态内已有先例）。
2. GitHub repo `description`（英中双语）+ topics（已含 `dsh-plugin` 等，可再补 `token-usage`、`ai-coding`、`productivity`）。
3. README 首段 / FAQ 标题（英文主 README + 各语言落地页已按上表嵌入）。
4. 市场/awesome 条目的一行描述（英文必须准确、可核对）。
5. 博客标题与 H2（长尾词）。
6. 社区帖子标题（每个渠道按自己的语气）。

## 4. 本仓库已备好的资产

| 文件 | 用途 |
| --- | --- |
| `docs/i18n/README.<lang>.md`（8 种） | 各语言搜索落地页：本地化标题/描述/关键词/截图/安装命令，从英文主 README 顶部语言导航进入 |
| `docs/i18n/marketplace.<lang>.json` | 各语言市场元数据（title/tagline/description/keywords），供官方市场/目录申报复用 |
| `docs/distribution/awesome-dsh-plugin.yml` | 向 awesome-dsh-plugin 提 PR 的**唯一**文件内容 |
| `docs/distribution/marketplace-index.json` | format-1 插件市场索引（部署后用户可在 Discover 添加） |
| `docs/distribution/community-posts.md` | Show HN / Reddit / X / dev.to / 掘金 / V2EX / 知乎 / 小红书 / 少数派 发布文案 |
| `assets/icon-180.png` | 市场/awesome 卡片图标（180×180 PNG） |

### 4.1 为什么根目录只能有 `README.md`

npm 发布时用 glob `{README,README.*}` 选一个 README 作为 **npm 首页正文**。实测 glob 返回
`['README.zh-CN.md', 'README.md']`，npm 取第一个 → **npm 页面显示中文**。修复方式：把所有非英文
README 移到 `docs/i18n/`，根目录只留 `README.md`（已做）。新增语言时**不要**在根目录放
`README.<lang>.md`，一律放 `docs/i18n/`。

自检（发布前跑）：

```bash
ls README*        # 期望只有 README.md（其它语言在 docs/i18n/）
```

### 4.2 npm 首页的 `readmeFilename` 也可直接查

发布后：`npm view dsh-workload-report readmeFilename` 应为 `README.md`。

## 5. 执行清单（按顺序，含需要确认的动作）

### P0（发布前必须做，需要你确认）

1. **提交并推送**当前工作区（本地已有 12+ 个提交未推，远端 main 仍是 v1.0.5）。
2. **发布 npm 2.5.0**：走 `docs/release.md` 的「CI 暂存 + OTP 批准」或本地 `npm publish --registry=https://registry.npmjs.org/ --otp=…`；发布前 `npm test && npm run check:release`（已全绿）。
3. **打 tag + GitHub Release v2.5.0**：release notes 用中英双语 + 六国语言一句话 + 截图（`test/.artifacts/i18n-de.png` 等）。
4. **提 awesome-dsh-plugin PR**：
   - 文件：`data/plugins/tableau-China__dsh-workload-report.yml`（内容 = `docs/distribution/awesome-dsh-plugin.yml`）。
   - 分类：`usage`；描述只有一句英文 + 一句中文，**必须与代码一致**（评审会核对）。
   - 合并后 `dsh-market`、`dshmarket.com`、`awesome-dsh-plugin.com`、`dsh-plugin.org`、`dsh-get`、Discover 索引通常一天内自动收录。

### P1（发布后 1–2 周）

5. **确认 dsh-plugin.org / dshbase.com / dsh-get 已自动收录**（我们已有 `dsh-plugin` topic）；若可认领，补 8 语言描述与截图。
6. **官方市场**：关注 DSH 官方公告与创作者扶持计划，开放即申报（元数据用 `marketplace-index.json` + `marketplace.<lang>.json`）。
7. **部署自定义 market index**（可选）：把 `docs/distribution/marketplace-index.json` 放到 `https://vizwise.cn/...` 或发布成 npm 包（jsDelivr 加速），README 里教用户 Discover → Index sources 添加。
8. **博客英文版 + 6 语言摘要**：标题用 §3 长尾词；页面加 `hreflang` 与语言互链；文内链回 GitHub/npm（带 UTM）。
9. **社区首发**（用 `community-posts.md`）：
   - 英文：Show HN（周二/周三 UTC 上午）、Reddit r/LocalLLaMA（先参与讨论再发）、X thread。
   - 中文：掘金长文（首发）、V2EX 分享、知乎回答「如何统计 DeepSeek Harness 用量」、小红书图文（截图 + 一句话卖点）、少数派投稿。
   - 每个渠道**只发一次**，不要多账号，不要请求 upvote/star。

### P2（持续）

10. dshbase.com、dsh-get、alternativeto、Product Hunt、Awesome-AI 类列表。
11. 每月复盘：GitHub Traffic（stars/views/referrers）、npm downloads（npm-stat）、博客 Search Console 查询词、市场安装数（若可读）。
12. 每次发版：更新 8 语言 marketplace 元数据与 README 截图 → 重跑 `npm test`。

## 6. 90 天节奏

| 周 | 重点 |
| --- | --- |
| W1 | push + npm 发布 + GitHub Release + awesome PR |
| W2 | 博客英文版 + 中文文更新（8 语言、安装方式、对比口径） |
| W3 | Show HN / Reddit / X 首发；收集反馈、修 bug |
| W4 | 掘金 / V2EX / 知乎 / 小红书 / 少数派；官方市场申报（若开放） |
| W5–6 | dshbase / dsh-get / alternativeto / Product Hunt；8 语言落地页互链与外链 |
| W7–8 | 官方市场跟进；根据搜索词数据调整 FAQ/标题；Issue 模板与 good-first-issue |
| W9–12 | 每月 Release 节奏（语义化版本 + 多语言 release notes）；数据复盘；准备下一个差异化功能 |

## 7. 度量与目标（示例，不是承诺）

| 指标 | 怎么读 | 第 1 个月目标（示例） |
| --- | --- | --- |
| GitHub stars | 仓库页 / API | 50+（决定 dsh-find-plugin 排名） |
| npm 周下载 | npm-stat / `npm view` | 100+ |
| 市场收录 | dsh-market 搜索本插件、awesome README | 全部主流目录可搜到 |
| 搜索词 | Google Search Console（博客）、GitHub 搜索 | 英文 5 + 中文 5 个长尾词有展现 |
| 社区来源 | UTM 链接 + GitHub Traffic referrers | 3 个以上社区带来点击 |

## 8. 红线（不要做）

- **不刷 star / 不买量 / 不多账号**：GitHub 风控与社区反作弊，短期收益、长期封禁。
- **描述不夸大**：awesome-dsh-plugin 会**核对代码**（写了 46 个工具就必须真有 46 个）；`dsh-market` 也以描述为声明。
- **不群发同一文案**：每个社区按语境重写（文案库已按渠道分开）。
- **不把非英文 README 放回根目录**（会重新污染 npm 首页，见 §4.1）。
- **发布前必须**：`npm test`、`npm run check:release`、`node test/e2e-i18n.mjs`（8 语言）。
- 对外发布/推送前按仓库规则**先确认**（本清单里所有 P0/P1 动作都需要你点头）。

## 9. 每次发版的 10 分钟检查

```bash
npm test && npm run check:release
node build.mjs && git diff --exit-code lib/client.js
node test/e2e-i18n.mjs            # 8 语言真实浏览器（需先起隔离实例）
npm view dsh-workload-report readmeFilename   # 发布后应为 README.md
```

再确认：README 截图是否最新、`docs/i18n/marketplace.<lang>.json` 的 description 是否仍准确、
awesome 条目描述是否仍与功能一致、CHANGELOG 是否有多语言一句话。

## 附：主要信息来源

- DSH 官方站（全球公开预览、插件生态）：https://www.deepseek.com/en/harness/
- awesome-dsh-plugin（事实上的社区 registry）：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- dsh-market（插件页内市场，11k★）：https://github.com/dsh-market/dsh-market
- dsh-plugin.org（topic 自动收录目录）：https://dsh-plugin.org
- DSH 插件索引格式（format 1）：`https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`
- 官方插件市场/创作者扶持公告（2026-11-05，中文报道）：https://www.163.com/dy/article/LB1VKOBM0514R9OJ.html
