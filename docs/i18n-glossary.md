# 多语言术语表与翻译规范

> 译者 / 翻译模型必读。词典文件：`src/locales/<lang>.json`；`zh.json` 与 `en.json` 是基准。
> 提交前跑 `node test/i18n.mjs --lang <lang>`，必须 0 失败。

## 1. 几条硬规则

1. **只改值，不改键**：键名、键顺序与 `zh.json` 完全一致；JSON 必须合法（2 空格缩进）。
2. **占位符原样保留**：`{name}` / `{count}` / `{value}` 等名字、数量、顺序都不许动；只翻译占位符之外的文字。
3. **整句翻译**：不要按英文单词逐词直译；按目标语言的 UI 习惯重写整句。量词、语序、标点按目标语言调整。
4. **数量句用无变形写法**：DSH 不提供复数规则。遇到 `{n}` / `{count}` / `{days}` 这类计数句，优先译成不随数字变化的句式
   （例：「已推送会话数：{n}」而不是「已推送 3 个会话 / 1 个会话」）。
5. **按钮 / 标签用短句**：按钮用祈使或名词短语，不加句号；说明句可以加句号。避免超长（德语 / 俄语一般比英文长 30–50%），
   按钮、表头、页签尤其要短。
6. **不翻译**：`DSH`、`DeepSeek`、`Token`、`KPI`、`API`、`HTML`、`JSON`、`Git`、`GitHub`、`Gitea`、`COS`（腾讯云对象存储缩写）、
   `Chrome`、`hostname`、`TTFT`、`Star`（GitHub 动作）、代码 / 路径 / URL / 仓库名 / 桶名 / 模型名 / 供应商 id。
   `Token` 可保留原词（业界惯例），不要译成「代币 / 令牌」。
7. **语气**：面向开发者 / 生产力工具用户，简洁、专业、克制；不用感叹号；不使用营销腔。
8. **标点**：`zh` 里的全角冒号 `：` 在其它语言用半角 `:`；`·` 作为分隔符保留；`…` 保留省略号语义。
   `tip.weekend`、`note.unavailable` 等值**以空格开头**（拼接用），翻译时保留前导空格。
9. **零宽字符 / BOM 禁止**；不要在值里换行（除非原值含 `\n`，如 `tip.slice`）。

## 2. 核心术语（务必全语言统一）

| 中文 | English | 说明 |
|---|---|---|
| 工作量报告 | Workload Report | 插件/报告标题 |
| 活跃时长 | active time | 净活跃 = 模型 + 工具时间，已剔除等待用户 |
| 净活跃 | net active | 与官方 activeMs 对照 |
| 等待用户 | waiting for user | 交互工具白名单区间 |
| 会话 | session | DSH 会话（含子代理） |
| 对话 / 轮次 | chats / turns | `table.conversations` 是「有步骤的会话数」，与 turns 区分 |
| 步骤 | steps | |
| 模型 | model | 不译模型名 |
| 供应商 | provider | 渠道 / 厂商，如 auto、magpie/workbuddy-ai |
| 工作区 | workspace | |
| 缓存读取 / 缓存命中 | cache read / cache hit | |
| 输出速度 | output speed | tok/s |
| 首字延迟 | TTFT | time to first token |
| 费用（估算） | cost (est.) | 非官方账单 |
| 区间 | range | 近 7 天 / 全部 |
| 全部会话 / 仅主会话 / 仅子代理 | all sessions / main only / subagents only | |
| 设备 / 设备同步 | device / device sync | |
| 推送 / 拉取 | push / pull | 多设备同步 |
| 凭据 | credentials | 不叫 password |
| 存储方式 | storage | COS / GitHub / Gitea / 共享目录 |
| 用户画像 | user profile | AI 画像 |
| 维度 | dimension | rhythm / focus / stack / collab / trend |
| 建议 | advice | |
| 风险提示 | risk | |
| 口径 | definitions | 报告页脚「口径详见…」 |
| AI 用户画像 | AI profile | 页签短名用 "AI profile" |

## 3. 各界面文案风格

- **侧边栏 / 按钮**：极短。`工作量报告` → Workload report；`刷新` → Refresh；`关闭` → Close。
- **KPI 卡**：标题 2–4 词；副标题是「A · B · C」结构化短句，分隔符 ` · ` 原样保留。
- **图表 / 卡片说明**：一句「看什么」，≤ 约 18 个汉字对应的信息量；不要写口径细节（口径在报告页脚）。
- **同步弹窗**：表单标签 1–2 词；错误提示说清「怎么修」，不要只报错。
- **AI 画像本地规则**：像分析师的短句（结论 + 数字证据）；`headline` 很短（≤30 字上限），`insight` 必须含数字。

## 4. 词条命名速查

| 前缀 | 界面 |
|---|---|
| `action.` / `panel.` / `tab.` / `range.` / `scope.` | 面板框架 |
| `kpi.` / `chart.` / `cal.` / `hour.` / `pie.` / `table.` / `metric.` | 看板图表与表格 |
| `model.` / `ws.` | 模型 / 工作区视图 |
| `profile.` / `profile.local.` / `profile.code.` | AI 画像（本地规则 / 失败 code） |
| `sync.` / `sync.err.` / `sync.ok.` / `set.` / `cred.` / `devices.` | 设备同步与设置 |
| `common.` | 跨界面兜底（未命名模型 / 工作区 / 会话标题） |
| `note.` | 口径说明 | 

## 5. 自检

```bash
node test/i18n.mjs --lang de    # 只查德语：键集 / 顺序 / 占位符 / 空值 / 漏译
node test/i18n.mjs              # 全量（含源码零写死文案、死键检查）
```

常见失败：
- `占位符与 zh 一致` → 丢了 `{n}` 或改成了 `{N}`；
- `键顺序与 zh 一致` → 键被重排或漏键；
- `疑似漏译` → 需要翻译的值直接抄了英文；
- `没有残留中文` → 非 ja 语言里混入了中文（复制时串行）。
