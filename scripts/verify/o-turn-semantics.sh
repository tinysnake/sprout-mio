#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const directory = resolve('.verify/o-turn-semantics')
mkdirSync(directory, { recursive: true })
const databaseUrl = join(directory, 'turn.sqlite')
const evidence = []
const children = new Set()
const delay = ms => new Promise(done => setTimeout(done, ms))
const port = Number(process.env.SPROUT_VERIFY_TURN_PORT ?? 3161)
const base = `http://localhost:${port}`
const runner = join(directory, 'protocol-runner.mjs')
const spawnLog = join(directory, 'spawn.jsonl')
const environment = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(directory, 'pi-data'),
  SPROUT_PI_RUNNER: runner, SPROUT_VERIFY_PI_SPAWN_LOG: spawnLog,
}
const ORIGINAL_PERSONA = 'Reply concisely. Remember conversation facts.'
const CHANGED_PERSONA = 'Changed after turn started'

function pass(check, output = {}) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ mode: 'protocol-stub', checks: evidence }, null, 2) + '\n')
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
let ids, cookie, db, server, userId, projectId, profileId, conversationId, instanceId
async function call(name, data) {
  assert(ids[name], `built ${name} missing`)
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, {
    method: 'POST', headers: { Origin: base, Cookie: cookie, 'content-type': 'application/json', 'x-tsr-serverfn': 'true', accept: 'application/json' },
    body: JSON.stringify({ t: toCrossJSON({ data }), f: 127, m: [] }), signal: AbortSignal.timeout(20000),
  })
  const body = await response.text()
  assert.equal(response.status, 200, `${name} HTTP ${response.status}: ${body.slice(0,300)}`)
  const { result } = fromCrossJSON(JSON.parse(body), { refs: new Map() })
  assert.equal(result.requestId, response.headers.get('x-sprout-request-id'))
  return result
}
async function callOk(name, data) {
  const result = await call(name, data)
  assert(result.ok, `${name} rejected ${JSON.stringify(result)}`)
  return result.data
}
const allRuns = () => db.prepare('SELECT * FROM agent_run WHERE conversation_id=? ORDER BY rowid').all(conversationId)
const runRow = id => db.prepare('SELECT * FROM agent_run WHERE id=?').get(id)
const runInputs = id => db.prepare('SELECT * FROM agent_run_input WHERE run_id=? ORDER BY rowid').all(id)
async function send(body) {
  return callOk('sendMessageFn', { conversationId, body })
}
async function waitRun(status, previous = 0) {
  return until(() => {
    const rows = allRuns()
    if (rows.length <= previous) return
    const row = rows.at(-1)
    if (row.status === 'failed' && status !== 'failed') throw new Error(`run failed ${row.error_code}: ${row.error_message}`)
    return row.status === status ? row : undefined
  }, `run ${status}`, 30000)
}
function noLostInputs() {
  const rows = db.prepare("SELECT m.id, count(i.message_id) AS inputs FROM message m LEFT JOIN agent_run_input i ON i.message_id=m.id WHERE m.conversation_id=? AND m.sender_kind='human' GROUP BY m.id").all(conversationId)
  assert(rows.every(row => row.inputs === 1), 'every human message must have exactly one run input')
  pass('every human message has exactly one run input', rows)
}
function snapshot(row, { persona = ORIGINAL_PERSONA, model = 'protocol/model' } = {}) {
  const value = JSON.parse(row.config_snapshot)
  for (const field of ['model','provider','thinking','tools','extensions','sessionId','sessionFile','profile','sdkVersion','cwd']) assert(value[field] !== undefined, `snapshot ${field}`)
  assert.equal(value.sessionId, row.session_id)
  assert.equal(`${value.provider}/${value.model}`, model)
  assert.equal(value.profile.persona, persona)
  return value
}

