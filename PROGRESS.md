# PROGRESS — dsh-workload-report

日期用 `YYYY-MM-DD`；只记录影响后续决策的事实。

## 2026-10-25 v2.0.3：画像卡改绿色 + 宽屏放宽 + 报告列宽自适应

### 事实

- **画像卡配色由蓝改绿**：用户反馈「背景色从蓝色改为绿色，区别于其他的，避免上下混淆」。
  根因是画像卡原先用品牌蓝（`--dsw-static-deepseek-500`）叠 6%，而它上下相邻的
  选中 chip / 主按钮 / 页签下划线 / 进度条**同样是品牌蓝**，同色系叠在一起滚到卡片边界时分不清。
  改成绿色相后色相独立。**不是只染底色** —— 底色、边框、首开提示面板、来源徽标、
  维度竖线、维度标题、建议项目符号共 7 处一并换色，否则会出现「绿底蓝字」的割裂感。
  全部走宿主 `--dsw-static-green-400/500/600` token，深浅色主题自动跟随。
- **看板面板宽度 1180 → 1600px**，与报告页宽（`.page` 的 `max-width: 1600px`）对齐。
  此前 1728 / 1920 视口下面板两侧各空 274 / 370px，而导出报告是 1600 宽，两种视图横向观感不一致。
- **报告列宽改为随视口伸缩**。经 Chrome headless 在 1240 / 1512 / 1728 / 1920 四视口实测，
  纠正了两个此前的错误假设：
  1. `.bars li` 的 `168px` 是**真正钉死**的那个 —— li 宽度 1143→1474px 变化时左列始终 168px。
     改 `clamp(140px, 22%, 280px)` 后 1240 下 251px、1600 页宽下 280px。
  2. `td.ws` 的 `max-width: 320px` **从未生效** —— `table-layout: auto` 下单元格 min-content
     会把列顶到 431~557px。改成 `clamp(240px, 32vw, 520px)` 才让上限真正有约束力。
     **教训**：在 auto 布局的表上，`max-width` 经常压不住内容；要验证宽度的实际生效值，
     必须用真实浏览器量 `getBoundingClientRect`，不能只看 CSS 里写了什么。
- **2.0.2 并入 2.0.3**：2.0.2 从未发布（远程 tag 只到 v2.0.1），其同步设置布局重做一并进 2.0.3。

### 验证

- 离线断言全通过；新增 2 条针对画像卡配色的断言
  （底色用 green-500、卡片内**不得**再出现 `deepseek-*`）。
- 报告列宽几何用真实浏览器实测，四视口均无横向滚动、名称列无意外截断。

### 遗留 / 待观察

- 本地 `node_modules/esbuild` 与 `puppeteer-core` 都是**空壳目录**（0 字节），
  构建需 `ESBUILD_PATH` 指向系统内其它 esbuild；浏览器测量改用 Chrome `--dump-dom` 注入脚本。
- profile 的插件依赖已由 `github:…#v2.0.1` 改为 `link:` 指向本工作区（备份在
  `~/.dsh/profiles/desktop/*.bak-before-local-link`），所以本地改动只需重建 + 重启即可生效。

## 2026-10-25 v2.0.4：状态紧凑化 + 设备身份显式化

### 事实

- 状态区一行：大徽标（26px）+ 结论 + 「上次推送 X · 上次拉取 Y」；设备数 / 上次测试移出（设备数移到第一部分）。
- 第一部分：本机显示名 ∥ 已登记设备 chips，下面常驻「设备身份按安装 ID 识别（xxxxxxxx…）」。
- **设备身份**：`machineIdOf()` = `<DSH_HOME>/.anonymous-user-id`，与名字无关；
  新增 `checkMachineIdentity()` 在保存时拦截 id 变化（换账户 / 换 DSH_HOME / 删文件），
  并给出「继续保存会把历史数据拆成两台设备」的说明。
- 端到端验证（local 传输）：改名 A→B 后磁盘上仍是同一个 `<uuid>.json`，`devices[0].id` 不变。
- **路径**：默认 `machines/{machineId}.json` 位于**同步存储根**（桶根 / 仓库根）下的 `machines/`，
  与 `dsh-workload-report` 目录无关；`prefixOf` 已抽到 `src/client/sync-state.js` 供宿主与客户端共用
  （`sync-service.js` 改为导入再转发，避免两处规则漂移）。
- 坑：客户端**不能** import `sync-service.js`（会带进 `node:fs/promises` 等），纯逻辑必须放 `sync-state.js`。
  另外 `export { x } from "..."` 只转发不产生局部绑定——宿主内部还要用就得先 `import`。

### 验证

- 离线断言 **1407 项**通过（新增设备身份 4 项、路径 5 项、布局顺序与只读路径等）。
- e2e：新增「设备行并列」「ID 保障说明」「大图标 ≥24px」「推送/拉取同一行」「状态区 ≤60px」
  「状态区不再重复设备数与上次测试」「高级选项直接显示且路径只读」「目录说明」全部通过。

## 2026-10-25 v2.0.3：设备同步 = 一个大弹窗

### 事实

- 用户要求：①「设备同步」页面改为完全弹窗并与同步设置合并；②「测试连接」放进弹窗内、配置后立即测试，
  并用「对号 / 圆圈」表达配置状态；③ 手动推送/拉取下一版改为同步频率（默认 6 小时，可选 12 小时 / 开机），
  **本版先预留位置**。
- 结构：`BySyncView` 页面删除 → 看板直接挂载 `SyncSettingsDialog`（`syncOpen` state）。
  弹窗顺序：本机显示名 → 存储方式 → 连接参数 → 凭据 → 连接与同步状态 → 同步频率 → 高级选项。
- 保存 `enabled=true` 时**自动 probe 一次**（真打 GitHub API 验证过：NO_CREDENTIALS → 填假 token → UNAUTHORIZED，
  图标 `failed`、状态区带错误码；手动「测试连接」按钮可重复触发）。
- 图标语义集中在 `sync-state.js` 的 `configureIconState()`（configured / failed / off / unchecked / none），
  文案键放 `ICON_TEXT_KEYS`（显式表，否则模板拼接会被 i18n 死键检查误判——这次踩过，`t(\`set.icon.${x}\`)` 导致 19 个键被判死键）。
- 同步频率：`FREQUENCY_OPTIONS` 里 `6h.ready=true`，`12h` / `boot` 置灰；下一版把 `ready` 打开 + 后台按该周期跑
  （宿主已有 `pushEveryMs` / `pullEveryMs`，接上即可）。

### 验证

- `node build.mjs && node test/verify.mjs`：**1407 项**通过。
- e2e：新增「点入口直接打开唯一大弹窗（无中间页面 / 无二层弹窗）」「测试连接在弹窗内」「状态图标 ✓/!/○」
  「同步频率默认 6 小时 + 12h/boot 置灰」「立即推送/拉取已迁入」等断言全绿；
  唯一失败仍是既有的「首页环形图上下居中」。

## 2026-10-25 v2.0.2：同步设置布局重做（用户反馈 5 条）

### 事实

- 用户提了 5 条布局问题，逐条落地（详见 CHANGELOG v2.0.2）：
  1. 「文件路径模板」默认值即可用 → 收进对话框底部**默认收起**的「高级选项」，排在主字段之后；
  2. 凭据与同步设置**合并进同一个对话框**（原两张卡两个保存按钮 → 一个按钮一次提交）；
  3. 表单**左右两列**（左「这台设备」/ 右「连接参数」），≤720px 单列；
  4. 「抹掉路径」**从界面移除**（含义难以理解、默认即关闭）；`sync.redactPaths` 配置项保留，YAML 可手改；
  5. 面板**右下角显示版本号**（`v2.0.2`）：挂在面板页脚栏 `.wl-foot` 一处，绝对定位不占布局。
- 版本号**不在客户端写死**：`index.js` 的 `PLUGIN_VERSION`（读 `package.json`）经 `/sync` 的 `version`
  字段下发；客户端取不到就不渲染（不会出现 `v0.0.0`）。
- 一次保存的顺序固定为「先设置、后凭据」：设置失败即停（凭据写了也连不上）；
  凭据连不上时用「设置已生效，但连接失败」文案，不误报整次失败。
- 清理死键：`set.redact` / `cred.save` / `cred.saving` / `cred.savedOk` / `cred.savedBad`（zh/en 同步删）。
- 评估过「版本号放到 AI 画像卡右下角（应用最后一页）」的第二个位置，**已撤回**：
  画像卡有 `aria-busy` / `data-phase`，多挂一个 `/sync` 请求会把 e2e 的「运行异常」和卡片结构断言搅乱，
  收益不抵风险。右下角只在面板外壳渲染一次（版本号是应用级信息，不混进功能卡）。

### 验证

- `node build.mjs && node test/verify.mjs`：**1360 项**离线断言通过（新增 56 项：对话框结构、两列、
  高级选项折叠与顺序、无「抹掉路径」、单保存按钮、先设置后凭据、版本号来源与挂载、zh/en 逐键对齐）。
- `node test/e2e-ui.mjs`（真实浏览器 + 隔离实例）：新增断言全绿——版本号 vX.Y.Z 落在面板右下角、
  两列并排同一行、路径模板默认隐藏 / 展开后位于表单末尾、无「抹掉路径」、单保存按钮、取消关闭对话框。
  唯一遗留失败 `首页「模型 Token 占比」环形图在卡内上下居中`（57/18px）**已用基线复测确认是改动前就存在的**
  （stash 掉全部客户端改动、只保留 e2e 脚本时同样失败，数值完全一致），属该实例数据下卡片高度 250px 时的布局问题，
  与本轮无关，另开工单处理。

### 第二轮布局调整（用户看过 COS 截图后）

- 用户反馈：「凭据被放进高级选项了？COS 截图里看不到」「左侧只有设备显示名、右侧一堆」「本机显示名应放到
  存储方式上方，一次设置适用所有方式」「连接参数左右显示、凭据不要折叠，每个一行」。
- 事实：**凭据从未被折叠进高级选项**；看不到是因为同步 `enabled=false` 时宿主拒绝写凭据
  （`POST /sync/credentials` 回 409），对话框先显示「开启同步并保存后出现」。
- 改动：本机显示名 → 全局行（chips 上方）；连接参数 → 左右两列、每字段一行，**单列时铺满**
  （`data-cols="1"`，避免 COS 下右半屏悬空）；凭据 → 展开的独立区块、每字段一行；高级选项只剩路径模板。
- 断言：离线 1357 项；e2e 新增「本机显示名在 chips 上方」「顺序」「凭据未折叠」「凭据每字段一行」
  「单列铺满」「路径模板在凭据之后」。

### 第三轮（用户看 GitHub 截图后）

- 反馈：「GitHub 的连接参数都在右侧，左侧空白」「仓库和数据库（分支）左右放在一行，更紧凑」
  「连接参数 = 左侧标题 + 右侧数据框」。
- 改动：新增统一行式字段 `.wl-field-row`（`grid-template-columns: max-content minmax(0,1fr)`，
  标题 `nowrap`、输入框吃满剩余宽度）；仓库类两列都放字段（仓库·服务地址 ∥ 分支）；
  凭据与本机显示名也用同一套。`styles.js` 里 `.wl-cred-field/.wl-cred-label/.wl-cred-source` 随之退场。
- 坑：`styles.js` 的 CSS 在模板字符串里，注释里写了反引号会把模板提前闭合导致构建失败——注释里不要用反引号。
- 断言：离线 1360 项；e2e 新增「左标题 + 右输入框同排不换行」「输入框吃满剩余宽度」
  「仓库类两列都有内容」「仓库/服务地址/分支 依次排布」。

### e2e 脚本顺带修的三处（都与 2.0.2 的浮层有关）

- **宿主登录遮罩**：新的 Web 宿主会弹「等待登录 / 登录已超时」（只有 ✕、点了不消失），它会挡住所有点击。
  脚本现在先按文字点按钮，再兜底移除该 `role="presentation"` 容器（**只移除不含插件浮层的**，
  插件自己的 `.wl-overlay` 带 `data-wl-overlay="true"` 不受影响）；「无遮罩层阻挡交互」断言也改为只排宿主遮罩。
- **「小时」字样断言**：原本扫 `document.body.innerText`，会把宿主侧边栏会话列表的时间戳（如「1小时」）算进去；
  改为只扫插件节点（`[class^="wl-"]`）。
- 保留 `data-wl-overlay="true"` 这个标记：它是宿主/插件浮层的唯一区分依据。


## 2026-10-25 发布 v2.0.0（GitHub）

### 事实

