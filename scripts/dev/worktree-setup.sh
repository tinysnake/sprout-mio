#!/usr/bin/env bash
# 新 worktree 的开发环境准备。gitignore 掉的本地文件（.env.local、AGENTS.local.md、.pi/、data/）
# 不会随 git 检出进入 worktree，缺了它们 agent 会退回主 checkout 干活，隔离就失效了。

set -uo pipefail

fail() { printf '%s\n' "$*" >&2; exit 1; }

root="$(git rev-parse --show-toplevel 2>/dev/null)" || fail "当前目录不在 git 工作区里"
main_checkout="$(git worktree list --porcelain | sed -n 's/^worktree //p' | head -1)"

[ -n "$main_checkout" ] || fail "找不到主 checkout"
[ "$root" = "$main_checkout" ] && fail "$root 是主 checkout，只用于 main 的集成与评审，不在这里准备开发环境"

cd "$root" || fail "进入 $root 失败"

pnpm install --prefer-offline || fail "pnpm install 失败"

for name in .env.local AGENTS.local.md; do
  if [ -e "$main_checkout/$name" ] && [ ! -e "$root/$name" ]; then
    ln -s "$main_checkout/$name" "$root/$name" || fail "链接 $name 失败"
  fi
done

if [ -e "$main_checkout/.pi" ] && [ ! -e "$root/.pi" ]; then
  cp -R "$main_checkout/.pi" "$root/.pi" || fail "复制 .pi 失败"
fi

if [ -e "$main_checkout/.agents/dev-pipeline" ] && [ ! -e "$root/.agents/dev-pipeline" ]; then
  ln -s "$main_checkout/.agents/dev-pipeline" "$root/.agents/dev-pipeline"
fi

mkdir -p data
pnpm db:migrate >/dev/null || fail "本地库迁移失败"

printf 'worktree ready: %s\nbranch: %s\n' "$root" "$(git branch --show-current)"