const stub = `import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
appendFileSync(process.env.SPROUT_VERIFY_PI_SPAWN_LOG,JSON.stringify({pid:process.pid})+'\\n');
const input=createInterface({input:process.stdin}); let config; let holding=false; let stubborn=false;
const line=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',raw=>{const x=JSON.parse(raw);
if(x.type==='open') {config=x;const file=x.sessionFile??join(x.sessionDirectory,x.sessionId+'.jsonl');
if(!existsSync(file))writeFileSync(file,JSON.stringify({id:x.sessionId})+'\\n');
line({type:'extension_ui_request',id:x.id});process.stdout.write('unrelated stdout\\n');line({type:'future_event',id:x.id});
const slash=x.profile.model.indexOf('/');
line({type:'ready',id:x.id,snapshot:{provider:x.profile.model.slice(0,slash),model:x.profile.model.slice(slash+1),thinking:x.profile.effort??'off',tools:['bash','edit','read','write'],extensions:['sprout-extension'],sessionId:x.sessionId,sessionFile:file,cwd:x.cwd,sdkVersion:'protocol-stub',profile:x.profile}});
} else if(x.type==='prompt') {holding=x.text.includes('stub-hold');line({type:'input_delivered',id:x.id,messageId:x.messageId});
if(x.text.includes('stub-crash'))process.exit(23);
else if(x.text.includes('stub-error'))line({type:'settled',id:x.id,text:'THIS MUST NOT BE SAVED',stopReason:'error'});
else if(!holding)line({type:'settled',id:x.id,text:'PROTOCOL_STUB_REPLY',stopReason:'stop'});
} else if(x.type==='steer') {
if(x.text.includes('stub-reject'))line({type:'input_rejected',id:x.id,messageId:x.messageId,reason:'Pi 会话拒绝了该消息'});
else {line({type:'input_delivered',id:x.id,messageId:x.messageId});
if(x.text.includes('stub-settle')){holding=false;line({type:'settled',id:x.id,text:'PROTOCOL_STUB_REPLY',stopReason:'stop'});}}
} else if(x.type==='abort') {if(holding){holding=false;line({type:'failure',id:x.id,code:'model_aborted',message:'Pi 模型未正常完成本轮',stopReason:'aborted'});}}
else if(x.type==='close'&&!stubborn)process.exit(0);
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
  rmSync(spawnLog, { force: true })
  writeFileSync(runner, stub); chmodSync(runner, 0o700)
  await command('pnpm', ['build'], 'build.log')
  await command('pnpm', ['exec','vp','test','run','tests/agent-run-turn.test.ts'], 'agent-run-turn-test.log')
  server = launch(process.execPath, ['.output/server/index.mjs'], 'server.log')
  const firstHealth = await health(server)
  db = new Database(databaseUrl)
  const signup = await fetch(`${base}/api/auth/sign-up/email`, {
    method:'POST', headers:{Origin:base,'content-type':'application/json'},
    body:JSON.stringify({name:'Turn verification',email:`turn-${randomUUID()}@example.test`,password:randomBytes(24).toString('base64url')}), signal:AbortSignal.timeout(20000),
  })
  assert.equal(signup.status,200)
  cookie=signup.headers.getSetCookie().find(value=>value.includes('session_token=')).split(';')[0]
  userId=(await signup.json()).user.id
  ids=serverFnIds()
  projectId=(await callOk('createProjectFn',{name:'Turn verification'})).id
  profileId=(await callOk('createAgentProfileFn',{name:'Turn verification agent',persona:ORIGINAL_PERSONA,model:'protocol/model',effort:'off'})).id
  await callOk('addProjectMemberFn',{projectId,agentProfileId:profileId})
  const direct=await callOk('createDirectConversationFn',{projectId,agentProfileId:profileId})
  conversationId=direct.conversation.id
  instanceId=direct.instance.id
  await delay(300)
  assert(!existsSync(spawnLog),'no Pi runner may start without work')
  const processes=execFileSync('ps',['-axo','pid,ppid,command'],{encoding:'utf8',timeout:10000})
  assert(!processes.split('\n').some(row=>row.includes(runner)),'no Pi stub child before a message')
  pass('lazy startup has no child process', {spawnLog, processScan:'ps -axo pid,ppid,command'})

  await send('stub-success')
  const first=await waitRun('completed')
  snapshot(first)
  assert.equal(first.stop_reason,'stop')
  const firstInput=runInputs(first.id)[0]
  assert.equal(firstInput.disposition,'delivered')
  assert(firstInput.delivered_at,'delivered input must record deliveredAt')
  pass('first turn completes and its input is delivered with deliveredAt', {runId:first.id,input:firstInput})

  await send('stub-hold')
  const busy=await waitRun('running',1)
  await send('steered into current turn')
  assert.equal(allRuns().length,2,'active run must absorb the new human message instead of a second run')
  const steered=await until(()=>{
    const inputs=runInputs(busy.id)
    return inputs.length===2&&inputs.every(row=>row.disposition==='delivered')?inputs:undefined
  },'steered input delivered into current turn')
  assert(steered[1].delivered_at,'steered input records deliveredAt')
  assert.equal(runRow(busy.id).status,'running')
  assert.equal(runRow(busy.id).assistant_message_id,null)
  pass('serial delivery: new message joins the active run and is steered in as delivered', {runId:busy.id,runCount:allRuns().length,inputs:steered.map(row=>row.disposition)})

  await send('stub-reject this delivery')
  const diagnostic=await until(()=>db.prepare("SELECT level,message FROM diagnostic_event WHERE run_id=? AND event='agent_run.input_delivery_failed'").get(busy.id),'rejection diagnostic recorded')
  const rejected=runInputs(busy.id)
  assert.equal(rejected.length,3)
  assert.equal(rejected[2].disposition,'pending')
  assert.equal(diagnostic.level,'warn')
  assert.match(diagnostic.message,/Pi 会话拒绝了该消息/)
  assert.equal(rejected[2].delivered_at,null)
  pass('failed delivery keeps input pending with a readable diagnostic reason', {runId:busy.id,disposition:rejected[2].disposition,diagnostic})

  const agentMessagesBefore=db.prepare("SELECT count(*) AS n FROM message WHERE conversation_id=? AND sender_kind='agent'").get(conversationId).n
  const stopped=await callOk('abortAgentRunFn',{runId:busy.id})
  assert.equal(stopped.status,'aborted')
  const aborted=await until(()=>{const row=runRow(busy.id);return row.status==='aborted'?row:undefined},'run aborted')
  assert.equal(aborted.stop_reason,'aborted')
  assert.equal(aborted.assistant_message_id,null)
  assert.equal(db.prepare("SELECT count(*) AS n FROM message WHERE conversation_id=? AND sender_kind='agent'").get(conversationId).n,agentMessagesBefore)
  const busyPid=JSON.parse(readFileSync(spawnLog,'utf8').trim().split('\n').at(-1)).pid
  await until(()=>{try{process.kill(busyPid,0);return}catch(error){assert.equal(error.code,'ESRCH');return true}},'aborted runner child exits')
  assert.equal(runInputs(busy.id)[2].disposition,'pending')
  pass('stop of a running run yields aborted, no agent reply, child exits, pending input stays pending', {runId:aborted.id,status:aborted.status,stopReason:aborted.stop_reason,assistantMessageId:aborted.assistant_message_id,pid:busyPid})

  await send('stub-error')
  const failedError=await waitRun('failed',2)
  assert.equal(failedError.stop_reason,'error')
  assert.equal(failedError.error_code,'model_error')
  assert(failedError.error_message&&failedError.error_message.trim(),'failed run must carry a readable errorMessage')
  assert.equal(failedError.assistant_message_id,null)
  assert.equal(db.prepare("SELECT count(*) AS n FROM message WHERE body='THIS MUST NOT BE SAVED'").get().n,0)
  await send('stub-crash')
  const failedCrash=await waitRun('failed',3)
  assert.equal(failedCrash.error_code,'runner_crashed')
  assert(failedCrash.error_message&&failedCrash.error_message.trim())
  const unexplained=db.prepare("SELECT count(*) AS n FROM agent_run WHERE status='failed' AND (error_code IS NULL OR error_code='' OR error_message IS NULL OR error_message='')").get().n
  assert.equal(unexplained,0,'every failed run must carry errorCode and non-empty errorMessage')
  pass('failed runs are explainable: errorCode and non-empty errorMessage always present', {runs:[failedError,failedCrash].map(row=>({id:row.id,errorCode:row.error_code,errorMessage:row.error_message}))})

  await send('stub-hold')
  const held=await waitRun('running',4)
  const frozen=snapshot(held)
  assert.equal(frozen.profile.persona,ORIGINAL_PERSONA)
  await callOk('updateAgentProfileFn',{agentProfileId:profileId,persona:CHANGED_PERSONA,model:'protocol/changed'})
  const afterEdit=snapshot(runRow(held.id))
  assert.equal(afterEdit.profile.persona,ORIGINAL_PERSONA,'editing the profile must not rewrite the running turn snapshot')
  assert.equal(afterEdit.model,'model')
  await callOk('abortAgentRunFn',{runId:held.id})
  await until(()=>runRow(held.id).status==='aborted','held run aborted')
  await send('stub-success')
  const nextTurn=await waitRun('completed',5)
  const nextSnapshot=snapshot(nextTurn,{persona:CHANGED_PERSONA,model:'protocol/changed'})
  assert.equal(nextSnapshot.profile.persona,CHANGED_PERSONA)
  assert.equal(`${nextSnapshot.provider}/${nextSnapshot.model}`,'protocol/changed')
  pass('profile edit affects only the next turn: running snapshot frozen, next turn uses new profile', {heldRun:held.id,nextRun:nextTurn.id,nextPersona:nextSnapshot.profile.persona,nextModel:`${nextSnapshot.provider}/${nextSnapshot.model}`})
  noLostInputs()

  await stop(server)
  server=launch(process.execPath,['.output/server/index.mjs'],'server-disabled.log',{...environment,SPROUT_PI_ENABLED:'false'})
  await health(server)
  const spawnCountBeforeDisabled=readFileSync(spawnLog,'utf8').trim().split('\n').length
  const disabledState=await callOk('getConversationRunStateFn',{conversationId})
  assert.equal(disabledState.enabled,false)
  const queuedMessage=await send('queued while host disabled')
  await delay(300)
  const queued=allRuns().at(-1)
  assert.equal(queued.status,'queued')
  assert.equal(runInputs(queued.id)[0].disposition,'pending')
  const stoppedQueued=await callOk('abortAgentRunFn',{runId:queued.id})
  assert.equal(stoppedQueued.status,'aborted')
  assert.equal(runRow(queued.id).stop_reason,'aborted')
  assert.equal(readFileSync(spawnLog,'utf8').trim().split('\n').length,spawnCountBeforeDisabled)
  pass('stop of a queued run yields aborted without spawning; disabled host reports enabled=false', {runId:queued.id,status:'aborted',enabled:disabledState.enabled})
  await stop(server)

  server=launch(process.execPath,['.output/server/index.mjs'],'server-browser.log')
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
    const pageUrl = `${base}/projects/${projectId}/conversations/${conversationId}`
    const screenshotDir = resolve('docs/p3/evidence')
    mkdirSync(screenshotDir, { recursive: true })

    await send('stub-error')
    await waitRun('failed',7)
    await page.goto(pageUrl,{waitUntil:'domcontentloaded',timeout:30000})
    await page.waitForSelector('[data-testid="pi-host-status"]',{timeout:20000})
    const failedRow=allRuns().at(-1)
    assert.equal(await page.locator('[data-testid="pi-host-status"]').textContent(),'失败')
    assert.equal(await page.locator('[data-testid="run-failure"]').textContent(),failedRow.error_message)
    assert((await page.locator('[data-testid="run-failure-request"]').textContent()).includes(failedRow.request_id))
    const failedShot=join(screenshotDir,'p3-b-run-failed.png')
    await page.screenshot({path:failedShot,fullPage:true})
    pass('UI shows failed state with errorMessage and requestId', {runId:failedRow.id,screenshot:failedShot})

    await send('stub-hold')
    const uiRun=await waitRun('running',8)
    await send('stub-reject while running')
    await until(()=>{
      const inputs=runInputs(uiRun.id)
      return inputs.length===2&&inputs[1].disposition==='pending'
    },'pending input visible for UI check')
    await page.reload({waitUntil:'domcontentloaded',timeout:30000})
    await until(async()=>{
      const status=await page.locator('[data-testid="pi-host-status"]').textContent()
      return status==='运行中'
    },'UI shows running',10000)
    assert.equal(await page.locator('[data-testid="pending-input-count"]').textContent(),'1 条输入未投递')
    const bodyText=await page.locator('body').innerText()
    assert(!bodyText.includes('已完成'),'pending input must never be displayed as processed')
    const runningShot=join(screenshotDir,'p3-b-run-running-pending.png')
    await page.screenshot({path:runningShot,fullPage:true})
    pass('UI shows running with a pending undelivered input, never as processed', {runId:uiRun.id,screenshot:runningShot})

    await page.locator('[data-testid="run-stop"]').click()
    await until(()=>runRow(uiRun.id).status==='aborted','UI stop aborts the run',10000)
    await until(async()=>{
      const status=await page.locator('[data-testid="pi-host-status"]').textContent()
      return status==='已停止'
    },'UI shows aborted after stop',15000)
    assert.equal(await page.locator('[data-testid="pending-input-count"]').textContent(),'1 条输入未投递')
    assert.equal(runRow(uiRun.id).assistant_message_id,null)
    const abortedShot=join(screenshotDir,'p3-b-run-aborted.png')
    await page.screenshot({path:abortedShot,fullPage:true})
    pass('stop button yields aborted shown as 已停止 with pending input still visible as undelivered', {runId:uiRun.id,screenshot:abortedShot})
    assert.deepEqual(consoleErrors,[],'conversation page must render without console errors')
    pass('conversation page has no console errors', {consoleErrors})
  } finally {
    await browser.close()
  }
  noLostInputs()
  await stop(server)
  pass('production shutdown', {runs:allRuns().map(row=>({id:row.id,status:row.status})),directory})
  writeFileSync(join(directory,'state.json'),JSON.stringify({userId,projectId,profileId,conversationId,instanceId},null,2)+'\n')
} catch(error) {
  console.error(`FAIL HERMETIC ${error.stack??error}`)
  process.exitCode=1
} finally {
  for(const child of children) kill(child,'SIGKILL')
  await Promise.allSettled([...children].map(child=>child.completion))
  db?.close()
}
JS
