#!/usr/bin/env bash
set -euo pipefail
set -m

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$root"
case "${SPROUT_VERIFY_CHAT_MODE-model-fixture}" in
  model-fixture|live) export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE-model-fixture}" ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [ "$SPROUT_VERIFY_CHAT_MODE" = live ]; then
  source "$root/scripts/verify/lib/live-model.sh"
  sprout_live_model
fi
log_dir="$root/.verify/a-base"
mkdir -p "$log_dir"
prod_port="${SPROUT_VERIFY_PROD_PORT:-3111}"
dev_port="${SPROUT_VERIFY_DEV_PORT:-3112}"
pi_bin="${PI_BIN:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/bin/pi}"
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

run 'ensure frozen installation' install node scripts/verify/prepare.mjs install
if [ "${SPROUT_VERIFY_TARGET-all}" != local ]; then
port_guard "$prod_port"
port_guard "$dev_port"
[ "$prod_port" != "$dev_port" ] || fail 'production and dev ports must differ'
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
else
  printf 'INFO portable A checks belong to the GitHub Actions target\n'
fi

run 'ensure extension artifact' extension-build node scripts/verify/prepare.mjs extension
[ -f dist/extension/main.js ] || fail 'missing dist/extension/main.js'
if [ "${SPROUT_VERIFY_TARGET-all}" != ci ]; then
if [ "$SPROUT_VERIFY_CHAT_MODE" = model-fixture ]; then
  run 'real Pi sprout_status invocation (model-fixture)' pi node scripts/verify/lib/status-model-fixture.mjs dist/extension/main.js "$log_dir/model-mode.json"
else
  printf 'CHAT mode=live runner=installed-Pi-CLI\n'
  [ -x "$pi_bin" ] || fail "Pi binary is unavailable $pi_bin"
  pi_args=(--no-extensions --no-skills --no-prompt-templates --no-themes -e dist/extension/main.js --tools sprout_status --mode json --session-dir "$log_dir/pi-sessions" -p)
  pi_args=(--model "$SPROUT_VERIFY_PI_MODEL" "${pi_args[@]}")
  # 自己起进程、留住内核分配的 pid：断言要拿 `worker.pid` 跟它对账，
  # 否则「pid 是真是假」只剩工具自证。
  "$pi_bin" "${pi_args[@]}" 'Call sprout_status exactly once with empty arguments. Then report the returned payload. Do not use other tools.' >"$log_dir/pi.log" 2>&1 &
  pi_pid=$!
  if wait "$pi_pid"; then
    pass "real Pi sprout_status invocation (live) (log $log_dir/pi.log)"
  else
    tail -60 "$log_dir/pi.log"
    fail 'real Pi sprout_status invocation (live)'
  fi
fi
node --input-type=module - "$log_dir/pi.log" "$SPROUT_VERIFY_CHAT_MODE" "$log_dir/model-mode.json" "$log_dir/pi-sessions" "${pi_pid-}" <<'JS'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const events = readFileSync(process.argv[2], 'utf8').split('\n').filter(Boolean).flatMap((line) => {
  try { return [JSON.parse(line)] } catch { return [] }
})
const calls = events.filter((event) => event.type === 'tool_execution_end' && event.toolName === 'sprout_status')
assert.equal(calls.length, 1, 'real Pi must emit one completed sprout_status tool call')
assert.equal(calls[0].isError, false)
const result = JSON.parse(calls[0].result.content.find((part) => part.type === 'text').text)
// 独立 CLI 装载一次真实 Pi：版本事实逐条钉住，载荷键集不许悄悄多一段（比如凭空长出一个 host）。
assert.deepEqual(Object.keys(result).sort(), ['app', 'contractVersion', 'piSession', 'version', 'worker'])
assert.equal(result.app, 'sprout-mio')
assert.equal(result.version, '0.1.0')
assert.equal(result.contractVersion, 1)
assert.deepEqual(calls[0].result.details, result)

// ---- worker：真实进程身份 + 装载方式（都不许是「未实现」这种假事实）
assert.deepEqual(Object.keys(result.worker).sort(), ['loader', 'pid'], 'worker reports pid and loader')
// 这条路径本来就是独立 CLI 装的：报成别的装载方式（或退回「未实现」）都红。
assert.equal(result.worker.loader, 'standalone-cli', 'standalone CLI load reports its own loading mode')
assert.equal(Number.isInteger(result.worker.pid), true, 'worker pid is a real pid')
const launchedPid = Number(process.argv[6] || 0)
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}
if (launchedPid > 0) {
  // live：pid 必须等于这次真的被拉起来的 Pi 进程（内核分配的 pid，不是工具自报）。
  assert.equal(result.worker.pid, launchedPid, 'worker pid equals the Pi process this script launched')
} else {
  // 夹具分支：Pi 是夹具的子进程，a-base 拿不到它的 pid，只能证明它不是断言进程自己、
  // 并且已经随那一轮退出。pid 与 `process.pid` 的等号由 tests/status-facts.test.ts 在同一进程内证。
  assert.notEqual(result.worker.pid, process.pid, 'worker pid is not the asserting process')
  assert.equal(alive(result.worker.pid), false, 'worker pid belongs to the Pi process that already exited')
}

// ---- piSession：会话身份来自 Pi 自己写入的实况，与 json 流里的 session 头对账
assert.deepEqual(Object.keys(result.piSession).sort(), ['file', 'host', 'id'], 'piSession reports writer and identity')
// 独立 CLI 装载时没有 Sprout 宿主写过实况：必须明说 none，不许把 Pi 的身份冒充成宿主写的。
assert.equal(result.piSession.host, 'none', 'standalone CLI reports no Sprout host')
const header = events.find((event) => event.type === 'session')
assert(header?.id, 'Pi json stream carries its own session header')
assert.equal(result.piSession.id, header.id, 'reported session id equals the id Pi wrote')
assert.equal(typeof result.piSession.file, 'string', 'reported session file is a path')
assert(result.piSession.file.endsWith(`_${header.id}.jsonl`), 'reported session file is the file Pi names after that id')
const [, , , mode, metadataPath, sessions] = process.argv
if (mode === 'live') {
  // 落盘文件里的 session 头必须是同一个 id：工具的说法与文件记录对账，不是「存在即可」。
  assert(existsSync(result.piSession.file), 'reported session file exists on disk')
  const fileHeader = JSON.parse(readFileSync(result.piSession.file, 'utf8').split('\n').filter(Boolean)[0])
  assert.equal(fileHeader.type, 'session')
  assert.equal(fileHeader.id, result.piSession.id, 'session file header id equals the reported session id')
  const actualModels = events.filter(event => event.type === 'message_end' && event.message?.role === 'assistant').map(({message}) => ({provider:message.provider,model:message.model}))
  const sessionId = header.id
  const actualThinking = readdirSync(sessions).filter(file => file.endsWith(`${sessionId}.jsonl`)).flatMap(file => readFileSync(join(sessions,file),'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))).filter(entry => entry.type === 'thinking_level_change').map(entry => entry.thinkingLevel)
  writeFileSync(metadataPath, JSON.stringify({mode,actualModels,actualThinking,requestCount:null,completedPlans:null,unusedSteps:null},null,2))
}
console.log('PASS real Pi tool_execution_end', JSON.stringify(result))
console.log('CHAT metadata', readFileSync(metadataPath,'utf8'))
JS

else
  printf 'INFO real Pi CLI invocation belongs to the local target\n'
fi
pass "a-base checks passed for target=${SPROUT_VERIFY_TARGET-all}"
