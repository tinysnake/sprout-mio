#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdirSync, openSync, closeSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import net from 'node:net'

const logDir = resolve('.verify/c-data-auth')
mkdirSync(logDir, { recursive: true })
const port = Number(process.env.SPROUT_VERIFY_AUTH_PORT ?? 3113)
assert(Number.isInteger(port) && port > 0 && port <= 65535, 'valid verification port')
const base = `http://localhost:${port}`
const databaseUrl = join(logDir, 'auth.sqlite')
const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  APP_ORIGIN: base,
  PORT: String(port),
  NITRO_PORT: String(port),
  NODE_ENV: 'production',
  BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
}
const pass = (label, evidence) => console.log(`PASS ${label} ${evidence ?? ''}`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const children = new Set()
function stop(child, signal = 'SIGTERM') {
  if (!child?.pid) return
  try { process.kill(-child.pid, signal) } catch (error) { if (error.code !== 'ESRCH') throw error }
}
function launch(command, args, log, settings = env) {
  const fd = openSync(join(logDir, log), 'w')
  const child = spawn(command, args, { env: settings, detached: true, stdio: ['ignore', fd, fd] })
  closeSync(fd)
  child.completion = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })
  children.add(child)
  return child
}
async function command(command, args, log, settings = env, limit = 300000) {
  const child = launch(command, args, log, settings)
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; stop(child, 'SIGKILL') }, limit)
  try {
    const result = await child.completion
    assert(!timedOut, `${command} exceeded ${limit}ms, see ${log}`)
    assert.equal(result.code, 0, `${command} ${args.join(' ')} failed, see ${log}`)
  } finally {
    clearTimeout(timer)
    children.delete(child)
  }
}
async function portIsFree() {
  await new Promise((resolve, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.on('connect', () => { socket.destroy(); reject(new Error(`Port ${port} is occupied`)) })
    socket.on('error', (error) => error.code === 'ECONNREFUSED' ? resolve() : reject(error))
  })
}
async function curl(path, name, { body, cookie = false, origin = true, method } = {}) {
  const output = join(logDir, `${name}.json`)
  const args = ['--noproxy', '*', '--connect-timeout', '2', '--max-time', '10', '-sS', '-o', output,
    '-D', join(logDir, `${name}.headers`), '-w', '%{http_code}', `${base}${path}`]
  if (body !== undefined) args.push('-X', method ?? 'POST', '-H', 'content-type: application/json', '--data', JSON.stringify(body))
  if (origin) args.push('-H', `Origin: ${base}`)
  if (cookie) args.push('-b', join(logDir, 'cookies.txt'), '-c', join(logDir, 'cookies.txt'))
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn('curl', args, { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', (data) => { stdout += data })
    child.stderr.on('data', (data) => { stderr += data })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve({ stdout }) : reject(new Error(`curl ${path} ${stderr}`)))
  })
  const headers = readFileSync(join(logDir, `${name}.headers`), 'utf8')
  const requestId = headers.match(/^x-sprout-request-id:\s*(\S+)/im)?.[1]
  return { status: Number(stdout), text: readFileSync(output, 'utf8'), requestId }
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
    ? files(join(directory, entry.name)) : [join(directory, entry.name)])
}

