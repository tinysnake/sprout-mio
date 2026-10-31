#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, openSync, closeSync, rmSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/as-p5a-chat-ui')
mkdirSync(directory, { recursive: true })
const database = join(directory, 'verification.sqlite')
let server

function pass(id, detail) {
  console.log(`PASS ${id} :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`)
}
function stop(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, name, env) {
  const descriptor = openSync(join(directory, name), 'w')
  const child = spawn(command, args, { env, detached: true, stdio: ['ignore', descriptor, descriptor] })
  closeSync(descriptor)
  child.completion = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  return child
}
async function command(command, args, name, env, timeout = 300000) {
  const child = launch(command, args, name, env)
  const timer = setTimeout(() => stop(child, 'SIGKILL'), timeout)
  try {
    const result = await child.completion
    assert.equal(result.code, 0, `${command} ${args.join(' ')} failed; see ${join(directory, name)}`)
  } finally { clearTimeout(timer) }
}
async function freePort() {
  for (let port = 3187; port < 3247; port++) {
    try {
      await new Promise((resolve, reject) => {
        const probe = net.createServer()
        probe.on('error', reject)
        probe.listen(port, 'localhost', () => probe.close(resolve))
      })
      return port
    } catch {}
  }
  throw new Error('no free port in 3187-3246')
}

try {
  const port = Number(process.env.SPROUT_P5A_CHAT_UI_PORT ?? await freePort())
  const base = `http://localhost:${port}`
  const env = {
    ...process.env,
    PORT: String(port),
    NITRO_PORT: String(port),
    APP_ORIGIN: base,
    BASE_URL: base,
    DATABASE_URL: database,
    BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
    SPROUT_PI_ENABLED: 'false',
    NODE_ENV: 'production',
    SPROUT_UI_EVIDENCE_DIR: join(directory, 'evidence'),
  }
  for (const suffix of ['', '-wal', '-shm']) rmSync(database + suffix, { force: true })
  await command('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log', env)
  assert(readFileSync(join(directory, 'build.log'), 'utf8').length >= 0)
  assert((await import('node:fs')).existsSync('.output/server/index.mjs'), '真实产物 .output/server/index.mjs 必须存在')
  pass('as-p5a-build-artifact', '.output/server/index.mjs')

  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log', env)
  let ready = false
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) break
    try {
      ready = (await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })).ok
    } catch {}
    if (ready) break
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  assert(ready, `production server not ready; see ${join(directory, 'server.log')}`)
  assert((await import('node:fs')).statSync(database).size > 0, '真实 SQLite 文件必须由服务写入')
  pass('as-p5a-production-server-and-sqlite', { base, database, bytes: (await import('node:fs')).statSync(database).size })

  const browser = launch(
    process.execPath,
    ['--import', 'tsx', 'scripts/browser/as-p5a-chat-ui.mjs'],
    'browser.log',
    env,
  )
  const timer = setTimeout(() => stop(browser, 'SIGKILL'), 300000)
  let browserResult
  try { browserResult = await browser.completion } finally { clearTimeout(timer) }
  if (browserResult.code !== 0) {
    console.error(readFileSync(join(directory, 'browser.log'), 'utf8'))
    throw new Error(`browser flow failed; see ${join(directory, 'browser.log')}`)
  }
  const output = readFileSync(join(directory, 'browser.log'), 'utf8')
  const checks = output.split('\n').filter((line) => /^(PASS|FAIL) [a-z0-9_]/.test(line))
  const required = [
    'group_blank_title_blocks_create',
    'chat_page_hides_request_id',
    'group_title_edited_from_details_rail',
    'group_governance_note_and_testids_once',
    'group_details_drop_instance_row',
    'group_member_list_only_in_member_section',
    'member_row_selects_profile',
    'agent_owner_group_keeps_title_entry',
    'agent_owner_group_keeps_owner_fallback_entry',
    'dm_keeps_members_and_activity_only',
    'channel_owner_change_is_the_only_governance_action',
  ]
  const ids = new Set(checks.map((line) => line.split(' ')[1]))
  for (const id of required) assert(ids.has(id), `browser assertion ${id} 缺失`)
  assert(checks.length >= 27, `expected at least 27 browser assertions, got ${checks.length}`)
  for (const line of checks) console.log(line)
  assert(checks.every((line) => line.startsWith('PASS ')), 'every browser assertion must pass')
  pass('as-p5a-browser-assertions', { count: checks.length, evidence: join(directory, 'evidence/results.json') })
  console.log(`PASS as-p5a-chat-ui :: ${checks.length} browser assertions + build/server/sqlite checks`)
} finally {
  stop(server)
  if (server) {
    const deadline = setTimeout(() => stop(server, 'SIGKILL'), 10000)
    await server.completion.catch(() => {})
    clearTimeout(deadline)
  }
}
JS
