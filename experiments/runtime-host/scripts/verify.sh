#!/usr/bin/env bash
# Reruns the P0-c runtime-host experiment end to end and writes artifacts to
# .verify-artifacts/. Each check prints PASS or FAIL with the numbers it read.
set -uo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
ART="$ROOT/.verify-artifacts"
DEV_PORT="${DEV_PORT:-3117}"
PROD_PORT="${PROD_PORT:-3118}"
SSE_SECONDS="${SSE_SECONDS:-32}"
SINGLETON_FILE="$ROOT/src/server/runtime.ts"
SINGLETON_BACKUP="$(mktemp)"
cp "$SINGLETON_FILE" "$SINGLETON_BACKUP"
CURL=(curl -s --noproxy '*' -m 10)

mkdir -p "$ART"
rm -f "$ART"/*.txt "$ART"/*.log 2>/dev/null

DEV_PID=""
PROD_PID=""
FAILURES=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
info() { printf '      %s\n' "$1"; }

cleanup() {
  if [ -s "$SINGLETON_BACKUP" ]; then cp "$SINGLETON_BACKUP" "$SINGLETON_FILE" 2>/dev/null || true; fi
  [ -n "$DEV_PID" ] && kill -TERM "$DEV_PID" 2>/dev/null
  [ -n "$PROD_PID" ] && kill -TERM "$PROD_PID" 2>/dev/null
  sleep 1
  [ -n "$DEV_PID" ] && kill -KILL "$DEV_PID" 2>/dev/null
  [ -n "$PROD_PID" ] && kill -KILL "$PROD_PID" 2>/dev/null
  rm -f "$SINGLETON_BACKUP"
}
trap cleanup EXIT

free_port() {
  local port="$1"
  local pids
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -z "$pids" ] && return 0
  kill -TERM $pids 2>/dev/null
  sleep 2
  pids="$(lsof -nP -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
  [ -n "$pids" ] && kill -KILL $pids 2>/dev/null
  sleep 1
}

wait_for_http() {
  local url="$1" key="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if "${CURL[@]}" "$url" 2>/dev/null | grep -q "\"$key\""; then return 0; fi
    sleep 1
  done
  return 1
}

json() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1"; }

start_dev() {
  local tag="$1"
  shift
  free_port "$DEV_PORT"
  ( cd "$ROOT" && exec env PORT="$DEV_PORT" "$@" ./node_modules/.bin/vite dev ) >"$ART/dev-$tag.log" 2>&1 &
  DEV_PID=$!
  wait_for_http "http://localhost:$DEV_PORT/api/diagnostics" moduleEvals 60 || { fail "dev($tag) server did not start"; return 1; }
}

stop_dev() {
  [ -n "$DEV_PID" ] && kill -TERM "$DEV_PID" 2>/dev/null
  sleep 2
  [ -n "$DEV_PID" ] && kill -KILL "$DEV_PID" 2>/dev/null
  DEV_PID=""
}

echo "== 0. install =="
[ -d node_modules ] || npm install --no-audit --no-fund
info "node $(node -v), vite $(node -p "require('vite/package.json').version"), effect $(node -p "require('effect/package.json').version"), @tanstack/react-start $(node -p "require('@tanstack/react-start/package.json').version")"

echo
echo "== 1. dev, singleton guard ON (a: state survives requests, c: SSE, b: HMR) =="
start_dev on || true
if [ -n "$DEV_PID" ]; then
  first="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/counter")"
  echo "$first" >"$ART/a-dev-first.json"
  sleep 3
  second="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/counter")"
  echo "$second" >"$ART/a-dev-second.json"
  c1="$(printf '%s' "$first" | json "['snapshot']['counter']")"
  c2="$(printf '%s' "$second" | json "['snapshot']['counter']")"
  i1="$(printf '%s' "$first" | json "['snapshot']['instanceId']")"
  i2="$(printf '%s' "$second" | json "['snapshot']['instanceId']")"
  if [ "$c2" -gt "$c1" ] && [ "$i1" = "$i2" ]; then
    pass "a) dev: counter $c1 -> $c2 across 3s with two completed requests, instance $i1 unchanged"
  else
    fail "a) dev: counter $c1 -> $c2, instance $i1 -> $i2"
  fi

  # a) concurrent requests must not re-initialize the runtime
  before_conc="$(printf '%s' "$second" | json "['diagnostics']['moduleEvals']")"
  pids=()
  for _ in $(seq 1 30); do
    "${CURL[@]}" -o /dev/null "http://localhost:$DEV_PORT/api/counter" &
    pids+=("$!")
  done
  wait "${pids[@]}" 2>/dev/null
  conc="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/diagnostics")"
  echo "$conc" >"$ART/a-dev-concurrent.json"
  if [ "$(printf '%s' "$conc" | json "['moduleEvals']")" = "$before_conc" ] \
     && [ "$(printf '%s' "$conc" | json "['runtimeConstructions']")" = "1" ]; then
    pass "a) dev: 30 concurrent requests did not re-initialize the runtime (moduleEvals=$before_conc, constructions=1)"
  else
    fail "a) dev: concurrent requests changed moduleEvals/constructions"
  fi

  # c) SSE long connection
  "${CURL[@]}" --max-time $((SSE_SECONDS + 4)) -N \
    "http://localhost:$DEV_PORT/api/events?durationMs=$((SSE_SECONDS * 1000))" >"$ART/c-dev-sse.txt"
  ticks="$(grep -c '^event: tick' "$ART/c-dev-sse.txt")"
  subs="$(grep -o '"subscribers":[0-9]*' "$ART/c-dev-sse.txt" | tail -1 | cut -d: -f2)"
  if [ "$ticks" -ge $((SSE_SECONDS - 3)) ]; then
    pass "c) dev: SSE delivered $ticks tick events over ${SSE_SECONDS}s (last subscribers=$subs)"
  else
    fail "c) dev: SSE delivered only $ticks tick events over ${SSE_SECONDS}s"
  fi
  # after disconnect, runtime must still be alive and ticking
  after_sse="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/counter")"
  echo "$after_sse" >"$ART/a-dev-after-sse.json"
  if [ "$(printf '%s' "$after_sse" | json "['snapshot']['activeTickers']")" = "1" ]; then
    pass "a) dev: runtime still alive after SSE disconnect (activeTickers=1, counter=$(printf '%s' "$after_sse" | json "['snapshot']['counter']"))"
  else
    fail "a) dev: unexpected tickers after SSE disconnect"
  fi

  # b) HMR with guard ON
  before_hmr="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/diagnostics")"
  echo "$before_hmr" >"$ART/b-dev-on-before.json"
  printf '\n// hmr-probe\n' >>"$SINGLETON_FILE"
  for _ in $(seq 1 25); do
    cur="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/diagnostics")"
    [ "$(printf '%s' "$cur" | json "['moduleEvals']")" -gt "$(printf '%s' "$before_hmr" | json "['moduleEvals']")" ] && break
    sleep 1
  done
  echo "$cur" >"$ART/b-dev-on-after.json"
  cp "$SINGLETON_BACKUP" "$SINGLETON_FILE"
  b_evals="$(printf '%s' "$cur" | json "['moduleEvals']")"
  b_const="$(printf '%s' "$cur" | json "['runtimeConstructions']")"
  b_tick="$(printf '%s' "$cur" | json "['activeTickers']")"
  if [ "$b_evals" -gt "$(printf '%s' "$before_hmr" | json "['moduleEvals']")" ] \
     && [ "$b_const" = "1" ] && [ "$b_tick" = "1" ]; then
    pass "b) dev HMR with guard: moduleEvals=$(printf '%s' "$before_hmr" | json "['moduleEvals']") -> $b_evals, runtimeConstructions=$b_const, activeTickers=$b_tick (no re-init)"
  else
    fail "b) dev HMR with guard: moduleEvals=$b_evals, runtimeConstructions=$b_const, activeTickers=$b_tick"
  fi
  # dev signal probe: the SSR module runs in a nitro worker thread
  diag="$(printf '%s' "$cur")"
  info "dev dev-worker: isMainThread=$(printf '%s' "$diag" | json "['isMainThread']") threadId=$(printf '%s' "$diag" | json "['threadId']") sigtermListeners=$(printf '%s' "$diag" | json "['sigtermListeners']")"
  dev_pid_snapshot="$(printf '%s' "$diag" | json "['instances'][-1]['pid']")"
  kill -TERM "$dev_pid_snapshot" 2>/dev/null
  sleep 3
  if grep -q 'shutdown-requested' "$ART/dev-on.log"; then
    pass "e) dev: Scope finalizers ran on SIGTERM"
  else
    info "e) dev: SIGTERM did not reach the runtime module (nitro runs SSR in a worker thread). Log has no shutdown lines."
  fi
  DEV_PID=""
fi

echo
echo "== 2. dev, singleton guard OFF (b: HMR re-init baseline) =="
start_dev off env HOST_RUNTIME_SINGLETON=0 || true
if [ -n "$DEV_PID" ]; then
  before="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/diagnostics")"
  echo "$before" >"$ART/b-dev-off-before.json"
  "${CURL[@]}" -o /dev/null "http://localhost:$DEV_PORT/api/counter"
  printf '\n// hmr-probe-off\n' >>"$SINGLETON_FILE"
  for _ in $(seq 1 25); do
    cur="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/diagnostics")"
    [ "$(printf '%s' "$cur" | json "['moduleEvals']")" -gt "$(printf '%s' "$before" | json "['moduleEvals']")" ] && break
    sleep 1
  done
  after_counter="$("${CURL[@]}" "http://localhost:$DEV_PORT/api/counter")"
  cp "$SINGLETON_BACKUP" "$SINGLETON_FILE"
  echo "$cur" >"$ART/b-dev-off-after.json"
  cur_const="$(printf '%s' "$cur" | json "['runtimeConstructions']")"
  cur_tick="$(printf '%s' "$cur" | json "['activeTickers']")"
  if [ "$cur_const" = "2" ] && [ "$cur_tick" = "2" ] && [ "$(printf '%s' "$after_counter" | json "['snapshot']['ticks']")" -le 2 ]; then
    pass "b) dev HMR without guard: runtimeConstructions=$cur_const, activeTickers=$cur_tick, new instance ticks reset to $(printf '%s' "$after_counter" | json "['snapshot']['ticks']") (duplicate background work)"
  else
    fail "b) dev HMR without guard: runtimeConstructions=$cur_const, activeTickers=$cur_tick"
  fi
  stop_dev
fi

echo
echo "== 3. production build and start (d/e) =="
kill -TERM "$DEV_PID" 2>/dev/null
free_port "$PROD_PORT"
free_port "$DEV_PORT"
npm run build >"$ART/prod-build.log" 2>&1
if [ -f .output/server/index.mjs ]; then
  pass "d) build produced .output/server/index.mjs"
else
  fail "d) build produced no .output/server/index.mjs"
fi
free_port "$PROD_PORT"
( cd "$ROOT" && exec env PORT="$PROD_PORT" node .output/server/index.mjs ) >"$ART/prod-run.log" 2>&1 &
PROD_PID=$!
if wait_for_http "http://localhost:$PROD_PORT/api/diagnostics" moduleEvals 40; then
  p_first="$("${CURL[@]}" "http://localhost:$PROD_PORT/api/counter")"
  sleep 3
  p_second="$("${CURL[@]}" "http://localhost:$PROD_PORT/api/counter")"
  echo "$p_first" >"$ART/d-prod-first.json"
  echo "$p_second" >"$ART/d-prod-second.json"
  pc1="$(printf '%s' "$p_first" | json "['snapshot']['counter']")"
  pc2="$(printf '%s' "$p_second" | json "['snapshot']['counter']")"
  info "prod main thread: isMainThread=$(printf '%s' "$p_first" | json "['snapshot']['isMainThread']") pid=$(printf '%s' "$p_first" | json "['snapshot']['pid']")"
  "${CURL[@]}" --max-time $((SSE_SECONDS + 4)) -N \
    "http://localhost:$PROD_PORT/api/events?durationMs=$((SSE_SECONDS * 1000))" >"$ART/d-prod-sse.txt"
  p_ticks="$(grep -c '^event: tick' "$ART/d-prod-sse.txt")"
  if [ "$pc2" -gt "$pc1" ] && [ "$p_ticks" -ge $((SSE_SECONDS - 3)) ]; then
    pass "d) prod: counter $pc1 -> $pc2 across requests and $p_ticks SSE ticks over ${SSE_SECONDS}s, moduleEvals=$(printf '%s' "$p_second" | json "['snapshot']['moduleEvals']")"
  else
    fail "d) prod: counter $pc1 -> $pc2, SSE ticks $p_ticks"
  fi
  kill -TERM "$PROD_PID"
  for _ in $(seq 1 12); do kill -0 "$PROD_PID" 2>/dev/null || break; sleep 1; done
  PROD_PID=""
  order="$(grep -E 'shutdown-requested|finalizer#1|finalizer#2|shutdown-complete' "$ART/prod-run.log" | tr '\n' '|')"
  echo "$order" >"$ART/e-prod-shutdown-order.txt"
  if printf '%s' "$order" | grep -q 'shutdown-requested.*finalizer#2.*finalizer#1.*shutdown-complete'; then
    pass "e) prod SIGTERM: shutdown-requested -> finalizer#2 ticker -> finalizer#1 subscribers -> shutdown-complete"
  else
    fail "e) prod SIGTERM order was: $order"
  fi
else
  fail "d) production server did not start"
fi

echo
if [ "$FAILURES" -eq 0 ]; then
  echo "RESULT: PASS (artifacts in .verify-artifacts/)"
else
  echo "RESULT: FAIL ($FAILURES checks failed; artifacts in .verify-artifacts/)"
fi
exit "$FAILURES"
