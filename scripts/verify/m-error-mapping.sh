#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/m-error-mapping')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_ERROR_MAPPING_PORT ?? 3150)
const databaseUrl = join(directory, 'error-mapping.sqlite')
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
const evidence = []
const children = new Set()
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  const result = await bounded(launch(command, args, name, env), 600000)
  assert.equal(result.code, 0, `${command} ${args.join(' ')} failed; see ${name}`)
}
async function freePort(value) {
  await new Promise((resolve, reject) => {
    const socket = net.connect(value, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port check timed out')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${value} occupied`)) })
    socket.once('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
  })
}
function serverFnIds() {
  const ids = {}
  const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(directory, entry.name)) : entry.name.endsWith('.mjs') ? [join(directory, entry.name)] : [],
  )
  const source = walk(join('.output', 'server')).map((file) => readFileSync(file, 'utf8')).join('\n')
  for (const match of source.matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)) ids[match[2]] = match[1]
  return ids
}
async function waitForHealth(child) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break
    try {
      const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) })
      const body = await response.json()
      if (response.status === 200 && body.ok) return body
    } catch {}
    await delay(250)
  }
  throw new Error('生产服务器未就绪；检查 server.log')
}
async function stop(child) {
  kill(child)
  const result = await bounded(child, 15000)
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-child.pid, 0) } catch (error) {
      if (error.code === 'ESRCH') return result
      throw error
    }
    await delay(100)
  }
  throw new Error(`进程组 ${child.pid} 未退出`)
}

const startRequire = createRequire(import.meta.resolve('@tanstack/react-start'))
const clientRequire = createRequire(startRequire.resolve('@tanstack/start-client-core/package.json'))
const { fromCrossJSON, toCrossJSON } = clientRequire('seroval')

