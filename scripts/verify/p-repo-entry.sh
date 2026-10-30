#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const directory = resolve('.verify/p-repo-entry')
const databaseUrl = join(directory, 'repo.sqlite')
const repoRoot = join(directory, 'repos')
const remotes = join(directory, 'remotes')
const evidence = []
const children = new Set()
const delay = ms => new Promise(done => setTimeout(done, ms))
const port = Number(process.env.SPROUT_VERIFY_P_PORT ?? 3162)
const base = `http://localhost:${port}`
const runner = join(directory, 'protocol-runner.mjs')
const spawnLog = join(directory, 'spawn.jsonl')
const environment = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(directory, 'pi-data'),
  SPROUT_REPO_DIR: repoRoot, SPROUT_PI_RUNNER: runner, SPROUT_VERIFY_PI_SPAWN_LOG: spawnLog,
}
const gitEnv = {
  ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: '', SSH_ASKPASS: '',
}
const git = args => execFileSync('git', args, { encoding: 'utf8', env: gitEnv, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] })

function pass(check, output = {}) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ mode: 'hermetic', checks: evidence }, null, 2) + '\n')
  console.log(`PASS HERMETIC ${check} ${JSON.stringify(output)}`)
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
async function command(executable, args, name, env = environment) {
  const result = await bounded(launch(executable, args, name, env), 600000)
  assert.equal(result.code, 0, `${executable} ${args.join(' ')} failed; see ${name}`)
  pass(`${executable} ${args.join(' ')}`, { exit: result.code, log: join(directory, name) })
}
async function until(probe, label, ms = 30000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(100)
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
  return { seed, remote: join(root, 'remote.git'), head: () => git(['-C', seed, 'rev-parse', 'HEAD']).trim() }
}
function advance(source, file, content) {
  mkdirSync(join(source.seed, file, '..'), { recursive: true })
  writeFileSync(join(source.seed, file), content)
  git(['-C', source.seed, 'add', '.'])
  git(['-C', source.seed, 'commit', '-qm', 'advance'])
  git(['-C', source.seed, 'push', '-q', source.remote, 'main'])
  return git(['-C', source.seed, 'rev-parse', 'HEAD']).trim()
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
  return result
}
async function callOk(name, data) {
  const result = await call(name, data)
  assert(result.ok, `${name} rejected ${JSON.stringify(result)}`)
  return result.data
}
async function project(name, profile) {
  const projectId = (await callOk('createProjectFn', { name })).id
  const agentProfileId = (await callOk('createAgentProfileFn', { name: `${name} agent`, persona: 'Reply concisely. Use tools when asked for repository content.', model: 'protocol/model', effort: 'off' })).id
  await callOk('addProjectMemberFn', { projectId, agentProfileId })
  const direct = await callOk('createDirectChatFn', { projectId, agentProfileId })
  return { projectId, chatId: direct.chat.id }
}
const runsOf = chatId => db.prepare('SELECT * FROM agent_run WHERE chat_id=? ORDER BY rowid').all(chatId)
async function send(chatId, body) {
  return callOk('sendMessageFn', { chatId, body })
}
async function waitRun(chatId, status, previous = 0) {
  return until(() => {
    const rows = runsOf(chatId)
    if (rows.length <= previous) return
    const row = rows.at(-1)
    if (row.status === 'failed' && status !== 'failed') throw new Error(`run failed ${row.error_code}: ${row.error_message}`)
    return row.status === status ? row : undefined
  }, `run ${status}`, 30000)
}
const provenanceOf = runId => db.prepare('SELECT * FROM repo_provenance WHERE run_id=?').get(runId)
const checkoutOf = projectId => db.prepare('SELECT * FROM repo_checkout WHERE project_id=?').get(projectId)

