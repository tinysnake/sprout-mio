#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
export SPROUT_VERIFY_CHAT_MODE=model-fixture
export SPROUT_PI_ENABLED=false
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
mkdir -p .verify
export SPROUT_P7_LOOP_EVIDENCE_DIR="$(mktemp -d "$PWD/.verify/p7-loop-multiround-XXXXXXXX")"
evidence="$SPROUT_P7_LOOP_EVIDENCE_DIR"
trap 'code=$?; printf "%s\n" "$code" > "$evidence/exit-code"; printf "EVIDENCE %s exit=%s\n" "$evidence" "$code"' EXIT
git rev-parse HEAD > "$evidence/base-commit"
{ git ls-files -z src drizzle package.json pnpm-lock.yaml | xargs -0 shasum -a 256
  shasum -a 256 tests/fixtures/p7-loop-*.ts scripts/verify/p7-loop-*.sh scripts/verify/lib/model-fixture.mjs
} > "$evidence/source-sha256.txt"
[ -z "${SPROUT_PI_RUNNER-}" ] || { echo 'P7 requires the production Pi runner' >&2; exit 2; }
node scripts/verify/prepare.mjs server > "$evidence/build-server.log" 2>&1
source scripts/verify/lib/ensure-worker-artifact.sh
ensure_worker_artifact > "$evidence/build-worker.log" 2>&1
node --import tsx tests/fixtures/p7-loop-multiround.ts
