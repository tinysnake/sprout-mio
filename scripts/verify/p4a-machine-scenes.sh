#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

# Machines 演示场景的全部状态（含平台与执行环境矩阵）只挂在 dev server 的 /__dev/ui 上。
# 自起独立端口，不依赖已运行的服务，也不碰 3000 上 Human 正在使用的实例。
port="${SPROUT_MACHINE_SCENES_PORT:-3099}"
log_dir="${SPROUT_MACHINE_SCENES_LOG_DIR:-.verify/p4a-machine-scenes}"
mkdir -p "$log_dir"
log="$log_dir/dev-server.log"
: > "$log"

# 场景页本身不读 auth，但 dev server 的 runtime 会在缺 BETTER_AUTH_SECRET 时报错；
# 仓库根的 .env.local 不在版本控制内，所以这里只在未提供时补一个本地随机值。
if [ -z "${BETTER_AUTH_SECRET:-}" ]; then
  export BETTER_AUTH_SECRET="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("base64url"))')"
fi

set -m
# PORT 必须一起给：仓库 .env.local 的 PORT=3000 会让 dev server 先去绑 3000。
PORT="$port" pnpm exec vp dev --host 127.0.0.1 --port "$port" --strictPort >>"$log" 2>&1 &
server_pid=$!
cleanup() {
  if kill -0 "$server_pid" 2>/dev/null; then
    kill -TERM -- "-$server_pid" 2>/dev/null || kill -TERM "$server_pid" 2>/dev/null || true
    sleep 1
    kill -KILL -- "-$server_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

url="http://127.0.0.1:$port/__dev/ui/?scene=machines"
ready=0
for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null --max-time 2 "$url"; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  printf 'FAIL dev server on %s did not become ready; see %s\n' "$port" "$log"
  exit 1
fi

SPROUT_MACHINE_SCENES_URL="http://127.0.0.1:$port/__dev/ui/" \
SPROUT_MACHINE_SCENES_EVIDENCE="${SPROUT_MACHINE_SCENES_EVIDENCE:-$log_dir/evidence}" \
  node scripts/browser/p4a-machine-scenes.mjs