- 版本从 1.1.0 升到 **2.0.0**（语义化版本：新增多设备同步能力 + 一轮样式/布局与区间口径调整）。
- 1.1.0 的多设备同步工作并入 2.0.0，不再单独发版；CHANGELOG / README 中英 / docs 的版本引用已同步，
  版本对照表新增「1.1.0 → 未发布（并入 2.0.0）」一行。
- 发布路径与既有约定一致：push `main` + tag `v2.0.0`（CI 校验构建/断言；Release workflow 仅**暂存** npm，
  仍需本人在本地执行 `npm stage approve <id> --otp=<code>` 才真正上 npm）。
- 发布说明（GitHub Release）重点：多设备同步（四传输 + 界面配置 + 设备筛选）与样式调整
  （四页签等高、报告页宽自适应、设备同步入口移位、四档区间口径统一）。

### 验证

- `node build.mjs && node test/verify.mjs`：1254 项断言通过，`lib/client.js` 与源码一致（CI 同款校验）。

## 2026-10-25 报告页宽自适应 + 看板面板等高

### 实现

- **报告页宽**：`.page` 从固定 `max-width:1120px` 改为 `width:100%; max-width:1600px` +
  `padding: 40px clamp(20px, 2.4vw, 44px) 56px`，宽屏不再两侧大片空白，超宽屏有上限。
- **看板面板**：`.wl-panel` 固定 `height: 92vh`（保留 `max-height`），`.wl-body` 加
  `flex: 1 1 auto; min-height: 0`。四个页签内容长短不同，原先面板随内容收缩导致切页签跳高；
  固定后初始高度一致，超出部分在面板内滚动。

### 量测（隔离实例 127.0.0.1:3299，Puppeteer 几何）

- 面板高度（按日期 / 模型用量 / 按工作区 / 主要会话）：修复前 1728×1400 下
  `1290 / 1184 / 1290 / 1290`（模型用量矮 106px）；修复后四档全为 `1290`；
  1920×1440 下四档全为 `1327`，1512×982 下全为 `905`，1240×900 下全为 `830`。
- 报告页宽：修复前 1240 / 1512 / 1728 / 1920 / 2560 视口一律 1120；
  修复后为 1240 / 1512 / 1600 / 1600 / 1600，`bodyScrollWidth === innerWidth`（无横向滚动）。
- 截图：`.tmp/report-width-1512.png`、`.tmp/report-width-1728.png`、`.tmp/panel-model-tab-tall.png`。

### 验证

- `node build.mjs && node test/verify.mjs`：**1254 项断言，exit 0**（新增 5 项结构断言）。
- e2e 新增 3 项几何断言（四页签等高、报告页宽 1240 占满、宽屏上限 1600）。

## 2026-10-25 区间口径四档统一 + 「设备同步」入口移位

### 实现

- **区间口径**：此前只有「全部」从最早活跃日开始、近 7/30/90 天是写死窗口。现在四档同一套：
  终点恒为今天，起点 = `max(窗口起点, 最早活跃日)`；历史比窗口长时仍固定窗口，数据不足 N 天时
  与「全部」完全一致（例：只有 5 天数据时四档都显示 `10-21 ~ 10-25`、KPI 都是 `5/5`）。
  `aggregate()` 新增 `anchorToActivity`（默认 true）；显式 `from`/`to` 与画像固定窗口
  （`profileWindowQuery` 传 false）不截短，保证「汇总窗口至少 minDays 天」。
  快照缓存键 + SWR 重建路径都带该开关；报告顶部高亮改按请求档位（否则截短后会高亮错档）。
- **设备同步入口**：从顶部页签行（AI 用户画像右侧）移到设备筛选 chips 同一行右侧
  （`data-sync-entry`，蓝底主按钮）；该行不再因设备不足 2 台而整体消失（入口常驻，
  同步设置在这一页）。顶部页签行恢复 4 个主视图页签 + AI 用户画像。

### 量测（隔离实例 127.0.0.1:3299，用请求拦截伪造「全部设备 / 本机 / iMac」三台设备）

- 设置联动（另一个窗口完成的同步设置）：在隔离实例里把存储方式切到「共享目录」、填目录、
  打开「已开启」并保存 —— 保存前/后 `/snapshot` 请求数 `1 → 2`（`settingsSaved` → `onChanged`），
  同步页从关闭态切到 `data-enabled="true"`，`enabledNow=true`，无错误提示。
- 设备行：`chips=[全部设备,本机,iMac]`，入口 `text=设备同步`、`entryInChipRow=true`、
  `sameRow=true`、`entryRightOfChips=true`（Puppeteer 几何断言）；顶部页签 `tabs` 不含设备同步。
- 点击入口：`data-active=true`、`.wl-sync` 渲染、无页签处于选中态（入口不占页签位）。
- 同一实例真实数据只有 5 天：近 7 / 30 / 90 天与「全部」四档 subtitle 都是 `2026-10-21 ~ 2026-10-25`，
  `kpi.activeDays` 都是 `5 / 5`。
- 截图：`.tmp/device-entry-row.png`、`.tmp/device-entry-opened.png`。

### 验证

- `node build.mjs && node test/verify.mjs`：**1247 项断言，exit 0**；新增区间/入口/路由层断言。
- e2e 校正 3 条与 v1.0.2 行为或测试数据不符的旧断言（明细默认展开、周几 tooltip 取有活动的周几、
  「全部」档起点与日历首格对齐）；其余失败项为隔离实例数据/环境的既有差异。

## 2026-10-20 画像卡右列 + 首开提示 + 30 天窗口

### 实现

- 主要会话页改为 `wl-session-layout` grid：会话表左约 2fr、画像卡右约 1fr；画像卡顶部对齐、
  保持特别底色；`<=1080px` 单列堆叠。布局参数集中在 `SESSION_LAYOUT`，组件 / 样式 / 测试同源。
- 首开提示面板（三行：只发近 N 天聚合统计 / provider+model 或宿主默认 / 点击才计费）+ 主按钮；
  probe 零模型调用，生成后提示面板隐藏、结果态右上「重新生成」。
- `aiProfile.minDays` 默认 30；`/profile` 先把 `days` 抬到下限，`all` / `from` / `to` 压小窗口时再取一次；
  响应新增 `summaryDays`，卡片标注「基于近 N 天汇总」。
- `AI_PROFILE_DEFAULTS.enabled` 改为 `true`；显式 `false` 仍隐藏入口、零模型调用。

### 量测（真实浏览器，隔离实例 127.0.0.1:3299）

- 宽屏 1560：会话表 `left=210, right=961, width=751`；画像卡 `left=975, right=1350, width=375`；
  两者 `top=439`，画像卡左边界 > 会话表右边界，宽度比 2.00:1，列间距 14px。
- 窄屏 1000：容器宽 898；会话表 `51–949`，画像卡 `51–949` 且 `top=2123 > 会话 bottom=2109`（上下堆叠）。
- 提示面板：三行文案 + Generate profile；结果态提示消失，显示「Based on the last 30 days」+ Regenerate。
- 卡片特别底色 computed `color(srgb 0.955 0.968 0.994)`，普通卡片 `rgb(255,255,255)`。
- 截图：`.tmp/shots/profile-layout-notice.png`、`profile-layout-result.png`、`profile-layout-narrow.png`；
  原始几何 JSON：`.tmp/shots/profile-layout-measure.json`。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**996 项断言，exit 0**（942 → 996）。
- spy：首开 / probe 后 `llm.prepareCall=0`，点击生成后 `=1`；`days=7` 时 payload `range.days=30`，
  `minDays=45` 时 `=45`。


## 2026-10-20 画像卡布局 + 截断抢救（v0.7.1）

### 事实

- 「用户画像」卡从「按日期」页移到「主要会话」页，紧随会话表；标题改「AI 用户画像」；
  底色在 `bg-layer-2` 上叠 6% 品牌色（`--dsw-static-deepseek-500`），深浅色都可见且有差异。
- 现场 `AI_NOT_STOPPED` 根因是旧版 `prepareCall` 固定传 `maxTokens: 1600`：长 JSON 被截断，
  `finish.kind=length`。现已移除 maxTokens，并在截断时先修复 JSON 括号再解析。
- `PROFILE_CACHE_VERSION` 3 → **4**；旧缓存自动失效重算。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**942 项断言，exit 0**（906 → 942）。
- 真实浏览器（隔离实例）量测深浅色下 `.wl-profile-card` 与普通 `.wl-card` 的 computed background，
  截图落在 `.tmp/shots/profile-light.png` / `profile-dark.png`。

## 2026-10-20 AI 画像质量提升（v0.7.0，数字举证 + 结构化渲染）

### 问题

画像已能真实生成（usage 约 479/73），但用户反馈「比较简单」：5 条泛泛特征 + 1 条建议。
根因：① 白名单只有 14 个字段，没有时段 / 会话结构 / 趋势；② prompt 没要求结构化输出与数字举证；
③ `maxTokens` 900、`temperature` 0.4。

### 实现

- `src/ai-profile.js`：白名单 14 → **56 键**（时段 5 段活跃 / Token 占比、会话时长四桶、
  Token 四分量、均值、工作区 / 模型结构、waitShare、近 7 天 vs 前 7 天趋势）。
  全部从 `present(aggregate(...))` 的 snapshot / bySession 派生，不新增数据源。
  断言递归拒绝私有键 / 路径 / 换行 / 超长字符串；趋势环比允许负数与 `null`。
- 本地规则画像升级为同构结构：`headline + dimensions(4–6) + advice(2–3) + risk`，
  每条 insight 仍带数字；无时段数据时回退到高峰小时，不写「深夜 0%」。
- `src/profile-service.js`：prompt 重写（资深分析师 / 必须引用数字 / 禁止空泛建议 / 严格 JSON schema /
  可用键 + 单位）；`maxTokens 1600`、`temperature 0.35`、仍不指定 `reasoningEffort`；
  解析四路径；`diagnostic.excerpt`（解析失败原始输出前 300 字）；`costHint`；缓存版本 2 → 3。
- 前端：新增 `src/profile-view.js`（AI / 本地 / 旧 traits 同构归一化 + 长度兜底）；
  `ProfileCard` 改为 headline 大字 + 维度（结论 / 灰色证据）+ 风险条 + 建议（why），保留徽标 / usage / 重生成。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**906 项断言，exit 0**（732 → 906）。
- 截图：`.tmp/shots/profile-ai-light.png`、`profile-ai-dark.png`、`profile-local-light.png`
  （真实 STYLES + profileSections/localProfile 同构 DOM；headline 1 / 维度 5 / 证据 5 / 建议 2 / risk 1）。
- 运行中的 DSH（127.0.0.1:3080）能 probe 到 magpie + workbuddy-ai/deepseek-v4.1-flash，
  但它加载的是旧版代码（响应仍是 `traits`，缓存 v2），**未重启实例**；本轮生成链路以 verify 的 llm 桩为准
  （usage 12/34，mock），真实模型的 headline / dimensions 需重载插件后再采一次。

## 2026-10-20 AI 画像诊断增强（保留真实错误 + 路由可见）

### 问题

现场：`aiProfile.enabled=true` 后 `/profile` 返回 `code:AI_FAILED`、usage 全 0、model:null，
但看不出失败阶段；宿主 `agentDefaultModel` 被用户覆盖为 `magpie / workbuddy-ai/default-model`（自定义网关），
而 `llm.listProviders()` 里可能没有 `magpie`。

### 实现

- `src/profile-service.js`：调用链按 `route → precheck → prepareCall → stream → finish → parse` 打 `stage`；
  `trace` 记录 `route / precheck`，异常经 `tagStage()` 带回；失败响应带
  `diagnostic.error.{code,message,stage}`（底层 code 保留）与 `route / precheck`。
- 脱敏 `sanitizeDiagnosticMessage()`：敏感词 / 明文密钥 → `[redacted]`，≤300 字符；同时用于 `/health.lastError`。
- `/profile?provider=&model=` 调试覆盖：仅 `enabled=true` 生效，不写配置、不读写缓存；`origin=query`。
- `/health.diagnostics.aiProfile`：`{ enabled, lastCode, lastStage, lastError, lastAt, route }`。
- 默认行为不变：失败仍 local（3–5 条 + 1 条建议）；`PROFILE_CACHE_VERSION` 1 → 2。
- 文档：`docs/ai-profile.md` 诊断章节、README 中英、CHANGELOG。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**731 项断言，exit 0**（680 → 731）。
- 覆盖：底层 `PROVIDER_NOT_FOUND` 保留、`stage=prepareCall`、脱敏 / 截断、provider/model 覆盖传到
  `prepareCall` 且不写缓存、现场场景（默认 provider 不在 listProviders）、`/health.aiProfile` 字段固定。
- 真实已登录 llm 环境**仍未实测**（隔离工作区只有 mock）；本次只保证诊断字段与降级链路。

