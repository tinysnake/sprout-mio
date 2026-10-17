#!/usr/bin/env bash
# Reruns the 12-cell recovery matrix. The harness is launched in the background
# and polled so a slow cell can never block this shell; its output is kept under
# evidence/matrix-run.txt. Exits non-zero if any cell's promise does not hold.
set -u
cd "$(dirname "$0")/.."
mkdir -p evidence
log="evidence/matrix-run.txt"

node scripts/matrix.mjs >"$log" 2>&1 &
pid=$!
while kill -0 "$pid" 2>/dev/null; do
  sleep 2
done
wait "$pid"
status=$?

cat "$log"
exit "$status"
