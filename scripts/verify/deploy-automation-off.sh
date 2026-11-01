#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
evidence="${DEPLOY_AUTOMATION_EVIDENCE_DIR:-$PWD/.verify/deploy-automation-off}"
for mode in false true; do
  export P6A_EVIDENCE_DIR="$evidence/$mode"
  mkdir -p "$P6A_EVIDENCE_DIR"
  export DATABASE_URL="$P6A_EVIDENCE_DIR/verification.sqlite"
  rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6A_EVIDENCE_DIR/automation-evidence.json"
  SPROUT_AUTOMATION_ENABLED="$mode" node --import tsx tests/fixtures/p6a-schedule.ts deploy-automation-off
done
