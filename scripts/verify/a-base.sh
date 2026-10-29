#!/usr/bin/env bash
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
log_dir="$root/.verify/a-base"
mkdir -p "$log_dir"
prod_port="${SPROUT_VERIFY_PROD_PORT:-3111}"
dev_port="${SPROUT_VERIFY_DEV_PORT:-3112}"
pi_bin="${PI_BIN:-/Users/snake/.pi/agent/bin/pi}"
export no_proxy="localhost,127.0.0.1,::1"
export NO_PROXY="$no_proxy"
CURL=(curl --noproxy '*' --connect-timeout 2 --max-time 5 -sS)
server_pid=""

pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; exit 1; }
stop_server() {
  if [ -n "$server_pid" ]; then
    kill -- -"$server_pid" 2>/dev/null || true
    for _ in {1..30}; do
      kill -0 "$server_pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- -"$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
    server_pid=""
  fi
}
trap stop_server EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

port_guard() {
  case "$1" in ''|*[!0-9]*) fail "invalid port $1" ;; esac
  if [ "$1" -lt 1 ] || [ "$1" -gt 65535 ]; then fail "invalid port $1"; fi
  if lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; then
    fail "port $1 is occupied; refusing to inspect a foreign server"
  fi
}

run() {
  local label="$1" logfile="$log_dir/$2.log"
  shift 2
  if node --input-type=module - "$logfile" "$@" <<'JS'
import { spawn } from 'node:child_process'
import { openSync, closeSync } from 'node:fs'
const [log, command, ...args] = process.argv.slice(2)
const fd = openSync(log, 'w')
const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd] })
closeSync(fd)
let timedOut = false
let forceTimer
const stop = (signal) => {
  try { process.kill(-child.pid, signal) } catch (error) {
    if (error.code !== 'ESRCH') throw error
  }
}
const timer = setTimeout(() => {
  timedOut = true
  console.error('Command exceeded 300 seconds', command, args.join(' '))
  stop('SIGTERM')
  forceTimer = setTimeout(() => stop('SIGKILL'), 3000)
}, 300000)
child.on('error', (error) => {
  clearTimeout(timer)
  console.error(error.message)
  process.exitCode = 1
})
child.on('close', (code) => {
  clearTimeout(timer)
  clearTimeout(forceTimer)
  process.exitCode = timedOut ? 1 : code ?? 1
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  stop(signal)
  process.exitCode = 1
})
JS
  then
    pass "$label (log $logfile)"
  else
    tail -60 "$logfile"
    fail "$label"
  fi
}

wait_http() {
  local port="$1" logfile="$2"
  for _ in {1..90}; do
    if "${CURL[@]}" -f -o /dev/null "http://localhost:$port/" 2>/dev/null; then return; fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done
  tail -50 "$logfile"
  fail "server did not answer on port $port"
}

get_200() {
  local path="$1" output="$2" code
  code="$("${CURL[@]}" -D "$output.headers" -o "$output" -w '%{http_code}' "http://localhost:$prod_port$path")"
  [ "$code" = 200 ] || fail "GET $path returned $code"
  pass "GET $path returned 200"
}

port_guard "$prod_port"
port_guard "$dev_port"
[ "$prod_port" != "$dev_port" ] || fail 'production and dev ports must differ'
run 'ensure frozen installation' install node scripts/verify/prepare.mjs install
run 'typecheck Web, Worker and extension' typecheck pnpm typecheck
run 'format lint and type gate' check pnpm check
run 'ensure Nitro production artifact' build node scripts/verify/prepare.mjs server
[ -f .output/server/index.mjs ] || fail 'missing .output/server/index.mjs'
[ -f .output/public/_shell.html ] || fail 'missing .output/public/_shell.html'
[ -n "$(find .output/public/assets -type f -name '*.js' -print -quit)" ] || fail 'missing client assets'
pass 'production artifacts .output/server/index.mjs and .output/public/assets/'

port_guard "$prod_port"
export DATABASE_URL="$log_dir/verification.sqlite"
export BETTER_AUTH_SECRET="ci-only-secret-ci-only-secret-123456"
PORT="$prod_port" APP_ORIGIN="http://localhost:$prod_port" pnpm start >"$log_dir/production.log" 2>&1 &
server_pid=$!
wait_http "$prod_port" "$log_dir/production.log"
get_200 / "$log_dir/home.html"
get_200 /projects/does-not-exist "$log_dir/deep.html"
for page in home deep; do
  grep -qF '<title>Sprout Mio</title>' "$log_dir/$page.html" || fail "$page did not return the application shell"
  grep -qiF 'content-type: text/html' "$log_dir/$page.html.headers" || fail "$page did not return HTML"
  grep -qF 'name="application-version"' "$log_dir/$page.html" || fail "$page is missing the application version"
  grep -qF '<script type="module"' "$log_dir/$page.html" || fail "$page is missing the client entry"
  if grep -qF '页面不存在' "$log_dir/$page.html"; then fail "$page unexpectedly rendered a page on the server"; fi
