#!/usr/bin/env bash
# 在库副本上先跑一次迁移，比对迁移前后的表名单，通过才允许动正式库。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

source_db="${1:-}"
app_dir="${2:-$REPO_ROOT}"
# 允许消失的表要事先申报；申报跟着应用目录走，跟声明它的那次迁移一起被评审。
declared="$app_dir/scripts/deploy/declared-drops.txt"
[[ -f "$source_db" ]] || fail "没有可演练的库：$source_db"
[[ -d "$app_dir" ]] || fail "没有可用的应用目录：$app_dir"
require_cmd sqlite3

work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-migrate-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
copy="$work/copy.sqlite"
sqlite3 "$source_db" "VACUUM INTO '$copy'"

table_names() {
  sqlite3 "$1" "select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name"
}
table_names "$copy" >"$work/before.txt"
DATABASE_URL="$copy" pnpm --dir "$app_dir" db:migrate >"$work/migrate.log" 2>&1 || {
  cat "$work/migrate.log" >&2
  fail "迁移在库副本上失败，正式库未改动"
}
table_names "$copy" >"$work/after.txt"
integrity="$(sqlite_scalar "$copy" "PRAGMA integrity_check;")"
[[ "$integrity" == "ok" ]] || fail "迁移后副本完整性检查失败：$integrity"

# 判据是表名单而不是表数量：删一张又加一张的表数量变化看不出来，丢表却能看出来。
undeclared="$(migration_undeclared_drops "$work/before.txt" "$work/after.txt" "$declared")"
[[ -z "$undeclared" ]] \
  || fail "迁移后这些表消失了但没有申报（确实要删就写进 ${declared}）：$(printf '%s ' $undeclared)"
stale="$(migration_stale_declarations "$work/after.txt" "$declared")"
[[ -z "$stale" ]] || say "提示 申报清单里这些表这次没有消失，可以清理：$(printf '%s ' $stale)"

say "PASS 迁移演练通过（表 $(wc -l <"$work/before.txt" | tr -d ' ') -> $(wc -l <"$work/after.txt" | tr -d ' ')）"
