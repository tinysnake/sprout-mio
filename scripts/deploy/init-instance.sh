#!/usr/bin/env bash
# 建实例运行目录与 env，并把空库迁到最新。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
require_cmd openssl
require_cmd sqlite3

dir="$(instance_dir "$instance")"
mkdir -p "$dir/data" "$dir/backups" "$dir/logs" "$dir/state" "$dir/pi" "$dir/repos" "$dir/app"

env_file="$dir/env"
if [[ -f "$env_file" ]]; then
  say "保留已有 env：$env_file"
else
  umask 077
  {
    printf 'BETTER_AUTH_SECRET=%s\n' "$(openssl rand -base64 48 | tr -d '\n')"
    printf 'DATABASE_URL=%s\n' "$(db_path "$instance")"
    printf 'APP_ORIGIN=http://localhost:%s\n' "$(port_for "$instance")"
    printf 'SPROUT_PI_DATA_DIR=%s/pi\n' "$dir"
    printf 'SPROUT_REPO_DIR=%s/repos\n' "$dir"
    if [[ "$instance" == "prod" ]]; then
      printf 'SPROUT_AUTOMATION_ENABLED=true\n'
    else
      printf 'SPROUT_AUTOMATION_ENABLED=false\n'
    fi
    if [[ "$instance" != "prod" ]]; then
      printf 'SPROUT_DRILL_MACHINE_SECRET=%s\n' "$(openssl rand -hex 32)"
    fi
  } > "$env_file"
  chmod 600 "$env_file"
  say "写入 env：$env_file"
fi

load_env "$instance"
assert_outside_repo "$DATABASE_URL"
[[ "$DATABASE_URL" == "$(db_path "$instance")" ]] || fail "env 里的 DATABASE_URL 不是本实例的库：$DATABASE_URL"

if [[ ! -f "$DATABASE_URL" ]]; then
  DATABASE_URL="$DATABASE_URL" pnpm --dir "$REPO_ROOT" db:migrate >/dev/null
  say "初始化数据库：$DATABASE_URL"
fi

tables="$(sqlite_scalar "$DATABASE_URL" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
(( tables > 0 )) || fail "数据库里没有表，迁移没有生效"
say "PASS 实例 $instance 就绪，表 $tables 张，库 $DATABASE_URL"
