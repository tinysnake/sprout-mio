#!/usr/bin/env bash
# 用 launchd 托管实例：开机自启、崩溃重起。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

action="${1:-}"
instance="${2:-prod}"
require_instance "$instance"

label="$(launchd_label "$instance")"
plist="$(launchd_plist "$instance")"
target="gui/$(id -u)/$label"
dir="$(instance_dir "$instance")"
app="$dir/app"

case "$action" in
  install)
    require_cmd launchctl
    [[ -f "$app/scripts/deploy/serve.sh" ]] || fail "$app 里没有 serve.sh，先部署代码"
    mkdir -p "$dir/logs" "$(dirname "$plist")"
    cat > "$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$app/scripts/deploy/serve.sh</string>
    <string>$instance</string>
  </array>
  <key>WorkingDirectory</key><string>$app</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SPROUT_RUNTIME_ROOT</key><string>$(runtime_root)</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$dir/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$dir/logs/launchd.err.log</string>
</dict>
</plist>
PLIST
    launchctl bootout "$target" >/dev/null 2>&1 || true
    launchctl bootstrap "gui/$(id -u)" "$plist" || fail "launchctl bootstrap 失败：$plist"
    launchctl enable "$target" >/dev/null 2>&1 || true
    wait_health "$(port_for "$instance")"
    say "PASS 实例 ${instance} 已交给 launchd（${label}），开机自启、崩溃重起"
    ;;
  uninstall)
    launchctl bootout "$target" >/dev/null 2>&1 || true
    rm -f "$plist"
    say "PASS 已移除 ${label} 的 launchd 托管（进程已停）"
    ;;
  status)
    if [[ ! -f "$plist" ]]; then
      say "实例 $instance 没有交给 launchd"
      exit 0
    fi
    launchctl print "$target" 2>/dev/null | sed -n '1,12p' || say "plist 存在但作业未加载"
    ;;
  *)
    fail "用法：launchd.sh install|uninstall|status [instance]"
    ;;
esac
