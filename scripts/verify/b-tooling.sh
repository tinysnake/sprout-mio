#!/usr/bin/env bash
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
log_dir="$root/.verify/b-tooling"
mkdir -p "$log_dir"
prod_port="${SPROUT_VERIFY_TOOLING_PORT:-3121}"
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
  printf 'RUN  %s: %s\n' "$label" "$*"
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
    local summary
    summary="$(tail -3 "$logfile" | tr '\n' ' ' | sed 's/  */ /g')"
    pass "$label: $* -> exit 0 | $summary"
  else
    tail -60 "$logfile"
    fail "$label: $*"
  fi
}

wait_http() {
  local port="$1" logfile="$2"
  for _ in {1..60}; do
    if "${CURL[@]}" -f -o /dev/null "http://localhost:$port/" 2>/dev/null; then return; fi
    kill -0 "$server_pid" 2>/dev/null || break
    sleep 1
  done
  tail -50 "$logfile"
  fail "production server did not answer on port $port"
}

get_200() {
  local path="$1" output="$2" code
  code="$("${CURL[@]}" -o "$output" -w '%{http_code}' "http://localhost:$prod_port$path")"
  [ "$code" = 200 ] || fail "GET $path returned $code"
  pass "GET $path returned 200 ($(wc -c <"$output" | tr -d ' ') bytes)"
}

port_guard "$prod_port"

printf 'RUN  clean frozen installation with timing\n'
install_start="$(date +%s)"
run 'clean frozen installation' install bash -c 'rm -rf node_modules dist .output data && pnpm install --frozen-lockfile'
install_seconds="$(( $(date +%s) - install_start ))"
[ -d node_modules ] || fail 'node_modules missing after install'
pass "frozen lockfile install took ${install_seconds}s (pnpm store not cold: COLD store untested)"

run 'format lint and type gate' check pnpm check
run 'contract and tooling tests' test pnpm test
run 'Nitro production build' build pnpm build
[ -f .output/server/index.mjs ] || fail 'missing .output/server/index.mjs'
[ -f .output/public/_shell.html ] || fail 'missing .output/public/_shell.html'
[ -n "$(find .output/public/assets -type f -name '*.js' -print -quit)" ] || fail 'missing client assets'
pass 'production artifacts .output/server/index.mjs and .output/public/assets/'

port_guard "$prod_port"
printf 'RUN  production start: PORT=%s APP_ORIGIN=http://localhost:%s pnpm start\n' "$prod_port" "$prod_port"
PORT="$prod_port" APP_ORIGIN="http://localhost:$prod_port" pnpm start >"$log_dir/production.log" 2>&1 &
server_pid=$!
wait_http "$prod_port" "$log_dir/production.log"
get_200 / "$log_dir/home.html"
get_200 /projects/does-not-exist "$log_dir/deep.html"
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

kill -TERM -- -"$server_pid"
exited=0
for _ in {1..100}; do
  if ! kill -0 "$server_pid" 2>/dev/null; then exited=1; break; fi
  sleep 0.1
done
[ "$exited" = 1 ] || { tail -20 "$log_dir/production.log"; fail 'SIGTERM did not stop the production process group within 10s'; }
wait "$server_pid" 2>/dev/null || true
server_pid=""
pass 'SIGTERM stopped the production process group within 10s'
port_guard "$prod_port"

pass "b-tooling all checks passed (clean install ${install_seconds}s)"
