# 多设备用量合并

> **状态：已实现（2.0.0）。** 原先标记「暂缓」是因为通用性弱；公开版把传输层做成可插拔后，
> 任何用户都能用自己的存储（腾讯云 COS / GitHub / Gitea / 共享目录）同步自己的多台设备。

## 目标与默认行为

| 原则 | 说明 |
| --- | --- |
| **默认零配置、零外发** | 不配 `sync.enabled` 时，行为与不含该功能的版本**完全一致**：只读本机，不联网 |
| **默认合并多机** | 配好来源后，KPI／日历／时刻／工作区默认汇总全部机器 |
| **可按设备筛选** | 看板设备筛选 chips（多选），或 API 参数 `?machine=<id\|name>`（可重复） |
| **机器名自动** | 优先 `hostname`，可用 `sync.machineName` 覆盖；**本机不需要任何设置** |
| **只同步统计行** | 传「逐会话汇总行」，不传原始会话日志、不传对话内容 |

## 一、机器身份

- **`machineId`（稳定）**：读 `<DSH_HOME>/.anonymous-user-id`（DSH 每台安装一个随机 UUID，
  不含机器或账户信息）；读不到时退回 `sha1(hostname + DSH_HOME)`。
- **`machineName`（展示）**：`sync.machineName ?? os.hostname()`，去掉 `.local` 后缀。
- 载荷携带 `machine: { id, name, host, platform, arch, plugin }`，来源天然可区分。
- **冲突**：每台机器只写自己那一个 key（`path` 模板含 `{machineId}`），路径不重叠 → **天然无冲突**。

## 二、同步载荷

与插件内部行结构**完全一致**，合并端无需转换：

```json
{
  "schema": 1,
  "kind": "dsh-workload-report/rows",
  "generatedAt": 1791125942708,
  "machine": { "id": "6311…", "name": "Mac mini", "host": "x.local", "platform": "darwin", "arch": "arm64", "plugin": "2.0.0" },
  "totals": { "sessions": 313, "activeMs": 1003379000 },
  "rows": [
    {
      "id": "session-2fdda78e-…", "createdAt": 1790784271748,
      "cwd": "/Users/me/proj", "isSubagent": false, "isSeeded": false, "agentPreset": "standard",
      "title": "…", "turns": 12, "steps": 34,
      "llmMs": 123456, "toolMs": 23456, "waitMs": 0, "decodeTokens": 18900,
      "tokens": { "input": 7269, "output": 188, "cacheRead": 6144, "cacheWrite": 0 },
      "lastPromptAt": 1791125946521, "asOfSeq": 172,
      "models": {}, "hours": [], "hourTokens": [], "hourHumanMsgs": [],
      "updatedAt": 1791167399954
    }
  ]
}
```

- **体积**：约 1 KB/会话（含模型与时刻分布）→ 300 会话 ≈ 300 KB。
- **幂等**：按 `row.id` 合并，`updatedAt` 大者胜；重复上传／拉取不会重复计数。
- **本机优先**：同一 id 在本机与远端都有时保留本机行（本机投影最准）。
- **不含**：对话内容、提示词、工具调用参数、附件。

## 三、在 GUI 里配置（推荐）

打开看板 → 设备筛选行右侧的「设备同步」入口（在「全部设备 / 本机 / …」chips 之后），从上到下三块：

### 1. 同步设置（选存储方式 + 参数，写入 profile 并立即生效）

| 存储方式 | 需要填 | 说明 |
| --- | --- | --- |
| **腾讯云 COS** | 存储桶、地域 | 桶名带 `-APPID` 后缀；地域下拉 14 个常用区域 |
| **GitHub 仓库** | 仓库、分支、服务地址 | 仓库填 `owner/name`（也接受完整 URL，会自动规整）；默认 `api.github.com` + `main` |
| **Gitea 仓库** | 仓库、分支、服务地址 | 服务地址填你自己的域名，默认分支 `master` |
| **共享目录** | 目录路径 | iCloud / Syncthing / NAS，**不需要任何凭据** |

通用项：本机显示名、文件路径模板（必须含 `{machineId}`）、是否开启、是否抹掉路径。
每块卡片底部有「去哪里获取」的说明，省得用户去搜文档。

保存走 DSH 官方的 `configEditor.edit()`：先校验完整候选值、加 profile 文件锁、原子替换、
保留 YAML 注释，然后由 Loader **热应用**——不用重启。

保存时只把**非默认值**写进你的 YAML（`slimConfig`），不会堆一堆空字段。
切换存储方式**不会清空**其它方式的配置，切回来不用重填。

### 2. 凭据（存 DSH 加密凭据库）

**不需要开终端。** 直接粘贴：

| 字段 | COS | GitHub / Gitea |
| --- | --- | --- |
| SecretId / Token | ✅ | ✅ |
| SecretKey | ✅ | — |

点「保存并测试」，插件立刻保存并自检一次，直接告诉你连接是否成功。

#### 存到哪里了

