#!/usr/bin/env bash
# 给某个实例准备一台 Worker：独立目录、独立 state、独立 launchd 作业。
# Worker 只出站连接，不占端口；它提供执行环境，Pi 会话仍由实例自己托管。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

action="${1:-}"
instance="${2:-prod}"
require_instance "$instance"

dir="$(instance_dir "$instance")/worker"
app="$dir/app"
state="$dir/state"
label="$(launchd_label "$instance").worker"
plist="$HOME/Library/LaunchAgents/$label.plist"
target="gui/$(id -u)/$label"

worker() { node "$app/dist/worker/main.js" "$@"; }

case "$action" in
  prepare)
    tag="${3:-}"
    [[ -n "$tag" ]] || fail "用法：worker.sh prepare <实例> <tag>"
    require_cmd git
    mkdir -p "$dir"
    if [[ -d "$app/.git" ]]; then
      git -C "$app" fetch --quiet origin --tags
      git -C "$app" reset --hard --quiet
      git -C "$app" clean -qfd
      git -C "$app" checkout --quiet "$tag" || fail "取不到 tag $tag"
    else
      git clone --quiet "$(deploy_remote)" "$app" || fail "clone 失败"
      git -C "$app" checkout --quiet "$tag" || fail "取不到 tag $tag"
    fi
    pnpm --dir "$app" install --frozen-lockfile >/dev/null || fail "依赖安装失败"
    pnpm --dir "$app" worker:build >/dev/null || fail "Worker 构建失败"
    worker version
    say "PASS ${instance} 的 Worker 已按 ${tag} 准备好，目录 $app"
    ;;
  enroll)
    machine="${3:-}"
    ticket="${4:-}"
    [[ -n "$machine" && -n "$ticket" ]] || fail "用法：worker.sh enroll <实例> <machine-id> <票据文件>"
    load_env "$instance"
    origin="$APP_ORIGIN"
    args=(init --server "$origin" --machine "$machine" --state-dir "$state")
    [[ "$origin" == http://* ]] && args+=(--allow-http "$origin")
    args+=(--ticket-file "$ticket")
    worker "${args[@]}"
    ;;
  run)
    mkdir -p "$state"
    worker run --state-dir "$state"
    ;;
  start)
    worker run --state-dir "$state"
    ;;
  install)
    require_cmd launchctl
    [[ -f "$app/dist/worker/main.js" ]] || fail "$app 里没有 Worker 产物，先跑 worker.sh prepare"
    [[ -f "$state/identity.json" ]] || fail "$state 里没有身份，先跑 worker.sh enroll"
    mkdir -p "$dir/logs" "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/node</string>
    <string>$app/dist/worker/main.js</string>
    <string>run</string>
    <string>--state-dir</string>
    <string>$state</string>
  </array>
  <key>WorkingDirectory</key><string>$state</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$dir/logs/worker.out.log</string>
  <key>StandardErrorPath</key><string>$dir/logs/worker.err.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$target" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || fail "launchctl bootstrap 失败：$plist"
    sleep 3
    launchctl print "$target" >/dev/null 2>&1 || fail "作业没有常驻，看 $dir/logs/worker.err.log"
    say "PASS ${instance} 的 Worker 已交给 launchd（${label}）"
    ;;
  uninstall)
    launchctl bootout "$target" >/dev/null 2>&1 || true
    rm -f "$plist"
    say "PASS 已移除 $label"
    ;;
  status)
    if [[ -f "$plist" ]]; then
      launchctl print "$target" 2>/dev/null | sed -n '1,8p' || say "plist 存在但作业未加载"
    else
      say "${instance} 的 Worker 没有交给 launchd"
    fi
    ;;
  *)
    fail "用法：worker.sh prepare|enroll|start|install|uninstall|status <实例> [参数]"
    ;;
esac
