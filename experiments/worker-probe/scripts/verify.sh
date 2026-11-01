#!/usr/bin/env bash
# Reruns the four P0 worker-protocol probes in order and keeps each log under
# .verify-artifacts/. Exits non-zero if any probe fails.
set -u
cd "$(dirname "$0")/.."
mkdir -p .verify-artifacts
fails=0
for probe in probes/0*.mjs; do
  name="$(basename "$probe" .mjs)"
  log=".verify-artifacts/${name}.log"
  if node "$probe" >"$log" 2>&1; then
    echo "PASS ${name}"
  else
    echo "FAIL ${name}"
    cat "$log"
    fails=$((fails + 1))
  fi
done
echo "---"
if [ "$fails" -eq 0 ]; then
  echo "ALL PASS ($(ls probes/0*.mjs | wc -l | tr -d ' ') probes)"
else
  echo "${fails} FAILED"
fi
exit "$fails"
