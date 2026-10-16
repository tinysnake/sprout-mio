#!/usr/bin/env bash
# Re-runnable acceptance check for the P0 stack experiment.
# Usage: bash scripts/verify.sh
set -euo pipefail
set -m

PORT="${PORT:-3111}"
BASE="http://localhost:${PORT}"
LOG="$(mktemp -t stack-app-dev.XXXXXX.log)"
BODY="$(mktemp -t stack-app-body.XXXXXX)"
FAILED=0

# The shell may export http_proxy; localhost checks must bypass it.
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"
CURL=(curl --noproxy '*' -sS)

step() { printf '\n=== %s\n' "$1"; }
ok() { printf 'PASS  %s\n' "$1"; }
bad() { printf 'FAIL  %s\n' "$1"; FAILED=1; }

cleanup() {
  if [ -n "${DEV_PID:-}" ] && kill -0 "$DEV_PID" 2>/dev/null; then
    # Job control put the dev server in its own process group; kill the tree.
    kill -- -"$DEV_PID" 2>/dev/null || kill "$DEV_PID" 2>/dev/null || true
    wait "$DEV_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  bad "port ${PORT} is already in use; refusing to test against a foreign server"
  exit 1
fi

step "drizzle migrate"
pnpm db:migrate >/dev/null
ok "migrations applied"

step "typecheck"
pnpm typecheck
ok "tsc --noEmit exited 0"

step "production build"
pnpm build >/dev/null
test -f dist/server/server.js
ok "vp build produced dist/server.js"
test -n "$(ls dist/client/assets 2>/dev/null)"
ok "client assets emitted"

step "dev server on :${PORT}"
pnpm exec vp dev --port "$PORT" >"$LOG" 2>&1 &
DEV_PID=$!

ready=0
for _ in $(seq 1 90); do
  if grep -q "ready in" "$LOG" 2>/dev/null && "${CURL[@]}" -f -o /dev/null "${BASE}/" 2>/dev/null; then
    ready=1
    break
  fi
  if ! kill -0 "$DEV_PID" 2>/dev/null; then break; fi
  sleep 1
done

if [ "$ready" != "1" ]; then
  bad "dev server never answered on ${BASE}/"
  tail -40 "$LOG"
  exit 1
fi
ok "dev server responded"

for path in / /api/health /api/auth/ok; do
  code=000
  attempts=0
  for _ in $(seq 1 20); do
    attempts=$((attempts + 1))
    code="$("${CURL[@]}" -o "$BODY" -w '%{http_code}' "${BASE}${path}" || echo 000)"
    [ "$code" = "200" ] && break
    sleep 0.5
  done
  body="$(head -c 200 "$BODY")"
  if [ "$code" = "200" ]; then
    ok "GET ${path} -> 200 after ${attempts} attempt(s) ${body}"
  else
    bad "GET ${path} -> ${code} after ${attempts} attempt(s) ${body}"
  fi
done

health="$("${CURL[@]}" "${BASE}/api/health" || true)"
case "$health" in
  *'"ok":true'*'"probes"'*) ok "Effect ran on the server and wrote/read SQLite via Drizzle: ${health}" ;;
  *) bad "Effect/Drizzle health payload unexpected: ${health}" ;;
esac

step "result"
if [ "$FAILED" = "0" ]; then
  echo "ALL CHECKS PASSED"
else
  echo "CHECKS FAILED"
  echo "--- dev server log (last 40 lines)"
  tail -40 "$LOG"
fi
exit "$FAILED"
