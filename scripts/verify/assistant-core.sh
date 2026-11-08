#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm exec vp test run tests/assistant-core.test.ts tests/assistant-gateway.test.ts tests/automation-contracts.test.ts tests/automation-core.test.ts tests/automation-http.test.ts tests/automation-migration.test.ts tests/cron-core.test.ts tests/cron-migration.test.ts tests/cron-schedule.test.ts tests/agent-run-turn.test.ts tests/chat-governance.test.ts tests/membership-view.test.ts tests/runtime.test.ts
