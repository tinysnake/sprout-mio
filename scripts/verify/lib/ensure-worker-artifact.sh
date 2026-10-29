#!/usr/bin/env bash
ensure_worker_artifact() {
  node scripts/verify/prepare.mjs worker
  [ -f dist/worker/main.js ] || {
    printf 'FAIL missing dist/worker/main.js after node scripts/verify/prepare.mjs worker\n'
    exit 1
  }
}
