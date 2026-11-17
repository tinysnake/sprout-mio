#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AB_DRY="${AB_DRY:-1}"
if [[ "$AB_DRY" == 0 ]]; then
  source scripts/verify/lib/live-model.sh
  sprout_live_model
elif [[ "$AB_DRY" != 1 ]]; then
  echo 'FAIL AB_DRY must be 1 (local fixture) or 0 (paid live)' >&2
  exit 1
fi
exec node scripts/verify-live/assistant-guide-ab/main.mjs