## 2026-10-20 AI 用户画像（可选 / 默认关闭）

### 目标

给当前用户生成一张「特征画像」卡片：按需点击、只发聚合统计、默认关闭、失败降级、结果缓存。

### 实现

- 纯函数层 `src/ai-profile.js`：白名单 payload（14 键）、稳定 JSON + SHA-256 前 16 位指纹、
  本地规则画像（中英各一套，3–5 条 + 1 条建议，≤40 字符）、严格 JSON 解析。
- 编排层 `src/profile-service.js`：`ctx.get("llm")` 可选获取（**不写进 inject**）；
  路由优先 `aiProfile.provider/model`，否则 `agentDefaultModel.currentSelection()`；
  调用前 `listProviders / listModels` 预检；`prepareCall → stream` 累积 text-delta / usage / finish；
  `AbortSignal.timeout` + 普通 timer 双保险；失败一律 local + code。
- 路由 `GET /profile`：`probe=1` 只查状态；`force=1` 跳过缓存；默认关闭直接返回 `enabled:false`，
  零 `ctx.get` / 零模型调用。该路由不持有快照 / 报告锁。
- 缓存：与索引同目录 `<索引基名>-ai-<lang>-<指纹>.json`，`.tmp` → `rename`；TTL `cacheTtlMs`。
- 前端 `ProfileCard`：复用 `CardHead`，probe 隐藏入口；生成中禁用；来源徽标「AI 生成 / 本地规则版」；
  未登录只给文案不跳转；usage + 生成时间小字。
- 文档：`docs/ai-profile.md`、README 中英、`docs/report-parity.md`（报告有意不展示）、
  `docs/ui-conventions.md`（卡片必须复用 CardHead）。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**680 项断言，exit 0**（595 → 680）。
- 真实已登录 llm 环境**未实测**：本次为隔离工作区，只有 mock llm；成功路径已用 mock 覆盖
  （usage 12/34、缓存命中第二次调用次数仍为 1、force=1 变为 2）。

## 2026-10-20 看板打开性能：打开零折叠 + 折叠三态 + 耗时指标

### 问题

用户实测：每次打开看板，「时刻分析」状态行都停在「正在计算中……」，感觉一直在算。
根因：`snapshot()` 每次都调用 `scheduleModelFold()`，打开面板会排队甚至启动 `readSession()` 读事件日志；
sync 末尾也会触发折叠（打开面板触发的重扫同样会读日志）。

### 量化（隔离实例，500 个会话；`node test/bench-open.mjs`）

| 场景 | 优化前 | 优化后 | 说明 |
| --- | --- | --- | --- |
| 冷缓存首开 | **448.9 ms** | **25.3 ms** | 聚合首次构建；Intl formatter 按时区缓存 |
| 热缓存再开 | 2.86 ms | 1.12 ms | 同参数快照缓存 TTL 5s → 15s；命中率 5/6 = 83.3% |
| 回填中打开（5 次均值） | 63.5 ms | 3.2 ms | 折叠不再由打开触发；首开 313 → 11.6 ms |
| 打开 5 次触发的读日志次数 | **159 次**（新增 1 会话，refreshMs=0） | **0 次** | 断言锁死 |

真实隔离实例（60 个真实会话副本）：冷开 78.5 → **13 ms**，热开 5.0 → **2–3 ms**；
首次预热折叠仍会读 60 份日志（本机 15.3s），但由定时器发起，打开面板不排队。

### 实现

- `index.js`：`snapshot()` 删除 `scheduleModelFold()`；sync 末尾不再触发折叠。
  触发源收敛到 `apply()` 的定时器：索引就绪后预热一次、12 分钟例行维护、60 秒空闲/转冷检查；
  活会话重折需「距上次事件 ≥ 10 分钟」或「事件增量 > 50」。
- 折叠三态：`modelFold.phase = first-fold | background | idle`；`failedRows` 不参与 phase。
- 指标：`/health` 与 `/snapshot.diagnostics` 暴露 `snapshotMs`、`snapshotCache.{hits,misses,hitRate,ttlMs}`、
  `foldRoundMs`、`foldSessionsRead`、`foldRounds`、`foldScheduled/foldWarmupAt`。
- 缓存：`snapshotCacheMs` 5000 → 15000；活会话事件 / 索引刷新 / 折叠完成立即失效。
- 失败重试：`modelRetryMs` 15 → 30 分钟；失败行只计入「Token 未计入」提示。
- 聚合：`dateKey / hourOf / zoneOffsetMinutes` 按时区缓存 `Intl.DateTimeFormat`（冷开的主要成本）。
- 前端：`hourTokensNote` 按 phase 渲染；background 为灰点小字；只在后台真在跑时 5s 轮询。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**595 项断言，exit 0**（567 → 595，新增 28 项）。
- 三态 DOM：E2E 拦截 snapshot，断言 `data-state=first-fold / background / idle` 与文案，截图
  `test/.artifacts/07-status-first-fold.png` / `08-status-background.png` / `09-status-idle.png`。

## 2026-10-17 发布 0.6.6：报告对齐 + README 重写 + 截图重拍

### 背景

- 0.6.5 已发布到 npm；报告对齐、文档与截图是后续改动，统一收进 **0.6.6**。
- 本轮只做本地提交与验证；**不 push、不发 npm、不打 tag**（由 Lead 执行）。

### 变更

- `package.json`：**0.6.5 → 0.6.6**；`files` 白名单由 `docs/metrics.md` 改为 **`docs`**，
  `docs/report-parity.md` / `docs/ui-conventions.md` 会进 npm 包。
- `CHANGELOG.md`：把「未发布」条目标为 **v0.6.6**，补发布小节（版本、files、README、截图、PROGRESS）。
- `README.md` / `README.zh-CN.md`：按当前真实功能重写，中英章节一一对应；覆盖安装与入口、
  数据来源与原则、8 张 KPI、时刻分析双口径、三层等待判定、配置项、`INDEX_VERSION = 7` 升级注意、
  文档索引与隐私；断言数更新为 **566**，不再保留「6 张 KPI / 533 断言」。
- 截图：用 `.tmp/readme-gen.mjs`（真实客户端组件 + 真实 `aggregate()` / `renderReport()`，无头 Chrome，
  2x DPR）重拍 4 张并覆盖 `assets/`。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**566 项断言，exit 0**。
- `npm pack --dry-run`：包内包含 `docs/report-parity.md`、`docs/ui-conventions.md`。
- 截图尺寸：dashboard **3120×2476**（2x 1560×1238）、report **2480×10476**（2x 1240×5238 fullPage）；
  新旧字节 / md5 见提交回报。
- README 中英章节数 / 键值一一对应（结构一致，非逐字直译）。

## 2026-10-17 报告对齐看板（并入 v0.6.6，修正本轮遗漏）

### 背景（用户的批评）

- 「导出 HTML 报告」`src/report-html.js` 仍是老版本：最近几轮只改了看板 `src/client/*`，
  报告没跟上（缺密度点后的新卡片头、KPI、日历、比例条、轮次第二口径等）。
- 根因不是技术，而是**流程**：之前只把「改看板」当完成，没有把报告列为同一提交的交付物。
  本轮先做差异审计，再把报告拉到一致，最后把「必须同步」写进测试与文档。

### 差异审计（看板 vs 报告）

| 区域 | 看板有 | 报告（修复前） | 处理 |
| --- | --- | --- | --- |
| KPI | 8 张含模型费用 / 最活跃模型；5 列跨列；净活跃 + 含等待用户 | 7 张、无最活跃模型；Token 用缩写；3 列 | 补齐 8 张 / 同栅格 / Token 完整整数 |
| 每日趋势 | 日历（默认）+ 柱状切换；周几累计条；峰值标签；命中区 tooltip | 只有柱；峰值不保证标注；无命中区 | 日历 + 柱状同时静态展示；补峰值/命中区 |
| 时刻分析 | Tokens 默认 + 轮次切换；密度点；三项图例；状态三态；峰值深蓝 | 有密度点/图例/深蓝，但无状态行、无轮次口径 | 状态行复用 `hourTokensNote`；轮次改第二张小图 |
| 模型用量 | treemap 铺满 + 小标题；按日趋势；筛选；明细/费用/链接 | 有 treemap/趋势/明细；小标题在标题下方 | 小标题归位；title 挂 rect；卡片头统一 |
| 表格比例条 | `MetricBarCell`（`barPercent`） | 纯数字 | 报告 `barCell()` 直接 import `barPercent` |
| 卡片说明 | 标题右侧 11px muted | 标题下方 12px | 全部改标题右侧，删除旧 `<p class="hint">` |
| 口径文案 | 净活跃/等待/未计入 N | 有 footer，但时刻状态行缺 running/idle | 状态行 + KPI + footer 三处对齐 |

有意不同：报告不渲染切换/排序/筛选按钮；每日两图同时展示；轮次用第二小图；工作区固定按时长；
模型固定 Token；主要会话前 12 行；固定中文。完整清单见 `docs/report-parity.md`。

### 实现

- `src/report-html.js`：新增 `cardHead()` / `barCell()` / `calendarHeatmap()` / `hourTurnsChart()`；
  KPI 8 张（含 `topModel`）、每日日历 + 柱状、时刻状态行（import `hourTokensNote`）、轮次小图、
  模型小标题与 rect title、表格比例条；所有时长继续走 `formatHours`。
- 报告仍是自包含 HTML：内联 CSS/SVG、无脚本、外链仅官方计费页。
- 新增 `docs/report-parity.md`：铁律 + 看板→报告逐项对照 + 有意差异 + 同步流程 + 结构断言表。
- `docs/ui-conventions.md`：抬头加「报告同步铁律」，新增第 7 节（组件对应表），检查清单加 3 条。
- `test/verify.mjs`：新增「报告结构对齐」块（密度点、Tokens 默认口径、轮次小图、状态三态、
  标题右侧 11px 说明、日历、峰值/命中区、比例条、模型小标题、KPI、净活跃/等待、自包含）。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**545 → 565 项断言，exit 0**（新增 20 项）。
- 隔离实例 `/report.html?theme=light|dark` 截图：`.tmp/shots/report-light.png` / `report-dark.png`；
  局部 `report-hour-light.png` / `report-hour-dark.png`。
- DOM 量测：`<script` = 0；外链仅 api-docs.deepseek.com / platform.kimi.com / platform.claude.com；
  13 个密度点；峰值柱 fill = `rgb(47, 75, 216)`；7 张卡片 hint 全部在标题右侧、11px、muted；
  时刻状态行 running / idle 均出现；无横向溢出。

### 机制（防止下次再漏）

1. 报告与看板在**同一提交**：任何 `src/client/*` UI 改动都要同步 `src/report-html.js`。
2. `docs/report-parity.md` 是唯一对照清单；状态列必须随改动更新。
3. `test/verify.mjs` 的结构断言是硬门槛：关键标记缺失即 exit 1。
4. `docs/ui-conventions.md` 检查清单第 7–9 条在每次 UI 改动后逐条过。

## 2026-10-17 卡片说明统一到标题右侧（CardHead.hint）

### 背景

- 「每日用量趋势」「时刻分析」的说明原先在标题下方（占一行、挤压图表高度）；「模型 Token 占比」的
  小标题也挂在标题下。用户要求统一放到标题右侧，尽可能简单。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| `CardHead.hint` 固定渲染在标题紧右侧（`.wl-card-head-hint`） | 11px / 第三级文字色 / `nowrap` + 省略号截断 + `title` 全文；禁止再在标题下方加 hint |
| 标题与 hint 为同一 flex 行、`align-items: baseline` | 同基线（实测差 0px）；中间剩余空间即与右上 chips 的弹性间距 |
| 文案只讲"看什么"，每条 ≤ 18 个汉字 | 口径细节留给 tooltip 与报告 footer；时刻卡 hint 随 Tokens / 轮次切换 |
| 骨架屏也走 `CardHead` | 占位与真实卡片的标题/说明位置一致，标题下不再出现 hint |

### 量测（无头 Chrome，zh-CN，1560×1000 / 1180×1000）

| 项 | 1560 | 1180 |
| --- | --- | --- |
| 基线差（h3 vs hint） | 0px | 0px |
| hint 左缘 − 标题左缘 | 86 / 104.4 / 60px | 86 / 104.4 / 60px |
| 字号 / 颜色 | 11px / `rgb(129,133,140)` | 同左 |
| 标题下方 hint 节点 | 0 | 0 |
| chips 换行 / 被挤压 | 否（hint→chips 间距 293.6 / 269.9px） | 否（252.5 / 228.8px） |

- 截图：`.tmp/shots/hint-1560.png`、`.tmp/shots/hint-1180.png`。
- 断言：**535 → 545**，连跑 2 次 exit 0。

