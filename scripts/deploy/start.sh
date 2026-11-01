#!/usr/bin/env bash
# 启动实例：pid 文件记进程号，健康检查通过才算启动成功。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
load_env "$instance"

dir="$(instance_dir "$instance")"
app="$dir/app"
port="$(port_for "$instance")"
pid_file="$dir/run.pid"
log_file="$dir/logs/server.log"

[[ -f "$app/.output/server/index.mjs" ]] || fail "$app 没有构建产物，先跑 promote.sh 或 drill.sh"
mkdir -p "$dir/logs"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  fail "实例 $instance 已经在跑（pid $(cat "$pid_file")）"
fi
assert_port_free "$port"

PORT="$port" nohup node "$app/.output/server/index.mjs" >>"$log_file" 2>&1 &
echo $! > "$pid_file"
wait_health "$port"
say "PASS 实例 ${instance} 在 ${port} 上启动，pid $(cat "$pid_file")，日志 $log_file"
