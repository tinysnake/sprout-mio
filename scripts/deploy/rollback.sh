#!/usr/bin/env bash
# 回滚：停服务 -> 备份当前 -> 恢复指定或最近一份备份 -> 回到上一个 tag -> 重启。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target="${1:-latest}"
require_cmd git

dir="$(instance_dir prod)"
app="$dir/app"
load_env prod

if [[ "$target" == "latest" ]]; then
  target="$(ls -t "$(backup_dir prod)"/sprout-*.sqlite 2>/dev/null | head -1 || true)"
fi
[[ -f "$target" ]] || fail "没有可恢复的备份：$target"

bash "$REPO_ROOT/scripts/deploy/backup.sh" prod >/dev/null
bash "$REPO_ROOT/scripts/deploy/stop.sh" prod >/dev/null 2>&1 || true
cp "$target" "$(db_path prod)"
rm -f "$(db_path prod)-wal" "$(db_path prod)-shm"

previous_tag="$(git -C "$app" describe --tags --abbrev=0 2>/dev/null || true)"
older_tag="$(git -C "$app" tag --sort=-creatordate | sed -n '2p' || true)"
if [[ -n "$older_tag" ]]; then
  git -C "$app" checkout --quiet "$older_tag"
  pnpm --dir "$app" install --frozen-lockfile >/dev/null
  pnpm --dir "$app" build >/dev/null
  say "代码回滚：${previous_tag:-none} -> $older_tag"
fi

bash "$REPO_ROOT/scripts/deploy/start.sh" prod >/dev/null
bash "$REPO_ROOT/scripts/deploy/verify.sh" prod >/dev/null
say "PASS prod 已回滚到备份 $target"
