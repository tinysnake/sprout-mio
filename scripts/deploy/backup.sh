#!/usr/bin/env bash
# 用 VACUUM INTO 备份实例数据库。WAL 下 cp 会丢掉已提交事务，所以不用 cp。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
require_cmd sqlite3
load_env "$instance"

db="$(require_db "$instance")"
mkdir -p "$(backup_dir "$instance")"
stamp="$(date +%Y%m%d-%H%M%S)"
out="$(backup_dir "$instance")/sprout-${stamp}.sqlite"

sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
sqlite3 "$db" "VACUUM INTO '$out'"

integrity="$(sqlite_scalar "$out" "PRAGMA integrity_check;")"
[[ "$integrity" == "ok" ]] || fail "备份完整性检查失败：$integrity"

source_tables="$(sqlite_scalar "$db" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
backup_tables="$(sqlite_scalar "$out" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
[[ "$source_tables" == "$backup_tables" ]] || fail "备份表数量不一致：$source_tables vs $backup_tables"

say "PASS 备份 ${instance} -> ${out}（表 ${backup_tables} 张）"
printf '%s\n' "$out"
