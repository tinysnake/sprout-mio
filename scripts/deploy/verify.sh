#!/usr/bin/env bash
# 校验实例后置状态。脚本自身也要被校验，所以这里的每条断言都对应文档里的一条不变量。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="${1:-}"
require_instance "${instance:-x}"
load_env "$instance"

db="$(db_path "$instance")"
[[ -f "$db" ]] || fail "实例 $instance 没有数据库：$db"
assert_outside_repo "$DATABASE_URL"
[[ "$DATABASE_URL" == "$db" ]] || fail "DATABASE_URL 与实例库路径不一致：$DATABASE_URL vs $db"

tables="$(sqlite_scalar "$db" "select count(*) from sqlite_master where type='table' and name not like 'sqlite_%'")"
(( tables > 0 )) || fail "数据库里没有表"

[[ -d "$SPROUT_PI_DATA_DIR" ]] || fail "缺少 Pi 目录：$SPROUT_PI_DATA_DIR"
[[ -d "$SPROUT_REPO_DIR" ]] || fail "缺少仓库目录：$SPROUT_REPO_DIR"
assert_outside_repo "$SPROUT_PI_DATA_DIR"
assert_outside_repo "$SPROUT_REPO_DIR"

for other in "${INSTANCES[@]}"; do
  [[ "$other" == "$instance" ]] && continue
  other_env="$(instance_dir "$other")/env"
  [[ -f "$other_env" ]] || continue
  other_pi="$(. "$other_env" >/dev/null 2>&1; printf '%s' "${SPROUT_PI_DATA_DIR:-}")"
  other_repo="$(. "$other_env" >/dev/null 2>&1; printf '%s' "${SPROUT_REPO_DIR:-}")"
  [[ "$other_pi" != "$SPROUT_PI_DATA_DIR" ]] || fail "实例 $instance 与 $other 共用 Pi 目录"
  [[ "$other_repo" != "$SPROUT_REPO_DIR" ]] || fail "实例 $instance 与 $other 共用仓库目录"
done

if [[ "$instance" == "prod" ]]; then
  [[ "${SPROUT_AUTOMATION_ENABLED:-true}" == "true" ]] || fail "prod 的自动接续被关掉了"
else
  [[ "${SPROUT_AUTOMATION_ENABLED:-}" == "false" ]] || fail "实例 $instance 必须关掉自动接续，否则会真的判定与投递"
  [[ -n "${SPROUT_DRILL_MACHINE_SECRET:-}" ]] || fail "实例 $instance 缺少 SPROUT_DRILL_MACHINE_SECRET"
  hash="$(credential_hash "$SPROUT_DRILL_MACHINE_SECRET")"
  bad="$(sqlite_scalar "$db" "select count(*) from machine_credential where secret_hash <> '$hash'")"
  [[ "$bad" == "0" ]] || fail "$bad 条机器凭据不是本实例的凭据"
  if [[ -n "$(sqlite_scalar "$db" "select name from sqlite_master where type='table' and name='session'")" ]]; then
    sessions="$(sqlite_scalar "$db" "select count(*) from session")"
    [[ "$sessions" == "0" ]] || fail "实例 $instance 还留着 $sessions 条登录态"
  fi
fi

port="$(port_for "$instance")"
if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
  say "PASS 实例 $instance 在 ${port} 上健康"
else
  say "PASS 实例 $instance 静态检查通过（端口 ${port} 上没有服务在跑）"
fi
