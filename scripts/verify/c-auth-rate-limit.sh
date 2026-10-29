#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import net from 'node:net'
import Database from 'better-sqlite3'

const directory = resolve('.verify/c-auth-rate-limit')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_RATE_LIMIT_PORT ?? 3116)
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'valid isolated port')
const base = `http://localhost:${port}`
const databaseUrl = join(directory, 'auth.sqlite')
const env = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base,
  PORT: String(port), NITRO_PORT: String(port), NODE_ENV: 'production',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  AUTH_RATE_LIMIT_MAX: '2', AUTH_RATE_LIMIT_WINDOW_SECONDS: '60',
  AUTH_RATE_LIMIT_GLOBAL_MAX: '100', AUTH_RATE_LIMIT_HTTP_MAX: '2',
}
const evidence = []
const children = new Set()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
function pass(check, detail) {
  evidence.push({ check, detail })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(`PASS ${check} ${detail}`)
}
function kill(child, signal = 'SIGTERM') {
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, name, settings = env) {
  const fd = openSync(join(directory, name), 'w')
  const child = spawn(command, args, { env: settings, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  children.add(child)
  return child
}
async function bounded(child, milliseconds) {
  const timer = setTimeout(() => kill(child, 'SIGKILL'), milliseconds)
  try {
    const result = await child.completion
    assert.equal(result.code, 0, `process failed: ${JSON.stringify(result)}; inspect logs`)
    children.delete(child)
  } finally { clearTimeout(timer) }
}
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(path, entry.name)) : [join(path, entry.name)])
}
let database
try {
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port check timed out')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} occupied`)) })
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
  })
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  await bounded(launch('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log'), 300000)
  const requireStart = createRequire(import.meta.resolve('@tanstack/react-start'))
  const { fromCrossJSON, toJSONAsync } = requireStart('seroval')
  const code = files(resolve('.output/server')).filter((file) => file.endsWith('.mjs'))
    .map((file) => readFileSync(file, 'utf8')).join('\n')
  const match = code.match(/id:\s*"([a-f0-9]+)",\s*name:\s*"authenticate"/)
  assert(match, 'authenticate production function id')
  const path = `/_serverFn/${match[1]}`
  const server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  async function request(path, body, spoof = '198.51.100.1') {
    const response = await fetch(base + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { origin: base, 'content-type': 'application/json', 'x-forwarded-for': spoof, 'x-real-ip': spoof },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    })
    return { status: response.status, headers: response.headers, text: await response.text() }
  }
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null || server.signalCode !== null) break
    try { ready = (await request('/api/health')).status === 200 } catch {}
    if (ready) break
    await delay(250)
  }
  assert(ready, 'isolated production HTTP ready; see server.log')
  pass('isolated server', `port=${port}; independent SQLite; max=2 window=60s`)
  async function authenticate(input, spoof) {
    const response = await request(path, await toJSONAsync({ data: input }), spoof)
    assert.equal(response.status, 200, 'server functions preserve HTTP 200')
    const result = fromCrossJSON(JSON.parse(response.text), { refs: new Map() }).result
    assert(result, 'AppResult serialized by real HTTP boundary')
    assert.equal(response.headers.get('x-sprout-request-id'), result.requestId)
    if (result.ok && input.action === 'login') assert.match(response.headers.get('set-cookie'), /session_token=/)
    return result
  }
  const email = 'normal@example.test'
  const password = randomBytes(24).toString('base64url')
  assert.equal((await request('/api/auth/sign-up/email', { email, password, name: 'Rate limit verifier' })).status, 200)
  assert.equal((await authenticate({ action: 'login', email, password })).ok, true)
  pass('normal password login through server function', 'HTTP 200 ok=true')
  const wrongPassword = 'incorrect-password-for-rate-limit'
  assert.equal((await authenticate({ action: 'login', email, password: wrongPassword })).error.code, 'unauthorized')
  const limited = await authenticate({ action: 'login', email: email.toUpperCase(), password: wrongPassword }, '198.51.100.2')
  assert.equal(limited.error?.code, 'too_many_requests', 'failed logins must hit server function limiter')
  assert.equal(limited.error.message, '尝试过于频繁，请稍后再试')
  assert.equal(limited.requestId, limited.error.requestId)
  pass('repeated failed login', 'HTTP 200 too_many_requests; case and forged IP do not reset account budget')
  const target = 'parallel@example.test'
  const concurrent = await Promise.all(Array.from({ length: 4 }, (_, index) => authenticate({
    action: 'login', email: index % 2 ? target.toUpperCase() : target, password: wrongPassword,
  }, `198.51.100.${index + 10}`)))
  assert.equal(concurrent.filter((result) => result.error?.code === 'unauthorized').length, 2)
  assert.equal(concurrent.filter((result) => result.error?.code === 'too_many_requests').length, 2)
  const register = await authenticate({ action: 'register', email: target, password, name: 'Blocked registration' })
  assert.equal(register.error?.code, 'too_many_requests')
  pass('concurrent attempts and action switching', 'exactly 2 dispatched, 2 limited; register shares exhausted account budget')
  const httpIp = '198.51.100.30'
  assert.equal((await request('/api/auth/sign-in/email', { email, password }, httpIp)).status, 200)
  assert.equal((await request('/api/auth/sign-in/email', { email, password: wrongPassword }, httpIp)).status, 401)
  const httpLimited = await request('/api/auth/sign-in/email', { email: target, password: wrongPassword }, httpIp)
  assert.equal(httpLimited.status, 429)
  assert(Number(httpLimited.headers.get('x-retry-after')) > 0)
  assert.equal((await request('/api/auth/sign-in/email', { email, password: wrongPassword }, '198.51.100.31')).status, 401, 'different IP must have an independent HTTP budget')
  pass('explicit Better Auth HTTP policy', 'same IP: normal login 200, failed login 401, next request 429; different IP: 401 with independent budget')
  database = new Database(databaseUrl)
  const diagnostics = database.prepare("SELECT level, request_id, message, data FROM diagnostic_event WHERE event = 'auth.rate_limited'").all()
  const rejected = [limited, ...concurrent.filter((result) => result.error?.code === 'too_many_requests'), register]
  assert.equal(diagnostics.length, rejected.length)
  for (const result of rejected) {
    const row = diagnostics.find((row) => row.request_id === result.requestId)
    assert(row, 'safe diagnostic correlated to rejection')
    assert.equal(row.level, 'warn')
    assert.equal(row.message, '尝试过于频繁，请稍后再试')
    assert.deepEqual(JSON.parse(row.data), { action: result === register ? 'register' : 'login' })
  }
  const safe = JSON.stringify({ rejected, diagnostics })
  for (const secret of [email, target, password, wrongPassword, '198.51.100.']) assert(!safe.includes(secret))
  assert.equal(database.prepare('SELECT count(*) AS count FROM user').get().count, 1)
  pass('safe rejection and diagnostics', `${diagnostics.length} warn events; action only; no credentials, raw IP or account key; rejected register created no user`)
  kill(server)
  await bounded(server, 10000)
  const restarted = launch(process.execPath, ['.output/server/index.mjs'], 'global-budget-server.log', {
    ...env, AUTH_RATE_LIMIT_GLOBAL_MAX: '2',
  })
  ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (restarted.exitCode !== null || restarted.signalCode !== null) break
    try { ready = (await request('/api/health')).status === 200 } catch {}
    if (ready) break
    await delay(250)
  }
  assert(ready, 'isolated server restarted with global max=2')
  for (const email of ['rotating-1@example.test', 'rotating-2@example.test']) {
    assert.equal((await authenticate({ action: 'login', email, password: wrongPassword })).error?.code, 'unauthorized')
  }
  assert.equal((await authenticate({ action: 'login', email: 'rotating-3@example.test', password: wrongPassword })).error?.code, 'too_many_requests')
  assert.equal((await authenticate({ action: 'logout' })).ok, true)
  pass('global budget and logout', 'rotating accounts hit total max=2; logout remains available; response header requestId matches AppResult')
  const productionDevLogin = await request('/dev-login?to=/projects')
  assert.equal(productionDevLogin.status, 404)
  const productionDevLoginHead = await fetch(base + '/dev-login', { method: 'HEAD' })
  assert.equal(productionDevLoginHead.status, 404)
  const ledger = new Database(databaseUrl)
  try {
    assert.equal(ledger.prepare("SELECT count(*) AS count FROM user WHERE email = 'dev@sprout.test'").get().count, 0)
  } finally { ledger.close() }
  pass('production build exposes no development login', 'GET /dev-login 404; HEAD 404; no demo Human created')
  kill(restarted)
  await bounded(restarted, 10000)
  pass('c-auth-rate-limit all checks passed', 'servers exit=0; evidence.json')
} catch (error) {
  console.error('FAIL c-auth-rate-limit', error.stack ?? error)
  process.exitCode = 1
} finally {
  database?.close()
  for (const child of children) kill(child, 'SIGKILL')
  await Promise.allSettled([...children].map((child) => child.completion))
}
JS
