#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != az-p5a-live-worker ]; }; then
  printf "Usage: bash %s [--only az-p5a-live-worker]\n" "$0" >&2
  exit 2
fi
# The ordinary verify runner disables Pi. Live explicitly enables it in the fixture.
# 两个场景都走真实模型。提供方偶发失败时 run 以 model_error 结束，重跑一次；
# 只有这一轮自己新增了 model_error 才重跑——日志里躺着别人的旧失败不算理由。
result=0
model_errors() {
  local log="$1"
  if [ -f "$log" ]; then grep -c "errorCode: 'model_error'" "$log" || true; else echo 0; fi
}
for scenario in group channel; do
  runner="p5a-group-fanout"
  [ "$scenario" = channel ] && runner="p5a-channel-mention"
  log="$(ls -dt .verify/p5a-live-*-"$scenario"-* 2>/dev/null | head -1)/service.log"
  before="$(model_errors "$log")"
  if output="$(bash "scripts/verify-live/${runner}.sh" 2>&1)"; then
    printf '%s\n' "$output"
    continue
  fi
  printf '%s\n' "$output"
  after="$(model_errors "$log")"
  if [ "$after" -gt "$before" ]; then
    echo "RETRY ${runner} after the model provider failed this attempt's turn"
    bash "scripts/verify-live/${runner}.sh" || result=1
  else
    result=1
  fi
done
exit "$result"