let browser
let tab
const browserErrors = []
let server
try {
  await portIsFree()
  for (const suffix of ['', '-shm', '-wal']) rmSync(databaseUrl + suffix, { force: true })
  await command('pnpm', ['db:generate'], 'generate.log')
  pass('db:generate', 'drizzle/0000_pale_famine.sql; see generate.log')
  await command('pnpm', ['setup'], 'setup.log')
  pass('setup from deleted database', databaseUrl)
  await command('pnpm', ['db:migrate'], 'migrate-again.log')
  pass('second db:migrate', 'exit 0; see migrate-again.log')
  await command(process.execPath, ['--import', 'tsx', 'src/db/migrate.ts'], 'migrate-entry.log')
  pass('reusable migrate entry', 'exit 0; see migrate-entry.log')
  await command(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { readdirSync } from 'node:fs';
    import Database from 'better-sqlite3';
    const db = new Database(process.env.DATABASE_URL);
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row=>row.name);
    const requiredTables = ['__drizzle_migrations','account','diagnostic_event','project','runtime_boot','session','user','verification'];
    const tableSet = new Set(tables);
    for (const table of requiredTables) assert(tableSet.has(table), 'missing required table: ' + table);
    const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all().map(row=>row.name);
    const requiredIndexes = ['account_userId_idx','diagnostic_event_at_idx','diagnostic_event_project_id_idx','diagnostic_event_request_id_idx','session_token_unique','session_userId_idx','user_email_unique','verification_identifier_idx'];
    const indexSet = new Set(indexes);
    for (const index of requiredIndexes) assert(indexSet.has(index), 'missing required index: ' + index);
    const count = db.prepare('SELECT count(*) AS count FROM __drizzle_migrations').get().count;
    const migrationFiles = readdirSync('drizzle').filter(file => file.endsWith('.sql')).sort();
    assert(count >= 1, 'initial migration must be applied');
    assert.equal(count, migrationFiles.length, 'migration ledger must match SQL files');
    console.log(JSON.stringify({tables,indexes,count,migrationFiles})); db.close();
  `], 'schema.log')
  pass('schema and indexes', readFileSync(join(logDir, 'schema.log'), 'utf8').trim())
  await command('pnpm', ['build'], 'build.log')
  pass('production build', '.output/server/index.mjs')

  const requireStart = createRequire(import.meta.resolve('@tanstack/react-start'))
  const { fromCrossJSON, toJSONAsync } = requireStart('seroval')
  const outputFiles = files(resolve('.output/server')).filter((file) => file.endsWith('.mjs'))
  const serverCode = outputFiles.map((file) => readFileSync(file, 'utf8')).join('\n')
  function functionPath(name) {
    const match = serverCode.match(new RegExp(`id:\\s*"([a-f0-9]+)",\\s*name:\\s*"${name}"`))
    assert(match, `production server function id for ${name}`)
    return `/_serverFn/${match[1]}`
  }
  const protectedPath = functionPath('getProtectedSession')
  const authenticatePath = functionPath('authenticate')
  writeFileSync(join(logDir, 'server-functions.json'), JSON.stringify({ protectedPath, authenticatePath }, null, 2))
  function result(response) {
    assert.equal(response.status, 200, response.text)
    const payload = fromCrossJSON(JSON.parse(response.text), { refs: new Map() })
    assert(payload.result, response.text)
    return payload.result
  }

  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  let ready = false
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null) break
    try { ready = (await curl('/api/auth/get-session', 'ready')).status === 200 } catch {}
    if (ready) break
    await delay(500)
  }
  assert(ready, 'production server ready; see server.log')
  pass('production HTTP ready', base)
  const anonymous = result(await curl(protectedPath, 'protected-anonymous'))
  assert.equal(anonymous.ok, false)
  assert.equal(anonymous.error.code, 'unauthorized')
  pass('anonymous protected function', 'HTTP 200 unauthorized')

  const password = randomBytes(24).toString('base64url')
  const email = 'http-human@example.test'
  const signup = await curl('/api/auth/sign-up/email', 'signup', { cookie: true, body: { email, password, name: 'HTTP Human' } })
  assert.equal(signup.status, 200, signup.text)
  assert.match(readFileSync(join(logDir, 'signup.headers'), 'utf8'), /set-cookie: .*session_token=/i)
  pass('curl signup with Origin', 'HTTP 200; session cookie set')
  const session = await curl('/api/auth/get-session', 'session', { cookie: true })
  assert.equal(session.status, 200)
  assert.equal(JSON.parse(session.text).user.email, email)
  pass('session cookie readable', 'HTTP 200; expected email')
  async function assertRequestId(payload, response, name) {
    assert.match(response.requestId ?? '', /^req_/)
    assert.equal(payload.requestId, response.requestId)
    if (!payload.ok) assert.equal(payload.error.requestId, response.requestId)
    const diagnostics = await curl(`/api/diagnostics?requestId=${response.requestId}`, `${name}-diagnostics`, { cookie: true })
    assert.equal(diagnostics.status, 200, diagnostics.text)
    const rows = JSON.parse(diagnostics.text).data.filter((row) => row.event === 'http.response')
    assert.equal(rows.length, 1)
    assert.equal(rows[0].requestId, payload.requestId)
    pass(`${name} requestId matches payload, header and http.response`, response.requestId)
  }
  const authenticatedResponse = await curl(protectedPath, 'protected-authenticated', { cookie: true })
  const authenticated = result(authenticatedResponse)
  assert.equal(authenticated.ok, true)
  assert.equal(authenticated.data.email, email)
  assert.match(authenticated.data.expiresAt, /^\d{4}-.*Z$/)
  assert.equal(authenticated.data.token, undefined)
  pass('authenticated protected function', 'HTTP 200 ok; ISO expiry; no token')
  await assertRequestId(authenticated, authenticatedResponse, 'protected-authenticated')
  const failedLoginResponse = await curl(authenticatePath, 'failed-login', { body: await toJSONAsync({ data: { action: 'login', email, password: 'wrong-password-for-check' } }) })
  const failedLogin = result(failedLoginResponse)
  assert.equal(failedLogin.ok, false)
  assert.equal(failedLogin.error.code, 'unauthorized')
  await assertRequestId(failedLogin, failedLoginResponse, 'failed-login')
  const page = await curl('/', 'protected-page', { cookie: true })
  assert.equal(page.status, 200)
  assert.match(page.text, /Sprout Mio/)
  pass('protected page shell', 'HTTP 200; navigation authorization verified below in Chromium')

  const noOrigin = await curl('/api/auth/sign-out', 'no-origin', { cookie: true, origin: false, body: {} })
  assert.equal(noOrigin.status, 403, noOrigin.text)
  pass('POST without Origin rejected', `HTTP ${noOrigin.status}; ${noOrigin.text}`)
  const signout = await curl('/api/auth/sign-out', 'signout', { cookie: true, body: {} })
  assert.equal(signout.status, 200, signout.text)
  const afterSignout = result(await curl(protectedPath, 'protected-after-signout', { cookie: true }))
  assert.equal(afterSignout.ok, false)
  assert.equal(afterSignout.error.code, 'unauthorized')
  pass('logout revokes protected function', 'HTTP 200 unauthorized')
  const signin = await curl('/api/auth/sign-in/email', 'signin', { cookie: true, body: { email, password } })
  assert.equal(signin.status, 200, signin.text)
  assert.equal(result(await curl(protectedPath, 'protected-after-signin', { cookie: true })).ok, true)
  pass('curl password login', 'HTTP 200; protected function ok')
  const serverFnNoOrigin = result(await curl(authenticatePath, 'server-function-no-origin', { cookie: true, origin: false, body: await toJSONAsync({ data: { action: 'logout' } }) }))
  assert.equal(serverFnNoOrigin.ok, false)
  assert.equal(serverFnNoOrigin.error.code, 'forbidden')
  assert.equal(result(await curl(protectedPath, 'protected-after-rejected-logout', { cookie: true })).ok, true)
  pass('server function requires Origin', 'HTTP 200 forbidden; rejected logout preserves session')
  const invalid = result(await curl(authenticatePath, 'invalid-input', { body: await toJSONAsync({ data: { action: 'register', email: 'invalid', password: 'short', name: '' } }) }))
  assert.equal(invalid.ok, false)
  assert.equal(invalid.error.code, 'validation_failed')
  assert(!JSON.stringify(invalid).includes('short'))
  pass('invalid input', 'HTTP 200 validation_failed; no raw input echoed')

  const { chromium } = await import('playwright')
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  tab = await context.newPage()
  tab.setDefaultTimeout(15000)
  tab.setDefaultNavigationTimeout(15000)
  tab.on('pageerror', (error) => browserErrors.push(error.message))
  const chats = () => tab.waitForURL((url) => /^\/projects\/prj_[0-9a-f-]{36}\/chats$/.test(url.pathname), { timeout: 20000 })
  const identity = async () => {
    await tab.getByTestId('account-menu').click()
    await tab.getByTestId('session-email').waitFor()
    const shown = (await tab.getByTestId('session-email').innerText()).trim()
    await tab.keyboard.press('Escape')
    await tab.getByTestId('session-email').waitFor({ state: 'detached' })
    return shown
  }
  await tab.goto(base)
  await tab.waitForURL(`${base}/login`)
  await tab.getByRole('heading', { name: '登录', exact: true }).waitFor()
  await tab.getByRole('button', { name: '没有账号？注册', exact: true }).click()
  await tab.getByLabel('姓名', { exact: true }).fill('Browser Human')
  await tab.getByLabel('邮箱', { exact: true }).fill('browser-human@example.test')
  await tab.getByLabel('密码', { exact: true }).fill(password)
  await tab.getByRole('button', { name: '注册', exact: true }).click()
  await chats()
  await tab.getByTestId('chats-title').waitFor()
  assert.equal((await tab.getByTestId('project-selector').innerText()).trim(), '我的项目')
  assert.equal(await identity(), 'browser-human@example.test')
  await tab.reload()
  await chats()
  assert.equal(await identity(), 'browser-human@example.test')
  await tab.screenshot({ path: join(logDir, 'authenticated.png') })
  pass('Chromium register and protected reload', 'authenticated.png')
  await tab.getByTestId('account-menu').click()
  await tab.getByTestId('sign-out').click()
  await tab.waitForURL(`${base}/login`)
  await tab.goto(base)
  await tab.waitForURL(`${base}/login`)
  await tab.getByLabel('邮箱', { exact: true }).fill('browser-human@example.test')
  await tab.getByLabel('密码', { exact: true }).fill('wrong-password-for-check')
  await tab.getByRole('button', { name: '登录', exact: true }).click()
  await tab.getByRole('alert').waitFor()
  assert.match(await tab.getByRole('alert').innerText(), /unauthorized/)
  await tab.screenshot({ path: join(logDir, 'login-error.png') })
  await tab.getByLabel('密码', { exact: true }).fill(password)
  await tab.getByRole('button', { name: '登录', exact: true }).click()
  await chats()
  assert.equal(await identity(), 'browser-human@example.test')
  assert.deepEqual(browserErrors, [], `browser errors ${browserErrors}`)
  pass('Chromium logout, redirect, safe error and password login', 'login-error.png; no page errors')
  await browser.close()
  browser = undefined
  await command(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import Database from 'better-sqlite3';
    const db = new Database(process.env.DATABASE_URL);
    assert.equal(db.prepare('SELECT count(*) AS count FROM user').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM project').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM agent_profile').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM project_member').get().count, 2);
    assert.equal(db.prepare('SELECT count(DISTINCT created_by) AS count FROM project').get().count, 2);
    assert.equal(db.prepare('SELECT count(*) AS count FROM chat').get().count, 0);
    console.log('users=2 projects=2 agentProfiles=2 members=2 chats=0'); db.close();
  `], 'default-project.log')
  pass('registration creates one default Project and Agent per Human', 'users=2 projects=2 agentProfiles=2 members=2 chats=0')
  stop(server)
  await server.completion
  children.delete(server)
  server = undefined
  await portIsFree()
  pass('production process stopped', `port ${port} released`)

  for (const [name, patch] of [['bad-port', { PORT: 'invalid' }], ['missing-secret', { BETTER_AUTH_SECRET: undefined }]]) {
    const invalidEnv = { ...env, ...patch }
    if (invalidEnv.BETTER_AUTH_SECRET === undefined) delete invalidEnv.BETTER_AUTH_SECRET
    const child = launch(process.execPath, ['.output/server/index.mjs'], `${name}.log`, invalidEnv)
    const timer = setTimeout(() => stop(child, 'SIGKILL'), 10000)
    const outcome = await child.completion
    clearTimeout(timer)
    children.delete(child)
    console.log(`CLOSED invalid config startup ${name}: observed exit=${outcome.code} signal=${outcome.signal}; owner=p1-d-runtime; nonzero before listening asserted by scripts/verify/d-runtime.sh; log=${join(logDir, `${name}.log`)}`)

    const authLog = `${name}-auth-import.log`
    const authChild = launch(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', 'await import("./src/lib/auth.ts")'], authLog, invalidEnv)
    const authTimer = setTimeout(() => stop(authChild, 'SIGKILL'), 10000)
    const authOutcome = await authChild.completion
    clearTimeout(authTimer)
    children.delete(authChild)
    assert.notEqual(authOutcome.code, 0, `${name} auth import must exit nonzero`)
    assert.notEqual(authOutcome.code, null, `${name} auth import must fail itself, not be killed by timeout`)
    const authOutput = readFileSync(join(logDir, authLog), 'utf8')
    assert.match(authOutput, /环境变量校验失败/)
    assert.match(authOutput, name === 'bad-port' ? /PORT/ : /BETTER_AUTH_SECRET/)
    pass('auth config validation', `${name} exit=${authOutcome.code} signal=${authOutcome.signal}; readable error; log=${join(logDir, authLog)}`)
  }
  pass('c-data-auth all checks passed', logDir)
} catch (error) {
  if (tab && browser?.isConnected()) {
    writeFileSync(join(logDir, 'browser-failure.html'), await tab.content().catch(() => 'unavailable'))
    await tab.screenshot({ path: join(logDir, 'browser-failure.png') }).catch(() => {})
    console.error('Browser evidence', tab.url(), JSON.stringify(browserErrors))
  }
  console.error('FAIL c-data-auth', error.stack ?? error)
  process.exitCode = 1
} finally {
  await browser?.close()
  for (const child of children) stop(child, 'SIGKILL')
  await Promise.allSettled([...children].map((child) => child.completion))
}
JS
