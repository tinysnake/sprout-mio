#!/usr/bin/env bash
# 把某个 tag 部署到 prod：备份 -> 取代码 -> 安装构建 -> 迁移演练 -> 迁移 -> 重启。
# 任何一步失败都恢复备份并重起旧代码。
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

tag="${1:-}"
[[ -n "$tag" ]] || fail "用法：promote.sh <tag>"
require_cmd git

dir="$(instance_dir prod)"
app="$dir/app"
load_env prod
port="$(port_for prod)"

mkdir -p "$dir/backups" "$dir/logs" "$dir/state"
if [[ ! -d "$app/.git" ]]; then
  say "首次部署：克隆到 $app"
  git clone --quiet "$(deploy_remote)" "$app"
fi

previous="$(git -C "$app" rev-parse --short HEAD 2>/dev/null || echo none)"
backup="$(bash "$REPO_ROOT/scripts/deploy/backup.sh" prod | tail -1)"
say "部署前备份：$backup"

restore() {
  printf 'FAIL %s\n' "$1" >&2
  bash "$REPO_ROOT/scripts/deploy/stop.sh" prod >/dev/null 2>&1 || true
  cp "$backup" "$(db_path prod)"
  if [[ "$previous" != "none" ]]; then
    git -C "$app" checkout --quiet "$previous"
    pnpm --dir "$app" install --frozen-lockfile >/dev/null 2>&1 || true
    pnpm --dir "$app" build >/dev/null 2>&1 || true
    bash "$REPO_ROOT/scripts/deploy/start.sh" prod >/dev/null 2>&1 || true
  fi
  fail "$1（已恢复备份 ${backup} 与提交 ${previous}）"
}

git -C "$app" fetch --quiet origin --tags
# 部署目录里只该有构建产物与依赖：本地改动与未跟踪文件都会挡住 checkout。
git -C "$app" reset --hard --quiet
git -C "$app" clean -qfd
git -C "$app" checkout --quiet "$tag" || restore "取不到 tag $tag"
pnpm --dir "$app" install --frozen-lockfile >/dev/null || restore "依赖安装失败"
pnpm --dir "$app" build >/dev/null || restore "构建失败"

bash "$REPO_ROOT/scripts/deploy/check-migration.sh" "$(db_path prod)" "$app" || restore "迁移演练未通过"

bash "$REPO_ROOT/scripts/deploy/stop.sh" prod >/dev/null 2>&1 || true
DATABASE_URL="$(db_path prod)" pnpm --dir "$app" db:migrate >"$dir/logs/migrate.log" 2>&1 || restore "正式库迁移失败"
bash "$REPO_ROOT/scripts/deploy/start.sh" prod >/dev/null || restore "启动失败"
bash "$REPO_ROOT/scripts/deploy/verify.sh" prod >/dev/null || restore "部署后校验失败"

printf '%s\n' "$previous" > "$dir/state/previous-deploy"
printf '%s\n' "$tag" > "$dir/state/current-deploy"
say "PASS prod 已部署 ${tag}（原 ${previous}），备份 ${backup}"
