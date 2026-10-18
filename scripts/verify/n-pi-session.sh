#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
bash scripts/verify-live/pi-dm-turn.sh --protocol-stub
