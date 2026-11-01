#!/usr/bin/env bash
# Worker 机器只用 git clone 就能跑：产物自包含、clone 后可直接执行、版本自证。
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

fail() { printf 'FAIL worker-dist: %s\n' "$*" >&2; exit 1; }
work="$(mktemp -d "${TMPDIR:-/tmp}/sprout-worker-dist-gate.XXXXXX")"
trap 'rm -rf "$work"' EXIT

bash scripts/worker/package.sh "$work/source" >/dev/null || fail "打包失败"
[[ -f "$work/source/main.js" ]] || fail "缺少 main.js"
[[ -f "$work/source/runner.js" ]] || fail "缺少 runner.js"
echo "PASS 产物自包含（仅 node 内置模块）"

version="$(cat "$work/source/VERSION")"
[[ -n "$version" ]] || fail "VERSION 为空"
echo "PASS 版本自证：$version"

help_text="$(node "$work/source/main.js" help)"
grep -q 'init' <<<"$help_text" || fail "help 没有提到 init"
grep -q '^sprout-worker run ' <<<"$help_text" || fail "help 没有提到 run"
echo "PASS help 列出 init 与 run"

size="$(wc -c < "$work/source/main.js")"
(( size < 5000000 )) || fail "main.js 体积异常：$size 字节"

git -C "$work/source" init --quiet
git -C "$work/source" add -A
git -C "$work/source" -c user.name=gate -c user.email=gate@example.test commit --quiet -m dist
git clone --quiet --depth 1 "file://$work/source" "$work/clone" || fail "clone 失败"
cloned_version="$(node "$work/clone/main.js" version | awk '{print $1, $2, $3}')"
[[ "$cloned_version" == "$version" ]] || fail "clone 出来的产物版本不一致：$cloned_version"
echo "PASS git clone 后可直接运行：$cloned_version"

if node "$work/clone/main.js" init >/dev/null 2>&1; then
  fail "init 缺少参数时没有报错"
fi
echo "PASS init 对缺失参数报错"

echo "PASS worker-dist: Worker 机器只要 git 与 node 就能接入"
