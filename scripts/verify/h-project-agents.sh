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

const directory = resolve('.verify/h-project-agents')
mkdirSync(directory, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_PROJECT_AGENTS_PORT ?? 3142)
const databaseUrl = join(directory, 'project-agents.sqlite')
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
async function curl(url, name, { body, cookie = false, header, json = true } = {}) {
  const target = join(directory, `${name}.body`)
  const headers = join(directory, `${name}.headers`)
  const args = ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '20', '-sS', '-o', target, '-D', headers, '-w', '%{http_code}', url]
  for (const value of header ?? []) args.push('-H', value)
  if (body) args.push('-H', 'content-type: application/json', '--data', body)
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
try {
  await freePort(port)
  for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
  rmSync(join(directory, 'cookies.txt'), { force: true })
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
  const required = [
    'createAgentProfileFn', 'listAgentProfilesFn', 'getAgentProfileFn', 'updateAgentProfileFn',
    'addProjectMemberFn', 'removeProjectMemberFn', 'listProjectMembersFn',
    'getProjectProfileFn', 'updateProjectProfileFn',
  ]
  for (const name of required) assert(ids[name], `缺少 server function id: ${name}`)
  pass('server function ids present', { required })

  const origin = `Origin: ${base}`
  const password = randomBytes(24).toString('base64url')
  const signup = await curl(`${base}/api/auth/sign-up/email`, 'signup', {
    cookie: true,
    header: [origin],
    body: JSON.stringify({ email: `h-project-agents-${Date.now()}@example.test`, password, name: 'P2-H verifier' }),
  })
  assert.equal(signup.status, 200, signup.text)
  pass('curl 注册并保存会话 cookie（带 Origin）', { status: signup.status, cookies: 'cookies.txt' })

  const createArgs = {
    cookie: true,
    header: ['x-tsr-serverfn: true', origin, 'accept: application/x-tss-framed, application/json'],
  }
  const created = await curl(`${base}/_serverFn/${ids.createAgentProfileFn}`, 'agent-create', {
    ...createArgs,
    body: serverFnBody({ name: 'curl-验收 Agent', persona: 'curl 创建的验收 profile' }),
  })
  assert.equal(created.status, 200, created.text)
  assert.match(created.requestId ?? '', /^req_/, '响应必须带 x-sprout-request-id')
  const agentProfileId = created.text.match(/agp_[0-9a-f-]{36}/)?.[0]
  assert(agentProfileId, `成功载荷必须包含 agent profile id: ${created.text.slice(0, 200)}`)
  pass('server function 创建 Agent profile 成功', { agentProfileId, requestId: created.requestId })

  const invalid = await curl(`${base}/_serverFn/${ids.createAgentProfileFn}`, 'agent-invalid', {
    ...createArgs,
    body: serverFnBody({ name: '   ' }),
  })
  assert.equal(invalid.status, 200, invalid.text)
  assert(invalid.text.includes('validation_failed'), '失败载荷必须是 validation_failed')
  assert(invalid.text.includes('名称不能为空'), '失败载荷必须带字段级错误')
  pass('server function 校验失败走 HTTP 200 载荷内错误', { status: invalid.status, requestId: invalid.requestId })

  const anonymous = await curl(`${base}/_serverFn/${ids.createAgentProfileFn}`, 'agent-anonymous', {
    header: ['x-tsr-serverfn: true', origin, 'accept: application/x-tss-framed, application/json'],
    body: serverFnBody({ name: '无会话' }),
  })
  assert.equal(anonymous.status, 200)
  assert(anonymous.text.includes('unauthorized'), '未登录必须返回 unauthorized 载荷')
  pass('未登录调用返回 unauthorized', { status: anonymous.status, requestId: anonymous.requestId })

  const noOrigin = await curl(`${base}/_serverFn/${ids.listProjectMembersFn}`, 'agent-no-origin', {
    header: ['x-tsr-serverfn: true', 'accept: application/x-tss-framed, application/json'],
    body: serverFnBody({ projectId: 'prj_00000000-0000-4000-8000-000000000000' }),
  })
  assert.equal(noOrigin.status, 200)
  assert(noOrigin.text.includes('unauthorized'), '无 Origin 且未登录必须返回 unauthorized 载荷')
  pass('无 Origin 未登录调用返回 unauthorized', { status: noOrigin.status, requestId: noOrigin.requestId })

  assert(statSync(databaseUrl).size > 0, '真实 SQLite 文件必须存在')
  if (process.env.SPROUT_SKIP_BROWSER !== '1') {
    const browser = await bounded(launch(process.execPath, ['scripts/browser/h-project-agents-flow.mjs'], 'browser.log', { ...environment, BASE_URL: base }), 300000)
    assert.equal(browser.code, 0, `浏览器流程失败；见 browser.log:\n${readFileSync(join(directory, 'browser.log'), 'utf8')}`)
    pass('真实 Chromium 流程', { log: 'browser.log', screenshots: `${process.env.SPROUT_UI_EVIDENCE_DIR ?? '.verify/h-project-agents/evidence'}/p2-h-*.png` })
  } else {
    pass('真实 Chromium 流程', { skipped: 'SPROUT_SKIP_BROWSER=1' })
  }

  const shutdown = await stop(server)
  assert.equal(shutdown.code, 0, '生产进程必须退出 0')
  pass('生产进程 SIGTERM 退出', shutdown)
} catch (error) {
  console.error(`FAIL ${error instanceof Error ? error.message : String(error)}`)
  if (server?.pid) kill(server, 'SIGKILL')
  process.exitCode = 1
}
JS
