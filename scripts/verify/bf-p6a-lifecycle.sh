#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export P6A_EVIDENCE_DIR="${P6A_EVIDENCE_DIR:-$PWD/.verify/p6a-lifecycle}"
mkdir -p "$P6A_EVIDENCE_DIR/run"; git rev-parse HEAD > "$P6A_EVIDENCE_DIR/base-commit"
git ls-files -z src drizzle pnpm-lock.yaml package.json | xargs -0 shasum -a 256 > "$P6A_EVIDENCE_DIR/source-sha256.txt"; shasum -a 256 tests/fixtures/p6a-lifecycle.ts scripts/verify/bf-p6a-lifecycle.sh >> "$P6A_EVIDENCE_DIR/source-sha256.txt"
status=0; node --import tsx tests/fixtures/p6a-lifecycle.ts || status=$?
printf '%s\n' "$status" > "$P6A_EVIDENCE_DIR/exit-code"; exit "$status"
