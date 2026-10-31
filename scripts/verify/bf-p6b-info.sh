#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export NODE_ENV=test
export NO_PROXY=localhost,127.0.0.1
export no_proxy="$NO_PROXY"
# P6b info: production domain/transport against a temporary real SQLite database.
pnpm exec tsx tests/fixtures/p6b-info.ts
