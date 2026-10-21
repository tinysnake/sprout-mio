#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const directory = resolve('.verify/live-pi-repo-analysis')
mkdirSync(directory, { recursive: true })
const databaseUrl = join(directory, 'repo.sqlite')
const repoRoot = join(directory, 'repos')
const remotes = join(directory, 'remotes')
const evidence = []
const children = new Set()
const delay = ms => new Promise(done => setTimeout(done, ms))
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
const model = process.env.SPROUT_VERIFY_PI_MODEL ?? 'deepseek/deepseek-flash'
const port = Number(process.env.SPROUT_VERIFY_PI_LIVE_PORT ?? 3163)
const base = `http://localhost:${port}`
const environment = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(directory, 'pi-data'),
  SPROUT_REPO_DIR: repoRoot,
}
delete environment.SPROUT_PI_RUNNER
const gitEnv = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', SSH_ASKPASS: '',
}
const git = args => execFileSync('git', args, { encoding: 'utf8', env: gitEnv, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })

function pass(check, output = {}) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ mode: 'real-model', checks: evidence }, null, 2) + '\n')
  console.log(`PASS LIVE ${check} ${JSON.stringify(output)}`)
}
function kill(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, name, env = environment) {
  const fd = openSync(join(directory, name), 'w')
  const child = spawn(command, args, { detached: true, stdio: ['ignore', fd, fd], env })
  closeSync(fd)
  child.completion = new Promise((done, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => done({ code, signal }))
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
async function command(executable, args, name) {
  const result = await bounded(launch(executable, args, name), 600000)
  assert.equal(result.code, 0, `${executable} ${args.join(' ')} failed; see ${name}`)
  pass(`${executable} ${args.join(' ')}`, { exit: result.code, log: join(directory, name) })
}
async function until(probe, label, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(200)
  }
  throw new Error(`${label} timed out after ${ms}ms`)
}
async function health(server) {
  return until(async () => {
    assert(server.exitCode === null && server.signalCode === null, 'server exited before ready')
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      return response.status === 200 ? response.json() : undefined
    } catch { return undefined }
  }, 'production ready', 60000)
}
async function stop(server, signal = 'SIGTERM') {
  kill(server, signal)
  const result = await bounded(server, 15000)
  assert.equal(result.code, 0, `server shutdown failed ${JSON.stringify(result)}`)
  return result
}
function seedRemote(name, files) {
  const root = join(remotes, name)
  const seed = join(root, 'seed')
  rmSync(root, { recursive: true, force: true })
  mkdirSync(seed, { recursive: true })
  git(['init', '-q', '-b', 'main', seed])
  git(['-C', seed, 'config', 'user.email', 'seed@example.test'])
  git(['-C', seed, 'config', 'user.name', 'seed'])
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(join(seed, file, '..'), { recursive: true })
    writeFileSync(join(seed, file), content)
  }
  git(['-C', seed, 'add', '.'])
  git(['-C', seed, 'commit', '-qm', 'seed'])
  git(['clone', '-q', '--bare', seed, join(root, 'remote.git')])
  return { seed, remote: join(root, 'remote.git') }
}

const require = createRequire(import.meta.url)
const Database = require('better-sqlite3')
const startRequire = createRequire(import.meta.resolve('@tanstack/react-start'))
const clientRequire = createRequire(startRequire.resolve('@tanstack/start-client-core/package.json'))
const { fromCrossJSON, toCrossJSON } = clientRequire('seroval')
function serverFnIds() {
  const walk = path => readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : entry.name.endsWith('.mjs') ? [join(path, entry.name)] : [])
  const source = walk('.output/server').map(file => readFileSync(file, 'utf8')).join('\n')
  return Object.fromEntries([...source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map(match => [match[2], match[1]]))
}
let ids, cookie, db, server, userId
async function call(name, data) {
  assert(ids[name], `built ${name} missing`)
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: 'POST', headers: { Origin: base, Cookie: cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', accept: 'application/json' },
    body: JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] }), signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  assert.equal(response.status, 200, `${name} HTTP ${response.status}: ${body.slice(0, 300)}`)
  const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() })
  assert.equal(result.requestId, response.headers.get('x-sprout-request-id'))
  assert(result.ok, `${name} rejected ${JSON.stringify(result)}`)
  return result.data
}
async function waitRun(chatId, status, previous = 0) {
  return until(() => {
    const rows = db.prepare('SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid').all(chatId)
    if (rows.length <= previous) return
    const row = rows.at(-1)
    if (row.status === 'failed' && status !== 'failed') throw new Error(`run failed ${row.error_code}: ${row.error_message}`)
    return row.status === status ? row : undefined
  }, `run ${status}`, 600000)
}

const marker = `MARKER_LIVE_P3C_${randomBytes(6).toString('hex')}`

