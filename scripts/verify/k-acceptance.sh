#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/k-acceptance')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_ACCEPTANCE_PORT ?? 3145)
const base = `http://localhost:${port}`
const database = join(directory, 'acceptance.sqlite')
const environment = {
  ...process.env, DATABASE_URL: database, APP_ORIGIN: base, PORT: String(port),
  NITRO_PORT: String(port), NODE_ENV: 'production',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  BASE_URL: base, ACCEPTANCE_DIRECTORY: directory,
}
const children = new Set()
const results = []
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
function record(name, passed, detail) {
  results.push({ name, passed, detail })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(results, null, 2) + '\n')
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(detail)}`)
}
function kill(child, signal = 'SIGTERM') {
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
async function bounded(child, ms) {
  let expired = false
  const timer = setTimeout(() => { expired = true; kill(child, 'SIGKILL') }, ms)
  try {
    const result = await child.completion
    children.delete(child)
    assert(!expired, `process ${child.pid} exceeded ${ms}ms`)
    return result
  } finally { clearTimeout(timer) }
}
async function health(child, label) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await response.json()
      if (response.status === 200 && body.ok) {
        writeFileSync(join(directory, `health-${label}.json`), JSON.stringify(body, null, 2) + '\n')
        return body
      }
    } catch {}
    await delay(250)
  }
  throw new Error(`production readiness failed; see server-${label}.log`)
}
async function stop(child, label) {
  kill(child)
  const result = await bounded(child, 15000)
  assert.equal(result.code, 0, `${label} SIGTERM exit code`)
  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    try { process.kill(-child.pid, 0) } catch (error) {
      if (error.code !== 'ESRCH') throw error
      record(`production_${label}_SIGTERM_exit_0`, true, result)
      return
    }
    await delay(100)
  }
  throw new Error(`${label} process group still alive`)
}
async function browser(mode) {
  const log = `browser-${mode}.log`
  const result = await bounded(launch(process.execPath, ['scripts/browser/k-acceptance-flow.mjs', mode], log), 300000)
  record(`real_Chromium_${mode}`, result.code === 0, { ...result, log })
}
try {
  await new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.once('error', reject)
    probe.listen(port, () => probe.close(resolve))
  })
  for (const name of ['acceptance.sqlite', 'acceptance.sqlite-wal', 'acceptance.sqlite-shm', 'state.json', 'before.json', 'after.json', 'receipts.json', 'browser-before.json', 'browser-after.json', 'browser-host-disabled.json']) rmSync(join(directory, name), { force: true })
  const buildEnv = { ...environment }
  delete buildEnv.BETTER_AUTH_SECRET
  const build = await bounded(launch('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log', buildEnv), 300000)
  assert.equal(build.code, 0, 'node scripts/verify/prepare.mjs server failed; see build.log')
  const shell = readFileSync('.output/public/_shell.html', 'utf8')
  const assets = readdirSync('.output/public/assets')
  const referenced = [...shell.matchAll(/assets\/([A-Za-z0-9._-]+\.js)/g)].map(match => match[1])
  assert(referenced.length > 0 && referenced.every(name => assets.includes(name)))
  record('production_build_current_assets', true, { code: build.code, referenced })
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : entry.name.endsWith('.mjs') ? [join(path, entry.name)] : [])
  const source = walk('.output/server').map(path => readFileSync(path, 'utf8')).join('\n')
  const ids = Object.fromEntries([...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map(match => [match[2], match[1]]))
  writeFileSync(join(directory, 'server-functions.json'), JSON.stringify(ids, null, 2) + '\n')
  const first = launch(process.execPath, ['.output/server/index.mjs'], 'server-before.log')
  const before = await health(first, 'before')
  record('production_first_ready', true, { bootId: before.bootId })
  await browser('before')
  assert(readFileSync(join(directory, 'before.json'), 'utf8'), 'missing restart snapshot')
  await stop(first, 'before')
  const state = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  const snapshot = JSON.parse(readFileSync(join(directory, 'before.json'), 'utf8'))
  const sqlite = new Database(database)
  try {
    sqlite.transaction(() => {
      assert.throws(() => sqlite.prepare('INSERT INTO agent_instance (id, agent_profile_id, chat_id, project_id) VALUES (?, ?, ?, ?)').run(`ins_${randomUUID()}`, state.agentProfileId, snapshot.chatId, state.project.id), error => error.code === 'SQLITE_CONSTRAINT_UNIQUE')
      assert.equal(sqlite.prepare('SELECT count(*) AS count FROM agent_instance WHERE agent_profile_id = ? AND chat_id = ?').get(state.agentProfileId, snapshot.chatId).count, 1)
    })()
    record('profile_chat_duplicate_instance_rejected_by_SQLite', true, { agentProfileId: state.agentProfileId, chatId: snapshot.chatId, count: 1, code: 'SQLITE_CONSTRAINT_UNIQUE' })
    // 重启前已提交的 Agent 回执落成快照：after 轮用它证明页面按原序逐字渲染同一批回执。
    const agentReceipts = sqlite.prepare("SELECT body FROM message WHERE chat_id = ? AND sender_kind = 'agent' ORDER BY created_at, rowid").all(snapshot.chatId).map(row => row.body)
    writeFileSync(join(directory, 'receipts.json'), JSON.stringify(agentReceipts, null, 2) + '\n')
    record('restart_agent_receipts_recorded', true, { chatId: snapshot.chatId, receipts: agentReceipts.length })
  } finally { sqlite.close() }
  // 宿主关闭态的诚实表达需要独立的服务实例：只换 SPROUT_PI_ENABLED，同一份 SQLite 与同一批页面数据。
  const hostDisabledEnv = { ...environment, SPROUT_PI_ENABLED: 'false' }
  const disabled = launch(process.execPath, ['.output/server/index.mjs'], 'server-host-disabled.log', hostDisabledEnv)
  const disabledReady = await health(disabled, 'host-disabled')
  record('production_host_disabled_ready', true, { bootId: disabledReady.bootId, SPROUT_PI_ENABLED: 'false' })
  await browser('host-disabled')
  await stop(disabled, 'host-disabled')
  const second = launch(process.execPath, ['.output/server/index.mjs'], 'server-after.log')
  const after = await health(second, 'after')
  assert.match(before.bootId, /^boot_/)
  assert.match(after.bootId, /^boot_/)
  assert.notEqual(after.bootId, before.bootId)
  record('restart_new_bootId_same_SQLite', true, { database, before: before.bootId, after: after.bootId })
  await browser('after')
  await stop(second, 'after')
} catch (error) {
  record('acceptance_runner', false, { error: error.stack ?? String(error) })
} finally {
  for (const child of children) kill(child, 'SIGKILL')
}
const failed = results.filter(result => !result.passed)
console.log(`acceptance runner checks=${results.length} failed=${failed.length}`)
process.exitCode = failed.length ? 1 : 0
JS
