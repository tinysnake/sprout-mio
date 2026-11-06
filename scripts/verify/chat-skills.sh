#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
mkdir -p .verify/chat-skills
pnpm test tests/chat-skills-foundation.test.ts tests/chat-skills-candidate.test.ts tests/chat-skills-spans.test.ts tests/chat-skills-edges.test.ts tests/chat-skills-expansion.test.ts tests/chat-skills-delivery.test.ts 2>&1 | tee .verify/chat-skills/gate.log
printf "%s\n" "PASS chat-skills :: seven groups: scoped discovery; candidate insertion; frozen transactional spans; inline chip text; chip edge spacing; prompt+steer/context receipt; failure boundaries"
