#!/usr/bin/env bash
# Risk -> assertion: a start message could be linked in SQLite without reaching Pi.
# Assert original messageId + complete snapshot in real runner stdin, SDK session
# and model request, for both first prompt and same-run steer. Adjacent observations
# assert stable prompt counts/prefixes; a withheld real ACK + cancellation asserts
# attempted input is preserved and never retried. Actual /api/remote/agent receipts
# assert Task allowlist/scoping, and a real Worker shell proves the execution chain.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE:-model-fixture}"
case "$SPROUT_VERIFY_CHAT_MODE" in
  model-fixture|live) ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [ "$#" -ne 0 ] && { [ "$#" -ne 2 ] || [ "$1" != --only ] || [ "$2" != bb-task-live ]; }; then
  echo 'Usage: bash scripts/verify/bb-task-live.sh [--only bb-task-live]' >&2
  exit 2
fi
if [ -n "${SPROUT_PI_RUNNER-}" ]; then
  echo 'bb-task-live requires the real Pi runner; remove SPROUT_PI_RUNNER' >&2
  exit 2
fi
if [ "$SPROUT_VERIFY_CHAT_MODE" = live ]; then
  source scripts/verify/lib/live-model.sh
  sprout_live_model
fi
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
# mktemp owns a new evidence root; retries never inspect historical directories.
mkdir -p .verify
evidence="$(mktemp -d "$(pwd)/.verify/task-live-XXXXXXXX")"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/exit-code"; printf "EVIDENCE %s (exit %s)\n" "$evidence" "$code"' EXIT
git rev-parse HEAD > "$evidence/base-commit"
shasum -a 256 tests/fixtures/task-live.ts scripts/verify/bb-task-live.sh scripts/pi-host-runner.mjs scripts/verify/lib/model-fixture.mjs > "$evidence/source-sha256.txt"
source scripts/verify/lib/ensure-worker-artifact.sh
if [ ! -d node_modules ]; then
  node scripts/verify/prepare.mjs install > "$evidence/install.log" 2>&1
fi
node scripts/verify/prepare.mjs server > "$evidence/build-service.log" 2>&1
ensure_worker_artifact > "$evidence/build-worker.log" 2>&1
for attempt in 1 2; do
  export SPROUT_TASK_EVIDENCE_DIR="$evidence/attempt-$attempt"
  mkdir -m 700 "$SPROUT_TASK_EVIDENCE_DIR"
  set +e
  node --import tsx tests/fixtures/task-live.ts > "$SPROUT_TASK_EVIDENCE_DIR/fixture.log" 2>&1
  result=$?
  set -e
  printf '%s\n' "$result" > "$SPROUT_TASK_EVIDENCE_DIR/exit-code"
  # Print the retained log without a pipeline that could hide the runner exit.
  while IFS= read -r line; do printf '%s\n' "$line"; done < "$SPROUT_TASK_EVIDENCE_DIR/fixture.log"
  [ "$result" -ne 0 ] || exit 0
  [ "$SPROUT_VERIFY_CHAT_MODE" = live ] && [ "$attempt" -eq 1 ] || exit "$result"
  if ! node --input-type=module - "$SPROUT_TASK_EVIDENCE_DIR" <<'NODE'
import { readFileSync } from 'node:fs';
const root = process.argv[2];
const result = JSON.parse(readFileSync(`${root}/result.json`, 'utf8'));
const text = readFileSync(`${root}/transcripts.json`, 'utf8') + readFileSync(`${root}/service.log`, 'utf8');
process.exit(result.runs?.some(run => run.error_code === 'model_error') && !/insufficient_balance|Insufficient Balance/.test(text) ? 0 : 1);
NODE
  then
    exit "$result"
  fi
  echo 'RETRY bb-task-live once after model_error in this invocation evidence'
done
exit 1
