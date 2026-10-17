#!/usr/bin/env bash
# Re-runs the contract suite against real SQLite (in-memory + file connections).
# Exit code is the verdict.
set -uo pipefail

cd "$(dirname "$0")/.."
mkdir -p .verify

echo "== typecheck =="
npx tsc --noEmit || exit 1
echo "typecheck: PASS"

echo
echo "== checks =="
node src/run.ts 2>&1 | tee .verify/checks.log
exit "${PIPESTATUS[0]}"