## 2026-10-17 UI 一致性（chips / CardHead / tooltip / 状态右对齐）

### 背景

- 用户实测「每日用量趋势」悬停无提示、工作区切换不在右上、模型用量 chips 没有底色、
  时刻卡「Token 未计入」孤零零挂在图例下方，且各卡开关/图例/提示样式各写一套。
- 排查结论：日历格与柱的 `<title>` 在旧构建里确实存在（60/60、7/7），但可见柱命中面积小
  （0 值柱 1px）、日期轴/周标签 0 个 title、旧文案三行且缺 Token/周末；审计另发现模型 treemap /
  趋势图的 title 挂在 `<g>` 上（多数浏览器不弹）。修复为「title 直接挂在形状 + 每列全高命中区」。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 切换控件统一 `ChipGroup` / `Chip`（`src/client/chips.jsx`） | 五处共用；样式只在 `styles.js` 定义一次，禁止变体 class |
| 卡片头统一 `CardHead`（`src/client/card-head.jsx`） | 标题在左、控件右上；模型卡补回标题，卡片内不再重复页面标题 |
| 状态判据抽到 `src/client/hour-status.js` | 只读 `diagnostics`，可单测；组件不写死 running/idle |
| 状态只跟 `modelFold.running` | 排队中的 refold 不显示「正在计算中」，避免活会话水位让提示常驻 |
| 每日柱每列一根透明命中区 | 0 值/1px 柱可 hover；title 不挂 `<g>`，避免浏览器不弹 |

### 已完成

- tooltip：日历格 / 每日柱 / 命中区 / 周几轴 / Year-Week 标签；单行文案 + 周末后缀；模型 treemap、趋势图 title 下移到 rect/命中区。
- chips：顶部范围、每日、时刻、工作区、模型五处共用；工作区开关移到卡片右上；模型 chips 恢复底色与选中态。
- 时刻：legend 行 `space-between`，右侧状态三态；回填期间继续 5 秒轮询。
- 样式：唯一 class 102 → 94；`.wl-legend` 合并；一次性提示类收敛为 `.wl-status` / hint 修饰。
- 文档：`docs/ui-conventions.md`；README 本轮未改，随后在 0.6.6 统一更新。

### 量测（无头 Chrome 1560×1000，zh-CN，7 天区间）

| 项 | 结果 |
| --- | --- |
| 日历格 title | 60/60 直接子 `<title>`；周几轴 7/7；周标签 3/3；周几条 7/7 |
| 每日柱 title | 可见柱 7/7 + 命中区 7/7；日期轴 7/7 |
| 样例 | `2026-08-19 · 活跃 46.2 m · Token 83.01 M`；`2026-09-05 · 活跃 57.8 m · Token 109 M · 周末`；`2026-10-12 · 活跃 20.4 m · Token 10.88 M` |
| chips 盒模型 | 四组均 24px 高 / 999px 圆角 / 0 10px 内边距 / 12px 字；右上间距均 17px（右）、15px（上） |
| chips 颜色 | 选中 `rgb(65,118,230)` + 白字；未选中 `color(srgb .9478 .9624 .9931)` 浅蓝底 + 1px 边框 |
| 状态 running | 「正在计算中……」右缘 826.6 = legend 右缘 826.6；`data-state=running` |
| 状态 idle | 「Token 未计入 5 个会话」右缘 826.6 = legend 右缘 826.6；`data-state=idle` |
| 状态 idle N=0 | 节点数 0（整条不渲染） |

### 测试

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**533 项断言，exit 0**。
- 截图：`.tmp/shots/ui-daily-calendar.png`、`ui-daily-bars.png`、`ui-chips-hour-workspace.png`、
  `ui-chips-model.png`、`ui-hour-status-running.png`、`ui-hour-status-idle.png`。
## 2026-10-17 时刻分析 Tokens 口径 + 人类消息密度点（v0.6.5）

> 版本号统一：此前的等待剔除、formatHours / 比例条 / 删日历提示等条目内容并入本版，
> package.json、README、CHANGELOG、docs 一律以 **0.6.5** 为准。

### 背景

- 时刻分析原先的柱高是「以轮次开始时刻计的净活跃时长」，用户要的是设计稿里的 **Token 产出**口径与顶部**人类消息密度**点。
- Token 只在投影里有总量，没有「按小时」分布；需要从事件日志的 `assistant/message` usage 按消息时间落桶，并严格守恒到官方总量。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 小时 Token = 每条 `assistant/message` 的 usage（输入 + 输出 + 缓存读 + 缓存写）按**消息时间**归 UTC 桶 | 与 `row.tokens` 同一定义；不按轮次起点（一条跨小时消息会落在它自己的小时） |
| `row.hourTokens` / `row.hourHumanMsgs` 随索引持久化，聚合用 `localHoursFromUtc` 平移 | 折叠在后台、不带查询时区；UTC 是唯一可持久化的稳定表示 |
| 守恒 `Σ hourTokens === row.tokensTotal`，整数目标用最大余数法 | 官方 Token 与事件累计不等（未闭合步 / crash 补写）时按比例回正，且不产生小数 Token |
| 读不出事件 → 无 `hourTokens`，`hourTokensSource.missing` 计数 | 不伪造分布；卡片与报告写「Token 未计入 N 个会话」，总量仍含该会话 |
| `byHour.tokensTotal` 取自 hourTokens，`starts` 留给「轮次」measure | 同一份 byHour 支持 Tokens / 轮次切换；旧 `tokens`（会话开始小时）字段保留兼容 |
| `INDEX_VERSION` 6 → 7 | v6 行没有新字段，不换代会把时间图 Token 显示成全 0 且无法补折 |
| 圆点几何抽到 `src/hour-scale.js` | 看板 DOM 与报告 SVG 共用半径 / 上沿 / 顶部空间；纯函数可直接断言 |

### 已完成

- `src/models.js`：`foldSessionHours` 新增 `hourTokens` / `hourHumanMsgs` / `hourTokensSource`，`sessionTokens` 作为守恒目标；
  `foldSessionModels` 透传并返回。
- `src/hour-scale.js`（新）：measure 取值 / 最大值 / 柱高百分比、`r = 3.4 + ratio×5.0`、上沿 14px、
  顶部预留 64px、`scaleTokenBuckets`（最大余数法）。
- `src/aggregate.js`：`distributeEventTokens()` 落小时 Token；`byHour` 增加 `tokensTotal` / `humanMsgs`；
  新增 `hourTokensSource { events, scaled, missing }`。
- `index.js`：`MODEL_ROW_FIELDS` 搬运新字段；折叠传 `sessionTokens: tokensTotal(row.tokens)`；
  `INDEX_VERSION` 6 → 7；`/snapshot.diagnostics` 带 `hourTokensSource`。
- 客户端：`HourChart` 默认 Tokens / 可切轮次、只在最大柱标值、顶部密度点、图例三项；卡片删除 `hour.sub` 小标题；
  `hour.tip` 改为一行 `小时 · Token · 轮次 · 人类消息`；缺失会话在卡片底部标注。
- 报告：`hourChart()` 改 Tokens + 密度点 + 峰值数值 + 同款图例 + 未计入提示。
- 文档：README（中英）断言数 / 口径、`docs/metrics.md` 的时刻 Token 与人类消息定义；版本统一 0.6.5。

### 视觉修正（2026-10-17）

> 用户看 `.tmp/shots/hour-card.png` 指出两处与设计稿不一致：峰值柱/「峰值」图例用了 amber（与人类消息点撞色）、
> 柱偏矮且顶部留白过多。复核结论：截图不是缩放，1560×1000 下卡片就是 637×314。

| 决策 | 取舍 |
| --- | --- |
| 峰值柱与「峰值」图例改用 `--dsw-static-blue-600`（`#2563eb`） | 宿主 token；比普通柱的 deepseek-400→600 更深，且与 amber 点（`#f59e0b`）明显分离 |
| 报告色板新增 `peak: "#2f4bd8"` | 报告是自包含 HTML，用不了宿主 token；取预览稿深蓝，人类消息点仍用 `weekend` amber |
| `.wl-hour-card` 纵向 flex，图表区 `flex:1 1 auto` + `min-height:240px` | 让柱区吃掉 header/legend 之外的高度；不再写死 196px |
| 柱形区 `top:64px` / `bottom:16px` | 顶部 64px 固定给密度点与峰值数值，柱高随卡片伸缩 |
| 同排 `.wl-pie-card` 拉伸时 `pie-wrap` 弹性居中 | 时刻卡变高后右侧饼图不留在顶部、下方留大片空白 |

- 量测（真实客户端 + 宿主 token + 无头 Chrome，1560×1000 / 1180×900）：
  卡片 637×354 / 596×354；图表区 240px（67.9%）；峰值柱 160px（45.3%）；顶部预留 64px；
  卡片顶到柱顶 122px（含 58px 标题区）；峰值柱 `#2563eb`、人类消息点 `#f59e0b`。
- 截图：`.tmp/shots/hour-card.png`、`hour-card-1180.png`、`hour-card-dark.png`、`hour-row-1560.png`。

### 测试

- 离线断言 **415 → 503**（连跑 2 次 exit 0）：跨小时 Token 归桶、`Σ hourTokens === tokensTotal`、缩放整数守恒、
  humanMsgs 计数与时区平移、measure 切换取数、未回填 / 读不出不计入并标注、圆点几何与图例文案、
  报告同步、宿主 `/snapshot.diagnostics.hourTokensSource`；新增峰值柱蓝 / 人类消息点 amber 的 token 分离断言。
- 同构量测（无头 Chrome 1560×1000，真实客户端组件 + 真实快照）：默认 Tokens、chips 切换生效、
  最大圆直径 16.8px 且上沿留白 14px、图例无括号解释、卡片无小标题、缺失提示可见。

## 2026-10-17 小时统一 1 位小数 / 日期明细比例条（v0.6.5 · 并入）

### 背景

- 页面里小时出现两种精度（`1.63 h` 与 `1.6 h`），来源是 `formatDuration`（小时 2 位）与 `formatKpiDuration`（1 位）各写一套。
- 「按日期明细」只有纯数字，缺少「主要会话」表里的浅色比例条。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| `formatHours(ms)` 以 1 小时为分钟 / 小时分界 | 既有报告断言「20 m」与短时长可读性优先；≥1h 固定 1 位小数（1.63 → 1.6），<1min 用秒 |
| 比例条拆成 `MetricBarCell` + `bar-width.js` | 两表共用一份宽度逻辑与 `.wl-bar-cell` 样式；纯函数可在离线断言里直接量测 |
| 日期明细用 Token 合计列替代步骤列 | 保持 8 列、窄屏不溢出；步骤仍在主要会话 / 工作区表 |
| 删除 `cal.hint` 键与渲染 | 需求明确；`chart.hint` 仍用于骨架屏，不留下空标签 |

### 已完成

- `src/format.js`：新增 `formatHours`；删除 `formatDuration` / `formatKpiDuration` 两套旧精度。
- `src/client/index.jsx` / `src/report-html.js`：所有时长展示改走 `formatHours`，无各自的 `/ 3600000` 或 `toFixed`。
- `src/client/bar-cell.jsx` / `bar-width.js`：新增通用比例条；主要会话四列 + 日期明细四列（对话 / 轮次 / 活跃 / Token）共用。
- `src/client/locales.js` / `index.jsx`：删除「全历史；右侧＝各周几累计」；每日用量趋势卡片头不再渲染提示段落。
- 文档：README（中英）/ release 断言数 384 → 415；package 版本随后统一为 0.6.5。

### 测试

- 离线断言 384 → 415（连跑 2 次 exit 0）：格式化边界与三处一致、两表共用组件、bar 宽度比例、删除提示键。


## 2026-10-17 等待用户剔除 / 净活跃口径（v0.6.5 · 并入）

### 背景

- 用户实测：用 `ask_user_question` 等回答 3 小时，这 3 小时被整段算成「活跃时长」（`toolMs` 是 call→result 墙钟），严重虚高。
- 目标：交互等待从活跃中剔除，但编译/跑批这类**没有人类输入**的长任务仍照常算工作。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 等待判定 = 单次区间 ≥ `waitMinMs` 且（白名单 或 夹着 `user/message`） | 白名单保证交互工具无 human 消息也能识别；human 夹层覆盖任意工具；统一阈值避免 30s 确认被切碎（断言 ④） |
| 长任务豁免 = 不满足上面任一信号就照常算工作 | 编译/跑批没有 user/message，不会被误伤（断言 ③） |
| 等待在**行级**剔除，而不是聚合后再减 | `byDay/byWorkspace/byHour/calendar/bySession` 的 `activeMs` 天然是净活跃；totals 另留官方 `activeMs` + `netActiveMs`，`llmMs/toolMs` 为净口径 |
| 小时桶缩放目标改为「官方 activeMs − waitMs」 | 保持 `sum(hours) === 净活跃`；事件桶与官方口径不等仍走 `events-scaled` |
| `INDEX_VERSION` 5 → 6 | v5 的 `hours` 把等待算成工作，语义作废；不换代会把旧桶当净活跃分布复用 |
| `excludeWait:false` 作为回归开关 | 置 false 时完全不判定等待，`waitMs=0`，小时桶与 0.6.0 逐桶一致 |