const stub = `import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
const input=createInterface({input:process.stdin});
const line=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',raw=>{const x=JSON.parse(raw);
if(x.type==='open') {const file=x.sessionFile??join(x.sessionDirectory,x.sessionId+'.jsonl');
if(!existsSync(file))writeFileSync(file,JSON.stringify({id:x.sessionId})+'\\n');
const model=x.profile.model??'protocol/unknown';const slash=model.indexOf('/');
line({type:'ready',id:x.id,snapshot:{provider:model.slice(0,slash),model:model.slice(slash+1),thinking:x.profile.effort??'off',tools:['bash','edit','read','write'],extensions:['sprout-extension'],sessionId:x.sessionId,sessionFile:file,cwd:x.cwd,sdkVersion:'protocol-stub',profile:x.profile}});
} else if(x.type==='prompt') {line({type:'input_delivered',id:x.id,messageId:x.messageId});
if(x.text.includes('stub-crash'))process.exit(23);
else line({type:'settled',id:x.id,text:'PROTOCOL_STUB_REPLY',stopReason:'stop'});
} else if(x.type==='close')process.exit(0);
});process.on('SIGTERM',()=>process.exit(0));`

const marker = `MARKER_P3C_${randomBytes(6).toString('hex')}`
const marker2 = `MARKER_P3C_UPDATE_${randomBytes(6).toString('hex')}`
const boundMarker = `MARKER_P3C_BOUND_${randomBytes(6).toString('hex')}`

