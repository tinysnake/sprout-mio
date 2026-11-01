#!/usr/bin/env bash
# 在临时运行根目录里把 init -> backup -> refresh -> verify 跑一遍，并验证负向用例。
# 这套脚本自己也要有门禁，否则「文档写了但脚本没做」没人发现。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

require_cmd sqlite3
scratch="$(mktemp -d "${TMPDIR:-/tmp}/sprout-deploy-selftest.XXXXXX")"
export SPROUT_RUNTIME_ROOT="$scratch"
export SPROUT_PORT_PROD=3320
export SPROUT_PORT_DRILL=3321
export SPROUT_PORT_DEV=3300

cleanup() { rm -rf "$scratch"; }
trap cleanup EXIT

step() { printf '\n--- %s\n' "$*"; }

step "init prod 与 drill"
bash "$REPO_ROOT/scripts/deploy/init-instance.sh" prod >/dev/null
bash "$REPO_ROOT/scripts/deploy/init-instance.sh" drill >/dev/null

prod_db="$scratch/prod/data/sprout.sqlite"
drill_db="$scratch/drill/data/sprout.sqlite"
[[ -f "$prod_db" && -f "$drill_db" ]] || fail "init 没有建出数据库"

step "往 prod 里放一条真实数据与一条登录态"
now_ms=$(( $(date +%s) * 1000 ))
sqlite3 "$prod_db" <<SQL
insert into user (id, name, email, email_verified, created_at, updated_at)
  values ('usr_selftest', '自检用户', 'selftest@sprout.test', 1, $now_ms, $now_ms);
insert into machine (id, name, root_directory, root_revision, created_by, created_at, updated_at)
  values ('mch_selftest', '自检机器', '$scratch/prod/repos', 1, 'usr_selftest', $now_ms, $now_ms);
insert into machine_credential (machine_id, ticket_hash, ticket_expires_at, secret_hash, activated_at)
  values ('mch_selftest', '$(printf 'a%.0s' {1..64})', $now_ms, '$(printf 'b%.0s' {1..64})', $now_ms);
insert into session (id, expires_at, token, created_at, updated_at, user_id)
  values ('ses_selftest', $now_ms, 'prod-token', $now_ms, $now_ms, 'usr_selftest');
SQL

step "backup prod"
backup_path="$(bash "$REPO_ROOT/scripts/deploy/backup.sh" prod | tail -1)"
[[ -f "$backup_path" ]] || fail "backup 没有产出文件：$backup_path"
[[ "$(sqlite_scalar "$backup_path" "PRAGMA integrity_check;")" == "ok" ]] || fail "备份不可用"

step "refresh drill"
bash "$REPO_ROOT/scripts/deploy/refresh-data.sh" drill >/dev/null

step "断言数据过来了、登录态没过来、凭据换成了本实例的"
email="$(sqlite_scalar "$drill_db" "select email from user where id='usr_selftest'")"
[[ "$email" == "selftest@sprout.test" ]] || fail "业务数据没有拷过来：$email"
sessions="$(sqlite_scalar "$drill_db" "select count(*) from session")"
[[ "$sessions" == "0" ]] || fail "演练库里还留着 $sessions 条登录态"
drill_secret="$(. "$scratch/drill/env" >/dev/null 2>&1; printf '%s' "$SPROUT_DRILL_MACHINE_SECRET")"
expected="$(credential_hash "$drill_secret")"
actual="$(sqlite_scalar "$drill_db" "select secret_hash from machine_credential where machine_id='mch_selftest'")"
[[ "$actual" == "$expected" ]] || fail "演练库的机器凭据没有被改写：$actual"

step "断言 prod 没有被 refresh 动过"
prod_sessions="$(sqlite_scalar "$prod_db" "select count(*) from session")"
[[ "$prod_sessions" == "1" ]] || fail "prod 的登录态被动了：$prod_sessions"
prod_secret="$(sqlite_scalar "$prod_db" "select secret_hash from machine_credential where machine_id='mch_selftest'")"
[[ "$prod_secret" == "$(printf 'b%.0s' {1..64})" ]] || fail "prod 的机器凭据被动了：$prod_secret"

