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

if launchd_installed "$instance"; then
  mkdir -p "$dir/logs"
  target="gui/$(id -u)/$(launchd_label "$instance")"
  if launchctl print "$target" >/dev/null 2>&1; then
    launchctl kickstart -k "$target" >/dev/null 2>&1 || fail "launchd 重启失败：$target"
  else
    launchctl bootstrap "gui/$(id -u)" "$(launchd_plist "$instance")" >/dev/null 2>&1 \
      || fail "launchd 加载失败：$(launchd_plist "$instance")"
  fi
  wait_health "$port"
  say "PASS 实例 ${instance} 由 launchd 托管，已在 ${port} 上就绪"
  exit 0
fi
mkdir -p "$dir/logs"
if [[ -f "$pid_file" ]] && kill -0 "$(cat "$pid_file")" 2>/dev/null; then
  fail "实例 $instance 已经在跑（pid $(cat "$pid_file")）"
fi
assert_port_free "$port"

# 以 app 为工作目录，避免 runner 等相对路径命中调用者仓库。
cd "$app"
PORT="$port" nohup node "$app/.output/server/index.mjs" >>"$log_file" 2>&1 &
echo $! > "$pid_file"
wait_health "$port"
say "PASS 实例 ${instance} 在 ${port} 上启动，pid $(cat "$pid_file")，日志 $log_file"
