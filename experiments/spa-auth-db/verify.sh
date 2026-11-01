#!/usr/bin/env bash
# Re-runnable verification for the P0 spa-auth-db probe. Every check prints PASS or FAIL
# with its evidence, and the script exits non-zero if any check fails.
set -uo pipefail

cd "$(cd "$(dirname "$0")" && pwd)"

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"
LOG_DIR=".verify"
COOKIE_JAR="${LOG_DIR}/cookies.txt"
TOTAL=0
FAILED=0

rm -rf "$LOG_DIR"
mkdir -p "$LOG_DIR"

pass() {
  TOTAL=$((TOTAL + 1))
  printf 'PASS %s :: %s\n' "$1" "$2"
}

fail() {
  TOTAL=$((TOTAL + 1))
  FAILED=$((FAILED + 1))
  printf 'FAIL %s :: %s\n' "$1" "$2"
}

expect_eq() {
  if [ "$2" = "$3" ]; then
    pass "$1" "$4"
  else
    fail "$1" "$4 [expected=$2 actual=$3]"
  fi
}

json_field() {
  node -e '
    const fs = require("fs")
    const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const value = process.argv[2].split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), data)
    console.log(value === null || value === undefined ? String(value) : String(value))
  ' "$1" "$2"
}

http_status() {
  curl -s -o "$2" -w '%{http_code}' "$1"
}

if [ ! -f .env.local ]; then
  printf 'BETTER_AUTH_URL=http://localhost:%s\nBETTER_AUTH_SECRET=%s\nDATABASE_URL=dev.db\n' \
    "$PORT" "$(node -e 'console.log(require("crypto").randomBytes(32).toString("base64url"))')" > .env.local
fi