存进 **DSH 自带的加密凭据存储**（`@deepseek-ai/dsh-credentials`，服务名 `credentials`），
记录 key 形如 `dsh-workload-report/cos-secret-id`。它带来这些保证：

| 保证 | 说明 |
| --- | --- |
| 不进配置文件 | profile 里只有 bucket / region 这类非机密项 |
| 不进 git | 不会跟着 dotfiles 被提交 |
| 不进浏览器 | 提交后输入框立即清空，不用 localStorage |
| 原子写 + 文件锁 | 底层是 DSH 维护的 0600 文件（`writeFileAtomic` + `withFileLock`） |
| 界面不回显 | `describeRecord` 只回答 `{ configured, kind, writable }`，**从不返回值** |
| 可随时清除 | 表单里的「清除凭据」按钮调用 `deleteRecord` |

### 3. 设备与操作

- 连接状态：传输方式 / 上次推送 / 上次拉取 / 最近错误
- 操作：测试连接 / 立即推送 / 立即拉取
- 设备列表：设备名、会话数、是否过期（`stale` 虚线 chip）

### 回退顺序

同一个字段按下面顺序取值，前面的优先：

1. **加密凭据库**（GUI 里填的）
2. **凭据文件**（0600，适合无 GUI 的服务器）
3. **环境变量**（CI / 脚本）
4. **配置内联**（不推荐，仅为兼容旧配置）

所以你已经用文件配好凭据时，GUI 会显示「已配置 · 来自凭据文件」，不会要求你重填。
空提交**不会**覆盖已存的值——要清空请用「清除凭据」。

### 老版本 DSH

- 没有 `credentials` 服务 → 表单提示「当前 DSH 版本没有加密凭据存储」，仍可用文件或环境变量。
- 没有 `configEditor` 服务 → 「保存设置」置灰并提示手动编辑 `cordis.patch.yml`。

## 四、凭据文件（无 GUI 场景）

### COS

```yaml
config:
  sync:
    enabled: true
    transport: cos
    cos:
      bucket: my-sync-1250000000     # 必须带 APPID 后缀
      region: ap-guangzhou
      secretIdFile: ~/.dsh/.cos-id    # 0600
      secretKeyFile: ~/.dsh/.cos-key  # 0600
```

- **签名**：COS 自有的 **`q-sign-algorithm=sha1`**（**不是**通用云 API 的 TC3-HMAC-SHA256——
  对 `cos.<region>.myqcloud.com` 用 TC3 会一律返回 `403 AccessDenied`）。
  手写实现（`src/cos-sign.js`，只用 Node 内置 `crypto`），已与官方测试向量的 SignKey、
  HeaderList、HttpString 的 SHA1 逐段对齐；插件保持 **0 runtime dependencies**。
- **关键细节**：签名用的 `UriPathname` 是**解码后**的路径，实际发请求用编码后的路径；
  两者混用会 `SignatureDoesNotMatch`。
