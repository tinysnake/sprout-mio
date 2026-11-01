#!/usr/bin/env bash
# Worker 机器用源码装：安装一次、构建一次，运行期不需要 node_modules。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf 'FAIL worker-artifact: %s\n' "$*" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-worker-artifact.XXXXXX")"
trap 'rm -rf "$work"' EXIT

grep -q '"worker:build"' package.json || fail "package.json 缺少 worker:build"
grep -q '"worker:start"' package.json || fail "package.json 缺少 worker:start"
echo "PASS package.json 提供 worker:build 与 worker:start"

grep -q 'pnpm worker:build' docs/deployment.md || fail "docs/deployment.md 没有写明构建命令"
grep -q 'dist/worker/main.js' docs/deployment.md || fail "docs/deployment.md 没有写明入口"
grep -q 'pnpm install --frozen-lockfile' docs/deployment.md || fail "docs/deployment.md 没有写明安装方式"
echo "PASS 文档写的命令与脚本一致"

bash scripts/worker/package.sh "$work/artifact" >/dev/null || fail "构建失败"
cd "$work/artifact"
[[ -f main.js ]] || fail "缺少 main.js"
[[ -f runner.js ]] || fail "缺少 runner.js"
echo "PASS 构建产物只有 main.js 与 runner.js"

version="$(cat VERSION)"
[[ "$version" == sprout-worker* ]] || fail "VERSION 不可信：$version"
echo "PASS 版本自证：$version"

standalone="$(env -u NODE_PATH node main.js version | awk '{print $1, $2, $3}')"
[[ "$standalone" == "$version" ]] || fail "在没有 node_modules 的目录里跑不起来：$standalone"
echo "PASS 运行期不依赖 node_modules：$standalone"

help_text="$(node main.js help)"
grep -q 'init' <<<"$help_text" || fail "help 没有提到 init"
grep -q '^sprout-worker run ' <<<"$help_text" || fail "help 没有提到 run"
echo "PASS help 列出 init 与 run"

if node main.js init >/dev/null 2>&1; then
  fail "init 缺少参数时没有报错"
fi
echo "PASS init 对缺失参数报错"

echo "PASS worker-artifact: 源码安装构建后，运行期只要 node"
