#!/usr/bin/env bash
# 把 prod 的数据刷进演练或开发实例：机器 id 与业务数据原样保留，
# 登录态清掉，机器凭据换成本实例那把固定凭据的哈希。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

target="${1:-}"
require_instance "${target:-x}"
[[ "$target" != "prod" ]] || fail "refresh-data 不接受 prod：正式实例的数据只能靠 promote 与 rollback 改变"
require_cmd sqlite3

load_env prod
prod_db="$(require_db prod)"
load_env "$target"
[[ -n "${SPROUT_DRILL_MACHINE_SECRET:-}" ]] || fail "实例 $target 的 env 里缺少 SPROUT_DRILL_MACHINE_SECRET"
target_db="$(db_path "$target")"
assert_outside_repo "$target_db"
assert_port_free "$(port_for "$target")"

mkdir -p "$(dirname "$target_db")" "$(backup_dir "$target")"
snapshot="$(backup_dir "$target")/from-prod-$(date +%Y%m%d-%H%M%S).sqlite"
sqlite3 "$prod_db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sqlite3 "$prod_db" "VACUUM INTO '$snapshot'"
[[ "$(sqlite_scalar "$snapshot" "PRAGMA integrity_check;")" == "ok" ]] || fail "prod 快照不可用：$snapshot"

rm -f "$target_db" "$target_db-wal" "$target_db-shm"
cp "$snapshot" "$target_db"

hash="$(credential_hash "$SPROUT_DRILL_MACHINE_SECRET")"
machines="$(sqlite_scalar "$target_db" "select count(*) from machine_credential")"
sqlite3 "$target_db" "update machine_credential set secret_hash='$hash', activated_at=cast(strftime('%s','now') as integer)*1000;"

cleared=""
for table in session verification; do
  if [[ -n "$(sqlite_scalar "$target_db" "select name from sqlite_master where type='table' and name='$table'")" ]]; then
    sqlite3 "$target_db" "delete from $table;"
    cleared="$cleared $table"
  fi
done

for table in project chat message task user machine project_machine; do
  a="$(sqlite_scalar "$snapshot" "select count(*) from $table")"
  b="$(sqlite_scalar "$target_db" "select count(*) from $table")"
  [[ "$a" == "$b" ]] || fail "表 $table 行数不一致：prod $a vs $target $b"
done

bad="$(sqlite_scalar "$target_db" "select count(*) from machine_credential where secret_hash <> '$hash'")"
[[ "$bad" == "0" ]] || fail "$bad 条机器凭据没有换成本实例的凭据"

say "PASS $target 数据来自 prod（机器 $machines 个，凭据已换），清理了登录态：${cleared:- 无}"
say "库：$target_db"