### 已完成

- `src/models.js`：新增 `DEFAULT_WAIT_TOOLS` / `DEFAULT_WAIT_MIN_MS`；`foldSessionHours` 在同一趟 events 里识别等待
  （白名单 / user/message 夹层 / 阈值），`waitMs` 整段剔除且不进小时桶；`foldSessionModels` 透传并返回 `waitMs`。
- `src/aggregate.js`：新增 `netActiveMs(row)`；桶的 `activeMs` 统一为净活跃并累计 `waitMs`；totals 保留官方
  `activeMs` 并新增 `waitMs` / `netActiveMs`；旧法摊销与事件桶回正都改用净活跃；占比/均值/每活跃小时输出改用净活跃。
- `index.js`：DEFAULTS 增加 `excludeWait` / `waitTools` / `waitMinMs`；折叠传参并写回 `row.waitMs`；
  `MODEL_ROW_FIELDS` 增加 `waitMs`；`INDEX_VERSION` 5 → 6（注释写明原因）。
- 客户端：KPI 活跃显示净活跃，副标题「含等待用户 {wait}」；工作区 foot 单列等待（zh/en 新键）。
- 报告：KPI / 每日柱 / 时刻图用净活跃，footer 写明净活跃 + 等待 = 官方 activeMs。
- 文档：`docs/metrics.md` 新增「等待用户（0.6.5）」章节；README（中英）/ release 断言数 326 → 384。

### 测试

- 离线断言 326 → 384（连跑 2 次 exit 0）：等待剔除 ①–⑦ + 白名单扩展 + 宿主配置端到端（true/false）+ 报告/i18n 展示。

## 2026-10-16 时刻分析改按轮次落桶（v0.6.0）

### 背景

- 用户要求以**轮次（turn）**为最小归属单位：多轮会话逐轮分开，每轮活跃时长整段记到该轮开始时刻所在整点，不分摊、不跨小时切分。
- 旧的「事件区间跨小时切分」把一轮 13:50–14:20 拆成 13 点 10min + 14 点 20min，与用户预期不符。

### 关键决策

| 决策 | 取舍 |
| --- | --- |
| 轮次开始时刻取 `turn/start`，缺省取该轮最早事件时间 | 真实事件里有 `turn/start`；没有时退化为最早事件，仍可判定 |
| 事件没有 `data.turn`（`request/header`、`user/message`、老格式）归入会话级伪轮次，起点用 `sessionStartMs = createdAt` | 满足「会话级兜底记 createdAt 小时」；`request/header` 本身不产生活跃，只用来配模型区间 |
| 模型区间归 `assistant/message` 所在轮次，工具区间归 `tool/call` 所在轮次 | 区间与轮次天然同轮；跨轮悬空调用仍不计 |
| 事件里无可用区间 → `hours = null` | 未回填 / `modelUsage: off` 仍走旧 `distributeHours()` 摊销，全局守恒 |
| 落桶仍为 UTC，聚合时按请求时区平移 | 保持可持久化、时区无关；新增断言锁住「上海 13:00 → 13 桶」无 +1h 偏移 |

### 已完成

- `src/models.js`：`foldSessionHours()` 重写为轮次聚合（`turnKeyOf` / `SESSION_TURN_KEY` / `utcHourOf`），`foldSessionModels()` 透传 `sessionStartMs`。
- `index.js`：折叠时传 `sessionStartMs: target.createdAt`；`INDEX_VERSION` 4 → 5。
- `docs/metrics.md`：口径改为「每小时柱高 = 以轮次开始时刻计的活跃时长（不分摊、不切分）」并写明与旧摊销法的差别。
- 离线断言 308 → 326（多轮分开 / 跨小时整段归起始 / 会话级兜底 / 两时区无偏移 / 缩放与旧法兜底守恒）。
- 真实日志核对：某会话 5777 事件，逐轮聚合 raw = 710.3min，`sum(hours) === target`，11 个非空桶。
## 2026-10-16 时刻分析时区错位复核（证伪，未改源码）

### 背景

- 用户报「Asia/Shanghai 下 13:00–14:00 的会话被算到 14:00–15:00（整体晚一小时）」。怀疑 `foldSessionHours`（UTC 落桶）与
  `localHoursFromUtc`（平移）方向/取模写错，或跨小时切分、客户端柱/标签错位。

### 结论：未能复现

| 核对方式 | 结果 |
| --- | --- |
| 纯函数逐桶：上海 13:00–14:00（UTC 05:00–06:00） | 只落 13 点 60min，12/14 点 0 |
| 纯函数逐桶：上海 13:50–14:20（UTC 05:50–06:20） | 13 点 10min + 14 点 20min（旧切分口径，已在 v0.6.0 改为整段 30min 归 13 点） |
| 纯函数逐桶：上海 23:30–00:30（UTC 15:30–16:30） | 23 点 30min + 次日 0 点 30min（旧切分口径，已在 v0.6.0 改为整段 60min 归 23 点） |
| 真实日志独立核对（6 个当日会话，`Intl` 直算 vs 折叠+平移） | 逐桶完全一致，最大占比差 0.00%，峰位相同 |
| 客户端 `HourChart` | 第 i 根柱的标签与 tooltip 都是 i（标签取 `hour.hour`，服务端保证 `byHour[i].hour === i`） |

- 结论：平移方向是 `h*60 + offset`（上海 +480 → 正确晚 8 小时）；跨小时在 UTC 边界逐段切分；跨天用归一化取模。**无需改源码**。
- 附带发现：复核时正在运行的 GUI 仍在跑旧内存镜像（写 `index-v3.json`，旧摊销法），需重启才会走 v0.5.1 事件时间戳。

### 已完成

- 离线断言 308 → 321：⑦ 整点 / ⑧ 跨小时 / ⑨ 跨天三个时区回归用例（逐桶期望值 + `byHour[i].hour === i` + 守恒）。**该批已并入 v0.6.0 的新口径，最终 326 项。**
- E2E 断言 61 → 63：时刻柱与 0–23 标签逐柱对齐、高亮柱＝最高填充柱。

## 2026-10-16 时刻分析改按事件时间戳（v0.5.1）

### 背景

- 旧法把每个会话的 `activeMs = llmMs + toolMs` 按 `[createdAt, lastPromptAt]` 墙钟窗口均匀摊销到 30 分钟切片再归小时：
  新环境下少数超长会话会把少量活跃时长摊平到十几小时（**假平峰**）；`lastPromptAt` 缺失时窗口退化成 1ms →
  全部砸在创建小时（**假尖峰**）。引擎时间本就不等于墙钟时间，这是近似值。

### 关键决策

| 问题 | 结论 |
| --- | --- |
| 事件桶用哪个时区 | **UTC**。折叠（`runModelFold`）在后台运行、不携带查询时区，结果还要写 `index-v4.json` 跨查询/重启复用；UTC 是唯一时区无关的稳定表示。聚合时 `localHoursFromUtc()` 按请求时区平移：固定偏移（Asia/Shanghai、UTC）精确；带夏令时的时区用参考时刻偏移，切换周可能有 ±1h 误差（已在注释/文档写明） |
| 事件累计与官方 activeMs 不一致 | 整体按比例缩放到官方 activeMs（`hoursSource: 'events-scaled'`），保证 `sum(hours) === row.activeMs`（±1ms）；聚合时再按当前 activeMs 回正一次，覆盖"折叠后活会话续聊"的漂移 |
| 未配对 / 未结束的工具调用 | **不计**（悬空调用没有可信的结束时间，宁可少算）；已在 `foldSessionHours` 注释写明 |
| 未回填 / `modelUsage: off` | 退回旧 `distributeHours()` 摊销；快照 `hourSource` 区分 `events` / `scaled` / `apportioned`，两条来源不混算 |

### 已完成

- `src/models.js`：新增 `foldSessionHours()`；`foldSessionModels()` 在同一份 events 上顺带返回 `hours / hoursSource`。
- `src/aggregate.js`：新增 `localHoursFromUtc()` / `zoneOffsetMinutes()`；`byHour` 优先事件桶、回退摊销；`hourSource` 诊断；
  `starts` 从 `distributeHours` 上提到聚合循环统一记（避免两条来源重复计数）。
- `index.js`：`INDEX_VERSION` 3 → 4；`hours / hoursSource` 随行持久化并随行换代搬运；`/snapshot` 的 `diagnostics.hourSource`。
- 离线断言 267 → 308（连跑 2 次 exit 0）。

## 2026-10-15 余额 chip（v0.5.0，默认关闭）

### 铁律补充

- **默认零外发**：余额显示默认关闭；关闭时宿主一次 `deepseekAccount` 调用都不发（`BalanceTracker.ensure` 在 `enabled !== true` 时直接返回）。
- **可选依赖必须用 `ctx.get`，不能写进 `inject`**：cordis v4（`@deepseek-ai/cordis@4.0.5-alpha.2`）的 `inject` 只有"必需依赖"语义——
  `Fiber._refresh()` 要求 `Object.keys(this.inject)` 里每个服务都有实现，否则 fiber 停在 PENDING；`ctx.deepseekAccount` 未 inject 还会抛
  `cannot get property "deepseekAccount" without inject`。`ctx.get(name)` 是 `ReflectService.get` 的混入方法（注释原文
  "Read a service from the store without the inject requirement"），也是官方插件 `dsh-session-log-export` 用 `ctx.get("feedbackUi")` 的同款写法。
  因此 `index.js` 不声明该服务，用 `ctx.get("deepseekAccount")` 取；老版 DSH 返回 undefined → chip 显示「当前 DSH 不支持」。

### 已完成

- 宿主：`DEFAULTS.balance = { enabled: false, refreshMs: 300000 }`；`BalanceTracker`（可选服务 / 8s 超时 `withTimeout` / refreshMs 缓存 /
  并发合并 / try-catch）；快照加 `balance` 字段；新增只读 `GET /balance`（不触发索引）。
- 客户端：`src/client/balance.js` 的纯函数 `balanceChip()` 统一决定四种状态；`BalanceChip` 注册到
  `conversation.session.header.actions`（顶部工具栏动作区）；`useBalance` 每 5 分钟打一次本机 `/balance`。
- i18n `balance.*` 6 键；样式全部用宿主 token；金额格式化 `formatMoney` 上提到 `src/format.js`。
- 离线断言 215 → 267（连跑 2 次 exit 0）。

### 关键决策

| 问题 | 结论 |
| --- | --- |
| 为什么默认关闭 | 出网会把"本机在用 DSH 且有登录态"暴露给 platform.deepseek.com；插件其余部分完全本地，不能因为一个装饰性 chip 破坏声明，故默认关闭、显式 `balance.enabled: true` 才开 |
| chip 数据从哪来 | 专门加 `/balance` 轻量路由：工具栏常驻，不能为余额去拉整份 `/snapshot`（会触发索引同步/聚合） |
| 未登录 / 失败怎么显示 | 未登录「未登录」+ 充值链接；失败「—」+ 充值链接（不弹错）；链接来自本地 `getState()`，不依赖余额查询成功 |
| 报告要不要带余额 | 不带。报告要能外发，余额是私密信息；且报告的自包含断言只允许官方计费外链 |

## 2026-10-10 初版（v0.1.0）

### 铁律（本项目的硬约束）

1. **只用官方接口读数据**：`ctx.sessionQuery.listSessions()` + `ctx.sessionProjectionCache.cachedSnapshot()` + `ctx.sessionProjections.snapshot()`。
   不解析 `~/.dsh/sessions/**/session*.jsonl.zstd`，不直接读 `storages/session_projcache/sessions/*.json` 文件格式（那是内部实现）。
2. **零 I/O 建索引**：`cachedSnapshot` 从持久化检查点的内存表同步读取，全部会话实测建索引 ~250ms；不要退回逐会话冷读日志。
3. **报告必须自包含**：内联 CSS + 内联 SVG，无外链、无脚本，才能直接发客户/打印。
4. 客户端插槽的 `inject.hooks` 只接受 **store 形状（getSnapshot/subscribe）的可观察源**，不是 React hook 函数。

### 已完成

