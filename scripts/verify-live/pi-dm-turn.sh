#!/usr/bin/env bash
set -euo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export no_proxy=localhost,127.0.0.1
export NO_PROXY="$no_proxy"
if [[ "${1:-}" == "--protocol-stub" ]]; then
  export SPROUT_VERIFY_PI_MODE=hermetic
elif [[ "$#" == 0 ]]; then
  export SPROUT_VERIFY_PI_MODE=live
else
  echo 'FAIL unexpected argument'
  exit 1
fi
node --input-type=module <<'JS'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import net from 'node:net'

const live = process.env.SPROUT_VERIFY_PI_MODE === 'live'
const directory = resolve(live ? '.verify/live-pi-dm-turn' : '.verify/n-pi-session')
mkdirSync(directory, { recursive: true })
const databaseUrl = join(directory, 'pi.sqlite')
const evidence = []
const children = new Set()
const delay = ms => new Promise(done => setTimeout(done, ms))
const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent')
const model = live ? process.env.SPROUT_VERIFY_PI_MODEL ?? 'deepseek/deepseek-flash' : 'protocol/model'
const port = Number(process.env.SPROUT_VERIFY_PI_PORT ?? (live ? 3158 : 3157))
const base = `http://localhost:${port}`
const runner = join(directory, 'protocol-runner.mjs')
const spawnLog = join(directory, 'spawn.jsonl')
const environment = {
  ...process.env, DATABASE_URL: databaseUrl, APP_ORIGIN: base, PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'),
  SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(directory, 'pi-data'),
  ...(live ? {} : { SPROUT_PI_RUNNER: runner, SPROUT_VERIFY_PI_SPAWN_LOG: spawnLog }),
}
if (live) delete environment.SPROUT_PI_RUNNER

function pass(check, output = {}) {
  evidence.push({ check, output })
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify({ mode: live ? 'real-model' : 'protocol-stub', checks: evidence }, null, 2) + '\n')
  console.log(`PASS ${live ? 'LIVE' : 'HERMETIC'} ${check} ${JSON.stringify(output)}`)
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
  assert(result.ok, `${name} rejected ${JSON.stringify(result)}`)
  return result.data
}
const allRuns = () => db.prepare('SELECT * FROM agent_run WHERE conversation_id=? ORDER BY rowid').all(conversationId)
async function send(body) {
  return call('sendMessageFn', { conversationId, body })
}
async function waitRun(status, previous = 0) {
  return until(() => {
    const rows = allRuns()
    if (rows.length <= previous) return
    const row = rows.at(-1)
    if (row.status === 'failed' && status !== 'failed') throw new Error(`run failed ${row.error_code}: ${row.error_message}`)
    return row.status === status ? row : undefined
  }, `run ${status}`, live ? 600000 : 30000)
}
function noLostInputs() {
  const rows = db.prepare("SELECT m.id, count(i.message_id) AS inputs FROM message m LEFT JOIN agent_run_input i ON i.message_id=m.id WHERE m.conversation_id=? AND m.sender_kind='human' GROUP BY m.id").all(conversationId)
  assert(rows.every(row => row.inputs === 1), 'every human message must have exactly one run input')
  pass('every human message has exactly one run input', rows)
}
function snapshot(row) {
  const value = JSON.parse(row.config_snapshot)
  for (const field of ['model','provider','thinking','tools','extensions','sessionId','sessionFile','profile','sdkVersion','cwd']) assert(value[field] !== undefined, `snapshot ${field}`)
  assert.equal(value.sessionId, row.session_id)
  assert.equal(`${value.provider}/${value.model}`, model)
  assert.deepEqual(value.tools, ['bash','edit','read','write'])
  assert.deepEqual(value.extensions, ['sprout-extension'])
  assert.equal(value.profile.persona, 'Reply concisely. Remember conversation facts. Do not use tools unless requested.')
  if (live) {
    const entries=readFileSync(value.sessionFile,'utf8').trim().split('\n').map(line=>JSON.parse(line))
    const actual=entries.filter(entry=>entry.type==='message'&&entry.message?.role==='assistant').at(-1)?.message
    assert(actual,'real Pi transcript must contain an assistant message')
    assert.equal(actual.provider,value.provider,'snapshot provider matches actual Pi assistant message')
    assert.equal(actual.model,value.model,'snapshot model matches actual Pi assistant message')
    assert.equal(actual.stopReason,row.stop_reason)
    pass('snapshot matches actual model in real Pi transcript',{runId:row.id,provider:actual.provider,model:actual.model,stopReason:actual.stopReason})
  }
  return value
}

