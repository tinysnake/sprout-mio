#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
node scripts/verify/prepare.mjs server
node tests/fixtures/webhook-live.mjs --cron