- 宿主半部 `index.js`：官方投影建索引 + `session/event` 增量更新 + 4 条只读路由（snapshot / export.json / report.html / health）。
- 聚合核心 `src/aggregate.js`（纯函数，宿主/报告/测试/客户端共用）+ 展示格式化 `src/format.js`。
- 自包含报告 `src/report-html.js`：KPI、每日堆叠柱 + 活跃时长折线、工作区排行、主要会话，全部内联 SVG。
- 客户端 `src/client/index.jsx`：`sidebar.footer.action` 入口 + `shell.overlay` 全屏看板，主题 token 自动适配深浅色，中英文文案。
- 离线验证 75 项断言（`test/verify.mjs`）；真实浏览器 E2E 19 项断言 + 6 张截图（`test/e2e-ui.mjs`）。

### 关键决策与坑

| 问题 | 结论 |
| --- | --- |
| 数据从哪来 | 官方投影（sessionStats / tokenUsage / title）。tokenUsage 是 `{uncachedInput, output, cacheRead, cacheWrite}`，缓存读取占绝大多数 token，展示时单列 |
| 子代理识别 | `SessionHeader.origin === "subagent"` 或 `delegationDepth > 0`；投影缓存文件里没有 origin，所以**不能**靠读缓存文件判断 |
| 客户端入口契约 | 包 `package.json` 需要 `dsh.client = { platform: "web", inject: [...] }` 且 `exports["./client"]` 指向 `lib/client.js`；bundle 必须 `window.__ModuleLoader__.load({id, factory})` |
| 插槽 hooks 坑 | `ctx.slots.register(..., C)` 的 `inject()` 返回 `{ hooks: { panel: fn } }` 时，渲染器把 `fn` 当 store 用 → `fn.getSnapshot is not a function`，插槽直接崩溃（控制台 `slot entry crashed`）。改用「传普通对象 + 组件内 `useSyncExternalStore`」 |
| 长区间截断 | `enumerateDays` 有 400 天上限，曾导致 `days=3650`（全部）时近 7 天变成 2017 年的空白日。现改为：区间 ≤180 天补齐空白日，>180 天只收录有活动的日子；`range.days` 表示区间跨度而非列表长度 |
| esbuild / puppeteer 解析 | 沙箱里没有 pnpm 与全局 dsh，且不便联网安装：`build.mjs` 与 E2E 都按「本目录 → 同级 同级插件项目 → ~/.dsh/profiles/web」顺序解析依赖 |
| E2E 遮罩 | 测试实例首次打开会有官方 `Preview Notice` 模态（`[class*="_mask_"]`）挡住侧边栏点击，E2E 必须先点 Continue；这不是插件问题 |

### 环境备忘（沙箱内）

- `dsh` 不在 PATH：用 `npx 缓存里的 .bin/dsh`。
- `ps` 被沙箱拦（`Operation not permitted`）；探测服务用 `curl` 而不是 ps。
- 真实 GUI 打不开调试：web 服务要 `?token=...` 才发 cookie，`curl -c jar` 后再访问。
- 写入范围：会话工作区（`~/WorkBuddy/ds_Harness`）可写；`~/.dsh` 与 `~/dsh_mac` 在沙箱外，需授权。

## 2026-10-10 装机后的两个真实缺陷（都已修）

真实 profile 一装就暴露了两个在 小规模 E2E 子集里看不见的问题：

### 1. tokenUsage 的 wire 形状 ≠ 持久化 state 形状（致命）

| 来源 | 形状 |
| --- | --- |
| 官方 wire view（`cachedSnapshot` / `projections.snapshot`） | `{ uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }`（**直接就是 bucket**） |
| 持久化检查点文件里的 `val`（state） | `{ totals: {...}, last: {...} }` |

`dsh-token-meter` 的投影定义写着 `wire.view = (state) => state.totals`。原先只读 `values.tokenUsage.totals`，
于是**所有走官方接口拿到的 token 全是 0**（时长却正常，因为 sessionStats 两种形状字段名一致，掩盖了问题）。
修法：两种形状都认（`usage.totals ?? usage`），并加回归断言。

### 2. 投影检查点会被格式迁移"作废"

本机多数历史会话里只有一部分 `cachedSnapshot` 命中——官方按"会话生命周期身份"（formatVersion/createdAt/cwd/isSeeded）
校验，v3→v4 迁移后的旧检查点被拒（这是设计，不是 bug）。修法：加官方冷读兜底
（`sessionQuery.observeSession(id, { projectionMode: "all" })`）+ 本地索引持久化，实测大部分靠冷读补齐，少数 v0 老会话
当前版本无法迁移（`subagent/descriptor ... unsupported descriptor version 2`）→ 明确列为"读取失败"并在看板上写明。

### 3. 顺带修掉的体验问题

- 首次全量冷读 全部会话 ≈ 2 分钟：改成**非阻塞 + 渐进式**（边解析边可查，`indexing: true` + 前端每 5s 自动重拉），
  并把并发从 4 提到 8；结果落盘 `index-v2.json`，重启走复用（实测重扫 <1s）。
- `indexing` 语义修正：只在"首次建索引未完成"时为真，后续增量重扫不再打扰用户。

### 装进真实 profile 的观察

- `dsh plugin --profile web add link:$PWD` 会**自动把包追加进 `dsh.profile.bundles`**（不用手改）。
- 新加的 bundle 会被 Loader **热加载**（宿主半部立即生效，实测 `/workload-report/v1/health` 直接 200）；
  但**改插件源码文件不会热替换已加载的模块**——要重启 Web profile 才生效；客户端半部需要刷新浏览器页面。

## 2026-10-10 追加：活跃天数 + inject 声明

- 「按工作区」加第二条 bar（活跃天数）：数据在 `aggregate()` 里用「工作区 → 自然日集合」算，属于展示层派生，
  索引文件不用改（行里已有 `createdAt`），所以升级后重启是快的、不用重跑冷读。
- 天数 bar 的宽度用**工作区之间相对值**（可比较），文字给「N 天 / 区间 M 天」做绝对参考——直接按区间天数画会在「全部」档小到看不见。
- `ctx.sessionProjections` / `ctx.sessions` 漏声明 → cordis 抛错被 catch，实时路径静默失效（`live` 恒 0，`/health.lastError` 里能看到）。
  **教训：cordis 的服务必须声明才能访问**；已加静态断言防止复发。

## 2026-10-10 追加：工作区行改"左付出 / 右消耗"

目标来自用户：**既要知道 Token 消耗，也要给客户讲清楚自己的付出**。三条设计决策值得记下来：

| 决策 | 取舍 |
| --- | --- |
| 左「付出」用**活跃时长**做主角，天数做小字 | 客户对"小时"最有共识；天数是支撑证据（持续性），单独占一条 bar 会让一行出现三条 bar，反而看不清 |
| 右「消耗」用**总 Token**，小字给"输出 / 缓存读取" | 输出 token 才是"产出内容量"，缓存读取是成本项；两者混在一根 bar 里会误导 |
| 两条 bar 都用**占全部的比例**（不是相对最大值） | 与旁边印的 % 同口径，bar 长度和数字说的是同一件事；代价是小项目 bar 很短（但数字仍在） |
| 行首右「最近使用 MM-DD」、行尾「会话 · 对话 · 平均每次对话时长」 | 客户视角的"最近还在推进""平均每次谈多久" |

**几何回归**：E2E 用 `getBoundingClientRect` 断言"左块右边界 ≤ 右块左边界 且两中线同高"——排版需求也能被自动测住。

## 2026-10-11 首页信息架构（v0.2.0）

用户要四件事：日历图（默认）+ 可切柱状图、时刻分析、工作区饼图、明细折叠；另外 KPI 要整数、活跃天数提前。

| 决策 | 取舍 |
| --- | --- |
| 时刻分析用 `sessionListMetadata.lastPromptAt` 界定活跃窗口 | 投影里只有会话级聚合值，没有逐事件时间戳；用 [开始, 最后提问] 做窗口 + 墙钟比例分摊，是唯一"零日志读"的可行口径。**切片严格覆盖 [start,end)，保证分摊总和与总时长相等**（测试断言守恒） |
| 日历的纵轴用周一为首（ISO 周） | 与"周计划"直觉一致；横轴 Year-Week，跨年时自动标出 `2026W01` 这类完整标签 |
| 日历颜色按区间内**相对最大值**分 5 档 | 绝对刻度在"全部"档会全是一个颜色；相对刻度保证任何区间都有对比度 |
| 明细改 `<details>` 折叠 | 明细是"要精确数字时才看"的内容，默认展开会把两张新图挤出首屏 |
| 总 Token 用整数、缩写只留小字 | 客户/博客需要可核对的真实数字；缩写放在备注里兼顾可读 |

**踩坑**：分摊循环最初写成 `while (cursor <= end)` + `min(cursor+slice, end+1)`，切片比例之和 = span+1 → 总量多出 5.5ms；
改成半开区间 `[start, end)` 后严格守恒（测试里加了守恒断言，以后回归会被抓住）。

## 2026-10-11 第二轮：排版与区间口径（v0.2.1）

| 需求 | 实现要点 |
| --- | --- |
| 工作区不逐行显示标签 | 每行两块指标只留数值/bar/小字；标签上移到列表顶部**一次**（`.wl-metrics-head`，与 1fr/1fr 网格对齐） |
| 「全部」不写死 10 年 | 客户端发 `all=1`，宿主用 `min(createdAt)` 当起点、今天当终点；`range.days` 随之为真实跨度 |
| 日历固定全历史 | 宿主新增 `calendar` 段（只受 scope 影响、不受 from/to 影响），客户端日历只读它；柱状图仍读受筛选的 `byDay` |
| 周几累计条 | 与日历同一张 SVG，紧贴最后一列右侧；每条带 `data-kind="weekday-bar"` 便于断言 |

**又是"测试写法"教训**：E2E 里"切换前后日历格子数"一开始用了两个不同选择器（含/不含 7 条周几条），
造成 66→59 的假失败。断言必须用同一个选择器测同一个量。

**真修复**：非首次重扫的渐进换表会造成请求读到残缺数据 → 改为原子替换（首次仍渐进，避免 2 分钟空白）。

## 2026-10-11 发布前收尾（v0.3.0）

- 单位统一 `H/M/S`：单位不再进翻译表；`formatDuration` 一处改动，看板与报告同时生效。
- 长备注压短 + 删死键：字典从 95 键降到 92 键，最长文案从 100+ 字降到 40 字内。
- **踩坑**：用 `String.replace(pattern, replacement)` 批量改文案时，replacement 里的 `## 待办` 会被当成"匹配内容"展开，
  把测试文件写坏过一次；另外同一条正则连用两次去改中英两段，第二次把中文覆盖成了英文。**改 i18n 用函数式替换或 split/join**。
- 新增 i18n 常驻断言（键集一致 / 引用存在 / 无死键 / 无超长），字体单位与文案长度也进了 E2E。

## 2026-10-13 第三轮：每日趋势单序列 / 图表铺满 / 骨架屏（v0.4.0 内）

| 需求 | 实现要点 |
| --- | --- |
| 柱状图只保留活跃时长 | 柱高 = `day.activeMs`（0 值日留 1px：柱 rect 数恒等于天数，且悬停提示覆盖每一天）；折线同系列同值，点上标 `formatDuration`（9px，`ceil(30 / 步长)` 隔点标注） |
| 去掉底部空白带 | 旧实现 viewBox 固定 1080×240，容器更高时等比缩放 → 图形上下留白。改为 ResizeObserver 量容器像素、viewBox = 容器尺寸（实测 xStretch = 1），字号即屏幕真实字号 |
| 打开即见布局 | 内存缓存未命中渲染 `SkeletonBody`（KPI 卡 / 图表容器 / 表格框），数值位「加载中…」；缓存命中仍走"旧值 + 后台刷新" |
| 默认近 7 天 | 客户端 `RANGES` 默认 `range.7` + 宿主 `DEFAULTS.defaultDays: 7`；README 配置示例同步 |
| 快照缓存竞态 | `patchLive()` 写行后 `snapshotCache = undefined`，与 sync / 模型回填后的失效处理一致 |

**踩坑**：同构量测的假 locale 若 `getSnapshot: () => ({ ... })` 每次返回新对象，React `useSyncExternalStore` 判定快照不稳定 → 无限重渲染（`Maximum update depth exceeded`）；假 ctx 必须返回同一个快照对象。
**量测**：`.tmp/iso-harness.mjs`（临时、已 gitignore）用假 ctx + 假 fetch 把**真实客户端组件**交给无头 Chrome，无需 DSH 实例；
读数：7 天 7 柱 / 30 天 30 柱、`otherRects = 0`（单序列）、数值标签两两 0 重叠、图底到图例 3.5px、日历与柱状容器高度差 0。

