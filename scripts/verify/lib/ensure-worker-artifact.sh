#!/usr/bin/env bash
# 依赖 dist/worker/main.js 的验收脚本在入口调用本函数：产物缺失时自行补齐，
# 产物存在时不重复构建。verify.sh 全量轮里早序脚本的 pnpm build 会清掉 dist/，
# 字母序靠后的脚本不得依赖前序脚本的构建副作用（docs/p1/conventions.md：脚本之间不共享进程）。
ensure_worker_artifact() {
  if [ ! -f dist/worker/main.js ]; then
    pnpm worker:build
  fi
  [ -f dist/worker/main.js ] || {
    printf 'FAIL missing dist/worker/main.js after pnpm worker:build\n'
    exit 1
  }
}
