#!/usr/bin/env bash
# 把实例库里旧格式 id（前缀_UUID）一次性重写成 前缀_8 位 hex，并改名 repos/ 与 pi/ 下的目录。
# 幂等：完成标记写进库，第二次运行零变更；数据库已提交而文件系统中断时，可单独重跑 --fs 续上。
# 必须在实例停机的窗口里跑：DB 与文件系统要在同一次部署内一起落地。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

name="${1:-}"
[[ -n "$name" ]] || fail "用法：rekey-ids.sh <instance>"
require_instance "$name"
require_cmd node

dir="$(instance_dir "$name")"
app="$dir/app"
script="$app/scripts/maintenance/rekey-short-ids.ts"
[[ -f "$script" ]] || fail "实例 $name 的部署目录里没有重写脚本：${script}（先部署含它的 tag）"
load_env "$name"

run() {
  local log
  log="$(mktemp)"
  # DATABASE_URL 让脚本与实例库一致；--db 显式传同一条路径，避免依赖 cwd。
  DATABASE_URL="$(db_path "$name")" node --import tsx "$script" \
    --db "$(db_path "$name")" \
    --repo-root "${SPROUT_REPO_DIR}" \
    --pi-data-root "${SPROUT_PI_DATA_DIR}" "$@" | tee "$log"
  # 入口判断误判时脚本会静默什么都不做并返回 0，所以必须有状态行才算真跑过。
  grep -q '状态：' "$log" || fail "重写脚本没有报出状态行，这次调用实际没跑"
  rm -f "$log"
}

say "ID 重写干跑"
run

say "ID 重写应用（数据库与文件系统）"
run --apply --fs
