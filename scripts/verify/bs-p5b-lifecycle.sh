#!/usr/bin/env bash
# Risk -> assertion: assignment accidentally starts work -> zero runs/inputs until explicit start.
# Start fanout/late delivery -> original owner prompt, depth-one collaboration, ready/ACK barriers.
# Observer integrity -> per-connection FIFO, flushed stdout receipt before model release, exit audit.
# Concurrent records/results -> paired HTTP release, one revision winner, immutable event boundaries.
# Chat leakage -> real old grant not_found; new grant restricted record and forbidden old reference.
# Lifecycle coupling -> runner completion/model_error preserves Task; Task completion preserves lease/Machine.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE-model-fixture}"
case "$SPROUT_VERIFY_CHAT_MODE" in
  model-fixture|live) ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != bs-p5b-lifecycle ]; }; then
  echo 'Usage: bash scripts/verify/bs-p5b-lifecycle.sh [--only bs-p5b-lifecycle]' >&2
  exit 2
fi
if [ -n "${SPROUT_PI_RUNNER-}" ]; then
  echo 'bs-p5b-lifecycle requires the real Pi runner; remove SPROUT_PI_RUNNER' >&2
  exit 2
fi
if [ "$SPROUT_VERIFY_CHAT_MODE" = live ]; then
  source scripts/verify/lib/live-model.sh
  sprout_live_model
fi
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
mkdir -p .verify
evidence="$(mktemp -d "$(pwd)/.verify/task-lifecycle-XXXXXXXX")"
chmod 700 "$evidence"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/exit-code"; printf "EVIDENCE %s (exit %s)\n" "$evidence" "$code"' EXIT
git rev-parse HEAD > "$evidence/base-commit"
shasum -a 256 tests/fixtures/task-lifecycle.ts scripts/verify/bs-p5b-lifecycle.sh scripts/pi-host-runner.mjs scripts/verify/lib/model-fixture.mjs > "$evidence/source-sha256.txt"
source scripts/verify/lib/ensure-worker-artifact.sh
if [ ! -d node_modules ]; then
  node scripts/verify/prepare.mjs install > "$evidence/install.log" 2>&1
fi
node scripts/verify/prepare.mjs server > "$evidence/build-service.log" 2>&1
ensure_worker_artifact > "$evidence/build-worker.log" 2>&1
export SPROUT_TASK_EVIDENCE_DIR="$evidence/run"
mkdir -m 700 "$SPROUT_TASK_EVIDENCE_DIR"
set +e
node --import tsx tests/fixtures/task-lifecycle.ts > "$SPROUT_TASK_EVIDENCE_DIR/fixture.log" 2>&1
result=$?
set -e
while IFS= read -r line; do printf '%s\n' "$line"; done < "$SPROUT_TASK_EVIDENCE_DIR/fixture.log"
exit "$result"
