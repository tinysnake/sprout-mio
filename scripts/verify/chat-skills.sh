#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# 这门禁需要宿主已安装的托管 Pi SDK（bin/pi 或 install/releases 任一形态）。先决条件不在时
# 打印 SKIP 并退出 77，runner 会记为 skipped：不计失败，也不产生通过结论。
node scripts/verify/lib/host-pi-sdk.mjs chat-skills || exit $?
mkdir -p .verify/chat-skills
pnpm test tests/chat-skills-foundation.test.ts tests/chat-skills-candidate.test.ts tests/chat-skills-spans.test.ts tests/chat-skills-edges.test.ts tests/chat-skills-expansion.test.ts tests/chat-skills-delivery.test.ts 2>&1 | tee .verify/chat-skills/gate.log
printf "%s\n" "PASS chat-skills :: seven groups: scoped discovery; candidate insertion; frozen transactional spans; inline chip text; chip edge spacing; prompt+steer/context receipt; failure boundaries"
