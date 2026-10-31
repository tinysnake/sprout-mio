#!/usr/bin/env bash
# Risk -> assertion: a run's turn snapshot drifts once facts change -> same runId reads the
# same bytes and hash, a second run gets its own.  Change hints spam the live run -> several
# changes merge into one bounded hint inside the merge window and the minimum interval, and
# the hint writes no message, run, input or lease row.  Ordinary change wakes an idle
# instance -> zero new runs/inputs/sessions while the scheduler is armed and the page polls.
# Visibility reads as authority -> a real grant reads status, runs and leases, is refused the
# Chat/Task bodies and every write, and sees foreign ids as not_found.  Agent status leaks
# across Projects -> each Project sees only its own instances, Chats and leases.  Views drift
# from their objects -> one transaction returns the four views next to the raw rows and they
# agree field by field, and the HTTP path serves the same bytes.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
if [ "$#" -ne 0 ]; then
  echo 'Usage: bash scripts/verify/bf-p6b-lifecycle.sh' >&2
  exit 2
fi
if [ -n "${SPROUT_PI_RUNNER-}" ]; then
  echo 'bf-p6b-lifecycle requires the real Pi runner; remove SPROUT_PI_RUNNER' >&2
  exit 2
fi
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
mkdir -p .verify
evidence="$(mktemp -d "$(pwd)/.verify/p6b-lifecycle-XXXXXXXX")"
chmod 700 "$evidence"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/exit-code"; printf "EVIDENCE %s (exit %s)\n" "$evidence" "$code"' EXIT
git rev-parse HEAD > "$evidence/base-commit"
shasum -a 256 tests/fixtures/p6b-lifecycle.ts scripts/verify/bf-p6b-lifecycle.sh \
  scripts/pi-host-runner.mjs scripts/verify/lib/model-fixture.mjs > "$evidence/source-sha256.txt"
source scripts/verify/lib/ensure-worker-artifact.sh
if [ ! -d node_modules ]; then
  node scripts/verify/prepare.mjs install > "$evidence/install.log" 2>&1
fi
node scripts/verify/prepare.mjs server > "$evidence/build-service.log" 2>&1
ensure_worker_artifact > "$evidence/build-worker.log" 2>&1
set +e
SPROUT_P6B_EVIDENCE_DIR="$evidence/fixture" node --import tsx tests/fixtures/p6b-lifecycle.ts \
  > "$evidence/fixture.log" 2>&1
result=$?
set -e
# Print the retained log without a pipeline that could hide the runner exit.
while IFS= read -r line; do printf '%s\n' "$line"; done < "$evidence/fixture.log"
printf '%s\n' "$result" > "$evidence/fixture-exit-code"
exit "$result"
