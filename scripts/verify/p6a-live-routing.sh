#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source scripts/verify/lib/live-model.sh
# A missing small-brain model still leaves an explicit failed receipt for both providers.
sprout_live_model || true
export SPROUT_VERIFY_DIR="${SPROUT_VERIFY_DIR:-.verify/p6a-live-routing/$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$SPROUT_VERIFY_DIR"
export DATABASE_URL="$SPROUT_VERIFY_DIR/live.sqlite"
export SPROUT_PI_ENABLED=false
node --import tsx src/db/migrate.ts
node --import tsx tests/fixtures/p6a-live-routing.ts