## 2026-10-13 第四轮：模型用量独立页签 + 首页模型环形图 + 柱状图去折线（v0.4.0 内）

| 需求 | 实现要点 |
| --- | --- |
| 模型用量拆独立页签 | 页签数组改为 `["byDay", "model", "byWorkspace", "bySession"]`（文案走 `tab.*` 动态族，新键 `tab.model`）；`ModelSection` 原样搬到该页签，首页不再渲染 treemap / 明细表 / 计费链接；骨架屏右列同步换成模型环形图占位 |
| 首页模型占比环形图 | **复用 `WorkspacePie`**（新增固定口径 `metric` 与 `ariaLabel` 两个可选 prop；固定口径时不渲染切换 chips），不复制第二套画法；数据 `data.byModel` → `{label, tokensTotal}`，固定 Token 占比 |
| 每日趋势去折线 + 周末异色 | 删 polyline 与 points；`day.date` 补 `T00:00:00` 本地解析取星期，0/6 用 `--dsw-static-amber-500`，柱上带 `data-date` / `data-weekend` 便于断言；数值仍 9px 标在柱顶（`data-kind="bar-label"`）；`chart.hint` 文案同步去掉「折线」 |

**量测**：`.tmp/iso-ui.mjs`（临时、已 gitignore）——真实客户端组件 + 真实 aggregate 快照 + 无头 Chrome 1560×1000，
23 项断言全过：页签顺序、7/30 天柱数 = 天数且 `polyline=0`、周末 / 工作日各 1 种 fill、首页环形图扇区 ≥1 且无 `circle`、
描边 = `--dsw-alias-bg-base` 1.6、首页无 treemap / 模型明细表、模型页签内容齐全。

**E2E 复核（真实实例，1560×1000）**：77 项通过，唯一失败是宿主 `conversation.session` 插槽自身的
`TypeError: text.replace is not a function`（本插件只注册 `sidebar.footer.action` 与 `shell.overlay`，与它无关）。
顺带修掉三个**测试自身**的老毛病：① KPI 跨列的断言查了 `gridColumnEnd`，而 `grid-column: span 2` 的计算值落在
`gridColumnStart`（end 是 `auto`）→ 一直误报；② 工作区右栏是 Token，却按 `h/m/s` 断言 → 永远不可能通过；
③ 换区间会先出骨架屏，固定 `sleep` 后点「柱状图」chip 会静默落空 → 改为等骨架结束 + 等 chip / 等 SVG。

**踩坑（重要）**：DSH 的 client-modules 扫描是**增量**的，bundle 字节在 Loader 扫描或 HMR `rebuilt()` 时读盘
（源码注释："Versioned code is immutable"）。实测本机那个运行中的 e2e 实例（`dsh web` + link 本插件）在我
`node build.mjs` 之后**能**取到新 bundle（`window.__DSH_BOOT__` 的 rev 对应新文件，取回的 bundle 含新文案、无 `polyline`），
所以对运行实例跑 E2E 可信；但没有 HMR 监听 / rev 未变时仍需重启。要做与实例无关的 UI 回归，用同构量测更稳。

## 2026-10-13 第五轮：模型回填常驻缺陷 + 报告对齐看板（v0.4.1）

### 根因（三个叠在一起，缺一条都复现不出完整症状）

| # | 现象 | 根因 | 证据（修复前，隔离实例 /tmp/dsh-workload-e2e） |
| --- | --- | --- | --- |
| 1 | 「模型维度正在回填…」常驻不消失 | `modelFoldTargets()` = `models === undefined \|\| asOfSeq > modelFoldSeq`；活会话每个事件 `asOfSeq` +1 → 永远 pending；`scheduleModelFold` 还有 15 分钟节流 | 轮询 6 次：`done` 130→194（/204），`pending` **恒为 204** |
| 2 | 重启 / 刷新后模型区没数据 | 折叠结果挂在行对象上，而 `liveRow/cachedRow/coldRow` 每次都新建行；`settle()` 与 `patchLive()` 直接换行；执行中的折叠还把结果写回**已被换掉的旧行** | 索引 336 行只有 132 行带 `models`，而 `folded` 已 274；`days=7` 的 `byModel = 0` |
| 3 | 一部分会话永远折不出来 | `readSession()` 对 v0 旧格式会话抛 `unsupported descriptor version 2`（本机 54 个） | `/health.modelFold.lastError` 原文；这些行把 pending 顶在 > 0 |

**关键量测（修复前 /health 的 modelFold）**：

```json
{ "running": false, "done": 204, "total": 204, "folded": 150, "skipped": 0,
  "lastAt": 1791886111864,
  "lastError": "failed to read stored session \"571902d6-…\": subagent/descriptor 0 uses unsupported descriptor version 2; …",
  "pending": 204 }
```
对应 `/snapshot?days=7`：`byModel = 0`、`topModel = null`（默认区间就是没数据）。

**修复后（同一实例，重启两次）**：

```json
{ "running": false, "done": 204, "total": 204, "folded": 150, "skipped": 0, "failed": 54,
  "pending": 0, "refold": 0, "failedRows": 54,
  "lastAt": 1791886511558, "lastErrorAt": 1791886699495,
  "lastError": "failed to read stored session \"f3f0af01-…\": subagent/descriptor 0 uses unsupported descriptor version 2; …" }
```
`days=7`：`byModel = 3`、`totalCost = ¥77.16`；**再重启一次**：`done = 0`（一次 `readSession` 都没发生）、`pending = 0`、`byModel = 3`。

### 修法

- `modelFoldQueue()` 三档：**pending**（从未折过，界面「回填中」只看它）/ **refold**（已折过且 `asOfSeq - modelFoldSeq > 50`，
  或会话已非 live）/ **failed**（失败行，过 `modelRetryMs` 再试）。失败**不算 pending** —— 否则 v0 老会话会让提示永远挂着。
- `carryModelFields()`：行换代时把 `models / modelFoldSeq / modelFoldAt / modelFoldSkipped / modelFoldError(At)` 整组搬到新行；
  折叠结果写回 `this.rows.get(id)`（**当前**行），不再写回抓到的旧行。
- 诊断：`modelFold.pending / refold / failedRows / lastError / lastErrorAt` 进 `/health` 与 `/snapshot`；界面在模型页签显示
  失败短句（`title` 放全文，`.wl-fold-error` 用 `--dsw-alias-label-error` token）；轮询条件从"仅 indexing"扩到"indexing 或 pending > 0"，
  折完自动停。运行级 `lastError` 为空时回退到**最近一条行级失败**，所以重启后不用再试一次就能看到原因。
- `saveToDisk()` 串行化（sync 与回填并发写同一个 `.tmp` 会 rename ENOENT）；`/health.diagnostics` 与 `/snapshot.diagnostics`
  统一走 `diagnosticsFor()`，新增 `syncing`（后台重扫事实，与给用户的 `indexing` 区分）。

### 量测（真实隔离实例 1560×1000；脚本 `.tmp/measure-final.mjs`，已 gitignore）

| 项 | 目标 | 实测 |
| --- | --- | --- |
| 首页模型环形图上下留白 | 差 ≤ 2px | 上 60.3 / 下 60.3 → **差 0**（卡高 344，图形 160） |
| 模型页签 treemap 到容器 | 左右 ≤ 8px | 容器 582×210，左/右/上/下 **0/0/0/0** |
| 卡片重复标题 | 无 | `.wl-card h3` = `[]`（只剩 h4 小标题 `Model share · area = tokens`） |
| 回填提示 | 折完即消失 | `[data-kind="model-folding"] = null` |
| 失败提示 | 可见 | `54 sessions failed to read logs: …`（`title` 全文） |
| 报告 treemap | 铺满 | 339 = 父容器 339，左右留白 0 |
| 报告内容 | 模型一节 + 模型费用 KPI + 无折线 + 周末异色 | sections 含「模型用量」；KPI 第 3 张「模型费用(估算)」；`polyline = 0`；周末柱 29 根 |
| 报告自包含 | 无脚本 / 仅官方外链 | `script = 0`、`style = 1`（内联）、6 条外链全是官方计费页 |
| 工具栏 | 无「复制 JSON」 | `["Refresh", "Export HTML report", "✕"]` |

E2E（`test/e2e-ui.mjs`，真实实例）全过；离线断言 184 → **215**（连跑 2 次 exit 0）。

### 环境坑（沙箱内）

- 隔离实例的 `dsh` 不在 PATH：`DSH_BIN=/Users/xilejun/.npm/_npx/b5c6312874079fe8/node_modules/.bin/dsh`（`test/e2e-boot.sh` 只剩这个变量要手动给）。
- `ps` 被沙箱拦：找实例进程用 `lsof -nP -iTCP:3299 -sTCP:LISTEN -t` 再 `kill`。
- puppeteer-core 不在本仓库：`WL_PUPPETEER_DIR=/Users/xilejun/WorkBuddy/ds_Harness/tableau-twb-viewer/node_modules`。
- 面板语言可能是**英文**（本实例就是）：E2E 里凡断言文案的地方都要中英都认，本轮踩过一次。
- 需要"重启后仍带模型数据"的证据时，用 `E2E_KEEP=1` 复用同一个 `E2E_HOME`（索引文件在 `$E2E_HOME/workload-report/index-v4.json`）。

## 待办

- [x] 安装进真实 web profile（2026-10-10 由用户执行 `dsh plugin --profile web add link:$PWD`）。
- [x] 模型维度已在 0.4.0 接入、0.4.1 修掉回填常驻缺陷（读 `readSession` 事件日志，见 docs/models.md）。
- [ ] 可选：把「按工作区」做成季度/月度对比；把导出接入 PNG（现在用浏览器截图即可）。
- [x] 2026-10-17：把「最活跃模型」搬进报告；8 张 KPI 在 5 列栅格正好排满（见 `docs/report-parity.md`）。

## 2026-10-13 v0.4.1 发布

### 本轮新增能力

- **模型维度（0.4.0 起）**：`src/models.js` 从官方 `ctx.sessionQuery.readSession()` 的事件日志折叠模型与 token
  （不解析 zstd/JSONL），归并 `deepseek-flash` → `deepseek-v4-flash`（官方定价页注 1：同一模型的新旧名）；
  索引 `INDEX_VERSION = 3`，行内带 `models` / `modelFoldSeq`，**结果随索引落盘、重启不重折**。
- **费用估算**：内置 DeepSeek 官方**峰谷价**（as-of 2026-10-13；峰时 01:00–04:00 与 06:00–10:00 UTC 周一至周五，谷价半价），
  按每条 `assistant/message` 的时间逐条判峰谷计费；无官方价的模型显示 `—` 不猜；页面与报告底部给官方计费链接；**运行时不联网**。
- **多机同步暂缓**：方案保留在 `docs/sync.md`，列入 `docs/roadmap.md` 后期。

### 关键决策与坑（避免重复踩）

1. **行换代必须搬运模型字段**：`liveRow/cachedRow/coldRow` 每次都新建行，模型折叠结果若不随行搬运就会被每次同步/事件冲掉
   （曾导致"折叠计数涨、界面却为空"）。用 `carryModelFields()` 统一搬运，折叠结果写回**当前**行。
2. **pending 只认"从未折过"**：活会话 `asOfSeq` 持续增长，把它计入 pending 会让提示永不消失；已折过的只在
   `asOfSeq - modelFoldSeq > 50` 或会话已非 live 时重折；失败行单独计数并暴露 `/health`。
3. **`overflow-x: auto` 会把另一轴计算成 `auto`**：日历需要横向滚动时，必须显式 `overflow-y: hidden`，
   并给内联 SVG `display: block`（去掉基线间隙），否则出现 7px 纵向滚动条。
4. **官方接口边界**：`listEvents()` 无事件正文；只有 `readSession()` 能拿完整事件；v0 旧格式会话 `readSession()` 会抛错，
   只能界面说明 + 单独计数，不是本插件可修的问题。
5. **i18n 静态校验**：新增/删除键必须 zh/en 同步，否则 verify 的死键/对齐断言会红。

### 发布

- GitHub：推 `main`（CI 跑构建 + 产物一致性 + 离线断言）。
- npm：`npm stage publish` 暂存 → 本人在本地用一次 OTP `npm stage approve`（npm 现要求交互式 2FA，token 不能替代）。

## 2026-10-20 v1.0.0 发布