try {
  await new Promise((done, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port probe timeout')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} occupied`)) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(error))
  })
  if (!existsSync(join(agentDir, 'auth.json'))) {
    console.error('SKIPPED real Pi credentials missing; live verification is not PASS')
    process.exitCode = 2
  } else {
    for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
    rmSync(join(directory, 'pi-data'), { recursive: true, force: true })
    rmSync(repoRoot, { recursive: true, force: true })
    mkdirSync(repoRoot, { recursive: true })
    await command('pnpm', ['build'], 'build.log')
    server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
    await health(server)
    db = new Database(databaseUrl)
    const signup = await fetch(`${base}/api/auth/sign-up/email`, {
      method: 'POST', headers: { Origin: base, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Repo live verification', email: `repo-live-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') }), signal: AbortSignal.timeout(20000),
    })
    assert.equal(signup.status, 200)
    cookie = signup.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0]
    userId = (await signup.json()).user.id
    ids = serverFnIds()
    const source = seedRemote('live-repo', { 'NOTES.md': marker, 'src/main.ts': 'export const MAIN = true;' })
    const remoteHead = git(['--git-dir', source.remote, 'rev-parse', 'refs/heads/main']).trim()
    const projectId = (await call('createProjectFn', { name: 'Live repo analysis' })).id
    const agentProfileId = (await call('createAgentProfileFn', { name: 'Live repo agent', persona: 'Reply concisely. Use tools when asked for repository content.', model, effort: 'off' })).id
    await call('addProjectMemberFn', { projectId, agentProfileId })
    const direct = await call('createDirectChatFn', { projectId, agentProfileId })
    const chatId = direct.chat.id
    await call('updateProjectProfileFn', { projectId, gitRemote: 'file://' + source.remote, defaultBranch: 'main' })
    const windowStart = Date.now()
    await call('sendMessageFn', { chatId, body: 'Use the read tool to read the file NOTES.md in this repository and reply with exactly the marker string it contains, nothing else.' })
    const run = await waitRun(chatId, 'completed')
    const snapshot = JSON.parse(run.config_snapshot)
    const provenance = db.prepare('SELECT * FROM repo_provenance WHERE run_id=?').get(run.id)
    const reply = db.prepare('SELECT body FROM message WHERE id=?').get(run.assistant_message_id).body
    assert(reply.includes(marker), `live reply must contain the repository marker ${JSON.stringify({ expected: marker, actual: reply, runId: run.id })}`)
    assert.notEqual(snapshot.sdkVersion, 'protocol-stub')
    assert(snapshot.tools.includes('read'), 'the live turn has the read tool available')
    assert.equal(snapshot.cwd, join(repoRoot, projectId), 'live turn cwd is the managed working copy')
    assert.equal(snapshot.repo.commit, remoteHead, 'snapshot commit equals the real remote HEAD')
    assert.equal(provenance.commit, remoteHead, 'provenance commit equals the real remote HEAD')
    assert.equal(provenance.path, snapshot.cwd, 'provenance path matches the snapshot cwd')
    assert.equal(provenance.ref, 'main')
    assert.equal(provenance.fresh, 1)
    assert(provenance.recorded_at * 1000 >= windowStart - 5000, 'provenance acquisition time falls inside the run window')
    assert(provenance.recorded_at * 1000 <= Date.now() + 5000, 'provenance acquisition time is not in the future')
    const transcript = readFileSync(snapshot.sessionFile, 'utf8')
    assert(transcript.includes(marker), 'real Pi transcript contains the repository marker')
    assert(transcript.includes('NOTES.md'), 'real Pi transcript shows the repository file was read')
    pass('real model reads the pushed repository content with matching provenance', {
      model, runId: run.id, reply, snapshotCommit: snapshot.repo.commit, provenanceCommit: provenance.commit,
      remoteHead, provenancePath: provenance.path, recordedAt: new Date(provenance.recorded_at * 1000).toISOString(),
      sessionFile: snapshot.sessionFile,
    })
    await stop(server)
    pass('production shutdown', { directory, runs: db.prepare('SELECT id,status FROM agent_run').all() })
  }
} catch (error) {
  console.error(`FAIL LIVE ${error.stack ?? error}`)
  if (db) {
    try {
      const rows = db.prepare('SELECT id,status,stop_reason,error_code,error_message,config_snapshot FROM agent_run').all()
      console.error('LIVE_FAILURE_RUN_STATES ' + JSON.stringify(rows, null, 2))
      for (const row of rows) {
        if (!row.config_snapshot) continue
        const file = JSON.parse(row.config_snapshot).sessionFile
        if (!file || !existsSync(file)) continue
        const content = readFileSync(file, 'utf8')
        console.error(`LIVE_FAILURE_FULL_TRANSCRIPT ${file}\n${content}`)
        writeFileSync(join(directory, 'failure-transcript.jsonl'), content)
      }
    } catch (diagnosticError) {
      console.error(`LIVE_FAILURE_DIAGNOSTIC_FAILED ${diagnosticError}`)
    }
  }
  process.exitCode = 1
} finally {
  for (const child of children) kill(child, 'SIGKILL')
  await Promise.allSettled([...children].map(child => child.completion))
  db?.close()
}
JS
