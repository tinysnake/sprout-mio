#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import Database from 'better-sqlite3'

const directory = resolve('.verify/d-runtime')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_RUNTIME_PORT ?? 3134)
const devPort = Number(process.env.SPROUT_VERIFY_RUNTIME_DEV_PORT ?? 3135)
const databaseUrl = join(directory, 'runtime.sqlite')
const base = `http://localhost:${port}`
const environment = { ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port), NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url') }
const evidence = []
const children = new Set()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const sourcePath = resolve('src/server/runtime.ts')
let source
let probeWritten = false
let database
function pass(check, output) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(`PASS ${check} ${JSON.stringify(output)}`)
}
function kill(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, name, env = environment) {
  const fd = openSync(join(directory, name), 'w')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  children.add(child)
  return child
}
async function bounded(child, milliseconds) {
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; kill(child, 'SIGKILL') }, milliseconds)
  try {
    const result = await child.completion
    assert(!timedOut, `process ${child.pid} exceeded ${milliseconds}ms`)
    children.delete(child)
    return result
  } finally { clearTimeout(timer) }
}
async function command(command, args, name, env = environment) {
  const result = await bounded(launch(command, args, name, env), 300000)
  assert.equal(result.code, 0, `${command} ${args.join(' ')} failed; see ${name}`)
}
async function freePort(value) {
  assert(Number.isInteger(value) && value > 0 && value <= 65535, 'valid port')
  await new Promise((resolve, reject) => {
    const socket = net.connect(value, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port check timed out')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${value} occupied`)) })
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
  })
}
async function curl(url, name, { body, cookie = false, header } = {}) {
  const target = join(directory, `${name}.json`)
  const headers = join(directory, `${name}.headers`)
  const args = ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '10', '-sS', '-o', target, '-D', headers, '-w', '%{http_code}', url]
  if (header) args.push('-H', header)
  if (body) args.push('-H', 'content-type: application/json', '-H', `Origin: ${new URL(url).origin}`, '--data', JSON.stringify(body))
  if (cookie) args.push('-b', join(directory, 'cookies.txt'), '-c', join(directory, 'cookies.txt'))
  const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment })
  let output = '', errors = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { errors += data })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(errors)))
  })
  const text = readFileSync(target, 'utf8')
  return { status: Number(output), text, headers: readFileSync(headers, 'utf8'), body: JSON.parse(text) }
}
async function health(child, origin, name) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break
    try {
      const result = await curl(`${origin}/api/health`, name)
      if (result.status === 200 && result.body.ok) return result
    } catch {}
    await delay(250)
  }
  throw new Error(`health not ready at ${origin}; inspect server log`)
}
async function stop(child) {
  kill(child)
  const result = await bounded(child, 10000)
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-child.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return result
      throw error
    }
    await delay(100)
  }
  throw new Error(`process group ${child.pid} survived shutdown`)
}
function boot(id) { return database.prepare('SELECT id, phase, stopped_at FROM runtime_boot WHERE id = ?').get(id) }
function modules(name) {
  return readFileSync(join(directory, name), 'utf8').split('\n').flatMap((line) => {
    const match = line.match(/\[runtime\] module (\{.*\})/)
    return match ? [JSON.parse(match[1])] : []
  })
}
try {
  await freePort(port)
  await freePort(devPort)
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'cookies.txt'), { force: true })
  const buildEnvironment = { ...environment }
  delete buildEnvironment.BETTER_AUTH_SECRET
  await command('pnpm', ['build'], 'build.log', buildEnvironment)
  assert(!readFileSync(join(directory, 'build.log'), 'utf8').includes('[runtime] phase'), 'prerender must not start runtime')
  if (existsSync(databaseUrl)) {
    const builtDatabase = new Database(databaseUrl)
    try {
      const table = builtDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_boot'").get()
      if (table) assert.equal(builtDatabase.prepare('SELECT count(*) AS count FROM runtime_boot').get().count, 0)
    } finally { builtDatabase.close() }
  }
  pass('pnpm build without auth secret', '.output/server/index.mjs; exit 0; no runtime phases or boot rows; build.log')
  for (const [name, changes, field] of [
    ['invalid-port', { PORT: 'abc' }, 'PORT'],
    ['missing-secret', { BETTER_AUTH_SECRET: '' }, 'BETTER_AUTH_SECRET'],
    ['short-secret', { BETTER_AUTH_SECRET: 'short' }, 'BETTER_AUTH_SECRET'],
    ['placeholder-secret', { BETTER_AUTH_SECRET: 'local-development-only-replace-with-a-random-secret' }, 'BETTER_AUTH_SECRET'],
  ]) {
    const result = await bounded(launch('pnpm', ['start'], `${name}.log`, { ...environment, ...changes }), 15000)
    assert(result.code !== null && result.code !== 0, `${name} must exit nonzero, not time out`)
    const log = readFileSync(join(directory, `${name}.log`), 'utf8')
    assert(log.includes(field) && log.includes('环境变量校验失败'), `${name} readable error`)
    assert(!/Listening on|Local:/.test(log), `${name} listened before validation`)
    await freePort(port)
    pass(`pnpm start rejects ${name}`, { ...result, field, log: `${name}.log` })
  }
  const migrationFailureUrl = join(directory, 'migration-failure.sqlite')
  const recoveryFailureUrl = join(directory, 'recovery-failure.sqlite')
  for (const target of [migrationFailureUrl, recoveryFailureUrl]) {
    for (const suffix of ['', '-wal', '-shm']) rmSync(target + suffix, { force: true })
  }
  const malformed = new Database(migrationFailureUrl)
  malformed.exec('CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY)')
  malformed.close()
  await command(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], 'recovery-fixture.log', { ...environment, DATABASE_URL: recoveryFailureUrl })
  const unrecoverable = new Database(recoveryFailureUrl)
  unrecoverable.exec('DROP TABLE runtime_boot')
  unrecoverable.close()
  for (const [phase, target] of [['migrating', migrationFailureUrl], ['recovering', recoveryFailureUrl]]) {
    const result = await bounded(launch('pnpm', ['start'], `${phase}-failure.log`, { ...environment, DATABASE_URL: target }), 15000)
    assert.equal(result.code, 1, `${phase} failure must exit 1`)
    const log = readFileSync(join(directory, `${phase}-failure.log`), 'utf8')
    assert(log.includes(`[runtime] 失败 ${phase}`) && log.includes('[runtime] 启动失败'), `${phase} readable failure`)
    assert(!/Listening on|Local:/.test(log), `${phase} failure listened`)
    await freePort(port)
    pass(`pnpm start rejects ${phase} failure`, { ...result, log: `${phase}-failure.log` })
  }
  const server = launch('pnpm', ['start'], 'production.log')
  const first = await health(server, base, 'health-first')
  const second = await curl(`${base}/api/health`, 'health-second', { header: 'x-sprout-request-id: req_spoofed' })
  const bootId = first.body.bootId
  for (const response of [first, second]) {
    assert.equal(response.status, 200)
    assert.equal(response.body.ok, true)
    assert.equal(response.body.ready, true)
    assert.deepEqual(response.body.database, { ok: true, migrationApplied: true })
    assert.match(response.body.bootId, /^boot_/)
    assert.match(response.body.requestId, /^req_/)
    assert(response.headers.toLowerCase().includes(`x-sprout-request-id: ${response.body.requestId}`))
  }
  assert.notEqual(first.body.requestId, second.body.requestId)
  assert.notEqual(second.body.requestId, 'req_spoofed')
  database = new Database(databaseUrl)
  assert.equal(boot(bootId).phase, 'ready')
  for (const response of [first, second]) {
    assert.equal(database.prepare("SELECT count(*) AS count FROM diagnostic_event WHERE request_id = ? AND event = 'http.response'").get(response.body.requestId).count, 1)
  }
  pass('production health and request correlation', { bootId, requestIds: [first.body.requestId, second.body.requestId], version: first.body.version, database: first.body.database })
  const anonymous = await curl(`${base}/api/diagnostics`, 'diagnostics-anonymous')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.body.error.code, 'unauthorized')
  assert.equal(anonymous.body.requestId, anonymous.body.error.requestId)
  assert(anonymous.headers.includes(anonymous.body.requestId))
  pass('diagnostics session required', { status: anonymous.status, code: anonymous.body.error.code })
  const signup = await curl(`${base}/api/auth/sign-up/email`, 'signup', { cookie: true, body: { email: 'runtime@example.test', password: randomBytes(24).toString('base64url'), name: 'Runtime verifier' } })
  assert.equal(signup.status, 200, signup.text)
  const events = await curl(`${base}/api/diagnostics?requestId=${first.body.requestId}&limit=1`, 'diagnostics-filtered', { cookie: true })
  assert.equal(events.status, 200)
  assert.equal(events.body.ok, true)
  assert.equal(events.body.data.length, 1)
  assert.equal(events.body.data[0].requestId, first.body.requestId)
  assert.match(events.body.data[0].at, /^\d{4}-.*Z$/)
  const projectEvents = await curl(`${base}/api/diagnostics?projectId=prj_missing`, 'diagnostics-project', { cookie: true })
  assert.deepEqual(projectEvents.body.data, [])
  const invalidLimit = await curl(`${base}/api/diagnostics?requestId=${first.body.requestId}&limit=201`, 'diagnostics-invalid-limit', { cookie: true })
  assert.equal(invalidLimit.status, 400)
  assert.equal(invalidLimit.body.error.code, 'validation_failed')
  pass('authenticated diagnostics filters and validation', { status: events.status, count: events.body.data.length, invalidLimit: invalidLimit.status })
  const result = await stop(server)
  await freePort(port)
  assert.equal(boot(bootId).phase, 'stopped')
  assert(boot(bootId).stopped_at > 0)
  const shutdownLog = readFileSync(join(directory, 'production.log'), 'utf8')
  const stopping = shutdownLog.lastIndexOf('"phase":"stopping"')
  const disposed = shutdownLog.lastIndexOf('[runtime] scope-disposed')
  const stopped = shutdownLog.lastIndexOf('"phase":"stopped"')
  assert(stopping >= 0 && disposed > stopping && stopped > disposed, 'shutdown order stopping -> dispose -> stopped')
  pass('SIGTERM process group exits within 10 seconds and boot stopped', { ...result, boot: boot(bootId), order: ['stopping', 'scope-disposed', 'stopped'] })
  database.prepare("INSERT INTO runtime_boot (id, started_at, phase, pid, app_version) VALUES ('boot_abandoned', unixepoch(), 'ready', 2147483647, 'test')").run()
  const restarted = launch(process.execPath, ['.output/server/index.mjs'], 'restarted.log')
  const resumed = await health(restarted, base, 'health-restarted')
  assert.equal(boot('boot_abandoned').phase, 'interrupted')
  const interruptions = database.prepare("SELECT data FROM diagnostic_event WHERE event = 'runtime.interrupted'").all().map((row) => JSON.parse(row.data)).filter((data) => data.bootId === 'boot_abandoned')
  assert.equal(interruptions.length, 1)
  const repeated = await curl(`${base}/api/health`, 'health-repeated')
  assert.equal(repeated.body.bootId, resumed.body.bootId)
  assert.equal(database.prepare("SELECT count(*) AS count FROM runtime_boot WHERE phase = 'ready'").get().count, 1)
  assert.equal((await stop(restarted)).code, 0)
  assert.equal(boot(resumed.body.bootId).phase, 'stopped')
  pass('recovery and direct production exit code', { abandoned: boot('boot_abandoned'), recoveryEvents: interruptions.length, current: boot(resumed.body.bootId), code: 0 })
  await command('pnpm', ['exec', 'vp', 'test', 'run', 'tests/runtime.test.ts', 'tests/diagnostics.test.ts'], 'behavior-tests.log')
  pass('health 503 before ready and 200 after ready', 'pnpm exec vp test run tests/runtime.test.ts tests/diagnostics.test.ts; 8 tests; behavior-tests.log')
  const devBase = `http://localhost:${devPort}`
  const dev = launch('pnpm', ['exec', 'vp', 'dev', '--port', String(devPort)], 'dev.log', { ...environment, APP_ORIGIN: devBase, PORT: String(devPort), NITRO_PORT: String(devPort), NODE_ENV: 'development' })
  const devFirst = await health(dev, devBase, 'dev-health-before')
  const before = modules('dev.log')
  assert(before.length > 0, 'dev runtime module evidence')
  const initial = before.at(-1)
  source = readFileSync(sourcePath, 'utf8')
  probeWritten = true
  writeFileSync(sourcePath, source + '\n')
  let after
  let devAfter
  for (let attempt = 0; attempt < 120; attempt++) {
    await delay(250)
    try { devAfter = await curl(`${devBase}/api/health`, 'dev-health-after') } catch { continue }
    after = modules('dev.log').at(-1)
    if (after.moduleEvals > initial.moduleEvals && devAfter.status === 200) break
  }
  assert(after.moduleEvals > initial.moduleEvals, 'HMR must re-evaluate runtime module')
  assert.equal(devAfter.body.bootId, devFirst.body.bootId)
  assert.equal(after.constructions, 1)
  assert.equal(after.activeResources, 1)
  pass('dev HMR reuses runtime and resource', { before: initial, after, bootId: devAfter.body.bootId, activeBackgroundTasks: 0 })
  writeFileSync(sourcePath, source)
  probeWritten = false
  await stop(dev)
  pass('d-runtime all checks passed', { evidence: join(directory, 'evidence.json'), unverified: ['dev graceful SIGTERM', 'WebSocket', 'multi-process', 'crash during recovery'] })
} catch (error) {
  console.error('FAIL d-runtime', error.stack ?? error)
  process.exitCode = 1
} finally {
  if (probeWritten) writeFileSync(sourcePath, source)
  for (const child of children) kill(child, 'SIGKILL')
  database?.close()
}
JS