const stub = `import {createInterface} from 'node:readline';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
appendFileSync(process.env.SPROUT_VERIFY_PI_SPAWN_LOG,JSON.stringify({pid:process.pid})+'\\n');
const input=createInterface({input:process.stdin}); let config; let stubborn=false;
const line=x=>process.stdout.write(JSON.stringify(x)+'\\n');
input.on('line',raw=>{const x=JSON.parse(raw);
if(x.type==='open') {config=x;const file=x.sessionFile??join(x.sessionDirectory,x.sessionId+'.jsonl');
if(!existsSync(file))writeFileSync(file,JSON.stringify({id:x.sessionId})+'\\n');
line({type:'extension_ui_request',id:x.id});process.stdout.write('unrelated stdout\\n');line({type:'future_event',id:x.id});
const slash=x.profile.model.indexOf('/');
line({type:'ready',id:x.id,snapshot:{provider:x.profile.model.slice(0,slash),model:x.profile.model.slice(slash+1),thinking:x.profile.effort??'off',tools:['bash','edit','read','write'],extensions:['sprout-extension'],sessionId:x.sessionId,sessionFile:file,cwd:x.cwd,sdkVersion:'protocol-stub',profile:x.profile}});
} else if(x.type==='prompt') {stubborn=x.text.includes('stub-hold-stubborn');line({type:'input_delivered',id:x.id,messageId:x.messageId});
if(x.text.includes('stub-crash'))process.exit(23);
else if(x.text.includes('stub-error'))line({type:'settled',id:x.id,text:'THIS MUST NOT BE SAVED',stopReason:'error'});
else if(!x.text.includes('stub-hold'))line({type:'settled',id:x.id,text:'PROTOCOL_STUB_REPLY',stopReason:'stop'});
} else if(x.type==='close'&&!stubborn)process.exit(0);
});process.on('SIGTERM',()=>process.exit(0));`