done
pass 'home and unknown deep link return the application SPA shell'
api_missing_code="$("${CURL[@]}" -o "$log_dir/api-missing.html" -w '%{http_code}' "http://localhost:$prod_port/api/does-not-exist")"
[ "$api_missing_code" = 404 ] || fail 'unknown API must retain its 404 status'
pass 'unknown API retains 404'
get_200 /api/ping "$log_dir/ping.json"
node --input-type=module - "$log_dir/ping.json" <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const ping = JSON.parse(readFileSync(process.argv[2], 'utf8'))
assert.equal(ping.app, 'sprout-mio')
assert.equal(ping.probe, 'http')
assert.equal(ping.runtime, 'unimplemented')
console.log('PASS HTTP probe payload', JSON.stringify(ping))
JS
stop_server
port_guard "$prod_port"
pass 'production process group stopped'

port_guard "$dev_port"
PORT="$dev_port" pnpm dev --port "$dev_port" --strictPort >"$log_dir/dev.log" 2>&1 &
server_pid=$!
wait_http "$dev_port" "$log_dir/dev.log"
"${CURL[@]}" -f "http://localhost:$dev_port/" -o "$log_dir/dev.html"
grep -qF 'Sprout Mio' "$log_dir/dev.html" || fail 'dev did not return the application'
pass 'pnpm dev answers GET / with the application shell'
stop_server
port_guard "$dev_port"
pass 'dev process group stopped'

run 'ensure Worker artifact' worker-build node scripts/verify/prepare.mjs worker
[ -f dist/worker/main.js ] || fail 'missing dist/worker/main.js'
run 'Worker version' worker-version node dist/worker/main.js --version
version="$(node --input-type=module -e "import { APP_VERSION } from './src/contracts/version.ts'; console.log(APP_VERSION)")"
protocol="$(node --import tsx --input-type=module -e "import { WORKER_PROTOCOL_VERSION } from './src/contracts/worker.ts'; console.log(WORKER_PROTOCOL_VERSION)")"
grep -qxF "sprout-worker $version protocol=$protocol node=$(node --version)" "$log_dir/worker-version.log" || fail 'Worker version or protocol marker is incorrect'
run 'Worker defaults to usage' worker-default node dist/worker/main.js
grep -qF 'sprout-worker init --server' "$log_dir/worker-default.log" || fail 'Worker default usage is missing init'
run 'Worker help' worker-help node dist/worker/main.js --help
grep -qF 'sprout-worker version' "$log_dir/worker-help.log" || fail 'Worker help is missing version'
pass "Worker output $(<"$log_dir/worker-version.log")"
pass "Worker output $(<"$log_dir/worker-default.log")"

run 'ensure extension artifact' extension-build node scripts/verify/prepare.mjs extension
[ -f dist/extension/main.js ] || fail 'missing dist/extension/main.js'
[ -x "$pi_bin" ] || fail "Pi binary is unavailable $pi_bin"
pi_args=(--no-extensions --no-skills --no-prompt-templates --no-themes -e dist/extension/main.js --tools sprout_status --mode json --session-dir "$log_dir/pi-sessions" -p)
if [ -n "${SPROUT_VERIFY_PI_MODEL:-}" ]; then pi_args=(--model "$SPROUT_VERIFY_PI_MODEL" "${pi_args[@]}"); fi
run 'real Pi sprout_status invocation' pi "$pi_bin" "${pi_args[@]}" 'Call sprout_status exactly once with empty arguments. Then report the returned payload. Do not use other tools.'
node --input-type=module - "$log_dir/pi.log" <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const events = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const calls = events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'sprout_status')
assert.equal(calls.length, 1, 'real Pi must emit one completed sprout_status tool call')
assert.equal(calls[0].isError, false)
const result = JSON.parse(calls[0].result.content.find((part) => part.type === 'text').text)
assert.deepEqual(result, { app: 'sprout-mio', version: '0.1.0', contractVersion: 1, worker: 'unimplemented', piSession: 'unimplemented' })
assert.deepEqual(calls[0].result.details, result)
console.log('PASS real Pi tool_execution_end', JSON.stringify(result))
JS

pass 'a-base all checks passed'
