#!/usr/bin/env bash
# 启动端到端验证实例：独立 DSH_HOME + 测试 profile（link 本插件）+ 真实投影数据副本。
# 不影响正在运行的 Web GUI（用独立 DSH_HOME 与端口）。
#
# 用法: ./test/e2e-boot.sh [port]
#   DSH_BIN        dsh 可执行文件（默认从 PATH 找 dsh）
#   DSH_REAL_HOME  真实 ~/.dsh（默认 $HOME/.dsh），只读复制其会话与投影缓存
#   E2E_SESSIONS   复制最近多少个会话目录（默认 60；0 = 全量，用于验证冷读兜底路径）

set -euo pipefail

PORT="${1:-3299}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_HOME="${E2E_HOME:-/tmp/dsh-workload-e2e}"
PROFILE_DIR="$TEST_HOME/profiles/workloadverify"
DSH_BIN="${DSH_BIN:-dsh}"
REAL_HOME="${DSH_REAL_HOME:-$HOME/.dsh}"
SESSIONS="${E2E_SESSIONS:-60}"

KEEP="${E2E_KEEP:-0}"
if [ "$KEEP" != "1" ]; then
  rm -rf "$TEST_HOME"
fi
mkdir -p "$PROFILE_DIR/node_modules" "$TEST_HOME/ws" "$TEST_HOME/storages"

# 1) 测试 profile：link 本插件
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-workloadverify",
  "private": true,
  "dependencies": {
    "dsh-workload-report": "link:$ROOT"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-workload-report"
      ]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
ln -sfn "$ROOT" "$PROFILE_DIR/node_modules/dsh-workload-report"

# 2) 跳过欢迎页，固定工作区选择器（无头环境）
cat > "$TEST_HOME/settings.yaml" <<'EOF'
ui-onboarding:
  welcomeNoticeVersion: 2026-08-13.1
agent-presets:
  default: standard
EOF

# 3) 真实数据副本：投影缓存 + 会话目录（只读复制，绝不写回真实 home）
if [ "$KEEP" = "1" ]; then
  echo "[e2e] E2E_KEEP=1：复用已有测试数据（不重新复制）"
else
  if [ -d "$REAL_HOME/storages/session_projcache" ]; then
    cp -R "$REAL_HOME/storages/session_projcache" "$TEST_HOME/storages/"
  fi
node -e '
const fs = require("node:fs");
const path = require("node:path");
const [realHome, testHome, limitRaw] = process.argv.slice(1);
const limit = Number(limitRaw);
const from = path.join(realHome, "sessions");
const to = path.join(testHome, "sessions");
if (!fs.existsSync(from)) process.exit(0);
const entries = [];
for (const ws of fs.readdirSync(from)) {
  const wsPath = path.join(from, ws);
  if (!fs.statSync(wsPath).isDirectory()) continue;
  for (const id of fs.readdirSync(wsPath)) {
    const dir = path.join(wsPath, id);
    let stat;
    try { stat = fs.statSync(dir); } catch { continue; }
    if (!stat.isDirectory()) continue;
    entries.push({ ws, id, mtime: stat.mtimeMs });
  }
}
entries.sort((a, b) => b.mtime - a.mtime);
const selected = limit > 0 ? entries.slice(0, limit) : entries;
for (const entry of selected) {
  const dest = path.join(to, entry.ws, entry.id);
  fs.mkdirSync(dest, { recursive: true });
  for (const file of fs.readdirSync(path.join(from, entry.ws, entry.id))) {
    if (!file.endsWith(".zstd")) continue;   // 会话日志（jsonl.zstd / v3 格式）
    fs.copyFileSync(path.join(from, entry.ws, entry.id, file), path.join(dest, file));
  }
}
console.log(`[e2e] 复制了 ${selected.length} 个会话目录（共 ${entries.length}）`);
' "$REAL_HOME" "$TEST_HOME" "$SESSIONS"
fi

echo "[e2e] DSH_HOME=$TEST_HOME  port=$PORT"
cd "$TEST_HOME/ws"
SSH_CONNECTION=1 DSH_HOME="$TEST_HOME" exec "$DSH_BIN" --profile workloadverify --port "$PORT"
