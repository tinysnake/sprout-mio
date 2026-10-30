#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != az-p5a-live-worker ]; }; then
  printf "Usage: bash %s [--only az-p5a-live-worker]\n" "$0" >&2
  exit 2
fi
# The ordinary verify runner disables Pi. Live explicitly enables it in the fixture.
# 两个场景都走真实模型。提供方偶发失败时 run 以 model_error 结束，重跑一次；
# 确定性缺陷（提示词、工具、扇出逻辑）在重跑里会以同样方式失败。
result=0
retry_after_model_error() {
  local scenario="$1" log
  log="$(ls -dt .verify/p5a-live-*-"$scenario"-* 2>/dev/null | head -1)/service.log"
  [ -f "$log" ] && grep -q "errorCode: 'model_error'" "$log"
}
for scenario in group channel; do
  runner="p5a-group-fanout"
  [ "$scenario" = channel ] && runner="p5a-channel-mention"
  if bash "scripts/verify-live/${runner}.sh"; then
    continue
  fi
  if retry_after_model_error "$scenario"; then
    echo "RETRY ${runner} after the model provider failed the turn"
    bash "scripts/verify-live/${runner}.sh" || result=1
  else
    result=1
  fi
done
exit "$result"