echo "== migration replay from an empty database"
rm -f dev.db dev.db-shm dev.db-wal
if npm run db:migrate > "$LOG_DIR/migrate.log" 2>&1; then
  TABLES=$(node -e '
    const Database = require("better-sqlite3")
    const rows = new Database("dev.db").prepare("select name from sqlite_master where type = ? order by name").all("table")
    console.log(rows.map((row) => row.name).join(","))
  ')
  expect_eq "migration_replay_from_empty" \
    "__drizzle_migrations,account,probe_items,session,user,verification" \
    "$TABLES" "drizzle-kit migrate applied 0000 from a deleted dev.db"
else
  fail "migration_replay_from_empty" "drizzle-kit migrate failed, see $LOG_DIR/migrate.log"
fi

echo "== production build"
if npm run build > "$LOG_DIR/build.log" 2>&1; then
  for artifact in .output/public/_shell.html .output/server/index.mjs; do
    if [ -f "$artifact" ]; then
      pass "build_artifact $(basename "$artifact")" "$artifact exists"
    else
      fail "build_artifact $(basename "$artifact")" "$artifact missing"
    fi
  done
else
  fail "production_build" "npm run build failed, see $LOG_DIR/build.log"
fi

echo "== start production server"
PORT="$PORT" node --env-file=.env.local .output/server/index.mjs > "$LOG_DIR/server.log" 2>&1 &
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

READY=no
for _ in $(seq 1 60); do
  if curl -s -o /dev/null "$BASE/api/auth/get-session"; then
    READY=yes
    break
  fi
  sleep 0.5
done

if [ "$READY" = "yes" ]; then
  pass "server_ready" "$BASE answered on port $PORT"
else
  fail "server_ready" "server did not answer, see $LOG_DIR/server.log"
  sed -n '1,40p' "$LOG_DIR/server.log"
  exit 1
fi

echo "== SPA deep link (shell served for a non-root URL)"
STATUS=$(http_status "$BASE/second" "$LOG_DIR/second.html")
expect_eq "deep_link_returns_200" "200" "$STATUS" "GET /second"
if grep -q 'Second page' "$LOG_DIR/second.html"; then
  fail "deep_link_serves_shell" "response contained server-rendered route markup"
else
  pass "deep_link_serves_shell" "response body has no server-rendered route markup"
fi
if grep -q '/assets/index-' "$LOG_DIR/second.html"; then
  pass "deep_link_bootstraps_client" "shell references the client entry bundle"
else
  fail "deep_link_bootstraps_client" "shell has no client entry bundle reference"
fi
STATUS=$(http_status "$BASE/" "$LOG_DIR/root.html")
expect_eq "root_returns_200" "200" "$STATUS" "GET /"
STATUS=$(http_status "$BASE/assets/missing.js" "$LOG_DIR/missing.js")
expect_eq "missing_asset_404" "404" "$STATUS" "GET /assets/missing.js is not swallowed by the shell"
STATUS=$(http_status "$BASE/no-such-route" "$LOG_DIR/unknown.html")
expect_eq "unknown_route_404" "404" "$STATUS" "GET /no-such-route (router not-found, not the shell)"

echo "== Better Auth email-password session"
EMAIL="curl-$(date +%s)@example.com"
SIGNUP_STATUS=$(curl -s -o "$LOG_DIR/signup.json" -w '%{http_code}' \
  -D "$LOG_DIR/signup.headers" -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/sign-up/email" \
  -H 'content-type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"probe-password-123\",\"name\":\"probe\"}")
expect_eq "sign_up_returns_200" "200" "$SIGNUP_STATUS" "POST /api/auth/sign-up/email ($EMAIL)"
if grep -qi '^set-cookie: better-auth.session_token=' "$LOG_DIR/signup.headers"; then
  pass "sign_up_sets_session_cookie" "$(grep -i '^set-cookie' "$LOG_DIR/signup.headers" | cut -d';' -f1)"
else
  fail "sign_up_sets_session_cookie" "no better-auth.session_token in Set-Cookie"
fi

STATUS=$(curl -s -o "$LOG_DIR/session-authed.json" -w '%{http_code}' -b "$COOKIE_JAR" "$BASE/api/auth/get-session")
expect_eq "get_session_http_200_with_cookie" "200" "$STATUS" "GET /api/auth/get-session with cookie jar"
expect_eq "session_readable_with_cookie" "$EMAIL" \
  "$(json_field "$LOG_DIR/session-authed.json" "user.email")" "session.user.email matches the signed-up user"

STATUS=$(curl -s -o "$LOG_DIR/session-anon.json" -w '%{http_code}' "$BASE/api/auth/get-session")
expect_eq "get_session_http_200_without_cookie" "200" "$STATUS" "GET /api/auth/get-session with no cookie"
expect_eq "session_absent_without_cookie" "null" \
  "$(json_field "$LOG_DIR/session-anon.json" "session")" "anonymous request has no session"

SIGNOUT_STATUS=$(curl -s -o "$LOG_DIR/signout.json" -w '%{http_code}' -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X POST "$BASE/api/auth/sign-out" -H 'content-type: application/json' -H "origin: $BASE" -d '{}')
expect_eq "sign_out_returns_200" "200" "$SIGNOUT_STATUS" "POST /api/auth/sign-out (better-auth CSRF check needs an Origin header)"
curl -s -o "$LOG_DIR/session-after-signout.json" -b "$COOKIE_JAR" "$BASE/api/auth/get-session"
expect_eq "session_gone_after_sign_out" "null" \
  "$(json_field "$LOG_DIR/session-after-signout.json" "session")" "session cleared after sign-out"

echo "== Drizzle transaction and constraint behavior"
STATUS=$(curl -s -o "$LOG_DIR/db-checks.json" -w '%{http_code}' -X POST "$BASE/api/probe/db")
expect_eq "db_checks_http_200" "200" "$STATUS" "POST /api/probe/db"
node -e '
  const fs = require("fs")
  const body = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
  for (const check of body.checks ?? []) {
    const verdict = check.passed ? "PASS" : "FAIL"
    console.log(`${verdict} db_${check.name} :: ${JSON.stringify(check.detail)}`)
  }
' "$LOG_DIR/db-checks.json" | tee "$LOG_DIR/db-checks.txt"
while IFS= read -r line; do
  case "$line" in
    PASS*) TOTAL=$((TOTAL + 1)) ;;
    FAIL*) TOTAL=$((TOTAL + 1)); FAILED=$((FAILED + 1)) ;;
  esac
done < "$LOG_DIR/db-checks.txt"

echo "== browser checks (Playwright, real Chromium)"
BASE_URL="$BASE" node scripts/browser-checks.mjs 2>&1 | tee "$LOG_DIR/browser-checks.txt"
while IFS= read -r line; do
  case "$line" in
    PASS*) TOTAL=$((TOTAL + 1)) ;;
    FAIL*) TOTAL=$((TOTAL + 1)); FAILED=$((FAILED + 1)) ;;
  esac
done < "$LOG_DIR/browser-checks.txt"

echo
echo "== summary"
printf 'checks: %s, passed: %s, failed: %s\n' "$TOTAL" "$((TOTAL - FAILED))" "$FAILED"

if [ "$FAILED" -eq 0 ]; then
  exit 0
fi
exit 1
