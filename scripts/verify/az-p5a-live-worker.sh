#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != az-p5a-live-worker ]; }; then
  printf "Usage: bash %s [--only az-p5a-live-worker]\n" "$0" >&2
  exit 2
fi
# The ordinary verify runner disables Pi. Live explicitly enables it in the fixture.
result=0
bash scripts/verify-live/p5a-group-fanout.sh || result=1
bash scripts/verify-live/p5a-channel-mention.sh || result=1
exit "$result"
