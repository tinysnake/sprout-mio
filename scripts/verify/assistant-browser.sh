#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node tests/fixtures/webhook-live.mjs --assistant
pnpm exec tsx tests/fixtures/assistant-feedback.ts
