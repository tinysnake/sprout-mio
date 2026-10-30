#!/usr/bin/env bash
# Shared live setup; every invocation keeps its own evidence, including build failures.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
scenario="$1"
export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE:-model-fixture}"
case "$SPROUT_VERIFY_CHAT_MODE" in
  model-fixture|live) ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [ "$SPROUT_VERIFY_CHAT_MODE" = live ]; then
  source scripts/verify/lib/live-model.sh
  sprout_live_model
fi
export SPROUT_P5A_EVIDENCE_DIR="$(pwd)/.verify/p5a-live-$(date +%Y%m%d-%H%M%S)-${scenario}-$$"
mkdir -m 700 -p "$SPROUT_P5A_EVIDENCE_DIR"
git rev-parse HEAD > "$SPROUT_P5A_EVIDENCE_DIR/base-commit"
shasum -a 256 tests/fixtures/p5a-live.ts scripts/verify-live/p5a-*.sh scripts/verify/az-p5a-live-worker.sh scripts/verify/lib/model-fixture.mjs > "$SPROUT_P5A_EVIDENCE_DIR/source-sha256.txt"
trap 'code=$?; printf "%s\n" "$code" > "$SPROUT_P5A_EVIDENCE_DIR/exit-code"; printf "EVIDENCE %s (exit %s)\n" "$SPROUT_P5A_EVIDENCE_DIR" "$code"' EXIT
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
source scripts/verify/lib/ensure-worker-artifact.sh
if [ ! -d node_modules ]; then
  node scripts/verify/prepare.mjs install > "$SPROUT_P5A_EVIDENCE_DIR/install.log" 2>&1
fi
node scripts/verify/prepare.mjs server > "$SPROUT_P5A_EVIDENCE_DIR/build-service.log" 2>&1
ensure_worker_artifact > "$SPROUT_P5A_EVIDENCE_DIR/build-worker.log" 2>&1
node --import tsx tests/fixtures/p5a-live.ts "$scenario"
