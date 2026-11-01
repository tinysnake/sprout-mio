#!/usr/bin/env bash
# 把打包产物推到 worker-dist 分支。Worker 机器 clone 那个分支即可，不需要包管理器。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
source scripts/deploy/lib.sh

branch="${WORKER_DIST_BRANCH:-worker-dist}"
remote="$(deploy_remote)"
work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-worker-dist.XXXXXX")"
trap 'rm -rf "$work"' EXIT

bash scripts/worker/package.sh "$work/out" >/dev/null
version="$(cat "$work/out/VERSION")"
{
  printf '# Sprout Worker 构建产物\n\n'
  printf '这个分支只有 Worker 的运行文件，没有源码，也不需要包管理器。\n\n'
  printf '```bash\n'
  printf 'git clone --depth 1 --branch %s %s ~/sprout-worker\n' "$branch" "$remote"
  printf 'node ~/sprout-worker/main.js version\n'
  printf 'node ~/sprout-worker/main.js init --server <origin> --machine <id> --ticket-file <file> --state-dir <directory>\n'
  printf 'node ~/sprout-worker/main.js run --state-dir <directory>\n'
  printf '```\n\n'
  printf '更新：`git -C ~/sprout-worker fetch origin %s && git -C ~/sprout-worker reset --hard origin/%s`\n\n' "$branch" "$branch"
  printf '版本：`%s`\n' "$version"
} > "$work/out/README.md"

git -C "$work/out" init --quiet
git -C "$work/out" add -A
git -C "$work/out" -c user.name="sprout-worker" -c user.email="worker-dist@localhost" \
  commit --quiet -m "worker dist $version"
git -C "$work/out" push --quiet --force "$remote" "HEAD:refs/heads/$branch"
printf 'PASS 已推送 %s 到 %s（%s）\n' "$branch" "$remote" "$version"
