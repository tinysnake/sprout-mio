#!/usr/bin/env bash
# 停止实例：先 SIGTERM，十秒不退再 SIGKILL。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
pid_file="$(instance_dir "$instance")/run.pid"

[[ -f "$pid_file" ]] || fail "实例 $instance 没有 pid 文件，可能没在跑"
pid="$(cat "$pid_file")"
if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$pid_file"
  say "实例 $instance 的进程 $pid 已不存在，清掉 pid 文件"
  exit 0
fi

kill -TERM "$pid"
for _ in $(seq 1 20); do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.5
done
if kill -0 "$pid" 2>/dev/null; then
  kill -KILL "$pid"
  say "实例 ${instance} 没有在 10 秒内退出，已强制结束"
fi
rm -f "$pid_file"
say "PASS 实例 ${instance} 已停止"
