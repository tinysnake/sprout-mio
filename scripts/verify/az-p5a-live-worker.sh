#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
case "${SPROUT_VERIFY_CHAT_MODE-model-fixture}" in
  model-fixture|live) export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE-model-fixture}" ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [[ "$SPROUT_VERIFY_CHAT_MODE" == model-fixture && -n "${SPROUT_PI_RUNNER-}" ]]; then
  echo 'model-fixture requires the real Pi runner; remove SPROUT_PI_RUNNER' >&2
  exit 2
fi
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != az-p5a-live-worker ]; }; then
  printf "Usage: bash %s [--only az-p5a-live-worker]\n" "$0" >&2
  exit 2
fi
# 默认 fixture 模式：两个场景都走真实 Chat、Pi SDK、Worker 和 remote tools，但模型由 loopback
# fixture 提供，routine verify 不产生付费调用。只有显式 live 才使用真实 provider。
# live 模式下提供方偶发失败时 run 以 model_error 结束，重跑一次；只有这次尝试自己新建的证据
# 目录里出现 model_error 才重跑——上一轮的旧错误不算理由。live 不猜模型：
# SPROUT_VERIFY_PI_MODEL 从环境变量或仓库根 .env 读取，缺失时在准备产物前报错退出。显式选择
# 的模型不可用/无余额时，换到网关的兜底模型重跑一次，并把这件事说出来。fixture 失败就是
# 真失败，不重试。
result=0
live_model=""
if [ "$SPROUT_VERIFY_CHAT_MODE" = live ]; then
  source scripts/verify/lib/live-model.sh
  sprout_live_model
  live_model="$SPROUT_VERIFY_PI_MODEL"
fi
fallback_model="magpie/auto/deepseek-v4.1-flash"
model_errors() {
  local log="$1"
  if [ -f "$log" ]; then grep -c "errorCode: 'model_error'" "$log" || true; else echo 0; fi
}
latest_dir() {
  ls -dt .verify/p5a-live-*-"$1"-* 2>/dev/null | head -1 || true
}
no_balance() {
  local dir="$1"
  [ -n "$dir" ] || return 1
  grep -qs "insufficient_balance\|Insufficient Balance" "$dir/transcripts.json" "$dir/service.log"
}
for scenario in group channel; do
  runner="p5a-group-fanout"
  [ "$scenario" = channel ] && runner="p5a-channel-mention"
  scenario_result=1
  attempts=1
  [ "$SPROUT_VERIFY_CHAT_MODE" = live ] && attempts=3
  for attempt_number in $(seq 1 "$attempts"); do
    before="$(latest_dir "$scenario")"
    if output="$(bash "scripts/verify-live/${runner}.sh" 2>&1)"; then
      printf '%s\n' "$output"
      scenario_result=0
      break
    fi
    printf '%s\n' "$output"
    [ "$SPROUT_VERIFY_CHAT_MODE" = live ] || break
    attempt="$(latest_dir "$scenario")"
    if [ -z "$attempt" ] || [ "$attempt" = "$before" ]; then break; fi
    if no_balance "$attempt"; then
      if [ "$live_model" = "$fallback_model" ]; then break; fi
      echo "FALLBACK ${runner} to ${fallback_model}: ${live_model} has no balance"
      live_model="$fallback_model"
      export SPROUT_VERIFY_PI_MODEL="$live_model"
      continue
    fi
    if [ "$(model_errors "$attempt/service.log")" -gt 0 ] && [ "$attempt_number" -lt 2 ]; then
      echo "RETRY ${runner} after the model provider failed this attempt's turn"
      continue
    fi
    break
  done
  [ "$scenario_result" -ne 0 ] && result=1
done
exit "$result"