- **桶必须私有**（载荷含 `cwd` 绝对路径）。
- **最小权限策略**（子账号，别用主账号密钥）：

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": ["cos:PutObject", "cos:GetObject", "cos:HeadObject", "cos:ListParts", "cos:GetBucket"],
    "resource": [
      "qcs::cos:ap-guangzhou:uid/1250000000:my-sync-1250000000/*",
      "qcs::cos:ap-guangzhou:uid/1250000000:my-sync-1250000000/"
    ]
  }]
}
```

> `resource` 必须**同时**包含桶本身和 `/*`：只写 `/*` 会让 `GetBucket`（列对象）失败。

### GitHub / Gitea

```yaml
    transport: github        # 或 gitea
    github:
      baseUrl: https://api.github.com    # 自建 Gitea 填 origin，如 https://git.example.com
      repo: zhangsan/my-workload-sync    # 必须私有
      branch: main                       # Gitea 常见 master
      tokenFile: ~/.dsh/.sync-token      # fine-grained PAT，仅 Contents: Read and write
```

### 共享目录（零凭据）

```yaml
    transport: local
    local:
      dir: ~/Library/Mobile Documents/com~apple~CloudDocs/dsh-sync
```

配合 iCloud Drive / Syncthing / NAS 使用：不需要任何账号，数据不出本地同步网络。
适合企业内网或不想开云账号的场景。

### 手动指定来源

`sync.sources: [{ key, url }]` 可绕过目录列举，用于只读来源。


## 五、合并语义与展示

**索引分层**：本机行放 `rows`，每个来源单独存 `sources[key] = { payload, fetchedAt, key }`。
来源被禁用或远端文件被删即整体丢弃（`pull` 会同步移除已消失的来源，无残留）。

**为什么合并「逐会话行」而不是「已聚合报告」**：后者会算错交叉指标——
例如两台机器同一天都做了同一个项目，把两份 `byWorkspace.activeDays` 相加会把「1 天」算成「2 天」。
按会话行合并后，活跃天数（按天去重）、时刻分摊、工作区×天 都仍然正确。

| 维度 | 默认（合并） | 设备筛选 |
| --- | --- | --- |
| 8 项 KPI | 多机相加 | 只看选中设备 |
| 日历热力图 / 每日趋势 | 多机相加（同日自动合并） | 同上 |
| 时刻分析（0–23） | 多机相加 | 同上 |
| 工作区占比 / 对照 | 见下方「工作区合并」 | 同上 |

**设备筛选**：API `?machine=<id|name>`（可重复），`machine=local` 只看本机；
看板顶部 chip 多选，默认「全部设备」。本机行永远参与（除非远端被显式选中且排除本机）。

**工作区合并**：现状 `byWorkspace` 的 key 是完整 `cwd`，别名只改显示名——
两机同项目若路径不同会显示成两行。配 `workspaceAliases` 后按 label 合并成一行。

## 六、看板 UI

看板新增「设备同步」入口：**设备筛选 chips 同一行的右侧**（不再是顶部页签，也不在 AI 画像之后）。
`sync.enabled=false` 时同样保留入口——同步设置就在这一页，用户要从这里进去开启：

| 区域 | 内容 |
| --- | --- |
| **凭据** | SecretId / SecretKey（或 Token）输入框 + 「保存并测试」/「清除凭据」；已配置字段不回填、不回显 |
| 连接状态 | 传输方式 / 上次推送 / 上次拉取 / 最近错误 |
| 操作 | 测试连接 / 立即推送 / 立即拉取 |
| 设备列表 | 设备名、会话数、是否过期（`stale` 虚线 chip） |

顶部 KPI 区域上方是**设备筛选 chips**（多选，默认「全部设备」）；「设备同步」入口就在这行 chips 的右侧。

## 七、隐私与安全

1. **默认关闭**；未配置 `sync.enabled` 时插件**不产生任何外发请求**（离线断言覆盖）。
2. 载荷不含对话内容；含 `cwd` 绝对路径 → **必须用私有桶 / 私有仓库**。
3. 凭据默认存 **DSH 加密凭据库**（GUI 填写）；也可用 0600 文件或环境变量。
   界面只显示「已配置」与来源，**从不回显内容**；空提交不覆盖已存值；日志只记「保存了 N 项」。
4. `redactPaths: true`：`cwd` 以别名或「名字#短哈希」代替，适合发布到共享通道。
5. 最小权限：COS 只授单个桶的 `machines/*` 前缀；GitHub 用 fine-grained PAT 只授权单仓库。

## 八、配置项总表

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `sync.enabled` | `false` | 总开关（false 时零外发） |
| `sync.mode` | `push+pull` | `push+pull` \| `push` \| `pull` |
| `sync.transport` | `github` | `cos` \| `github` \| `gitea` \| `local` |
| `sync.path` | `machines/{machineId}.json` | key 模板，支持 `{machineId}` / `{machineName}` |
| `sync.machineName` | `os.hostname()`（去 .local） | 展示名 |
| `sync.pushEveryMs` | 6h | 推送周期（最小 60s） |
| `sync.pullEveryMs` | 30m | 拉取周期（最小 60s） |
| `sync.timeoutMs` | 15000 | 单请求超时 |
| `sync.staleAfterMs` | 24h | 来源多久没拉到算过期（仅展示） |
| `sync.redactPaths` | `false` | 抹掉 cwd 绝对路径 |
| `sync.cos.*` | — | `bucket` / `region` / `secretIdFile` / `secretKeyFile` |
| `sync.github.*` | — | `baseUrl` / `repo` / `branch` / `tokenFile` |
| `sync.local.*` | — | `dir` |

环境变量兜底：`WR_COS_SECRET_ID` / `WR_COS_SECRET_KEY` / `WR_SYNC_TOKEN` / `GITHUB_TOKEN`。

## 九、验收标准

1. 不配置 `sync` → 行为与此前版本一致（离线断言）。
2. 两台机器各传一份 → 合并总量 = 两台之和；同一 `id` 只计一次。
3. 禁用/删除来源 → 总量立即回落，无残留。
4. 来源过期 → 仅该来源标记 stale，本机数据不受影响。
5. 同一项目同一天在两台机器都有活动 → **活跃天数不重复计天**。
6. 私有桶/仓库可读写；无凭据时不启用来源（`probe` 返回明确错误码）。
7. 离线断言：载荷校验、按 id 去重、跨机合并、`machine` 筛选、来源失效处理、COS 签名正确性；
   UI 结构断言：设备筛选 chips 与「设备同步」入口同处一行（入口在 chips 右侧），顶部页签行不再有设备同步页签。

## 十、版本计划

| 版本 | 内容 |
| --- | --- |
| **2.0.0**（本版） | 机器身份 + 载荷 + COS/GitHub/Gitea/local 四传输 + 合并 + 设备筛选 + 设备同步入口 + 测试 + 本文档 |
| 1.2.0+ | 按机器拆分展示、WebDAV 传输、设备筛选记忆 |
