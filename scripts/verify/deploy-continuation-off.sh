#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
evidence="${DEPLOY_CONTINUATION_EVIDENCE_DIR:-$PWD/.verify/deploy-continuation-off}"
for mode in false true; do
  export P6A_EVIDENCE_DIR="$evidence/$mode"
  mkdir -p "$P6A_EVIDENCE_DIR"
  export DATABASE_URL="$P6A_EVIDENCE_DIR/verification.sqlite"
  rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6A_EVIDENCE_DIR/continuation-evidence.json"
  SPROUT_CONTINUATION_ENABLED="$mode" node --import tsx tests/fixtures/p6a-schedule.ts deploy-continuation-off
done
