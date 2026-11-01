#!/usr/bin/env bash
# 部署脚本共用函数。实例名只接受 prod / drill / dev。
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTANCES=(prod drill dev)

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL %s\n' "$*" >&2; exit 1; }
require_cmd() { command -v "$1" >/dev/null 2>&1 || fail "缺少命令 $1"; }

# 运行根目录与仓库无关：显式变量优先，其次是本机指针文件，最后才是默认位置。
runtime_root() {
  if [[ -n "${SPROUT_RUNTIME_ROOT:-}" ]]; then
    printf '%s' "$SPROUT_RUNTIME_ROOT"
    return
  fi
  local pointer="${SPROUT_RUNTIME_ROOT_FILE:-$HOME/.sprout-runtime-root}"
  if [[ -f "$pointer" ]]; then
    printf '%s' "$(head -1 "$pointer")"
    return
  fi
  printf '%s' "$HOME/sprout-runtime"
}

# 部署来源用远端 URL，不用开发 checkout 的路径，prod 才能搬去任意位置。
deploy_remote() {
  if [[ -n "${SPROUT_DEPLOY_REMOTE:-}" ]]; then
    printf '%s' "$SPROUT_DEPLOY_REMOTE"
    return
  fi
  git -C "$REPO_ROOT" remote get-url origin 2>/dev/null || printf '%s' "$REPO_ROOT"
}
instance_dir() { printf '%s/%s' "$(runtime_root)" "$1"; }

require_instance() {
  local name="$1"
  case " ${INSTANCES[*]} " in *" $name "*) ;; *) fail "未知实例 ${name}（只接受 ${INSTANCES[*]}）" ;; esac
}

load_env() {
  local file
  file="$(instance_dir "$1")/env"
  [[ -f "$file" ]] || fail "实例 $1 没有 env 文件：$file"
  set -a
  # shellcheck disable=SC1090
  . "$file"
  set +a
}

db_path() { printf '%s/data/sprout.sqlite' "$(instance_dir "$1")"; }
launchd_label() { printf 'dev.sprout.%s\n' "$1"; }
launchd_plist() { printf '%s/Library/LaunchAgents/%s.plist\n' "$HOME" "$(launchd_label "$1")"; }
launchd_installed() {
  local plist root
  plist="$(launchd_plist "$1")"
  [[ -f "$plist" ]] || return 1
  # 同名实例可能属于另一个运行根目录：plist 里写的根不是当前根就不算托管。
  root="$(plutil -extract EnvironmentVariables.SPROUT_RUNTIME_ROOT raw -o - "$plist" 2>/dev/null || true)"
  [[ "$root" == "$(runtime_root)" ]]
}

state_dir() {
  local dir
  dir="$(instance_dir "$1")/state"
  mkdir -p "$dir"
  printf '%s\n' "$dir"
}

backup_dir() { printf '%s/backups' "$(instance_dir "$1")"; }
port_for() {
  local override
  override="$(printenv "SPROUT_PORT_$(printf '%s' "$1" | tr '[:lower:]' '[:upper:]')" 2>/dev/null || true)"
  if [[ -n "$override" ]]; then
    printf '%s\n' "$override"
    return
  fi
  case "$1" in
    prod) printf '3220' ;;
    drill) printf '3221' ;;
    dev) printf '3000' ;;
  esac
}

assert_outside_repo() {
  local path="$1"
  [[ "$path" = /* ]] || fail "必须是绝对路径：$path"
  case "$path" in
    "$REPO_ROOT" | "$REPO_ROOT"/*) fail "路径落在仓库内：$path" ;;
  esac
}

require_db() {
  local path
  path="$(db_path "$1")"
  [[ -f "$path" ]] || fail "实例 $1 没有数据库：$path"
  printf '%s\n' "$path"
}

sqlite_scalar() { sqlite3 "$1" "$2"; }

credential_hash() { printf '%s' "$1" | shasum -a 256 | cut -d' ' -f1; }

assert_port_free() {
  local port="$1"
  if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
    fail "端口 ${port} 上已经有服务在应答，实例不能共用端口"
  fi
}

wait_health() {
  local port="$1" deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if curl -fsS --max-time 2 "http://127.0.0.1:${port}/api/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  fail "端口 ${port} 在 60 秒内没有通过健康检查"
}

require_clean_tree() {
  local dir="$1"
  [[ -z "$(git -C "$dir" status --porcelain)" ]] || fail "$dir 有未提交改动，部署只接受干净工作树"
}
