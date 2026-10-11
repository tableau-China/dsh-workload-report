# 多机用量合并（规划中 · 目标版本 0.4.0）

> **状态：规划，尚未实现。** 本文定稿后开工；合并完成后，本文即成为用户配置指南。
> 背景：用户有两台 Mac（本机 Intel Mac 走终端，iMac 走官方安装版），部分项目两边都在跑，希望把两台机器的用量**自动**合到一张报告里，而不是手工搬运日志。

## 目标与默认行为

| 原则 | 说明 |
| --- | --- |
| **默认零配置** | 不配置 `sync` 时，行为与当前版本**完全一致**：只读本机环境（不联网、不外发） |
| **默认合并多机** | 配好来源后，KPI／日历／时刻／工作区默认汇总全部机器 |
| **可按设备筛选** | 需要时只看单台（API 参数 + UI 选择器） |
| **机器名自动** | 优先 `os.hostname()`，可用配置覆盖；**本机不需要任何设置** |
| **只同步统计行** | 传"逐会话汇总行"，不传原始会话日志、不传对话内容 |

## 一、机器身份

- **`machineId`（稳定）**：优先 `<DSH_HOME>/.anonymous-user-id`（UUID，每台安装一个）；缺失时退回 `sha1(hostname + DSH_HOME)`。
- **`machineName`（展示）**：`config.machineName ?? os.hostname()`，去掉 `.local` 后缀。
  本机实测：`Xilejun-2.local` → 展示为 **Xilejun-2**。
- 冲突处理：读端发现"两个来源 name 相同但 id 不同"时，把展示名追加短 id（`iMac(a1b2)`），避免看混。
- 载荷中携带 `machine: { id, name, host, platform, arch, plugin }`，因此**来源天然可区分**——
  这补上了会话记录本身没有机器字段的缺口（会话 header 仅有 `type/version/id/createdAt/cwd/isSeeded/delegationDepth/agentPreset`）。

## 二、同步载荷 `rows.json`

与插件内部行结构**完全一致**，因此合并无需转换：

```json
{
  "schema": 1,
  "kind": "dsh-workload-report/rows",
  "generatedAt": 1791125942708,
  "machine": { "id": "6311…", "name": "Xilejun-2", "host": "Xilejun-2.local", "platform": "darwin", "arch": "x64", "plugin": "0.4.0" },
  "totals": { "sessions": 313, "activeMs": 1003379000 },
  "rows": [
    {
      "id": "session-2fdda78e-…", "createdAt": 1790784271748,
      "cwd": "/Users/xilejun/WorkBuddy/ds_Harness/dsh-workload-report",
      "isSubagent": false, "isSeeded": false, "agentPreset": "standard",
      "title": "…", "turns": 12, "steps": 34,
      "llmMs": 123456, "toolMs": 23456, "decodeTokens": 18900,
      "tokens": { "input": 7269, "output": 188, "cacheRead": 6144, "cacheWrite": 0 },
      "lastPromptAt": 1791125946521, "asOfSeq": 172, "updatedAt": 1791167399954
    }
  ]
}
```

- **体积**：约 350 B/会话 → 300 会话 ≈ **100 KB**（gzip 后 ~25 KB）。GitHub 单文件上限 100 MB，完全够用。
- **幂等**：按 `row.id` 合并，`updatedAt` 大者胜；重复上传/重复拉取不会重复计数。
- **不含**：对话内容、提示词、工具调用参数、附件 —— 只有 id／时间／路径／时长／token。

## 三、传输：GitHub 优先（默认关闭）

```yaml
- id: workload-report
  name: dsh-workload-report
  config:
    sync:
      enabled: false                     # ← 默认 false：只读本机
      mode: push+pull                    # push+pull | push | pull
      repo: tableau-China/dsh_workloader_log_sync   # 已建好（私有）
      path: machines/{machineId}.json    # 每台机器只写自己的文件
      tokenFile: ~/.dsh/.github-token    # 推荐：token 不进配置
      # token: ghp_xxx                   # 备选（明文，不推荐）
      pushEveryMs: 21600000              # 6 小时
      pullEveryMs: 1800000               # 30 分钟
```

| 事项 | 设计 |
| --- | --- |
| 写 | `PUT /repos/{repo}/contents/machines/{machineId}.json`（先 GET 取 `sha`，无则创建） |
| 读 | `GET /repos/{repo}/contents/machines` 列目录 → 逐个 `Accept: application/vnd.github.raw` 拉取；**自己的文件跳过** |
| **冲突** | 每台机器只写自己的文件 → 路径不重叠，**天然无冲突**，不需要 git 合并 |
| 权限 | 只读场景用 fine-grained PAT（**Contents: Read**）；要推送则 **Read and write**，且只授权这一个仓库 |
| 无 token | 仅公开仓库可读 → **不推荐**（载荷含绝对路径）；无 token 时插件不启用该来源 |
| 速率 | 认证 5000 次/时；pull 30 分钟一次 ≈ 48 次/天，远低于上限 |
| 扩展 | 传输层抽象为 `transport`，0.4.x 可加 S3/COS（`type: s3`，endpoint/bucket/keys）；不改变载荷与合并逻辑 |

