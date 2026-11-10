#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm exec vp test run tests/automation-contracts.test.ts tests/automation-core.test.ts tests/automation-http.test.ts tests/automation-migration.test.ts tests/chat.test.ts tests/chat-wake.test.ts tests/agent-run-turn.test.ts tests/task-start.test.ts tests/task-migration.test.ts tests/run-activity-ui.test.ts
