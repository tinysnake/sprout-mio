#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import Database from 'better-sqlite3'

const directory = resolve('.verify/g-identity-data')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_IDENTITY_PORT ?? 3171)
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'valid verification port')
const databaseUrl = join(directory, 'identity.sqlite')
const base = `http://localhost:${port}`
const environment = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
}
const children = new Set()
const evidence = []
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms))
function pass(check, output) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n')
  console.log(`PASS ${check} ${JSON.stringify(output)}`)
}
function kill(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, log, env = environment) {
  const fd = openSync(join(directory, log), 'w')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.completion = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  children.add(child)
  return child
}
async function bounded(child, limit = 300000) {
  let expired = false
  const timer = setTimeout(() => { expired = true; kill(child, 'SIGKILL') }, limit)
  try {
    const result = await child.completion
    assert(!expired, `process ${child.pid} exceeded ${limit}ms`)
    children.delete(child)
    return result
  } finally { clearTimeout(timer) }
}
async function command(command, args, log, env = environment) {
  const result = await bounded(launch(command, args, log, env))
  assert.equal(result.code, 0, `${command} ${args.join(' ')} failed; see ${join(directory, log)}`)
  pass([command, ...args].join(' '), { ...result, log: join(directory, log) })
}
async function freePort() {
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port check timed out')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} occupied`)) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
  })
}
async function health(child, name) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const status = execFileSync('curl', ['--noproxy', '*', '--connect-timeout', '1', '--max-time', '2', '-sS', '-o', join(directory, `${name}.json`), '-w', '%{http_code}', `${base}/api/health`], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] })
      const body = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8'))
      if (status === '200' && body.ok) {
        process.kill(child.pid, 0)
        pass(`${name} /api/health`, { status: Number(status), body, pid: child.pid })
        return body
      }
    } catch {}
    await delay(250)
  }
  throw new Error(`production server not ready; see ${name}.log`)
}
async function stop(child) {
  kill(child)
  const result = await bounded(child, 15000)
  assert.equal(result.code, 0, 'production process exits cleanly')
  await freePort()
  pass('production process stopped', result)
}
function inspectSchema() {
  const db = new Database(databaseUrl)
  try {
    const tables = ['agent_profile', 'project_profile', 'project_member', 'conversation', 'conversation_member', 'agent_instance', 'message']
    const columns = Object.fromEntries(tables.map(table => [table, db.prepare('PRAGMA table_info(' + table + ')').all()]))
    assert(tables.every(table => columns[table].length > 0), 'all seven named P2 tables exist')
    for (const [table, expected] of Object.entries({ project_member: ['project_id','agent_profile_id'], conversation_member: ['conversation_id','member_kind','member_id'] })) {
      assert.deepEqual(columns[table].filter(row => row.pk).sort((a,b) => a.pk-b.pk).map(row => row.name), expected)
    }
    const unique = db.prepare('PRAGMA index_list(agent_instance)').all().find(row => row.name === 'agent_instance_profile_conversation_unique')
    assert.equal(unique.unique, 1)
    assert.deepEqual(db.prepare('PRAGMA index_info(agent_instance_profile_conversation_unique)').all().map(row => row.name), ['agent_profile_id','conversation_id'])
    assert.deepEqual(db.prepare('PRAGMA index_info(message_conversation_created_at_idx)').all().map(row => row.name), ['conversation_id','created_at'])
    for (const [table, constraint] of [['conversation','conversation_kind_check'], ['conversation_member','conversation_member_kind_check'], ['message','message_sender_kind_check']]) {
      assert(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table).sql.includes(constraint))
    }
    const migrations = db.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get().count
    assert.equal(migrations, 2)
    pass('SQLite tables, primary keys, unique index and named checks', { tables, columns, unique, migrations })
  } finally { db.close() }
}

try {
  await freePort()
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  await command('pnpm', ['db:migrate'], 'migrate-first.log')
  await command('pnpm', ['db:migrate'], 'migrate-second.log')
  const migrations = readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort()
  assert.equal(migrations.filter(file => file.startsWith('0001_')).length, 1)
  pass('migration files', migrations)
  inspectSchema()
  await command('pnpm', ['exec', 'vp', 'test', 'run', 'tests/identity-data.test.ts'], 'identity-test.log', { ...environment, NODE_ENV: 'test' })
  const buildEnvironment = { ...environment }
  delete buildEnvironment.BETTER_AUTH_SECRET
  await command('pnpm', ['build'], 'build.log', buildEnvironment)
  const first = launch('pnpm', ['start'], 'server-first.log')
  const firstHealth = await health(first, 'server-first')
  const db = new Database(databaseUrl)
  try {
    assert.equal(db.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get().count, 2)
    assert.equal(db.prepare('SELECT phase FROM runtime_boot WHERE id=?').get(firstHealth.bootId).phase, 'ready')
    pass('startup uses migrated SQLite database', { migrations: 2, bootId: firstHealth.bootId, phase: 'ready' })
  } finally { db.close() }
  await stop(first)
  const second = launch('pnpm', ['start'], 'server-second.log')
  const secondHealth = await health(second, 'server-second')
  assert.notEqual(firstHealth.bootId, secondHealth.bootId)
  await stop(second)
  pass('production restart', { firstBootId: firstHealth.bootId, secondBootId: secondHealth.bootId })
  await command('pnpm', ['check'], 'check.log')
  await command('pnpm', ['test'], 'test.log', { ...environment, NODE_ENV: 'test' })
  pass('g-identity-data all checks passed', { directory, migrations })
} catch (error) {
  console.error(`FAIL g-identity-data ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  for (const child of children) kill(child, 'SIGKILL')
  await Promise.allSettled([...children].map(child => child.completion))
}
JS