## 四、合并语义与展示

**索引分层**：本机行放 `rows`，每个来源单独存 `sources[key] = { meta, rows, fetchedAt }`。
聚合时把"启用来源"的行并入；来源被禁用/删除即整体丢弃（无残留）。

**为什么合并"逐会话行"而不是"已聚合报告"**：后者会算错交叉指标——
例如两台机器同一天都做了同一个项目，把两份 `byWorkspace.activeDays` 相加会把"1 天"算成"2 天"。
按会话行合并后，`活跃天数`（按天去重）、`时刻分摊`、`工作区×天` 都仍然正确。

| 维度 | 默认（合并） | 设备筛选 |
| --- | --- | --- |
| 6 项 KPI | 两机相加 | 只看选中设备 |
| 日历热力图 / 每日趋势 | 两机相加（同日自动合并） | 同上 |
| 时刻分析（0–23） | 两机相加 | 同上 |
| 工作区占比/对照 | 见下方"工作区合并" | 同上 |

**工作区合并（关键体验）**：现状 `byWorkspace` 的 key 是完整 `cwd`，别名只改显示名——
两机同项目若路径不同会显示成**两行同名**。本版改为**按 label 分组**：指向同一别名的多个路径合并成一行（投入相加），
行内保留"来自 N 个路径 / N 台机器"的明细。单机时行为不变（向后兼容）。

**设备筛选**：API 增加 `machine=<id|name>`（可重复）；UI 顶部加设备选择器，默认"全部设备"，
该项工作量小，随 0.4.0 一起做。

**诊断**：`/health` 与看板底部提示每个来源的 `name / fetchedAt / rows / stale`；
拉取失败只影响该来源（显示"iMac · 6 小时前 · 已过期"），**不影响本机数据**。

## 五、自动化

- **推送**：插件内部定时（`pushEveryMs`）→ iMac **无需脚本、无需 launchd**，装上插件配好即用。
- **拉取**：插件内部 `pullEveryMs`；随现有 sync 循环执行。
- **对称**：两台机器都配 `push+pull` 即互为来源，无主从之分。
- **可选**：`scripts/sync-rows.mjs` + `launchd` plist 模板，给"不想把 token 放配置里"或"想在 DSH 未运行时也推送"的用户。

## 六、隐私与安全

1. 默认关闭；未配置 `sync` 时插件**不产生任何外发请求**（离线断言覆盖）。
2. 载荷不含对话内容；含 `cwd` 绝对路径 → **建议私有仓库**（文档中明确提示）。
3. token 优先 `tokenFile`／环境变量，避免明文写进 profile；只授权单个仓库。
4. 进阶选项（可选实现）`redactPaths: true`：`cwd` 以哈希代替 + 仅用别名展示。

## 七、配置项总表（新增部分）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `machineName` | `os.hostname()`（去 .local） | 展示名 |
| `sync.enabled` | `false` | 总开关 |
| `sync.mode` | `push+pull` | 方向 |
| `sync.repo` | — | `owner/name` |
| `sync.path` | `machines/{machineId}.json` | 文件路径模板 |
| `sync.tokenFile` / `sync.token` | — | 凭据 |
| `sync.pushEveryMs` / `pullEveryMs` | 6h / 30m | 周期 |
| `sources[]`（只读清单） | — | 手动指定来源 URL（绕过目录列举） |

## 八、验收标准

1. 不配置 `sync` → 行为与 0.3.5 一致（回归断言）。
2. 两台机器各传一份 → 合并总量 = 两台之和；同一 `id` 只计一次。
3. 禁用/删除来源 → 总量立即回落，无残留。
4. 来源过期 → 仅该来源标记 stale，本机数据不受影响。
5. 同一项目同一天在两台机器都有活动 → **活跃天数不重复计天**。
6. 私有仓库 + 只读 token 可读；写需 RW token；无 token 时不启用来源。
7. 离线断言新增：载荷校验（schema/machine/rows）、按 id 去重、跨机合并、`machine` 筛选、来源失效处理；
   E2E 新增：设备选择器存在且默认为"全部设备"。

## 九、版本计划

| 版本 | 内容 |
| --- | --- |
| **0.3.6**（先做，已定） | 英文首页 + `description`/`keywords` 优化（纯展示层，零逻辑风险） |
| **0.4.0** | 机器身份 + 载荷导出 + GitHub 传输 + 合并 + 按别名分组工作区 + 设备筛选 + 来源诊断 + [docs/sync.md](./sync.md) + 测试 |
| 0.4.1+ | 按机器拆分展示、S3/COS 传输（按需） |

## 十、已确认的决定（2026-10-11）

1. **汇总仓库**：https://github.com/tableau-China/dsh_workloader_log_sync （**私有**，已创建，含用途与安全说明）。
2. **凭据**：iMac 放 fine-grained PAT（Contents: Read and write，仅该仓库）→ `~/.dsh/.github-token`；本机只读。
3. **顺序**：先 0.3.6（英文首页 + 检索元数据，本版已完成），**0.4.0 实现多机合并**。
4. 展示：**默认合并全部机器**；设备筛选后续加入（API 参数 + UI 选择器）。
