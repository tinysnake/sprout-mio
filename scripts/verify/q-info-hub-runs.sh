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

const directory = resolve('.verify/q-info-hub-runs')
const databaseUrl = join(directory, 'info-hub-runs.sqlite')
const repoRoot = join(directory, 'repos')
const remotes = join(directory, 'remotes')
const holdFlag = join(directory, 'release-slow.flag')
const evidence = []
const children = new Set()
const delay = ms => new Promise(done => setTimeout(done, ms))
const port = Number(process.env.SPROUT_VERIFY_Q_PORT ?? 3173)
const base = `http://localhost:${port}`
const runner = join(directory, 'protocol-runner.mjs')
const environment = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(directory, 'pi-data'),
  SPROUT_REPO_DIR: repoRoot, SPROUT_PI_RUNNER: runner,
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
    assert(!expired, `process ${child.pid} exceeded ${ms}ms`)
    children.delete(child)
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
async function stop(server) {
  kill(server)
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
let ids, cookie, db, server
async function callAs(jar, name, data) {
  assert(ids[name], `built ${name} missing`)
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: 'POST', headers: { Origin: base, Cookie: jar, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', accept: 'application/json' },
    body: JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] }), signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  assert.equal(response.status, 200, `${name} HTTP ${response.status}: ${body.slice(0, 300)}`)
  const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() })
  assert.equal(result.requestId, response.headers.get('x-sprout-request-id'))
  return { result, body }
}
async function callOk(name, data) {
  const { result } = await callAs(cookie, name, data)
  assert(result.ok, `${name} rejected ${JSON.stringify(result)}`)
  return result.data
}
async function project(name) {
  const projectId = (await callOk('createProjectFn', { name })).id
  const agentProfileId = (await callOk('createAgentProfileFn', { name: `${name} agent`, persona: 'Reply concisely.', model: 'protocol/model', effort: 'off' })).id
  await callOk('addProjectMemberFn', { projectId, agentProfileId })
  const direct = await callOk('createDirectChatFn', { projectId, agentProfileId })
  return { projectId, chatId: direct.chat.id, instanceId: direct.instance.id }
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
const inputsOf = runId => db.prepare('SELECT * FROM agent_run_input WHERE run_id=? ORDER BY rowid').all(runId)

const stub = `import {createInterface} from 'node:readline';
import {existsSync,writeFileSync} from 'node:fs';
import {join as joinPath} from 'node:path';
const hold='${holdFlag}';
function waitHold(done){if(existsSync(hold))return done();const t=setInterval(()=>{if(existsSync(hold)){clearInterval(t);done();}},150);setTimeout(()=>{clearInterval(t);done();},90000);}
const input=createInterface({input:process.stdin});
const line=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',raw=>{const x=JSON.parse(raw);
if(x.type==='open') {const file=x.sessionFile??joinPath(x.sessionDirectory,x.sessionId+'.jsonl');
if(!existsSync(file))writeFileSync(file,JSON.stringify({id:x.sessionId})+'\\n');
const slash=x.profile.model.indexOf('/');
line({type:'ready',id:x.id,snapshot:{provider:x.profile.model.slice(0,slash),model:x.profile.model.slice(slash+1),thinking:x.profile.effort??'off',tools:['bash','edit','read','write'],extensions:['sprout-extension'],sessionId:x.sessionId,sessionFile:file,cwd:x.cwd,sdkVersion:'protocol-stub',profile:x.profile}});
} else if(x.type==='prompt') {line({type:'input_delivered',id:x.id,messageId:x.messageId});
if(x.text.includes('SLOW_HOLD'))waitHold(()=>line({type:'settled',id:x.id,text:'SLOW_DONE',stopReason:'stop'}));
else line({type:'settled',id:x.id,text:'PROTOCOL_STUB_REPLY',stopReason:'stop'});
} else if(x.type==='steer') {line({type:'input_rejected',id:x.id,messageId:x.messageId,reason:'stub refuses steer'});
} else if(x.type==='close')process.exit(0);
});process.on('SIGTERM',()=>process.exit(0));`

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
  rmSync(holdFlag, { force: true })
  mkdirSync(repoRoot, { recursive: true })
  writeFileSync(runner, stub); chmodSync(runner, 0o700)
  execFileSync(process.execPath, ['--check', runner], { stdio: 'pipe' })
  await command('pnpm', ['exec', 'vp', 'test', 'run', 'tests/info-hub-runs.test.ts'], 'info-hub-runs-test.log')
  await command('pnpm', ['build'], 'build.log')
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  await health(server)
  db = new Database(databaseUrl)
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { Origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Info Hub runs verification', email: `q-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') }), signal: AbortSignal.timeout(20000),
  })
  assert.equal(signup.status, 200)
  cookie = signup.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0]
  const signupB = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST', headers: { Origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Info Hub runs outsider', email: `q-b-${randomUUID()}@example.test`, password: randomBytes(24).toString('base64url') }), signal: AbortSignal.timeout(20000),
  })
  assert.equal(signupB.status, 200)
  const cookieB = signupB.headers.getSetCookie().find(value => value.includes('session_token=')).split(';')[0]
  ids = serverFnIds()
  for (const required of ['getProjectInfoHubFn', 'getChatInfoFn', 'getTurnStartContextFn'])
    assert(ids[required], `built server function ${required} missing`)

  const marker = `MARKER_P3D_${randomBytes(6).toString('hex')}`
  const source = seedRemote('p3d-main', { 'NOTES.md': marker, 'src/app.ts': 'export const APP = 1;' })
  const main = await project('P3D main')
  await callOk('updateProjectProfileFn', { projectId: main.projectId, gitRemote: 'file://' + source.remote, defaultBranch: 'main' })
  await send(main.chatId, 'analyze the repository')
  const firstRun = await waitRun(main.chatId, 'completed')
  const bareHead = git(['--git-dir', source.remote, 'rev-parse', 'refs/heads/main']).trim()
  assert.equal(bareHead, source.head())

  await send(main.chatId, 'SLOW_HOLD the next analysis')
  const slowRun = await waitRun(main.chatId, 'running')
  await send(main.chatId, 'steer attempt while running')
  await until(() => db.prepare("SELECT count(*) AS count FROM diagnostic_event WHERE event='agent_run.input_delivery_failed' AND run_id=?").get(slowRun.id).count >= 1, 'steer rejection recorded', 10000)
  const inputs = inputsOf(slowRun.id)
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0].disposition, 'delivered', 'first input delivered into the running turn')
  assert.equal(inputs[1].disposition, 'pending', 'steer-rejected input stays pending in the database')
  const heldTurn = await callOk('getTurnStartContextFn', { chatId: main.chatId })
  const heldInfo = await callOk('getChatInfoFn', { chatId: main.chatId })
  const heldHub = await callOk('getProjectInfoHubFn', { projectId: main.projectId })
  assert.equal(heldHub.agents.runs.available, true)
  assert.equal(heldHub.agents.runs.hostEnabled, true)
  assert.equal(heldInfo.runs.active.length, 1)
  assert.equal(heldInfo.runs.active[0].runId, slowRun.id)
  assert.equal(heldInfo.runs.active[0].status, 'running')
  assert.equal(heldInfo.runs.active[0].pendingInputs, inputs.filter(row => row.disposition === 'pending').length, 'pending count equals the database truth, not delivered')
  assert.equal(heldInfo.runs.active[0].pendingInputs, 1)
  assert.equal(heldHub.agents.runs.active.length, 1, 'project view sees the same active run')
  assert.equal(heldTurn.activeRun.runId, slowRun.id)
  assert.equal(heldTurn.activeRun.pendingInputs, 1)
  assert.equal(heldTurn.workspace.basis, 'run_provenance')
  assert.equal(heldTurn.workspace.commit, bareHead, 'turn workspace commit equals the real remote HEAD')
  assert.equal(heldTurn.workspace.fresh, true)
  assert.equal(heldTurn.workspace.ref, 'main')
  assert.match(heldTurn.workspace.source, /p3d-main/)
  assert.equal(heldTurn.injectedIntoPrompt, false, 'turn context declares it is not injected into the model prompt')
  assert.deepEqual(heldHub.machines, [], 'unbound Project has a real empty Machine collection')
  assert.equal(heldHub.leases.available, false, 'leases stay explicitly unavailable')
  assert.match(heldHub.leases.reason, /P4b/)
  pass('active run view: real status, pending input not shown as delivered, turn workspace from run provenance', {
    runId: slowRun.id, pendingInputs: heldInfo.runs.active[0].pendingInputs, commit: heldTurn.workspace.commit, fresh: heldTurn.workspace.fresh,
  })

  const { chromium } = await import('playwright')
  {
    const browser = await chromium.launch()
    try {
      const context = await browser.newContext()
      const separator = cookie.indexOf('=')
      await context.addCookies([{ name: cookie.slice(0, separator), value: cookie.slice(separator + 1), url: base }])
      const page = await context.newPage()
      const consoleErrors = []
      page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
      page.on('pageerror', error => consoleErrors.push(String(error)))
      const screenshotDir = resolve(process.env.SPROUT_UI_EVIDENCE_DIR ?? '.verify/q-info-hub-runs/evidence')
      mkdirSync(screenshotDir, { recursive: true })

      await page.goto(`${base}/projects/${main.projectId}/settings`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      // Project Info Hub 在 Settings 的折叠区，展开后才渲染 run 事实。
      if (await page.locator('[data-testid="info-hub-project-runs-recent"]').count() === 0) await page.locator('[data-testid="project-info-hub-toggle"]').first().click()
      await page.waitForSelector('[data-testid="info-hub-project-runs-recent"]', { timeout: 20000 })
      assert.equal(await page.locator('[data-testid="info-hub-project-runs-host-status"]').textContent(), '宿主已启用')
      const activeItem = page.locator('[data-testid="info-hub-project-runs-active-item"]')
      assert.equal(await activeItem.count(), 1)
      assert.match(await activeItem.textContent(), /运行中/)
      // 历史 run 只保留聚合计数，不再逐条罗列每次开始与结束时间。
      const recentSummary = page.locator('[data-testid="info-hub-project-runs-recent"]')
      assert.match(await recentSummary.textContent(), /最近 \d+ 个 run：.*已完成 \d+/)
      assert.ok(Number(await recentSummary.getAttribute('data-run-count')) >= 1, 'project view keeps the recent run aggregate')
      assert.equal(await page.locator('[data-testid="info-hub-project-runs-recent-item"]').count(), 0, 'per-run history rows are gone')
      const repoBasis = page.locator('[data-testid="info-hub-project-runs-recent-repo"]')
      assert.ok((await repoBasis.textContent()).includes(bareHead), 'project view shows the real commit')
      assert.ok((await repoBasis.textContent()).includes('宿主已更新工作树'), 'fresh provenance rendered')
      const projectShot = join(screenshotDir, 'p3-d-info-hub-project-runs.png')
      await page.screenshot({ path: projectShot, fullPage: true })

      // Chat 视角的 Info Hub 在 inspector 里，由 ?info=1 恢复。
      await page.goto(`${base}/projects/${main.projectId}/chats/${main.chatId}?info=1`, { waitUntil: 'domcontentloaded', timeout: 30000 })
      await page.waitForSelector('[data-testid="info-turn-context"]', { timeout: 20000 })
      assert.match(await page.locator('[data-testid="info-chat-runs-active-pending"]').textContent(), /1 条输入未投递/)
      assert.equal(await page.locator('[data-testid="info-turn-workspace-commit"]').textContent(), bareHead)
      assert.equal(await page.locator('[data-testid="info-turn-workspace-fresh"]').textContent(), '宿主已更新工作树')
      assert.match(await page.locator('[data-testid="info-turn-prompt-injection"]').textContent(), /注入模型 prompt：否/)
      assert.ok((await page.locator('[data-testid="info-turn-previous-run"]').textContent()).includes('已完成'))
      const chatShot = join(screenshotDir, 'p3-d-info-hub-chat-runs.png')
      await page.screenshot({ path: chatShot, fullPage: true })
      assert.deepEqual(consoleErrors, [], 'info hub pages must render without console errors')
      pass('real Chromium renders run facts, repo basis and turn context without console errors', { projectShot, chatShot })
    } finally { await browser.close() }
  }

  writeFileSync(holdFlag, 'release\n')
  await until(() => runsOf(main.chatId).find(row => row.id === slowRun.id)?.status === 'completed', 'held run completed after release', 30000)
  const settledTurn = await callOk('getTurnStartContextFn', { chatId: main.chatId })
  const settledInfo = await callOk('getChatInfoFn', { chatId: main.chatId })
  assert.equal(settledTurn.activeRun, null)
  assert.equal(settledTurn.workspace.basis, 'project_checkout')
  assert.equal(settledTurn.workspace.commit, bareHead, 'settled turn workspace comes from the ready checkout')
  assert.equal(settledTurn.injectedIntoPrompt, false)
  assert.equal(settledInfo.runs.active.length, 0)
  assert.equal(settledInfo.runs.recent.length, 2, 'both completed runs appear in the chat view')
  for (const run of settledInfo.runs.recent) {
    assert.equal(run.status, 'completed')
    assert.equal(run.repo.commit, bareHead, 'view commit equals git rev-parse of the real remote HEAD')
    assert.equal(run.repo.fresh, true)
    assert.equal(run.repo.sourceKind, 'managed_clone')
    assert.equal(run.repo.ref, 'main')
  }
  const provenance = db.prepare('SELECT * FROM repo_provenance WHERE run_id=?').get(settledInfo.runs.recent[0].runId)
  assert.equal(provenance.commit, settledInfo.runs.recent[0].repo.commit, 'view repo matches the provenance row')
  pass('settled runs: recent facts, checkout-based turn workspace, provenance equals view', {
    recent: settledInfo.runs.recent.map(run => ({ runId: run.runId, status: run.status, commit: run.repo.commit, fresh: run.repo.fresh })),
  })

  const ghost = await project('P3D ghost')
  await callOk('updateProjectProfileFn', { projectId: ghost.projectId, defaultBranch: 'main', workDirectory: 'ghost-dir' })
  await send(ghost.chatId, 'analyze the missing copy')
  const ghostRun = await waitRun(ghost.chatId, 'failed')
  const ghostInfo = await callOk('getChatInfoFn', { chatId: ghost.chatId })
  const ghostTurn = await callOk('getTurnStartContextFn', { chatId: ghost.chatId })
  const failedSummary = ghostInfo.runs.recent[0]
  assert.equal(failedSummary.status, 'failed')
  assert.equal(failedSummary.errorCode, 'repo_workdir_missing')
  assert(failedSummary.errorMessage && failedSummary.errorMessage.trim(), 'failed run carries a readable error')
  assert.equal(failedSummary.requestId, ghostRun.request_id, 'failed run carries its requestId')
  assert.equal(failedSummary.repo, undefined, 'a failed preparation must not invent repo basis')
  assert.equal(ghostTurn.previousRun.runId, ghostRun.id)
  assert.equal(ghostTurn.previousRun.errorCode, 'repo_workdir_missing')
  assert.equal(ghostTurn.workspace, null, 'no checkout and no provenance means workspace stays null')
  pass('failed run: readable errorCode, errorMessage and requestId in both views', {
    runId: ghostRun.id, errorCode: failedSummary.errorCode, requestId: failedSummary.requestId,
  })

  const tokens = [main.projectId, main.chatId, main.instanceId, firstRun.id, slowRun.id, bareHead, marker, 'p3d-main', ghost.chatId, ghostRun.error_code, 'ghost-dir', 'P3D main agent']
  for (const [name, input] of [
    ['getProjectInfoHubFn', { projectId: main.projectId }],
    ['getChatInfoFn', { chatId: main.chatId }],
    ['getTurnStartContextFn', { chatId: main.chatId }],
    ['getChatInfoFn', { chatId: ghost.chatId }],
    ['getTurnStartContextFn', { chatId: ghost.chatId }],
  ]) {
    const { result, body } = await callAs(cookieB, name, input)
    assert.equal(result.ok, false, `${name} must reject the other user`)
    assert.equal(result.error.code, 'not_found', `${name} cross-project access is not_found`)
    const leaked = tokens.filter(token => body.includes(token))
    assert.deepEqual(leaked, [], `${name} leaked ${leaked.join(', ')}`)
    pass(`cross-project ${name} is not_found with zero leakage`, { code: result.error.code, leaked })
  }

  const shutdown = await stop(server)
  pass('production shutdown', { directory, exit: shutdown.code })
} catch (error) {
  console.error(`FAIL HERMETIC ${error.stack ?? error}`)
  process.exitCode = 1
} finally {
  for (const child of children) kill(child, 'SIGKILL')
  await Promise.allSettled([...children].map(child => child.completion))
  db?.close()
}
JS
