#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm exec vp test run tests/feishu.test.ts tests/feishu-risk.test.ts tests/feishu-migration.test.ts tests/channel-delivery.test.ts tests/channel-actions.test.ts tests/channel-migration.test.ts tests/feedback-migration.test.ts tests/assistant-core.test.ts tests/assistant-watch-windows.test.ts tests/assistant-watch-migration.test.ts tests/assistant-gateway.test.ts tests/automation-contracts.test.ts tests/automation-core.test.ts tests/automation-http.test.ts tests/automation-migration.test.ts tests/cron-core.test.ts tests/cron-migration.test.ts tests/cron-schedule.test.ts tests/agent-run-turn.test.ts tests/chat-governance.test.ts tests/membership-view.test.ts tests/runtime.test.ts
