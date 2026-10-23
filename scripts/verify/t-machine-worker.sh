#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NO_PROXY=localhost,127.0.0.1,::1
export no_proxy="$NO_PROXY"
node tests/fixtures/machine-http.mjs
