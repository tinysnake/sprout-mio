#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
node scripts/verify/prepare.mjs server
node scripts/verify/drain-http.mjs