try {
  await new Promise((done, reject) => {
    const socket = net.connect(port, 'localhost')
    socket.setTimeout(2000, () => { socket.destroy(); reject(new Error('port probe timeout')) })
    socket.once('connect', () => { socket.destroy(); reject(new Error(`port ${port} occupied`)) })
    socket.once('error', error => error.code === 'ECONNREFUSED' ? done() : reject(error))
  })
  if (live && !existsSync(join(agentDir, 'auth.json'))) {
    console.error('SKIPPED real Pi credentials missing; live verification is not PASS')
    process.exitCode = 2
  } else {
    for (const suffix of ['', '-wal', '-shm']) rmSync(databaseUrl + suffix, { force: true })
    rmSync(join(directory, 'pi-data'), { recursive: true, force: true })
    rmSync(spawnLog, { force: true })
    if (!live) { writeFileSync(runner, stub); chmodSync(runner, 0o700) }
    await command('pnpm', ['build'], 'build.log')
    if (!live) await command('pnpm', ['exec','vp','test','run','tests/agent-run.test.ts'], 'agent-run-test.log')
    server = launch(process.execPath, ['.output/server/index.mjs'], 'server-first.log')
    const firstHealth = await health(server)
    db = new Database(databaseUrl)
    const signup = await fetch(`${base}/api/auth/sign-up/email`, {
      method:'POST', headers:{Origin:base,'content-type':'application/json'},
      body:JSON.stringify({name:'Pi DM verification',email:`pi-${randomUUID()}@example.test`,password:randomBytes(24).toString('base64url')}), signal:AbortSignal.timeout(20000),
    })
    assert.equal(signup.status,200)
    cookie=signup.headers.getSetCookie().find(value=>value.includes('session_token=')).split(';')[0]
    userId=(await signup.json()).user.id
    ids=serverFnIds()
    projectId=(await call('createProjectFn',{name:'Pi verification'})).id
    profileId=(await call('createAgentProfileFn',{name:'Pi verification agent',persona:'Reply concisely. Remember conversation facts. Do not use tools unless requested.',model,effort:'off'})).id
    await call('addProjectMemberFn',{projectId,agentProfileId:profileId})
    const direct=await call('createDirectConversationFn',{projectId,agentProfileId:profileId})
    conversationId=direct.conversation.id
    instanceId=direct.instance.id
    await delay(300)
    if (!live) {
      assert(!existsSync(spawnLog),'no Pi runner may start without work')
      const processes=execFileSync('ps',['-axo','pid,ppid,command'],{encoding:'utf8',timeout:10000})
      assert(!processes.split('\n').some(row=>row.includes(runner)),'no live Pi stub child before a message')
      pass('lazy startup has no child process', {spawnLog, processScan:'ps -axo pid,ppid,command'})
    }
    const codeword=`MIO_${randomBytes(12).toString('hex')}`
    await send(live ? `Remember this exact codeword for this conversation: ${codeword}. Reply with that codeword only.` : 'stub-success')
    const first=await waitRun('completed')
    const firstSnapshot=snapshot(first)
    assert.equal(first.stop_reason,'stop')
    const reply=db.prepare('SELECT * FROM message WHERE id=?').get(first.assistant_message_id)
    assert(reply?.body.trim(),'reply persisted in the existing message table')
    assert.equal(reply.sender_kind,'agent')
    assert.equal(reply.sender_id,profileId)
    if(live) {
      assert(reply.body.includes(codeword), `first-turn recall mismatch ${JSON.stringify({expected:codeword,actual:reply.body,runId:first.id,sessionId:first.session_id})}`)
      assert(!reply.body.includes('PROTOCOL_STUB_REPLY'))
      assert.notEqual(firstSnapshot.sdkVersion,'protocol-stub')
      assert(existsSync(firstSnapshot.sessionFile))
      const transcript=readFileSync(firstSnapshot.sessionFile,'utf8')
      assert(transcript.includes(codeword),'real Pi transcript contains codeword')
      assert(transcript.includes('sprout-session-binding'),'Sprout extension actually loaded')
    }
    pass('DM turn completes through existing message table', {model,reply:reply.body,sessionFile:firstSnapshot.sessionFile,runId:first.id,status:first.status,stopReason:first.stop_reason})
    noLostInputs()

    if(live) {
      await send('Without using tools, what exact codeword did I give you earlier? Reply with the codeword only.')
      const second=await waitRun('completed',1)
      const secondSnapshot=snapshot(second)
      assert.equal(secondSnapshot.sessionFile,firstSnapshot.sessionFile)
      const secondReply=db.prepare('SELECT body FROM message WHERE id=?').get(second.assistant_message_id).body
      assert(secondReply.includes(codeword), `second-turn recall mismatch ${JSON.stringify({expected:codeword,actual:secondReply,runId:second.id,sessionId:second.session_id})}`)
      pass('second turn recalls first-turn codeword', {reply:secondReply,runId:second.id,sessionFile:secondSnapshot.sessionFile})
      const stopped=await stop(server)
      server=launch(process.execPath,['.output/server/index.mjs'],'server-second.log')
      const secondHealth=await health(server)
      assert.notEqual(secondHealth.bootId,firstHealth.bootId)
      await send('Without using tools, repeat the exact secret codeword I gave you at the beginning. Reply with the codeword only.')
      const third=await waitRun('completed',2)
      const thirdSnapshot=snapshot(third)
      const thirdReply=db.prepare('SELECT body FROM message WHERE id=?').get(third.assistant_message_id).body
      assert(thirdReply.includes(codeword), `third-turn recall mismatch ${JSON.stringify({expected:codeword,actual:thirdReply,runId:third.id,sessionId:third.session_id})}`)
      assert.equal(thirdSnapshot.sessionFile,firstSnapshot.sessionFile)
      assert.equal(thirdSnapshot.sessionId,firstSnapshot.sessionId)
      assert(allRuns().every(row=>row.status==='completed'))
      pass('real host restart reopens same session with history', {stopped,firstBootId:firstHealth.bootId,secondBootId:secondHealth.bootId,reply:thirdReply,sessionFile:thirdSnapshot.sessionFile,runs:allRuns().map(row=>({id:row.id,status:row.status}))})
      const {chromium}=await import('playwright')
      const browser=await chromium.launch()
      try {
        const context=await browser.newContext()
        const separator=cookie.indexOf('=')
        await context.addCookies([{name:cookie.slice(0,separator),value:cookie.slice(separator+1),url:base}])
        const page=await context.newPage()
        await page.goto(`${base}/projects/${projectId}/conversations/${conversationId}`,{waitUntil:'domcontentloaded',timeout:30000})
        await page.waitForSelector('[data-testid="message-item"][data-sender-kind="agent"]',{timeout:20000})
        const replies=await page.$$eval('[data-testid="message-item"][data-sender-kind="agent"] [data-testid="message-body"]',nodes=>nodes.map(node=>node.textContent))
        assert.equal(replies.length,3)
        assert(replies.every(body=>body.includes(codeword)))
        const screenshot=resolve('docs/p3/evidence/p3-a-real-dm-after-restart.png')
        mkdirSync(resolve('docs/p3/evidence'),{recursive:true})
        await page.screenshot({path:screenshot,fullPage:true})
        pass('real Chromium displays all three persisted agent replies after restart',{replies,screenshot})
      } finally {await browser.close()}
      noLostInputs()
    } else {
      await send('stub-error')
      const failed=await waitRun('failed',1)
      assert.equal(failed.stop_reason,'error')
      assert.equal(failed.error_code,'model_error')
      assert.equal(failed.assistant_message_id,null)
      assert.equal(db.prepare("SELECT count(*) AS n FROM message WHERE body='THIS MUST NOT BE SAVED'").get().n,0)
      pass('stopReason error never completes or saves a reply', {id:failed.id,status:failed.status,stopReason:failed.stop_reason,errorCode:failed.error_code})
      await send('stub-crash')
      const crashed=await waitRun('failed',2)
      assert.equal(crashed.error_code,'runner_crashed')
      assert.equal(crashed.assistant_message_id,null)
      pass('child crash fails the run', {id:crashed.id,status:crashed.status,errorCode:crashed.error_code})
      await send('stub-hold')
      const running=await waitRun('running',3)
      await until(()=>db.prepare("SELECT disposition FROM agent_run_input WHERE run_id=?").get(running.id).disposition==='delivered','input delivered')
      await send('queued while running')
      assert.equal(allRuns().length,4)
      const inputs=db.prepare('SELECT * FROM agent_run_input WHERE run_id=? ORDER BY rowid').all(running.id)
      assert.deepEqual(inputs.map(row=>row.disposition),['delivered','pending'])
      assert.throws(()=>db.prepare("INSERT INTO agent_run (id,instance_id,conversation_id,project_id,request_id,status,session_id) VALUES ('illegal-active',?,?,?,?,'queued',?)").run(instanceId,conversationId,projectId,'req_duplicate',instanceId),/UNIQUE constraint/)
      pass('active-run partial index rejects second run and preserves pending input', {runId:running.id,inputs})
      await call('updateAgentProfileFn',{agentProfileId:profileId,persona:'Changed after turn started',model:'protocol/changed'})
      const frozen=snapshot(db.prepare('SELECT * FROM agent_run WHERE id=?').get(running.id))
      assert.equal(frozen.model,'model')
      noLostInputs()
      const before=allRuns().map(row=>({id:row.id,status:row.status}))
      await stop(server)
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(running.id).status,'interrupted')
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(first.id).status,'completed')
      assert.equal(db.prepare("SELECT count(*) AS n FROM diagnostic_event WHERE run_id=? AND event='agent_run.interrupted'").get(running.id).n,1)
      const pids=readFileSync(spawnLog,'utf8').trim().split('\n').map(row=>JSON.parse(row).pid)
      for (const pid of pids) assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH','all Pi children must exit before stopped')
      pass('SIGTERM interrupts running run and preserves completed run', {before,after:allRuns().map(row=>({id:row.id,status:row.status})),pids})
      const abandoned=`run_${randomUUID()}`
      db.prepare("INSERT INTO agent_run (id,instance_id,conversation_id,project_id,request_id,status,session_id) VALUES (?,?,?,?,?,'queued',?)").run(abandoned,instanceId,conversationId,projectId,'req_abandoned',instanceId)
      server=launch(process.execPath,['.output/server/index.mjs'],'server-second.log')
      const secondHealth=await health(server)
      assert.notEqual(firstHealth.bootId,secondHealth.bootId)
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(abandoned).status,'interrupted')
      assert.equal(db.prepare("SELECT count(*) AS n FROM diagnostic_event WHERE run_id=? AND event='agent_run.interrupted'").get(abandoned).n,1)
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(first.id).status,'completed')
      pass('startup recovery interrupts abandoned queued run', {id:abandoned,status:'interrupted',firstBootId:firstHealth.bootId,secondBootId:secondHealth.bootId})
      await stop(server)
      const abandonedRunning=`run_${randomUUID()}`
      db.prepare("INSERT INTO agent_run (id,instance_id,conversation_id,project_id,request_id,status,session_id,started_at) VALUES (?,?,?,?,?,'running',?,unixepoch())").run(abandonedRunning,instanceId,conversationId,projectId,'req_abandoned_running',instanceId)
      const spawnCount=readFileSync(spawnLog,'utf8').trim().split('\n').length
      server=launch(process.execPath,['.output/server/index.mjs'],'server-disabled.log',{...environment,SPROUT_PI_ENABLED:'false'})
      await health(server)
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(abandonedRunning).status,'interrupted')
      assert.equal(db.prepare("SELECT count(*) AS n FROM diagnostic_event WHERE run_id=? AND event='agent_run.interrupted'").get(abandonedRunning).n,1)
      const disabledMessage=await send('disabled host preserves input')
      await delay(300)
      const disabled=allRuns().at(-1)
      assert.equal(disabled.status,'queued')
      assert.equal(db.prepare('SELECT disposition FROM agent_run_input WHERE message_id=?').get(disabledMessage.id).disposition,'pending')
      assert.equal(readFileSync(spawnLog,'utf8').trim().split('\n').length,spawnCount)
      pass('running startup recovery and disabled host preserve pending input without spawning', {recoveredRun:abandonedRunning,recoveredStatus:'interrupted',disabledRun:disabled.id,status:disabled.status})
      await stop(server)
      const emptyAgentDir=join(directory,'empty-pi-agent')
      mkdirSync(emptyAgentDir,{recursive:true})
      const unavailableEnvironment={...environment,PI_CODING_AGENT_DIR:emptyAgentDir}
      delete unavailableEnvironment.SPROUT_PI_RUNNER
      server=launch(process.execPath,['.output/server/index.mjs'],'server-unavailable-sdk.log',unavailableEnvironment)
      await health(server)
      const previous=allRuns().length
      await send('enabled host with unavailable SDK')
      const unavailable=await waitRun('failed',previous)
      assert.equal(unavailable.error_code,'session_open_failed')
      assert(unavailable.error_message.includes('找不到 Pi SDK'))
      assert.equal(unavailable.assistant_message_id,null)
      pass('enabled host with unavailable SDK explicitly fails', {id:unavailable.id,status:unavailable.status,errorCode:unavailable.error_code,message:unavailable.error_message})
      noLostInputs()
      const malformed=join(directory,'missing-runner.mjs')
      const invalid=launch(process.execPath,['.output/server/index.mjs'],'invalid-runner.log',{...environment,SPROUT_PI_RUNNER:malformed})
      const rejected=await bounded(invalid,15000)
      assert.notEqual(rejected.code,0)
      assert(readFileSync(join(directory,'invalid-runner.log'),'utf8').includes('SPROUT_PI_RUNNER'))
      pass('invalid runner configuration fails before listening',rejected)
      await stop(server)
      server=launch(process.execPath,['.output/server/index.mjs'],'server-stubborn.log')
      const stubbornHealth=await health(server)
      const beforeStubborn=allRuns().length
      await send('stub-hold-stubborn')
      const stubbornRun=await waitRun('running',beforeStubborn)
      const shutdownStarted=Date.now()
      kill(server)
      const shutdownFailure=await bounded(server,15000)
      assert.equal(shutdownFailure.code,1)
      assert.equal(shutdownFailure.signal,null)
      assert(Date.now()-shutdownStarted<9000,'Pi shutdown failure must settle before the global deadline')
      assert.equal(db.prepare('SELECT status FROM agent_run WHERE id=?').get(stubbornRun.id).status,'interrupted')
      assert.equal(db.prepare('SELECT phase FROM runtime_boot WHERE id=?').get(stubbornHealth.bootId).phase,'stopping')
      const stubbornPid=JSON.parse(readFileSync(spawnLog,'utf8').trim().split('\n').at(-1)).pid
      assert.throws(()=>process.kill(stubbornPid,0),error=>error.code==='ESRCH')
      pass('stubborn child is killed and host shutdown fails within its deadline', {exit:shutdownFailure,runId:stubbornRun.id,status:'interrupted',bootPhase:'stopping',pid:stubbornPid})
      server=launch(process.execPath,['.output/server/index.mjs'],'server-after-shutdown-failure.log')
      await health(server)
      assert.equal(db.prepare('SELECT phase FROM runtime_boot WHERE id=?').get(stubbornHealth.bootId).phase,'interrupted')
      noLostInputs()
    }
    await stop(server)
    pass('production shutdown', {runs:allRuns().map(row=>({id:row.id,status:row.status})),directory})
    writeFileSync(join(directory,'state.json'),JSON.stringify({userId,projectId,profileId,conversationId,instanceId,model,sessionFile:firstSnapshot.sessionFile},null,2)+'\n')
  }
} catch(error) {
  console.error(`FAIL ${live?'LIVE':'HERMETIC'} ${error.stack??error}`)
  if (live && db && conversationId) {
    const rows=allRuns()
    const states=Array.from({length:Math.max(3,rows.length)},(_,index)=>{
      const row=rows[index]
      return row ? {round:index+1,runId:row.id,sessionId:row.session_id,stopReason:row.stop_reason,status:row.status,errorCode:row.error_code,errorMessage:row.error_message,configSnapshot:row.config_snapshot?JSON.parse(row.config_snapshot):null} : {round:index+1,status:'not_started'}
    })
    console.error('LIVE_FAILURE_RUN_STATES '+JSON.stringify(states,null,2))
    const files=new Set(states.flatMap(row=>row.configSnapshot?.sessionFile?[row.configSnapshot.sessionFile]:[]))
    const transcripts=[]
    for (const [index,file] of [...files].entries()) {
      const content=existsSync(file)?readFileSync(file,'utf8'):'SESSION FILE MISSING'
      console.error(`LIVE_FAILURE_FULL_TRANSCRIPT ${file}\n${content}`)
      const artifact=join(directory,`failure-transcript-${index+1}.jsonl`)
      writeFileSync(artifact,content)
      transcripts.push({sessionFile:file,artifact})
    }
    writeFileSync(join(directory,'failure-evidence.json'),JSON.stringify({error:String(error),runs:states,transcripts},null,2)+'\n')
  }
  process.exitCode=1
} finally {
  for(const child of children) kill(child,'SIGKILL')
  await Promise.allSettled([...children].map(child=>child.completion))
  db?.close()
}
JS
