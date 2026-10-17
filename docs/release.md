# 发布手册（npm）

> 现状（2026-10-11 实测）：npm 要求**每次发布都必须有交互式 2FA**。
> - 直连发布（`npm publish`）用**任何 token** 都会被要求 OTP（报 `EOTP`）；
> - 账号级 "Trusted Publisher" 设置页当时打不开，故未启用 OIDC；
> - 因此采用 **CI 暂存 + 本人一次 OTP 批准**：CI 只做暂存（token 即可，无需 2FA），
>   真正的"发布"由你用验证码批准 —— 既保留 2FA 的意义，又能无人值守跑完前面所有校验。

## 一、一次性配置（每台机器/账号只需做一次）

| 步骤 | 说明 |
| --- | --- |
| 1. 账号开 2FA | npm 现在要求发布必须有两步验证（bypass-2FA 的 granular token 已不能发布）。`npm profile enable-2fa auth-and-writes --registry=https://registry.npmjs.org/` 或在 npmjs.com → Account → Two-factor authentication 开启 |
| 2. 配置 Trusted Publisher | npmjs.com → `dsh-workload-report` → Settings → **Trusted Publisher** → GitHub Actions：<br>Organization/user = `tableau-China`，Repository = `dsh-workload-report`，Workflow filename = `release.yml`，Environment 留空 |
| 3. 及时验证 | 配置后 **2 天内**必须成功发布一次，否则该配置失效，需要删除重建（这是 npm 的规则） |

> ⚠️ 国内镜像（npmmirror）只读，发布**必须**显式指向官方源；本地 `.npmrc` 里的 registry 是镜像不影响 workflow。

## 一·五、包归属与权限（2026-10-11 起）

| 项 | 值 |
| --- | --- |
| 包 | `dsh-workload-report`（非 scoped，public） |
| 归属 | npm 组织 **`vizwise`**（发布者账号需要该组织的 publish 权限） |
| 版本发布者记录 | `xilejun`（历史版本）→ 后续以当时登录的账号为准 |
| token | 组织/账号变更后会失效，需重新 `npm login` 或重建 Granular token；

**批准暂存版本**除了 CLI，也可以在 npm 网页的包页面 → "Staged" 条目上直接 Approve。

## 二、日常发版（推荐：CI 暂存 + 一次 OTP 批准）

```bash
cd ~/WorkBuddy/ds_Harness/dsh-workload-report

# 1) 改代码后先本地自检
node build.mjs && node test/verify.mjs        # 构建 + 415 项离线断言

# 2) 更新 CHANGELOG.md（新增该版本条目）并提交
git add -A && git commit -m "feat: …"

# 3) 升版本 + 打 tag（npm version 会改 package.json 并创建 commit + tag）
npm version patch -m "release: v%s"           # 或 minor / major

# 4) 推 tag → GitHub Actions 自动发布
git push --follow-tags
```

workflow（[.github/workflows/release.yml](../.github/workflows/release.yml)）会依次：校验 tag 与 `package.json` 版本一致 → 构建并校验入库 `lib/client.js` → 跑 415 项离线断言 → 检查该版本未被发布 → **`npm stage publish`**（用 `NPM_TOKEN` 密钥，无需 OTP）。

跑完后 Actions 的 Summary 会给出 stage id 与下一步命令；你本地执行一次：

```bash
npm stage approve <stage-id> --registry=https://registry.npmjs.org/ --otp=<6位验证码>
```

其他 stage 子命令：`npm stage list`（查看待批准）、`npm stage view <id>`、`npm stage reject <id> --otp=<码>`（作废）。
也可以在 npm 网页上操作：包页面里 `Staged` 状态的版本旁有 Approve / Reject。

### 前置：配置 NPM_TOKEN 密钥

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret，名称 `NPM_TOKEN`，
值用 npmjs.com 生成的 **Granular Access Token**（权限：Packages → Read and write；组织/包选择本包）。
该 token **不能**替代 2FA 发布（npm 会拒绝），只用于"暂存"。

## 三、本地直接发布（最省事，需你本人在场）

```bash
node build.mjs && node test/verify.mjs          # 自检
npm publish --registry=https://registry.npmjs.org/ --otp=<6位验证码>
```

- **必须带 `--otp`**：不带就会走浏览器授权，且用 token 也一样被要求 OTP（`EOTP`）。
- 若走的是浏览器授权（返回 **202 Accepted**），registry 会先出现 `0.0.0-stage` 占位版本，
  真版本约 1 分钟后落入 —— 这**不是失败**，别重复发。

- 加 `--otp` 可以一次成功；**不加**的话 CLI 会走浏览器授权流程，返回 **202 Accepted**（异步受理），
  期间 registry 会出现 `0.0.0-stage` 占位版本，真版本约 1 分钟后落入 —— 这**不是失败**，别重复发。
- 发完自检：`npm view dsh-workload-report version`、`curl -s https://registry.npmjs.org/dsh-workload-report | head -c 300`。

## 四、发布后校验清单

| 检查 | 命令 / 判据 |
| --- | --- |
| 版本与 latest | `npm view dsh-workload-report version` = 新版本 |
| tarball 内容 | `npm pack dsh-workload-report@<版本>` 后解包，文件清单与 `files` 一致 |
| 构建产物一致 | 解包后的 `lib/client.js` 与仓库内文件 **逐字节一致** |
| 入口声明 | `exports["./client"]`、`dsh.bundle.patch`、`dsh.client` 齐全 |
| 国内镜像 | `curl -sI https://registry.npmmirror.com/dsh-workload-report` 为 200，且 tarball shasum 与官方一致 |
| 真实安装 | 隔离 `DSH_HOME` 下 `dsh plugin --profile web add dsh-workload-report` 能装上且版本正确 |

## 五、踩过的坑（避免重复）

| 现象 | 根因 | 处理 |
| --- | --- | --- |
| `E403 … Two-factor authentication … required to publish` | 账号未开 2FA；npm 已禁止 bypass-2FA token 发布 | 开 2FA 后重发（本地加 `--otp`，或走 CI OIDC） |
| 发布后 registry 只有 `0.0.0-stage` | 走浏览器授权时返回 202，占位版本先落库 | 等约 1 分钟；真版本会写入，勿重复发布 |
| 页面上 4 张图裂 | README 用相对路径，而 `assets/` 不在 tarball 里 | README 图片用绝对链接（已改） |
| 误以为"没发布" | 按 README 里的 npm 方式装却 404（当时确实从未发布） | 现在 README 与实际一致；发布前先 `npm view` 确认 |
| `npm publish` 打到镜像 | `.npmrc` 里 registry 是 npmmirror | 发布命令显式加 `--registry=https://registry.npmjs.org/` |
| `EOTP This operation requires a one-time password`（用 token 也一样） | npm 政策：发布必须有交互式 2FA，token 不能替代 | 加 `--otp=<6位码>`；或改走"CI 暂存 + `npm stage approve`" |
