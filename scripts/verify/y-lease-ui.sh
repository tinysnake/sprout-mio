#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"

# 演示场景只挂在 dev server 的 /__dev/ui 上；这里自起一个独立端口，避免依赖已运行的服务，
# 也不碰 3000 上 Human 正在使用的实例。
port="${SPROUT_LEASE_SCENES_PORT:-3099}"
log_dir="${SPROUT_LEASE_SCENES_LOG_DIR:-.verify/p4b-ui}"
mkdir -p "$log_dir"
log="$log_dir/dev-server.log"
: > "$log"

set -m
pnpm exec vp dev --host 127.0.0.1 --port "$port" --strictPort >>"$log" 2>&1 &
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

SPROUT_LEASE_SCENES_URL="http://127.0.0.1:$port/__dev/ui/" \
SPROUT_LEASE_SCENES_EVIDENCE="${SPROUT_LEASE_SCENES_EVIDENCE:-$log_dir/evidence}" \
  node scripts/browser/p4b-lease-scenes.mjs
