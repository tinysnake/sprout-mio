#!/usr/bin/env bash
# 把 Worker 打成两个自包含文件，Worker 机器只要有 node，git 拉下来就能跑。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

out="${1:-}"
[[ -n "$out" ]] || { printf '用法：scripts/worker/package.sh <输出目录>\n' >&2; exit 1; }
command -v node >/dev/null || { printf 'FAIL 缺少 node\n' >&2; exit 1; }

pnpm worker:build >/dev/null
mkdir -p "$out"
cp dist/worker/main.js dist/worker/runner.js "$out"/

external="$(grep -hE '^import .*from "[^"]+"' "$out"/main.js "$out"/runner.js \
  | sed -E 's/.*from "([^"]+)"/\1/' | sort -u \
  | grep -vE '^(node:|\./|\.\./)' || true)"
[[ -z "$external" ]] || { printf 'FAIL 打包产物仍依赖外部包：%s\n' "$external" >&2; exit 1; }

node --check "$out/main.js"
node --check "$out/runner.js"
node "$out/main.js" version | awk '{print $1, $2, $3}' > "$out/VERSION"
grep -q '^sprout-worker ' "$out/VERSION" || { printf 'FAIL 产物跑不起来\n' >&2; exit 1; }
printf 'PASS Worker 产物就绪：%s（main.js + runner.js，仅依赖 node 内置模块）\n' "$out"
