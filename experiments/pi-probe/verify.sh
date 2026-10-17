#!/usr/bin/env bash
# Replays the two acceptance items that need a fresh run: (a) config and auth
# inheritance and (d) stopping a live agent plus resuming its session.
#
# Everything runs against the managed Pi at $PI_BIN. No ~/.pi file is written;
# probe sessions go to a temp directory, never to ~/.pi/agent/sessions.
set -uo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PI_BIN="${PI_BIN:-/Users/snake/.pi/agent/bin/pi}"
tmp="$(mktemp -d "${TMPDIR:-/tmp}/pi-probe-verify.XXXXXX")"
pass=0
fail=0

check() { # check <label> <expected-substring> <actual>
  if grep -qF -- "$2" <<<"$3"; then
    echo "PASS  $1"
    pass=$((pass + 1))
  else
    echo "FAIL  $1"
    echo "      expected to contain: $2"
    echo "      actual: ${3:0:400}"
    fail=$((fail + 1))
  fi
}

echo "== a) config and auth inheritance =="
a_out="$(env -i HOME="$HOME" PATH="/opt/homebrew/bin:/usr/bin:/bin" \
  "$PI_BIN" -p --session-dir "$tmp/a-sessions" "Reply with exactly PROBE_A_OK" 2>&1)"
check "auth comes from ~/.pi with no API key in the environment" "PROBE_A_OK" "$a_out"

mkdir -p "$tmp/empty-agent"
a_negative="$(env HOME="$tmp/empty" PI_CODING_AGENT_DIR="$tmp/empty/agent" \
  "$PI_BIN" -p --offline --session-dir "$tmp/empty/sessions" "Reply with exactly SHOULD_NOT_WORK" 2>&1)"
check "an empty config dir loses auth (control)" "No API key found" "$a_negative"

echo
echo "== d) stop a live agent, then resume its session =="
node "$here/d-abort.mjs" >"$tmp/d-abort.out" 2>"$tmp/d-abort.err"
check "abort response is a success" '"success": true' "$(cat "$tmp/d-abort.out")"
check "agent is not streaming after abort" '"isStreamingAfterAbort": false' "$(cat "$tmp/d-abort.out")"
check "session run settled as aborted" '"agentSettledAbortedFlag": true' "$(cat "$tmp/d-abort.out")"
check "child exits cleanly" '"code": 0' "$(cat "$tmp/d-abort.out")"

d_resume="$("$PI_BIN" -p --session-dir "$here/results/d-sessions" --session probe-d --tools bash \
  "Without running any command, answer in one line: what task was aborted?" 2>&1)"
check "aborted session resumes with its history" "aborted" "$d_resume"

echo
echo "passed=$pass failed=$fail"
rm -rf "$tmp"
[ "$fail" -eq 0 ]
