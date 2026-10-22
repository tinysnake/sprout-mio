#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'

const directory = resolve('.verify/j-info-hub')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_INFO_HUB_PORT ?? 3144)
const databaseUrl = join(directory, 'info-hub.sqlite')
const stateFile = join(directory, 'state.json')
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
/** server function 的请求体是 Seroval CrossJSON，客户端与 curl 走同一协议。 */
function cross(value, state) {
  if (typeof value === 'string') return { t: 1, s: value }
  if (typeof value === 'number') return { t: 0, s: value }
  if (typeof value === 'boolean') return { t: 2, s: value ? 1 : 0 }
  const i = state.next++
  const k = Object.keys(value)
  return { t: 10, i, p: { k, v: k.map((key) => cross(value[key], state)) }, o: 0 }
}
function serverFnBody(data) {
  return JSON.stringify({ t: cross({ data }, { next: 0 }), f: 127, m: [] })
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
async function curl(url, name, { body, jar = 'cookies.txt', header, json = true } = {}) {
  const target = join(directory, `${name}.body`)
  const headers = join(directory, `${name}.headers`)
  const args = ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '20', '-sS', '-o', target, '-D', headers, '-w', '%{http_code}', url]
  for (const value of header ?? []) args.push('-H', value)
  if (body) args.push('-H', 'content-type: application/json', '--data', body)
  if (jar) args.push('-b', join(directory, jar), '-c', join(directory, jar))
  const child = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'], env: environment })
  let output = '', errors = ''
  child.stdout.on('data', (data) => { output += data })
  child.stderr.on('data', (data) => { errors += data })
  await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code) => code === 0 ? resolve() : reject(new Error(errors)))
  })
  const text = readFileSync(target, 'utf8')
  const headerText = readFileSync(headers, 'utf8')
  const requestId = headerText.split('\n').map((line) => line.trim()).find((line) => line.toLowerCase().startsWith('x-sprout-request-id:'))?.split(':')[1]?.trim()
  return { status: Number(output), text, headers: headerText, requestId, body: json && text.trim() ? JSON.parse(text) : undefined }
}
async function waitForHealth(child) {
  for (let attempt = 0; attempt < 160; attempt++) {
    if (child.exitCode !== null || child.signalCode !== null) break
    try {
      const result = await curl(`${base}/api/health`, 'health', { jar: null })
      if (result.status === 200 && result.body.ok) return result
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

let server
try {
  await freePort(port)
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'cookies.txt'), { force: true })
  rmSync(join(directory, 'cookies-b.txt'), { force: true })
  rmSync(stateFile, { force: true })
  const buildEnvironment = { ...environment }
  delete buildEnvironment.BETTER_AUTH_SECRET
  await command('pnpm', ['build'], 'build.log', buildEnvironment)
  const shell = readFileSync('.output/public/_shell.html', 'utf8')
  const clientAssets = readdirSync('.output/public/assets')
  const referenced = [...shell.matchAll(/assets\/([A-Za-z0-9._-]+\.js)/g)].map((match) => match[1])
  assert(referenced.length > 0 && referenced.every((file) => clientAssets.includes(file)), 'SPA shell 必须只引用本次构建的客户端资源')
  pass('pnpm build', { shell: '.output/public/_shell.html', referenced, buildLog: 'build.log' })

  server = launch('pnpm', ['start'], 'server.log')
  const ready = await waitForHealth(server)
  pass('production server ready', { requestId: ready.requestId, bootId: ready.body.bootId, version: ready.body.version })

  const ids = serverFnIds()
  const required = ['getProjectInfoHubFn', 'getChatInfoFn']
  for (const name of required) assert(ids[name], `缺少 server function id: ${name}`)
  pass('server function ids present', { required })

  const origin = `Origin: ${base}`
  const serverFnHeaders = ['x-tsr-serverfn: true', origin, 'accept: application/x-tss-framed, application/json']
  const anonymousHub = await curl(`${base}/_serverFn/${ids.getProjectInfoHubFn}`, 'info-hub-anonymous', {
    header: serverFnHeaders,
    body: serverFnBody({ projectId: 'prj_00000000-0000-4000-8000-000000000000' }),
  })
  assert.equal(anonymousHub.status, 200, anonymousHub.text)
  assert(anonymousHub.text.includes('unauthorized'), '未登录调用 getProjectInfoHubFn 必须返回 unauthorized 载荷')
  const anonymousChat = await curl(`${base}/_serverFn/${ids.getChatInfoFn}`, 'chat-info-anonymous', {
    header: serverFnHeaders,
    body: serverFnBody({ chatId: 'cnv_00000000-0000-4000-8000-000000000000' }),
  })
  assert.equal(anonymousChat.status, 200, anonymousChat.text)
  assert(anonymousChat.text.includes('unauthorized'), '未登录调用 getChatInfoFn 必须返回 unauthorized 载荷')
  pass('未登录调用两个 Info Hub boundary 返回 unauthorized', { hub: anonymousHub.requestId, chat: anonymousChat.requestId })

  assert(statSync(databaseUrl).size > 0, '真实 SQLite 文件必须存在')
  const browser = await bounded(launch(process.execPath, ['scripts/browser/j-info-hub-flow.mjs'], 'browser.log', { ...environment, BASE_URL: base, INFO_HUB_STATE_FILE: stateFile }), 300000)
  assert.equal(browser.code, 0, `浏览器流程失败；见 browser.log:\n${readFileSync(join(directory, 'browser.log'), 'utf8')}`)
  pass('真实 Chromium 流程', { log: 'browser.log', screenshots: `${process.env.SPROUT_UI_EVIDENCE_DIR ?? 'docs/p1/evidence'}/p2-j-*.png` })

  const state = JSON.parse(readFileSync(stateFile, 'utf8'))
  assert.match(state.projectId, /^prj_/, '状态文件必须记录 projectId')
  assert.match(state.chatId, /^cnv_/, '状态文件必须记录 chatId')
  const password = randomBytes(24).toString('base64url')
  const signupB = await curl(`${base}/api/auth/sign-up/email`, 'signup-b', {
    jar: 'cookies-b.txt',
    header: [origin],
    body: JSON.stringify({ email: `j-info-hub-b-${Date.now()}@example.test`, password, name: 'P2-J 验收用户 B' }),
  })
  assert.equal(signupB.status, 200, signupB.text)
  const callB = { jar: 'cookies-b.txt', header: serverFnHeaders }
  const hubB = await curl(`${base}/_serverFn/${ids.getProjectInfoHubFn}`, 'info-hub-cross-hub', {
    ...callB,
    body: serverFnBody({ projectId: state.projectId }),
  })
  assert.equal(hubB.status, 200, hubB.text)
  assert(hubB.text.includes('not_found'), `第二用户调 getProjectInfoHubFn 必须 not_found: ${hubB.text.slice(0, 200)}`)
  const chatB = await curl(`${base}/_serverFn/${ids.getChatInfoFn}`, 'info-hub-cross-chat', {
    ...callB,
    body: serverFnBody({ chatId: state.chatId }),
  })
  assert.equal(chatB.status, 200, chatB.text)
  assert(chatB.text.includes('not_found'), `第二用户调 getChatInfoFn 必须 not_found: ${chatB.text.slice(0, 200)}`)
  const leaked = [state.projectId, state.chatId, state.instanceId, state.agentName, state.outsiderName]
    .filter((token) => hubB.text.includes(token) || chatB.text.includes(token))
  assert.deepEqual(leaked, [], `响应体不得泄漏其他 Project 的对象 id 或名称: ${leaked.join(', ')}`)
  pass('第二用户的越权与不存在都是 not_found 且不泄漏对象 id 或名称', { hubB: hubB.text.slice(0, 160), chatB: chatB.text.slice(0, 160), leaked })

  const shutdown = await stop(server)
  assert.equal(shutdown.code, 0, '生产进程必须退出 0')
  pass('生产进程 SIGTERM 退出', shutdown)
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  if (server?.pid) kill(server, 'SIGKILL')
  process.exitCode = 1
}
JS
