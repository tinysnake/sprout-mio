#!/usr/bin/env bash
# 前台跑实例，交给 launchd 托管时用；自己起停用 start.sh。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
dir="$(instance_dir "$instance")"
app="$dir/app"
[[ -f "$app/.output/server/index.mjs" ]] || fail "$app 没有构建产物，先跑 promote.sh"
load_env "$instance"
export PORT
PORT="$(port_for "$instance")"
cd "$app"
exec node "$app/.output/server/index.mjs"
