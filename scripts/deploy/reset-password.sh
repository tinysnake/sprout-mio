#!/usr/bin/env bash
# 直接改实例里的账号密码：不依赖发信服务，忘记密码时用它。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
email="${2:-}"
[[ -n "$instance" && -n "$email" ]] || fail "用法：reset-password.sh <instance> <email>"
require_instance "$instance"
app="$(instance_dir "$instance")/app"
require_db "$instance" >/dev/null
[[ -d "$app/node_modules/better-auth" ]] || fail "实例 $instance 还没部署代码：$app"

password="${SPROUT_NEW_PASSWORD:-}"
if [[ -z "$password" ]]; then
  [[ -t 0 ]] || fail "非交互环境下请设置 SPROUT_NEW_PASSWORD"
  read -rsp "新密码（至少 8 位）：" password
  printf '\n'
  read -rsp "再输一次：" confirm
  printf '\n'
  [[ "$password" == "$confirm" ]] || fail "两次输入不一致"
fi
[[ ${#password} -ge 8 ]] || fail "密码至少 8 位"

tmp="$(mktemp "$app/.reset-password.XXXXXX.mjs")"
trap 'rm -f "$tmp"' EXIT
cp "$REPO_ROOT/scripts/deploy/password.mjs" "$tmp"
node "$tmp" "$(db_path "$instance")" "$email" "$password"