try {
  await new Promise((done, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port probe timeout')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} occupied`)) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(error))
  })
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'pi-data'), { recursive: true, force: true })
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(remotes, { recursive: true, force: true })
  rmSync(spawnLog, { force: true })
  mkdirSync(repoRoot, { recursive: true })
  writeFileSync(runner, stub); chmodSync(runner, 0o700)
  await command('pnpm', ['exec', 'vp', 'test', 'run', 'tests/repository.test.ts'], 'repository-test.log')
  await command('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log')
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  await health(server)
  db = new Database(databaseUrl)
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { Origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Repo verification', email: `repo-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') }), signal: AbortSignal.timeout(20000),
  })
  assert.equal(signup.status, 200)
  cookie = signup.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0]
  userId = (await signup.json()).user.id
  ids = serverFnIds()

  const managed = seedRemote('p3c-managed', { 'NOTES.md': marker, 'src/app.ts': 'export const APP = 1;' })
  const managedProject = await project('P3C managed')
  await callOk('updateProjectProfileFn', { projectId: managedProject.projectId, gitRemote: 'file://' + managed.remote, defaultBranch: 'main' })
  await send(managedProject.chatId, 'analyze the repository')
  const managedRun = await waitRun(managedProject.chatId, 'completed')
  const managedProvenance = provenanceOf(managedRun.id)
  const bareHead = git(['--git-dir', managed.remote, 'rev-parse', 'refs/heads/main']).trim()
  assert.equal(managedProvenance.commit, managed.head(), 'provenance commit equals the real seed commit')
  assert.equal(managedProvenance.commit, bareHead, 'provenance commit equals the bare remote HEAD')
  assert.equal(managedProvenance.ref, 'main')
  assert.equal(managedProvenance.source_kind, 'managed_clone')
  assert.equal(managedProvenance.fresh, 1)
  assert.equal(managedProvenance.path, join(repoRoot, managedProject.projectId))
  assert.equal(managedProvenance.source, 'file://' + managed.remote)
  assert(managedProvenance.recorded_at >= managedRun.queued_at, 'provenance records acquisition inside the run window')
  assert(managedProvenance.size_bytes > 0, 'provenance records disk usage')
  const managedSnapshot = JSON.parse(managedRun.config_snapshot)
  assert.equal(managedSnapshot.cwd, managedProvenance.path, 'snapshot cwd is the working copy')
  assert.equal(managedSnapshot.repo.commit, managedProvenance.commit, 'snapshot repo commit matches provenance')
  assert.equal(managedSnapshot.repo.provenanceId, managedProvenance.id)
  const managedCheckout = checkoutOf(managedProject.projectId)
  assert.equal(managedCheckout.status, 'ready')
  assert.equal(managedCheckout.commit, bareHead)
  assert(readFileSync(join(managedProvenance.path, 'NOTES.md'), 'utf8').includes(marker), 'working copy carries the pushed file content')
  pass('managed clone: remote HEAD becomes the working copy, provenance and snapshot agree', { runId: managedRun.id, commit: managedProvenance.commit, bareHead, path: managedProvenance.path })

  const updatedHead = advance(managed, 'NOTES.md', marker2)
  await send(managedProject.chatId, 'fetch again')
  const updatedRun = await waitRun(managedProject.chatId, 'completed', 1)
  const updatedProvenance = provenanceOf(updatedRun.id)
  assert.equal(updatedProvenance.commit, updatedHead, 'next run picks up the advanced remote HEAD')
  assert.notEqual(updatedProvenance.commit, managedProvenance.commit)
  assert(readFileSync(join(updatedProvenance.path, 'NOTES.md'), 'utf8').includes(marker2), 'working tree updated to the new commit')
  pass('managed clone follows the advanced remote on the next run', { runId: updatedRun.id, commit: updatedProvenance.commit, updatedHead })

  const bound = seedRemote('p3c-bound', { 'NOTES.md': boundMarker })
  mkdirSync(repoRoot, { recursive: true })
  git(['clone', '-q', bound.remote, join(repoRoot, 'bound-copy')])
  const boundProject = await project('P3C bound')
  await callOk('updateProjectProfileFn', { projectId: boundProject.projectId, gitRemote: 'file://' + bound.remote, defaultBranch: 'main', workDirectory: 'bound-copy' })
  await send(boundProject.chatId, 'read my existing copy')
  const boundRun = await waitRun(boundProject.chatId, 'completed')
  const boundProvenance = provenanceOf(boundRun.id)
  const copyHead = git(['-C', join(repoRoot, 'bound-copy'), 'rev-parse', 'HEAD']).trim()
  assert.equal(boundProvenance.source_kind, 'bound_copy')
  assert.equal(boundProvenance.fresh, 0, 'bound copy provenance shows the tree was not rewritten')
  assert.equal(boundProvenance.commit, copyHead, 'bound copy provenance matches the copy HEAD')
  assert(boundProvenance.fetched_at, 'bound copy with a remote records the fetch time')
  assert.equal(boundProvenance.path, join(repoRoot, 'bound-copy'))
  assert.equal(JSON.parse(boundRun.config_snapshot).cwd, boundProvenance.path)
  assert(readFileSync(join(boundProvenance.path, 'NOTES.md'), 'utf8').includes(boundMarker))
  pass('bound copy: existing local clone is reused with honest provenance', { runId: boundRun.id, commit: boundProvenance.commit, copyHead, fetchedAt: boundProvenance.fetched_at })

  const ghostProject = await project('P3C ghost')
  await callOk('updateProjectProfileFn', { projectId: ghostProject.projectId, defaultBranch: 'main', workDirectory: 'ghost-dir' })
  await send(ghostProject.chatId, 'analyze the missing copy')
  const ghostRun = await waitRun(ghostProject.chatId, 'failed')
  assert.equal(ghostRun.error_code, 'repo_workdir_missing')
  assert(ghostRun.error_message && ghostRun.error_message.trim())
  assert.equal(provenanceOf(ghostRun.id), undefined, 'no provenance may be invented for a failed preparation')
  assert.equal(checkoutOf(ghostProject.projectId), undefined)
  assert(!existsSync(join(repoRoot, ghostProject.projectId)), 'no working copy may be fabricated')
  pass('missing workDirectory fails the run explicitly without fallback', { runId: ghostRun.id, errorCode: ghostRun.error_code, errorMessage: ghostRun.error_message })

  const missingRemote = seedRemote('p3c-missing-remote', { 'FILE.md': 'v1' })
  const missingProject = await project('P3C missing remote')
  await callOk('updateProjectProfileFn', { projectId: missingProject.projectId, gitRemote: 'file://' + join(remotes, 'p3c-missing-remote', 'no-such.git'), defaultBranch: 'main' })
  await send(missingProject.chatId, 'analyze an unreachable remote')
  const missingRun = await waitRun(missingProject.chatId, 'failed')
  assert.equal(missingRun.error_code, 'repo_remote_not_found')
  assert(missingRun.error_message.includes('fatal'), `readable git detail expected: ${missingRun.error_message}`)
  assert(!existsSync(join(repoRoot, missingProject.projectId)), 'failed clone leaves nothing behind')

  const badRefProject = await project('P3C bad ref')
  await callOk('updateProjectProfileFn', { projectId: badRefProject.projectId, gitRemote: 'file://' + missingRemote.remote, defaultBranch: 'no-such-branch' })
  await send(badRefProject.chatId, 'analyze a missing ref')
  const badRefRun = await waitRun(badRefProject.chatId, 'failed')
  assert.equal(badRefRun.error_code, 'repo_ref_not_found')
  assert(badRefRun.error_message && badRefRun.error_message.trim())

  const auth401 = join(directory, 'auth-401.mjs')
  writeFileSync(auth401, "import http from 'node:http';\nhttp.createServer((request, response) => { response.writeHead(401, { 'WWW-Authenticate': 'Basic realm=\"git\"' }); response.end('auth required'); }).listen(Number(process.argv[2]), '127.0.0.1');\n")
  const authPort = port + 1
  const authServer = launch(process.execPath, [auth401, String(authPort)], 'auth-401.log')
  await until(async () => {
    try { return (await fetch(`http://127.0.0.1:${authPort}/repo.git`, { signal: AbortSignal.timeout(1000) })).status === 401 } catch { return false }
  }, 'auth stub ready')
  const authProject = await project('P3C auth')
  await callOk('updateProjectProfileFn', { projectId: authProject.projectId, gitRemote: `http://127.0.0.1:${authPort}/repo.git`, defaultBranch: 'main' })
  await send(authProject.chatId, 'analyze an auth-gated remote')
  const authRun = await waitRun(authProject.chatId, 'failed')
  assert.equal(authRun.error_code, 'repo_auth_failed')
  assert(authRun.error_message && authRun.error_message.trim())
  kill(authServer)
  const explainable = [ghostRun, missingRun, badRefRun, authRun]
  assert(explainable.every(row => row.error_code && row.error_message && row.error_message.trim()), 'every repo failure carries errorCode and non-empty errorMessage')
  assert(new Set(explainable.map(row => row.error_code)).size === 4, 'the four failure classes are distinguishable by code')
  pass('auth, missing remote, missing ref and missing copy fail with four distinct codes', { runs: explainable.map(row => ({ runId: row.id, errorCode: row.error_code, errorMessage: row.error_message })) })

  const rejected = await call('prepareProjectRepoFn', { projectId: missingProject.projectId })
  assert.equal(rejected.ok, false)
  assert.equal(rejected.error.code, 'conflict')
  assert(rejected.error.message.includes('fatal'), 'shared error table forwards the readable git detail')
  assert(rejected.error.requestId)
  pass('repository error class flows through the shared domain error table', { error: rejected.error })

  await stop(server)
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server-disk-cap.log', { ...environment, SPROUT_REPO_MAX_BYTES: '2048' })
  await health(server)
  const bulky = seedRemote('p3c-bulky', { 'BIG.bin': Buffer.alloc(16384, 7) })
  const bulkyProject = await project('P3C bulky')
  await callOk('updateProjectProfileFn', { projectId: bulkyProject.projectId, gitRemote: 'file://' + bulky.remote, defaultBranch: 'main' })
  await send(bulkyProject.chatId, 'analyze the bulky repository')
  const bulkyRun = await waitRun(bulkyProject.chatId, 'failed')
  assert.equal(bulkyRun.error_code, 'repo_disk_limit')
  assert(bulkyRun.error_message.includes('已清理'), `disk limit failure must report the cleanup: ${bulkyRun.error_message}`)
  assert(!existsSync(join(repoRoot, bulkyProject.projectId)), 'half-done managed clone is cleaned up')
  assert.equal(checkoutOf(bulkyProject.projectId), undefined)
  assert.equal(provenanceOf(bulkyRun.id), undefined)
  pass('disk limit rejects and cleans the half-done managed clone', { runId: bulkyRun.id, errorMessage: bulkyRun.error_message, removed: join(repoRoot, bulkyProject.projectId) })
  await stop(server)
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server-ui.log')
  await health(server)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch()
  try {
    const context = await browser.newContext()
    const separator = cookie.indexOf('=')
    await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }])
    const page = await context.newPage()
    const consoleErrors = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => consoleErrors.push(String(error)))
    const screenshotDir = resolve(process.env.SPROUT_UI_EVIDENCE_DIR ?? '.verify/p-repo-entry/evidence')
    mkdirSync(screenshotDir, { recursive: true })

    await page.goto(`${base}/projects/${managedProject.projectId}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('[data-testid="repo-state"]', { timeout: 20000 })
    assert.equal(await page.locator('[data-testid="repo-commit"]').textContent(), git(['--git-dir', managed.remote, 'rev-parse', 'refs/heads/main']).trim())
    assert.equal(await page.locator('[data-testid="repo-ref"]').textContent(), 'main')
    assert.equal(await page.locator('[data-testid="repo-source-kind"]').textContent(), '宿主克隆')
    assert.equal(await page.locator('[data-testid="repo-status"]').textContent(), '就绪')
    assert.match(await page.locator('[data-testid="repo-source"]').textContent(), /p3c-managed/)
    assert.equal(await page.locator('[data-testid="repo-managed-root"]').textContent(), repoRoot)
    assert.match(await page.locator('[data-testid="repo-size"]').textContent(), /\d+ 字节/)
    const settingsShot = join(screenshotDir, 'p3-c-repo-settings.png')
    await page.screenshot({ path: settingsShot, fullPage: true })
    await page.locator('[data-testid="repo-prepare"]').click()
    await page.waitForSelector('[data-testid="repo-prepared"]', { timeout: 20000 })
    assert(!(await page.locator('[data-testid="repo-panel-error"]').count()), 'successful preparation shows no error')
    pass('settings page shows the working copy provenance and prepares on demand', { screenshot: settingsShot, commit: git(['--git-dir', managed.remote, 'rev-parse', 'refs/heads/main']).trim() })

    await page.goto(`${base}/projects/${ghostProject.projectId}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await page.waitForSelector('[data-testid="repo-prepare"]', { timeout: 20000 })
    await page.locator('[data-testid="repo-prepare"]').click()
    await page.waitForSelector('[data-testid="repo-panel-error"]', { timeout: 20000 })
    const errorMeta = await page.locator('[data-testid="repo-panel-error-meta"]').textContent()
    // 裁定 d43：普通失败页只给错误码，requestId 只在 not_found 诊断块里出现。
    assert.match(errorMeta, /conflict/, 'failure shows the error code')
    assert.doesNotMatch(errorMeta, /req_/, 'failure page hides the internal request id')
    assert.match(await page.locator('[data-testid="repo-panel-error"]').textContent(), /不存在/)
    const errorShot = join(screenshotDir, 'p3-c-repo-error.png')
    await page.screenshot({ path: errorShot, fullPage: true })
    assert.deepEqual(consoleErrors, [], 'settings page must render without console errors')
    pass('settings page shows readable acquisition failure with the error code only', { screenshot: errorShot, errorMeta })
  } finally {
    await browser.close()
  }
  await stop(server)
  pass('production shutdown', { directory, marker, boundMarker })
} catch (error) {
  console.error(`FAIL HERMETIC ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  for (const child of children) kill(child, 'SIGKILL')
  await Promise.allSettled([...children].map(child => child.completion))
  db?.close()
}
JS
