#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/verify/lib/live-model.sh
# A missing small-brain model still leaves an explicit failed receipt for both providers.
sprout_live_model || true
# JEV takes its own credential, so the gate accepts it from the environment or this
# checkout's .env. Without it every JEV case records an explicit failed receipt.
if [ -z "${JEV_API_KEY:-}" ] && [ -f .env ]; then
  JEV_API_KEY="$(
    sed -n 's/^JEV_API_KEY=//p' .env |
      tail -1 |
      sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/" -e 's/[[:space:]]*$//'
  )"
fi
export JEV_API_KEY="${JEV_API_KEY:-}"
# The JEV service answers HTTP 451 "not available in your region" on this host's
# direct egress and 200 through the operator's proxy, so the gate lets Node's fetch
# honour the proxy environment the rest of this checkout already uses.
if [ -n "${https_proxy:-}${HTTPS_PROXY:-}${all_proxy:-}${ALL_PROXY:-}" ]; then
  export NODE_USE_ENV_PROXY=1
fi
export SPROUT_VERIFY_DIR="${SPROUT_VERIFY_DIR:-.verify/p6a-live-routing/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$SPROUT_VERIFY_DIR"
export DATABASE_URL="$SPROUT_VERIFY_DIR/live.sqlite"
export SPROUT_PI_ENABLED=false
node --import tsx src/db/migrate.ts
node --import tsx tests/fixtures/p6a-live-routing.ts
