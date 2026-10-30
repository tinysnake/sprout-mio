#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != az-p5a-live-worker ]; }; then
  printf "Usage: bash %s [--only az-p5a-live-worker]\n" "$0" >&2
  exit 2
fi
# The ordinary verify runner disables Pi. Live explicitly enables it in the fixture.
# 两个场景都走真实模型。提供方偶发失败时 run 以 model_error 结束，重跑一次；
# 只有这次尝试自己新建的证据目录里出现 model_error 才重跑——上一轮的旧错误不算理由。
# 提供方账户没有余额与产品无关，改用本地网关上的模型重跑一次，并把这件事说出来。
result=0
live_model="${SPROUT_VERIFY_PI_MODEL:-deepseek/deepseek-flash}"
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
  for attempt_number in 1 2 3; do
    before="$(latest_dir "$scenario")"
    if output="$(bash "scripts/verify-live/${runner}.sh" 2>&1)"; then
      printf '%s\n' "$output"
      scenario_result=0
      break
    fi
    printf '%s\n' "$output"
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