- **性能**：打开面板不再触发折叠（0 次 readSession），冷开 448.9→25.3ms、热开 1.12ms；快照缓存 15s；state 三态 first-fold/background/idle。
- **AI 画像**：默认包含、手动触发、30 天窗口、56 字段白名单 + 指纹缓存 + 截断抢救 + 失败诊断；独立页签在导航右侧（蓝底）。
- **报告**：日历/柱状左右并排、去轮次子图、去逐行重复标签；report-parity 结构断言 20+ 条。
- **版本策略**：由 0.7.1 升为 **1.0.0**（用户决定），此后语义化版本承载新功能。

## 2026-10-21 v1.0.1 文档对齐 + 死代码清理

### 事实

- npm 上 `dsh-workload-report@1.0.0` 是上次对话发的，**带着旧 README（Current version 0.7.0）和旧产物
  （含已删除的 `wl-session-layout`）**；Release workflow 第 9 步「检查该版本是否已发布」因此拦下重发。
- npm 不允许覆盖已发布版本，查证 [unpublish policy](https://docs.npmjs.com/policies/unpublish)：
  「that specific name and version combination can never be reused」——unpublish 后同版本号也永远不能再用；
  且上周下载 449 / 上月 1103（远超 300/周门槛，创建超 72 小时），unpublish 大概率被拒。
  **结论：以 patch 版本 1.0.1 承载本次修订**，latest 指向新版本，npm 历史保持真实。

### 变更

- README 中英：版本号 1.0.1；画像改独立页签表述；新增「打开即快」条目；断言数 996 → 993。
- `docs/ai-profile.md` / `docs/report-parity.md`：失效的两列描述改为独立页签。
- CHANGELOG：开头新增**版本对照表**（标注 0.7.x 未单独发版、已并入 1.0.0）；新增 v1.0.1 条目。
- **死代码清理**：删除 `.wl-session-layout` 全部 CSS 与 `SESSION_LAYOUT` / `sessionLayoutGeometry()`
  （两列布局的残留，JSX 早已不用、verify 还在断言其不存在）；`session-layout.js` 只留 `SESSION_PAGE_SECTIONS`。
  产物 `lib/client.js` 105.5 → 104.1 KB。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑：**993 项断言，exit 0**（清理前后各一次）。
- 交叉核对：`package.json` / README ×2 / CHANGELOG 对照表版本号一致（1.0.1）。
- 残留扫描：README / docs 中已无 `两列` / `2fr` / `1080px` / `0.7.0` / `996` 失效描述。

## 2026-10-22 v1.0.2 五处 UI 反馈修正

### 需求（用户提出 5 条，本轮实现）

1. KPI「累计活跃时长」副标题「含等待用户 11.9 h」→「等待 11.9 h」。
2. 报告「柱状图（当前区间）」→「模型 Token 占比」；**并且不得与日历共用同一卡片容器**（用户追加反馈）。
3. 「按日期明细（7 天，点击展开）」默认展开；超过 10 天底部加分页，默认每页 10 天。
4. 「按工作区」页左上角加小标题（与「模型用量」页同构）。
5. 「AI 用户画像」页签蓝底由直角矩形改为圆角矩形。

### 实现

- **文案**：`kpi.active.waitSub` 中英同步（`等待 {wait}` / `Waiting {wait}`）；报告 KPI 副标题
  `含等待用户` → `等待`。口径不变（净活跃 + 等待单列）。
- **报告结构**：新增 `daily-plus-model` 容器承载**两张平级 `.card`**（此前是单卡内两个 `daily-cell`）。
  环形图实现抽成通用 `sharePie(items, palette, { valueOf, format, ariaLabel, centerLabel, colors })`，
  工作区图（`activeMs` + `formatHours`）与模型图（`tokensTotal` + `formatTokens`）共用同一几何。
  删除已成死代码的 `dailyChart()`（约 70 行）与 `workspacePie()`。
- **明细分页**：`<details open>`；`DETAIL_PAGE_SIZE = 10`；`pageCount = ceil(rows/10)`，
  `pageCount > 1` 才渲染 `.wl-pager`（上一页 / 第 N/M 页 / 下一页，首末页 disabled）。
  分页按钮复用 `.wl-btn`，不另造样式。
- **工作区小标题**：新增 `ws.hint`（中英），`<CardHead title={t("tab.byWorkspace")} hint={t("ws.hint")} />`。
- **页签圆角**：`.wl-tab[data-align="end"]` 追加独立规则块（放在 `.wl-tab` 基础规则**之后**，
  避免 padding/margin 被覆盖）：`border-radius: 8px` + `margin-top/bottom` + `border-bottom: none`。

### 验证

- `node build.mjs && node test/verify.mjs` 连跑 2 次：**1014 项断言，exit 0**（1005 → 1014）。
- 真实浏览器（隔离实例 3299，1560×1000）：页签 `border-radius = 8px/8px`、背景 `rgb(77,107,254)`；
  明细 `open = true`、标题 `Daily detail (3 days)`（无 "click to expand"）；7 天数据不出现分页。
- 真实报告 HTML（隔离实例）：`daily-plus-model` 存在、`daily-pair` 无残留、
  「模型 Token 占比」**不在**每日趋势卡内、「柱状图（当前区间）」0 次、
  KPI 副标题 `等待 10.6 h`、全文无「含等待用户」。
- 分页边界纯逻辑校验：7/10 → 1 页（不显示控件）、11 → 2 页、25 → 3 页、31 → 4 页。

### 环境坑

- 正在运行的 3080 实例**不会**自动加载本地 `src/` 改动（它是从 npm 装的），
  验证新代码必须用 `test/e2e-boot.sh` 起的隔离实例，且**改动后要重启**（模块在启动时加载）。

## 2026-10-23 v1.0.3 报告列宽对齐 + 顶部区间筛选器样式

### 需求（用户反馈）

- 「每日用量趋势」尺寸太大，挤占右侧空间；要求与「时刻分析」同宽、「模型 Token 占比」与「工作区占比」同宽，并留出 padding。
- 顶部保留 7 天 / 30 天 / 90 天等筛选器，当前范围突出显示。
- **澄清**：筛选器不是交互，**只要打印出来的样式**（关键约束，直接决定实现方式）。

### 实现

- `daily-plus-model` 从 `1.1fr 1fr` 改为 `1fr 1fr`，与 `two-col` 完全一致 → 四卡等宽、左右两列对齐。
- 新增通用 `.card-body`（`padding: 14px 4px 18px` + `flex` 垂直居中），四张图卡共用；
  `.daily-plus-model > .card` / `.two-col > .card` 用 flex 列 + `align-items: stretch` 等高。
- `rangeFilter(rangeKey)`：**纯 `<span>`** 实现，`data-active="true"` 的那档实底高亮。
  **不用 `<a href>`** —— 报告是自包含静态文件，「外链仅官方计费页」是铁律（`docs/report-parity.md`），
  加链接会破坏它，且导出文件里会出现失效链接。`renderReport` 新增 `rangeKey`，
  `index.js` 按 `?all=1` / `?days=` 传入。
- KPI 卡等高：`.kpi` 改 flex 列 + `.kpi .sub { margin-top: auto }`，解决「最活跃模型」长模型名撑高整行、
  其它卡不跟随导致的边框参差。
- `.cal-scroll` 加 `display:flex; justify-content:center`：窄区间时日历自然宽度小于卡片，居中不留单侧空白。

### 验证

- 离线断言 **1020 项**（连跑 2 次 exit 0）。
- 真实浏览器（隔离实例 3299，1440 宽）实测：
  - 四张卡宽均 **522px**：每日用量趋势 `188→710`、时刻分析 `188→710`、模型 Token 占比 `730→1252`、工作区占比 `730→1252`。
  - 筛选器 `近 30 天`：`bg rgb(59,130,246)` / `color rgb(255,255,255)` / `border-radius 8px` / `cursor auto`。
  - `script 标签数 = 0`、非 https 链接数 = 0（铁律未破）。
  - KPI 首行 `[109,109,109]`、次行 `[139,139,139,139,139]`（等高）。
  - 日历在卡片内左右各约 54px 对称留白。
- 截图：`/tmp/wl-final-30d.png`。

### 事实

- **1.0.2 从未发布成功**：之前 `npm publish` 因登录过期返回 401，随后版本升到 1.0.3，
  故 1.0.3 一次性包含 1.0.2 + 1.0.3 的全部改动。CHANGELOG 对照表已标注「1.0.2 未发布（并入 1.0.3）」。

## 2026-10-23 v1.0.4 打开慢 / 破碎感：冷读节流

### 症状与量化

用户反馈"每次打开工作量报告渲染明显很慢，刚开始内容甚至有破碎感"。逐层排查：

| 层 | 指标 | 结论 |
| --- | --- | --- |
| 后端接口 | `snapshot` 3–11 ms | 不慢 |
| 前端渲染 | 点击→KPI 出现 194 ms | 不慢 |
| 前端长任务 | 最长 658 ms（多为布局/绘制） | 次要 |
| **索引构建** | **`buildMs` 242,280 ms（4 分钟）** | **主因** |
| 冷读 | `cold: 125` | 主因的直接来源 |

### 根因

`revalidateMs` 默认 **12 小时**：索引行超过 12h 就被判"过期"，不再复用旧值，
必须 `readSession()` 重读整份事件日志。480 个会话里约 125 个过期 →
每次启动冷读 4 分钟 → 数据逐步填充 → 用户看到"慢 + 破碎"。

### 修复

- `revalidateMs`: 12h → **7 天**。
- 新增 `revalidateRecentDays`（默认 **30**）：过期行只有在"最近 30 天还有活动"时才重校验。
  判定顺序 `header.updatedAt` → `lastEventAt` → 索引行 `lastPromptAt` → `createdAt`；全无则保守重校验。
- 新增 `needsRevalidate()` 方法集中判定；新增诊断 `staleKept`。
- `revalidateRecentDays: 0` = 关闭优化，回到旧行为。

### 验证（全部有可复现证据）

- 离线断言 **1032 项**，连跑 2 次 exit 0。
- 从 `index.js` 抽取真实 `needsRevalidate` 执行 **8 个边界场景全过**（含兜底与关闭开关回归）。
- 真实索引模拟（480 会话）：需冷读 **54 → 0**。
- 重启 3080 实测：**`buildMs` 48,999 → 1,567 ms（31×）**；`snapshot` 4–37 ms；`report.html` 30 ms。

### 环境坑（重要，避免重犯）

- **不要用 `lsof -ti:3080` 杀进程**：macOS 上 Chrome 的 Network Service 也占用该端口，
  第一次误杀了 Chrome 的 `6730`。正确做法：`ps aux | grep "dsh web" | grep -v grep`。
- 3080 是 link 到本地源码的实例，**改完代码必须重启**才生效；重启方式为 `kill` 后 DSH 自动拉起。

## 2026-10-23 v1.0.5 快照 SWR + 预聚合评估

### SWR（快照缓存命中率）

- 问题：`snapshotCache.hitRate` 仅 23%–44%，`invalidatedBy: live`。
- 根因：`patchLive()` 每来一个活会话事件就 `invalidateSnapshot("live")` **直接置空**缓存，
  于是在会话里打字后打开面板几乎必然 miss。
- 修复：活会话事件只**标记过期、保留旧值**，命中即返回（`dataStale: true`）并 `setImmediate` 后台重建。
  **只有 `live` 走 SWR**；`fold` / `index` 是结构性变化，仍直接清空同步重建 ——
  这样「回填后模型区有数据」「活会话事件即时反映」两组既有断言继续成立（这是本次设计的关键点）。
- 上限 `snapshotStaleMaxMs`（10 分钟）+ 开关 `snapshotSwr`。
- 验证：隔离实例 **5 个场景全过**（首次构建 / TTL 命中 / 活会话后仍返回旧值 / fold 同步重建 / 关闭开关）。

### 预聚合评估（结论：当前不做）

实测数据（483 会话 / 索引 0.51 MB）：

| 指标 | 值 |
| --- | --- |
| `aggregate` 483 会话 | **9.3 ms**（5 次均值） |
| 会话数 → 耗时斜率 | ~0.015 ms/会话（9660 会话 ≈ 148 ms） |
| `snapshot` 各区间 | 4–37 ms |
| `report.html` | 30 ms |
| 索引 `JSON.parse` | 5.2 ms |
| `models` 字段占索引 | 22.2% |

**判断**：三级成本里，预聚合只能优化第 2 层（聚合，毫秒级）；
真正的分钟级成本在第 1 层（读事件日志），已由 v1.0.4 的冷读节流解决。
预聚合要覆盖 `days / from-to / tz / scope / aliases / pricing / metric` 的组合 + 活会话实时一致性，
复杂度和「不编数字」风险远大于 10 ms 收益。

**触发条件**（任一满足再重评）：`snapshot` p95 > 200 ms；会话数 > 5000；`buildMs` 再次 > 10 s。

详见 [docs/preaggregation.md](../docs/preaggregation.md)。
