#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export P6A_EVIDENCE_DIR="${P6A_EVIDENCE_DIR:-$PWD/.verify/p6a-integration}"
mkdir -p "$P6A_EVIDENCE_DIR"
export DATABASE_URL="$P6A_EVIDENCE_DIR/verification.sqlite"
rm -f "$DATABASE_URL" "$DATABASE_URL-wal" "$DATABASE_URL-shm" "$P6A_EVIDENCE_DIR/integration-result.json"
node --import tsx tests/fixtures/p6a-schedule.ts integration