let ids
let cookie
async function signUp() {
  const email = `m-error-mapping-${randomBytes(8).toString('hex')}@example.test`
  const password = randomBytes(24).toString('base64url')
  const response = await fetch(`${base}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { Origin: base, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, name: 'P2-I 错误映射验收用户' }),
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200, 'sign-up status')
  const sessionCookie = response.headers.getSetCookie().find((entry) => entry.includes('session_token='))
  assert(sessionCookie, 'sign-up session cookie')
  return sessionCookie.split(';')[0]
}
async function call(name, input, label, { authenticated = true } = {}) {
  assert(ids[name], `built server function ${name} missing`)
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: 'POST',
    headers: {
      Origin: base,
      ...(authenticated ? { Cookie: cookie } : {}),
      'content-type': 'application/json',
      'x-tsr-serverfn': 'true',
      accept: 'application/json',
    },
    body: JSON.stringify({ t: toCrossJSON({ data: input }), f: 127, m: [] }),
    signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  writeFileSync(join(directory, `${label}.body`), body)
  assert.equal(response.status, 200, `${label} HTTP status; see ${label}.body`)
  const { result: value } = fromCrossJSON(JSON.parse(body), { refs: new Map() })
  const requestId = response.headers.get('x-sprout-request-id')
  assert.equal(value.requestId, requestId, `${label} requestId equals response header`)
  return { value, requestId }
}
async function assertNoErrorDiagnostic(requestId, label) {
  const response = await fetch(`${base}/api/diagnostics?requestId=${requestId}`, {
    headers: { Origin: base, Cookie: cookie },
    signal: AbortSignal.timeout(20000),
  })
  assert.equal(response.status, 200, `${label} diagnostics status`)
  const body = await response.json()
  const errorRows = body.data.filter((row) => row.level === 'error')
  assert.deepEqual(errorRows, [], `${label} 不得写 error 诊断: ${JSON.stringify(errorRows)}`)
  return body.data.length
}

const missing = {
  projectId: 'prj_00000000-0000-4000-8000-000000000000',
  agentProfileId: 'agp_00000000-0000-4000-8000-000000000000',
  chatId: 'cnv_00000000-0000-4000-8000-000000000000',
}

let server
try {
  await freePort(port)
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'cookies.txt'), { force: true })
  const buildEnvironment = { ...environment }
  delete buildEnvironment.BETTER_AUTH_SECRET
  await command('pnpm', ['build'], 'build.log', buildEnvironment)
  pass('pnpm build', { buildLog: 'build.log' })

  server = launch('pnpm', ['start'], 'server.log')
  const ready = await waitForHealth(server)
  pass('production server ready', { requestId: ready.requestId, bootId: ready.bootId, version: ready.version })

  ids = serverFnIds()
  const required = [
    'getProjectFn', 'getProjectProfileFn', 'updateProjectProfileFn',
    'getAgentProfileFn', 'updateAgentProfileFn',
    'getChatFn', 'listChatMembersFn', 'listMessagesFn', 'sendMessageFn',
    'getProjectInfoHubFn', 'getChatInfoFn',
  ]
  for (const name of required) assert(ids[name], `缺少 server function id: ${name}`)
  pass('server function ids present', { required })

  assert(statSync(databaseUrl).size > 0, '真实 SQLite 文件必须存在')
  cookie = await signUp()
  pass('curl/fetch 注册并保存会话 cookie', { cookies: 'sign-up session_token' })

  const probes = [
    { name: 'getProjectFn', input: { projectId: missing.projectId }, label: 'project-detail-missing', code: 'not_found' },
    { name: 'getProjectProfileFn', input: { projectId: missing.projectId }, label: 'project-config-read-missing', code: 'not_found' },
    { name: 'updateProjectProfileFn', input: { projectId: missing.projectId, defaultBranch: 'main' }, label: 'project-config-write-missing', code: 'not_found' },
    { name: 'getAgentProfileFn', input: { agentProfileId: missing.agentProfileId }, label: 'profile-detail-missing', code: 'not_found' },
    { name: 'updateAgentProfileFn', input: { agentProfileId: missing.agentProfileId, name: '改名' }, label: 'profile-update-missing', code: 'not_found' },
    { name: 'getChatFn', input: { chatId: missing.chatId }, label: 'chat-detail-missing', code: 'not_found' },
    { name: 'listChatMembersFn', input: { chatId: missing.chatId }, label: 'chat-members-missing', code: 'not_found' },
    { name: 'listMessagesFn', input: { chatId: missing.chatId }, label: 'chat-messages-missing', code: 'not_found' },
    { name: 'sendMessageFn', input: { chatId: missing.chatId, body: '验收消息' }, label: 'chat-send-missing', code: 'not_found' },
    { name: 'getProjectInfoHubFn', input: { projectId: missing.projectId }, label: 'info-hub-project-missing', code: 'not_found' },
    { name: 'getChatInfoFn', input: { chatId: missing.chatId }, label: 'info-hub-chat-missing', code: 'not_found' },
  ]
  const checked = []
  for (const probe of probes) {
    const { value, requestId } = await call(probe.name, probe.input, probe.label)
    assert.equal(value.ok, false, `${probe.label} 必须失败`)
    assert.equal(value.error.code, probe.code, `${probe.label} 的 code 必须是 ${probe.code}，实际 ${value.error.code}`)
    assert.notEqual(value.error.code, 'internal', `${probe.label} 不得返回 internal`)
    const rows = await assertNoErrorDiagnostic(requestId, probe.label)
    checked.push({ label: probe.label, code: value.error.code, requestId, diagnosticRows: rows })
  }
  pass('不存在 id 的负路径全部 not_found 且无 error 诊断', { checked })

  const anonymousProject = await call('getProjectFn', { projectId: missing.projectId }, 'project-anonymous', { authenticated: false })
  assert.equal(anonymousProject.value.error.code, 'unauthorized', '未登录 getProjectFn 必须 unauthorized')
  const anonymousChatInfo = await call('getChatInfoFn', { chatId: missing.chatId }, 'info-hub-anonymous', { authenticated: false })
  assert.equal(anonymousChatInfo.value.error.code, 'unauthorized', '未登录 getChatInfoFn 必须 unauthorized')
  const anonymousRows = (await assertNoErrorDiagnostic(anonymousProject.requestId, 'project-anonymous'))
    + (await assertNoErrorDiagnostic(anonymousChatInfo.requestId, 'info-hub-anonymous'))
  pass('未登录路径仍为 unauthorized 且无 error 诊断', { project: anonymousProject.requestId, chatInfo: anonymousChatInfo.requestId, diagnosticRows: anonymousRows })

  const shutdown = await stop(server)
  assert.equal(shutdown.code, 0, '生产进程必须退出 0')
  pass('生产进程 SIGTERM 退出', shutdown)
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  if (server?.pid) kill(server, 'SIGKILL')
  process.exitCode = 1
}
JS
