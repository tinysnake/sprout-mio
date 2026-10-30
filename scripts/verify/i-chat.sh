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

const directory = resolve('.verify/i-chat')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_CHAT_PORT ?? 3143)
const databaseUrl = join(directory, 'chat.sqlite')
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
async function curl(url, name, { body, cookie = false, jar = 'cookies.txt', header, json = true } = {}) {
  const target = join(directory, `${name}.body`)
  const headers = join(directory, `${name}.headers`)
  const args = ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '20', '-sS', '-o', target, '-D', headers, '-w', '%{http_code}', url]
  for (const value of header ?? []) args.push('-H', value)
  if (body) args.push('-H', 'content-type: application/json', '--data', body)
  if (cookie) args.push('-b', join(directory, jar), '-c', join(directory, jar))
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
      const result = await curl(`${base}/api/health`, 'health')
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
let restarted
try {
  await freePort(port)
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'cookies.txt'), { force: true })
  rmSync(stateFile, { force: true })
  const buildEnvironment = { ...environment }
  delete buildEnvironment.BETTER_AUTH_SECRET
  await command('node', ['scripts/verify/prepare.mjs', 'server'], 'build.log', buildEnvironment)
  const shell = readFileSync('.output/public/_shell.html', 'utf8')
  const clientAssets = readdirSync('.output/public/assets')
  const referenced = [...shell.matchAll(/assets\/([A-Za-z0-9._-]+\.js)/g)].map((match) => match[1])
  assert(referenced.length > 0 && referenced.every((file) => clientAssets.includes(file)), 'SPA shell 必须只引用本次构建的客户端资源')
  pass('node scripts/verify/prepare.mjs server', { shell: '.output/public/_shell.html', referenced, buildLog: 'build.log' })

  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  const ready = await waitForHealth(server)
  const firstBootId = ready.body.bootId
  pass('production server ready', { requestId: ready.requestId, bootId: firstBootId, version: ready.body.version })

  const ids = serverFnIds()
  const required = [
    'createDirectChatFn', 'listChatsFn', 'getChatFn',
    'listChatMembersFn', 'listInstancesForChatFn', 'listMessagesFn', 'sendMessageFn',
    'createProjectFn', 'createAgentProfileFn', 'addProjectMemberFn',
    'updateChatTitleFn', 'clearChatTitleFn',
  ]
  for (const name of required) assert(ids[name], `缺少 server function id: ${name}`)
  pass('server function ids present', { required })

  const origin = `Origin: ${base}`
  const anonymous = await curl(`${base}/_serverFn/${ids.sendMessageFn}`, 'chat-anonymous', {
    header: ['x-tsr-serverfn: true', origin, 'accept: application/x-tss-framed, application/json'],
    body: serverFnBody({ chatId: 'cnv_00000000-0000-4000-8000-000000000000', body: '无会话' }),
  })
  assert.equal(anonymous.status, 200, anonymous.text)
  assert(anonymous.text.includes('unauthorized'), '未登录必须返回 unauthorized 载荷')
  pass('未登录调用 sendMessageFn 返回 unauthorized', { status: anonymous.status, requestId: anonymous.requestId })

  const noOrigin = await curl(`${base}/_serverFn/${ids.listChatsFn}`, 'chat-no-origin', {
    header: ['x-tsr-serverfn: true', 'accept: application/x-tss-framed, application/json'],
    body: serverFnBody({ projectId: 'prj_00000000-0000-4000-8000-000000000000' }),
  })
  assert.equal(noOrigin.status, 200)
  assert(noOrigin.text.includes('unauthorized'), '无 Origin 且未登录必须返回 unauthorized 载荷')
  pass('无 Origin 未登录调用返回 unauthorized', { status: noOrigin.status, requestId: noOrigin.requestId })

  // 标题的 HTTP 级反证：未登录调用被拒，登录态的跨 Project 调用被拒且不写库。
  const serverFnHeaders = ['x-tsr-serverfn: true', origin, 'accept: application/x-tss-framed, application/json']
  const password = randomBytes(24).toString('base64url')
  const signupA = await curl(`${base}/api/auth/sign-up/email`, 'signup-title-a', {
    cookie: true,
    header: [origin],
    body: JSON.stringify({ email: `i-chat-title-a-${Date.now()}@example.test`, password, name: 'I-Ch 标题 A' }),
  })
  assert.equal(signupA.status, 200, signupA.text)
  const projectA = await curl(`${base}/_serverFn/${ids.createProjectFn}`, 'title-project-a', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ name: '标题 HTTP 验收 A' }),
  })
  assert.equal(projectA.status, 200, projectA.text)
  const projectAId = projectA.text.match(/prj_[0-9a-f-]{36}/)?.[0]
  assert(projectAId, `创建 Project 必须返回 id: ${projectA.text.slice(0, 200)}`)
  const profileA = await curl(`${base}/_serverFn/${ids.createAgentProfileFn}`, 'title-profile-a', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ name: '标题 HTTP Agent' }),
  })
  assert.equal(profileA.status, 200, profileA.text)
  const profileAId = profileA.text.match(/agp_[0-9a-f-]{36}/)?.[0]
  assert(profileAId, `创建 profile 必须返回 id: ${profileA.text.slice(0, 200)}`)
  const memberA = await curl(`${base}/_serverFn/${ids.addProjectMemberFn}`, 'title-member-a', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ projectId: projectAId, agentProfileId: profileAId }),
  })
  assert.equal(memberA.status, 200, memberA.text)
  const dmA = await curl(`${base}/_serverFn/${ids.createDirectChatFn}`, 'title-dm-a', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ projectId: projectAId, agentProfileId: profileAId }),
  })
  assert.equal(dmA.status, 200, dmA.text)
  const chatAId = dmA.text.match(/cnv_[0-9a-f-]{36}/)?.[0]
  assert(chatAId, `创建 DM 必须返回 chat id: ${dmA.text.slice(0, 200)}`)

  const anonymousTitle = await curl(`${base}/_serverFn/${ids.updateChatTitleFn}`, 'chat-title-anonymous', {
    header: serverFnHeaders,
    body: serverFnBody({ chatId: chatAId, title: '未登录改名' }),
  })
  assert.equal(anonymousTitle.status, 200, anonymousTitle.text)
  assert(anonymousTitle.text.includes('unauthorized'), `未登录重命名必须 unauthorized: ${anonymousTitle.text.slice(0, 200)}`)
  pass('HTTP 未登录调用 updateChatTitleFn 返回 unauthorized', { status: anonymousTitle.status, requestId: anonymousTitle.requestId })

  const renameA = await curl(`${base}/_serverFn/${ids.updateChatTitleFn}`, 'chat-title-rename-a', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ chatId: chatAId, title: 'A 的验收标题' }),
  })
  assert.equal(renameA.status, 200, renameA.text)
  assert(renameA.text.includes('A 的验收标题'), `重命名必须回传新标题: ${renameA.text.slice(0, 200)}`)
  pass('HTTP 创建者重命名成功并回传新标题', { requestId: renameA.requestId })

  const passwordB = randomBytes(24).toString('base64url')
  const signupB = await curl(`${base}/api/auth/sign-up/email`, 'signup-title-b', {
    cookie: true,
    jar: 'cookies-title-b.txt',
    header: [origin],
    body: JSON.stringify({ email: `i-chat-title-b-${Date.now()}@example.test`, password: passwordB, name: 'I-Ch 标题 B' }),
  })
  assert.equal(signupB.status, 200, signupB.text)
  const crossTitle = await curl(`${base}/_serverFn/${ids.updateChatTitleFn}`, 'chat-title-cross-user', {
    cookie: true,
    jar: 'cookies-title-b.txt',
    header: serverFnHeaders,
    body: serverFnBody({ chatId: chatAId, title: 'B 越权改名' }),
  })
  assert.equal(crossTitle.status, 200, crossTitle.text)
  assert(crossTitle.text.includes('not_found'), `跨用户重命名必须 not_found: ${crossTitle.text.slice(0, 200)}`)
  assert(!crossTitle.text.includes('B 越权改名'), '拒绝响应不得回显被拒绝的标题')
  const readBack = await curl(`${base}/_serverFn/${ids.getChatFn}`, 'chat-title-read-back', {
    cookie: true,
    header: serverFnHeaders,
    body: serverFnBody({ chatId: chatAId }),
  })
  assert.equal(readBack.status, 200, readBack.text)
  assert(readBack.text.includes('A 的验收标题'), `跨用户被拒后标题必须保持 A 的写入: ${readBack.text.slice(0, 200)}`)
  assert(!readBack.text.includes('B 越权改名'), '跨用户被拒后不得留下 B 的标题')
  pass('HTTP 跨用户重命名被拒且库里标题未变', { requestId: crossTitle.requestId, title: 'A 的验收标题' })

  assert(statSync(databaseUrl).size > 0, '真实 SQLite 文件必须存在')
  const browser = await bounded(launch(process.execPath, ['scripts/browser/i-chat-flow.mjs'], 'browser.log', { ...environment, BASE_URL: base, CHAT_STATE_FILE: stateFile }), 300000)
  assert.equal(browser.code, 0, `浏览器流程失败；见 browser.log:\n${readFileSync(join(directory, 'browser.log'), 'utf8')}`)
  pass('真实 Chromium 流程', { log: 'browser.log', screenshots: `${process.env.SPROUT_UI_EVIDENCE_DIR ?? '.verify/i-chat/evidence'}/p2-i-*.png` })

  const titleEvidence = resolve('.verify/i-chat-title/evidence')
  const titleBrowser = await bounded(launch(process.execPath, ['scripts/browser/p4b-chat-title-flow.mjs'], 'browser-title.log', { ...environment, BASE_URL: base, SPROUT_UI_EVIDENCE_DIR: titleEvidence }), 300000)
  assert.equal(titleBrowser.code, 0, `对话标题浏览器流程失败；见 browser-title.log:\n${readFileSync(join(directory, 'browser-title.log'), 'utf8')}`)
  const titleResults = JSON.parse(readFileSync(join(titleEvidence, 'results.json'), 'utf8'))
  assert(titleResults.results.every((entry) => entry.passed), '对话标题断言必须全部通过')
  pass('真实 Chromium 验证标题兜底、重命名、恢复与跨账号隔离', {
    log: 'browser-title.log',
    checks: titleResults.results.map((entry) => entry.name),
    screenshots: `${process.env.SPROUT_UI_EVIDENCE_DIR ?? '.verify/i-chat-title/evidence'}/p4b-chat-title-*.png`,
  })

  const shutdown = await stop(server)
  assert.equal(shutdown.code, 0, '生产进程必须退出 0')
  pass('生产进程 SIGTERM 退出', shutdown)

  restarted = launch(process.execPath, ['.output/server/index.mjs'], 'server-second.log')
  const rebooted = await waitForHealth(restarted)
  assert(rebooted.body.bootId !== firstBootId, '重启后必须是新的 bootId')
  pass('生产进程重启后健康检查通过', { bootId: rebooted.body.bootId })

  const browserAgain = await bounded(launch(process.execPath, ['scripts/browser/i-chat-flow.mjs'], 'browser-restart.log', { ...environment, BASE_URL: base, CHAT_STATE_FILE: stateFile, CHAT_VERIFY: '1' }), 300000)
  assert.equal(browserAgain.code, 0, `重启后会话校验失败；见 browser-restart.log:\n${readFileSync(join(directory, 'browser-restart.log'), 'utf8')}`)
  pass('重启后同一对话仍对应同一分身且消息保留', { log: 'browser-restart.log', state: 'state.json' })

  const secondShutdown = await stop(restarted)
  assert.equal(secondShutdown.code, 0, '重启后的生产进程必须退出 0')
  pass('重启后的生产进程 SIGTERM 退出', secondShutdown)
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  if (server?.pid) kill(server, 'SIGKILL')
  if (restarted?.pid) kill(restarted, 'SIGKILL')
  process.exitCode = 1
}
JS
