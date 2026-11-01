#!/usr/bin/env bash
# Re-runs the Effect TestClock measurement and checks the four claims the
# migration was scoped on. Exits non-zero when a claim stops holding.
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

out=.verify/effect-clock-spike
mkdir -p "$out"
npx tsx experiments/effect-clock-spike/spike.ts | tee "$out/spike.log"

json=$(grep '^SPIKE_JSON ' "$out/spike.log" | sed 's/^SPIKE_JSON //')
[ -n "$json" ] || { echo "FAIL no SPIKE_JSON line in the output" >&2; exit 1; }

SPIKE_JSON="$json" node --input-type=module -e '
import assert from "node:assert/strict";
const m = JSON.parse(process.env.SPIKE_JSON);
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
  if (!ok) failed += 1;
}
check(
  "TestClock compresses the scheduling decision",
  m.testClockMs < 500 && m.testClockTimedOut === true,
  `${m.testClockMs}ms against the ${m.baselineRealTimerMs}ms real timer`,
);
check(
  "the real timer path still costs real time",
  m.baselineRealTimerMs > 2000,
  `${m.baselineRealTimerMs}ms`,
);
check(
  "injecting now() does not compress scheduling",
  m.injectedClockRealTimerMs > 2000,
  `${m.injectedClockRealTimerMs}ms`,
);
check(
  "Date.now() is not redirected by TestClock",
  m.dateNowRedirected === false,
  `redirected=${m.dateNowRedirected}`,
);
check(
  "a real child process is not compressed",
  m.realChildExitMs > 400 && m.testClockTimeoutDecisionMs < 100,
  `timeout decision ${m.testClockTimeoutDecisionMs}ms, child exit ${m.realChildExitMs}ms`,
);
assert(failed === 0);
'
