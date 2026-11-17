#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export AB_MODEL="${AB_MODEL:-${SPROUT_VERIFY_PI_MODEL:-}}"
if [ -z "$AB_MODEL" ]; then
  echo 'AB_MODEL or SPROUT_VERIFY_PI_MODEL must explicitly name a model' >&2
  exit 2
fi
if [ "${AB_DRY:-0}" != 1 ]; then
  export SPROUT_VERIFY_PI_MODEL="$AB_MODEL"
  source scripts/verify/lib/live-model.sh
  sprout_live_model
fi
exec node scripts/verify-live/crew-prompt-ab/main.mjs --batch "$@"