step "迁移演练只碰副本"
before_rows="$(sqlite_scalar "$prod_db" "select count(*) from user")"
bash "$REPO_ROOT/scripts/deploy/check-migration.sh" "$prod_db" >/dev/null
after_rows="$(sqlite_scalar "$prod_db" "select count(*) from user")"
[[ "$before_rows" == "$after_rows" ]] || fail "迁移演练改动了源库"

step "运行根目录可以由指针文件指定，不必在仓库旁边"
printf '%s\n' "$scratch" > "$scratch/root-pointer"
SPROUT_RUNTIME_ROOT= SPROUT_RUNTIME_ROOT_FILE="$scratch/root-pointer" bash "$REPO_ROOT/scripts/deploy/verify.sh" prod >/dev/null

step "verify 两个实例"
bash "$REPO_ROOT/scripts/deploy/verify.sh" prod >/dev/null
bash "$REPO_ROOT/scripts/deploy/verify.sh" drill >/dev/null

step "负向用例：refresh 不许碰 prod"
if bash "$REPO_ROOT/scripts/deploy/refresh-data.sh" prod >/dev/null 2>&1; then
  fail "refresh-data.sh 接受了 prod，正式数据可能被覆盖"
fi

step "负向用例：凭据不对时 verify 必须红"
sqlite3 "$drill_db" "update machine_credential set secret_hash='$(printf 'c%.0s' {1..64})';"
if bash "$REPO_ROOT/scripts/deploy/verify.sh" drill >/dev/null 2>&1; then
  fail "verify.sh 没发现演练库的机器凭据不对"
fi

step "文档与脚本必须一一对应"
documented="$(grep -oE 'scripts/deploy/[a-z-]+\.sh' "$REPO_ROOT/docs/deployment.md" | sort -u)"
listed="$(cd "$REPO_ROOT/scripts/deploy" && ls *.sh | sed 's|^|scripts/deploy/|' | sort)"
entries="$(printf '%s\n' "$listed" | grep -v 'scripts/deploy/lib.sh$')"
missing="$(comm -13 <(printf '%s\n' "$documented") <(printf '%s\n' "$entries"))"
unlisted="$(comm -23 <(printf '%s\n' "$documented") <(printf '%s\n' "$entries"))"
[[ -z "$missing" ]] || fail "这些脚本没有写进 docs/deployment.md：$(printf '%s ' $missing)"
[[ -z "$unlisted" ]] || fail "文档里提到但不存在或写错名的脚本：$(printf '%s ' $unlisted)"
worker_listed="$(cd "$REPO_ROOT/scripts/worker" && ls *.sh | sed 's|^|scripts/worker/|' | sort)"
worker_documented="$(grep -oE 'scripts/worker/[a-z-]+\.sh' "$REPO_ROOT/docs/deployment.md" | sort -u)"
[[ -z "$(comm -13 <(printf '%s\n' "$worker_documented") <(printf '%s\n' "$worker_listed"))" ]] \
  || fail "worker 脚本没有写进 docs/deployment.md：$(comm -13 <(printf '%s\n' "$worker_documented") <(printf '%s\n' "$worker_listed"))"
[[ -z "$(comm -23 <(printf '%s\n' "$worker_documented") <(printf '%s\n' "$worker_listed"))" ]] \
  || fail "文档里提到的 worker 脚本不存在：$(comm -23 <(printf '%s\n' "$worker_documented") <(printf '%s\n' "$worker_listed"))"

for script in $listed $worker_listed; do
  [[ -x "$REPO_ROOT/$script" ]] || fail "$script 没有执行权限"
done

say ""
say "PASS deploy selftest：init / backup / refresh / verify 与两个负向用例都符合预期，文档与脚本一一对应"
