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

expected_automation="false"
[[ "$instance" == "prod" ]] && expected_automation="true"

run_bounded() {
  local limit="$1" pid waited=0
  shift
  "$@" &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    if (( waited >= limit )); then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
      return 124
    fi
    sleep 1
    waited=$(( waited + 1 ))
  done
  wait "$pid"
}

check_git_egress() {
  require_cmd git
  # 实例的 git 只拿实例 env。这里清掉调用方 shell 的代理变量，否则这项检查会被开发者的 shell 掩盖。
  [[ -n "$(sqlite_scalar "$db" "select name from sqlite_master where type='table' and name='project_profile'")" ]] \
    || fail "实例 $instance 的库里没有 project_profile 表，无法检查出网"
  local remotes_raw remote
  remotes_raw="$(sqlite_scalar "$db" "select distinct git_remote from project_profile where git_remote is not null and git_remote <> ''")"
  local -a remotes=()
  while IFS= read -r remote; do
    case "$remote" in
      https://* | http://*) remotes+=("$remote") ;;
    esac
  done <<< "$remotes_raw"
  if (( ${#remotes[@]} == 0 )); then
    say "PASS 实例 $instance 没有需要探通的 http(s) 远端"
    return 0
  fi
  for remote in "${remotes[@]}"; do
    if ! run_bounded 30 env -u http_proxy -u https_proxy -u all_proxy \
      -u HTTP_PROXY -u HTTPS_PROXY -u ALL_PROXY \
      GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= LC_ALL=C LANG=C \
      git -c credential.helper= -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 \
      ls-remote --heads "$remote" >/dev/null 2>&1; then
      fail "实例 $instance 探不通远端 ${remote}：30 秒内没有成功，按实例 env 里的 git 出网配置排查，见 docs/deployment.md 实例出网"
    fi
    say "PASS 实例 $instance 能访问远端 ${remote}"
  done
}

# 出网是 preflight 而不是后置不变量：默认不查，否则断网时连回滚都会因为这项检查变红。
if [[ "${SPROUT_VERIFY_EGRESS:-}" == "1" ]]; then
  check_git_egress
fi

port="$(port_for "$instance")"
health="$(curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" 2>/dev/null || true)"
if [[ -n "$health" ]]; then
  actual="$(printf '%s' "$health" | node -e 'let body = ""; process.stdin.on("data", (chunk) => { body += chunk; }).on("end", () => { process.stdout.write(String(JSON.parse(body).automationEnabled)); });')"
  [[ "$actual" == "$expected_automation" ]] || fail "实例 $instance 的自动接续开关是 $actual，期望 $expected_automation"
  say "PASS 实例 $instance 在 ${port} 上健康，automationEnabled=$actual"
else
  say "PASS 实例 $instance 静态检查通过（端口 ${port} 上没有服务在跑）"
fi
