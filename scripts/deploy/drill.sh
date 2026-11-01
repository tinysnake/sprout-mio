#!/usr/bin/env bash
# 演练实例：从 prod 最新数据起一份副本，装指定 tag，迁移后起在 3221 上。
# 演练只证明「这份代码 + 这份数据能起来」，不证明 prod 已经就绪。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="${1:-}"
[[ -n "$tag" ]] || fail "用法：drill.sh <tag>"
require_cmd git

dir="$(instance_dir drill)"
app="$dir/app"
bash "$REPO_ROOT/scripts/deploy/stop.sh" drill >/dev/null 2>&1 || true
bash "$REPO_ROOT/scripts/deploy/refresh-data.sh" drill >/dev/null

if [[ ! -d "$app/.git" ]]; then
  git clone --quiet "$REPO_ROOT" "$app"
fi
git -C "$app" fetch --quiet origin --tags
git -C "$app" checkout --quiet "$tag"
pnpm --dir "$app" install --frozen-lockfile >/dev/null
pnpm --dir "$app" build >/dev/null

load_env drill
DATABASE_URL="$(db_path drill)" pnpm --dir "$REPO_ROOT" db:migrate >"$dir/logs/migrate.log" 2>&1
bash "$REPO_ROOT/scripts/deploy/start.sh" drill >/dev/null
bash "$REPO_ROOT/scripts/deploy/verify.sh" drill >/dev/null
say "PASS 演练实例已按 $tag 起在 $(port_for drill) 上（数据来自 prod，自动化已关）"
