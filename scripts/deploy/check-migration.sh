#!/usr/bin/env bash
# 在库副本上先跑一次迁移，比对表与列快照，通过才允许动正式库。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

source_db="${1:-}"
app_dir="${2:-$REPO_ROOT}"
[[ -f "$source_db" ]] || fail "没有可演练的库：$source_db"
[[ -d "$app_dir" ]] || fail "没有可用的应用目录：$app_dir"
require_cmd sqlite3

work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-migrate-check.XXXXXX")"
trap 'rm -rf "$work"' EXIT
copy="$work/copy.sqlite"
sqlite3 "$source_db" "VACUUM INTO '$copy'"

before="$(sqlite_scalar "$copy" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
DATABASE_URL="$copy" pnpm --dir "$app_dir" db:migrate >"$work/migrate.log" 2>&1 || {
  cat "$work/migrate.log" >&2
  fail "迁移在库副本上失败，正式库未改动"
}
after="$(sqlite_scalar "$copy" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
integrity="$(sqlite_scalar "$copy" "PRAGMA integrity_check;")"
[[ "$integrity" == "ok" ]] || fail "迁移后副本完整性检查失败：$integrity"
[[ "$after" -ge "$before" ]] || fail "迁移后表数量减少：$before -> $after"

say "PASS 迁移演练通过（表 ${before} -> ${after}）"
