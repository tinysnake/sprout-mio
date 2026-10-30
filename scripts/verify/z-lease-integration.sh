#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
case "${SPROUT_VERIFY_CHAT_MODE-model-fixture}" in
  model-fixture|live) export SPROUT_VERIFY_CHAT_MODE="${SPROUT_VERIFY_CHAT_MODE-model-fixture}" ;;
  *) echo 'SPROUT_VERIFY_CHAT_MODE must be model-fixture or live' >&2; exit 2 ;;
esac
if [[ "$SPROUT_VERIFY_CHAT_MODE" == model-fixture && -n "${SPROUT_PI_RUNNER-}" ]]; then
  echo 'model-fixture requires the real Pi runner; remove SPROUT_PI_RUNNER' >&2
  exit 2
fi
# Production page -> authenticated Chat turn -> real Pi remote tool -> macOS Worker.
# Private SQLite, credentials, session transcripts and operation output stay in mktemp.
source "$(dirname "$0")/lib/ensure-worker-artifact.sh"
ensure_worker_artifact
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
/** 第三层 runner 是进程组组长：命令 pid 自己的 pgid 才是要收的组。 */
const processGroupOf = (pid) => { const r = spawnSync('ps', ['-o', 'pgid=', '-p', String(pid)], {encoding:'utf8'}); const g = Number(r.stdout.trim()); return Number.isSafeInteger(g) && g > 1 ? g : null; };
import { createServer } from 'node:net';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';
import Sqlite from 'better-sqlite3';
import { assertForcedReceiptPersists } from './scripts/browser/p4b-forced-receipt-scene.mjs';
import { startModelFixture, leaseTurn } from './scripts/verify/lib/model-fixture.mjs';
const chatMode = process.env.SPROUT_VERIFY_CHAT_MODE;
console.log(`CHAT mode=${chatMode} runner=scripts/pi-host-runner.mjs`);
let modelFixture;
const privateDir = mkdtempSync(join(tmpdir(), 'sprout-lease-integration-'));
const evidenceRoot = resolve('.verify/p4b-integration/evidence');
mkdirSync(evidenceRoot, { recursive: true });
const evidence = mkdtempSync(join(evidenceRoot, 'run-'));
const root = join(privateDir, 'root'); mkdirSync(root);
const socket = createServer(); await new Promise(r => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port; await new Promise(r => socket.close(r));
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, DATABASE_URL: join(privateDir, 'private.sqlite'), APP_ORIGIN: base,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'), HOST: '127.0.0.1', PORT: String(port), NITRO_PORT: String(port),
  NODE_ENV: 'production', SPROUT_PI_ENABLED: 'true', SPROUT_PI_DATA_DIR: join(privateDir, 'pi'),
  SPROUT_REPO_DIR: join(privateDir, 'repos'), NO_PROXY: 'localhost,127.0.0.1,::1', no_proxy: 'localhost,127.0.0.1,::1' };
const children = [];
function launch(args, name, input) {
  const fd = openSync(join(privateDir, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, args, { env, stdio: [input ? 'pipe' : 'ignore', fd, fd] });
  closeSync(fd); children.push(child); if (input) child.stdin.end(input);
  child.done = new Promise(r => child.once('exit', code => r(code))); return child;
}
const req = createRequire(import.meta.resolve('@tanstack/react-start'));
const clientReq = createRequire(req.resolve('@tanstack/start-client-core/package.json'));
const { fromCrossJSON, toJSON } = clientReq('seroval');
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap(i => i.isDirectory() ? walk(join(path, i.name)) : i.name.endsWith('.mjs') ? [readFileSync(join(path, i.name), 'utf8')] : []); }
const ids = Object.fromEntries([...walk('.output/server').join('\n').matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map(m => [m[2], m[1]]));
let cookie, browser, context, page, projectId, machineId, cleanupPid;
const passes = [];
function pass(name) { passes.push(name); writeFileSync(join(evidence, 'results.json'), JSON.stringify({ base, passes }, null, 2)); console.log(`PASS ${name}`); }
function profileModel(role) { return modelFixture ? { model: modelFixture.model(role) } : process.env.SPROUT_VERIFY_PI_MODEL ? { model: process.env.SPROUT_VERIFY_PI_MODEL } : {}; }
function armTool(role, body, name, parameters) { modelFixture?.arm(role, { expectedUserText:body, steps:[{name,arguments:parameters}], reply:'Local model fixture received the actual tool result; inspect the server facts.' }); }
async function armLease(action, parameters) {
  if (!modelFixture) return;
  await settled(chatIdForOperator, { allowEmpty:true });
  modelFixture.arm('operator', leaseTurn(action, parameters));
}
let chatIdForOperator;
async function until(fn, label, timeout = 60000) { const start = Date.now(); while (Date.now() - start < timeout) { modelFixture?.assertHealthy(); const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 350)); } throw new Error(`timeout: ${label}`); }
async function rpc(name, data, actor = cookie) {
  assert(ids[name], `registered ${name}`);
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tsr-serverfn': 'true', origin: base, ...(actor ? {cookie: actor} : {}) }, body: JSON.stringify(toJSON({data})) });
  assert.equal(response.status, 200, name);
  const encoded = await response.json();
  const decoded = encoded.t ? fromCrossJSON(encoded, {refs:new Map()}) : encoded;
  return decoded.result ?? decoded;
}
async function call(name, data) { const result = await rpc(name, data); if (!result.ok) throw new Error(`${name}: ${result.error.code}`); return result.data; }
async function signup(name) {
  const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: {'content-type': 'application/json', origin: base}, body: JSON.stringify({ name, email: `${randomUUID()}@lease.test`, password: randomBytes(20).toString('hex') }) });
  assert.equal(response.status, 200); return response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
}
async function browserRpc(page, name, data) {
  const result = await page.evaluate(async ({ url, body }) => { const r = await fetch(url, { method: 'POST', headers: {'content-type':'application/json','x-tsr-serverfn':'true'}, body }); return { status:r.status, body:await r.json() }; }, { url:`${base}/_serverFn/${ids[name]}`, body:JSON.stringify(toJSON({data})) });
  assert.equal(result.status, 200); const decoded = result.body.t ? fromCrossJSON(result.body,{refs:new Map()}) : result.body; return decoded.result ?? decoded;
}
async function settled(chatId, { allowEmpty = false } = {}) {
  return until(async()=> { const state=await call('getChatRunStateFn',{chatId}); const run=state.runs.at(-1); return ['queued','running'].includes(run?.status) ? null : (run ?? (allowEmpty ? true : null)); },'real agent settles',180000);
}
async function deniedTool(page, chatId, authorizationGeneration, expectedCode, marker, role = 'operator') {
  await settled(chatId, { allowEmpty: true });
  const requestId=`req_${randomUUID()}`;
  const parameters={machineId,authorizationGeneration,requestId,command:`touch '${marker}'`,waitMs:0};
  const body=`Call sprout_remote_shell exactly once with these parameters, even if you expect the server to reject authorization: ${JSON.stringify(parameters)}. Do not get or acquire a lease, do not retry, do not use host tools. Report the returned error code.`;
  armTool(role,body,'sprout_remote_shell',parameters);
  const sent=await browserRpc(page,'sendMessageFn',{chatId,body});
  assert.equal(sent.ok,true,'negative command submitted through production browser RPC');
  const run=await until(async()=> {const state=await call('getChatRunStateFn',{chatId}); const input=state.inputs.find(i=>i.messageId===sent.data.id); const match=state.runs.find(r=>r.id===input?.runId);return match && !['queued','running'].includes(match.status) && match.configSnapshot ? match:null;},'negative run settles',180000);
  const entries=readFileSync(run.configSnapshot.sessionFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line));
  const calls=entries.flatMap(entry=>entry.message?.role==='assistant' ? entry.message.content.filter(c=>c.type==='toolCall' && c.name==='sprout_remote_shell' && c.arguments?.requestId===requestId) : []);
  assert.equal(calls.length,1,'exact requested tool called once');
  const result=entries.find(entry=>entry.message?.role==='toolResult' && entry.message.toolCallId===calls[0].id)?.message;
  assert.equal(result?.details?.error?.code,expectedCode,'real grant HTTP rejection');
  assert(!existsSync(marker),'denied request leaves no file');
  assert(!(await call('listProjectExecutionsFn',{projectId,machineId,limit:100})).some(e=>e.requestId===requestId),'denied request was not enqueued');
}
try {
  if (chatMode === 'model-fixture') {
    modelFixture = await startModelFixture({privateDir});
    env.PI_CODING_AGENT_DIR = modelFixture.agentDir;
    console.log(`CHAT provider/model=${modelFixture.model('operator')},${modelFixture.model('nonHolder')} thinking=off paid-model-calls=0 (private catalog, loopback endpoint, both profiles pinned)`);
  }
  const migration = launch(['--import', 'tsx', 'src/db/migrate.ts'], 'migrate'); assert.equal(await migration.done, 0);
  launch(['.output/server/index.mjs'], 'server');
  await until(async () => { try { return (await fetch(`${base}/api/health`)).ok; } catch { return false; } }, 'service');
  cookie = await signup('Integration Human');
  projectId = (await call('createProjectFn', {name:'Lease integration', description:'Real Machine and Chat'})).id;
  const projectB = (await call('createProjectFn', {name:'Independent Project'})).id;
  const profile = await call('createAgentProfileFn', {name:'Lease operator', persona:'Use the named Sprout remote tools exactly as requested. Never substitute host tools for remote tools. Report tool errors faithfully and do not retry changed generations.', ...profileModel('operator'), effort:'off'});
  await call('addProjectMemberFn', {projectId, agentProfileId:profile.id});
  const chat = await call('createDirectChatFn', {projectId, agentProfileId:profile.id});
  const chatId = chat.chat?.id ?? chat.id;
  chatIdForOperator = chatId;
  const enrollment = await call('createMachineFn', {name:'Integration Mac'});
  machineId = enrollment.detail.machine.id;
  await call('saveMachineRootDirectoryFn', {machineId, directory:root, expectedRevision:enrollment.detail.machine.rootRevision});
  await call('saveProjectMachineBindingFn', {machineId, projectId, description:'primary', expectedRevision:null});
  mkdirSync(join(root, projectId), { recursive:true });
  const ticketFile = join(privateDir,'ticket'); writeFileSync(ticketFile,enrollment.ticket,{mode:0o600});
  const workerArgs = [resolve('dist/worker/main.js')];
  const init = launch([...workerArgs,'init','--server',base,'--machine',machineId,'--state-dir',join(privateDir,'worker'),'--ticket-file',ticketFile,'--allow-http',base], 'worker-init');
  assert.equal(await init.done,0,'Worker init exits successfully'); unlinkSync(ticketFile);
  const worker = launch([...workerArgs,'run','--state-dir',join(privateDir,'worker')], 'worker');
  await until(async () => (await call('getMachineFn',{machineId})).connection.kind==='online','Worker online');
  await until(async () => (await call('getMachineFn',{machineId,projectId})).bindings[0]?.observation?.fact?.result?.kind==='accessible','directory ready');
  browser = await chromium.launch(); context = await browser.newContext({viewport:{width:1440,height:1000}});
  await context.addCookies(cookie.split('; ').map(v=>{const i=v.indexOf('=');return {name:v.slice(0,i),value:v.slice(i+1),url:base};}));
  page = await context.newPage();
  // 无 Project 的租约入口明确阻断，不能静默退化为 Machine 页。
  await page.goto(`${base}/machines/${machineId}/lease`);
  await page.getByTestId('machine-lease-context-required').waitFor();
  assert.equal(await page.getByTestId('machine-settings-group').count(),0);
  assert.equal(await page.getByTestId('machine-lease-detail').count(),0);
  await page.getByTestId('machine-detail-back').click();
  await page.waitForURL(`**/machines/${machineId}`);
  await page.getByTestId('machine-settings-group').waitFor();
  assert.equal(await page.getByTestId('machine-lease-detail').count(),0);
  assert.equal(await page.getByTestId('machine-remote-executions').count(),0);
  assert.equal(await page.getByTestId('machine-lease-link').first().getAttribute('href'),`/machines/${machineId}/lease?projectId=${projectId}`);
  assert.equal(await page.getByTestId('machine-lease-list').count(),1,'Machine details show the Project × Machine lease list');
  assert.equal(await page.getByTestId('machine-lease-jump').count(),0,'no per-context lease action in the page header');
  const machineDetailsRoute = `${base}/machines/${machineId}`;
  for (const viewport of [{width:390,height:844},{width:1200,height:900}]) {
    await page.setViewportSize(viewport);
    await page.goto(machineDetailsRoute);
    const leaseList = page.getByTestId('machine-lease-list');
    await leaseList.waitFor();
    const leaseRows = page.getByTestId('machine-lease-link');
    assert.equal(await leaseRows.count(),1,'the bound Project has one lease row');
    for (const row of await leaseRows.all()) {
      assert.equal((await row.getByText('Project',{exact:true}).count()),1,'lease row explicitly labels its identity as Project');
      assert((await row.innerText()).includes('Lease integration'),'lease row preserves the Project name');
      assert.equal(await row.getAttribute('href'),`/machines/${machineId}/lease?projectId=${projectId}`,'lease row opens this Project-scoped route');
    }
    const layout = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="machine-lease-list"]');
      const row = list?.querySelector('a[data-testid="machine-lease-link"]');
      const bounds = row?.getBoundingClientRect();
      return {scrollWidth:document.documentElement.scrollWidth,innerWidth:window.innerWidth,rowLeft:bounds?.left,rowRight:bounds?.right};
    });
    assert(layout.scrollWidth <= layout.innerWidth + 1,`no horizontal overflow at ${viewport.width}px`);
    assert(layout.rowLeft !== undefined && layout.rowLeft >= 0 && layout.rowRight <= viewport.width + 1,`lease row stays within ${viewport.width}px viewport`);
    await page.screenshot({path:join(evidence,`machine-details-leases-${viewport.width}.png`)});
  }
  await page.getByTestId('machine-lease-link').click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  assert.equal(new URL(page.url()).searchParams.get('projectId'),projectId,'lease entry preserves its Project context');
  // 带 Project 的 Machine 设置仍可编辑绑定，租约列表从绑定上下文进入。
  await page.goto(`${base}/machines/${machineId}?projectId=${projectId}`);
  await page.getByTestId('machine-binding-form').waitFor();
  assert.equal(await page.getByTestId('machine-lease-link').first().getAttribute('href'),`/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-link').click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  pass('lease context required and Machine settings entry navigates to standalone lease route');
  // Project settings 只给摘要与入口：租约管理入口深链到独立租约路由。
  await page.goto(`${base}/projects/${projectId}/settings`);
  await page.getByTestId('info-hub-project-machines').waitFor();
  assert.equal(await page.locator('[data-testid$="-mutation"]').count(),0,'no lease mutation form in Project settings');
  const manageHref = await page.getByTestId('lease-manage-link').first().getAttribute('href');
  assert.equal(manageHref,`/machines/${machineId}/lease?projectId=${projectId}`,'lease entry deep-links to Machine detail');
  await page.getByTestId('lease-manage-link').first().click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  for (const id of ['machine-settings-group','machine-connection-section','machine-shells','machine-root-section','machine-bindings','machine-restart-section','machine-binding-form']) {
    assert.equal(await page.getByTestId(id).count(),0,`lease route must exclude ${id}`);
  }
  assert.equal(await page.getByTestId('machine-lease-jump').count(),0,'lease page has no self-navigation action');
  await page.goBack();
  await page.waitForURL(`**/projects/${projectId}/settings`);
  await page.goForward();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.reload();
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.getByTestId('machine-detail-back').click();
  await page.waitForURL(`**/projects/${projectId}/settings`);
  pass('Project settings entry preserves browser back/forward and lease refresh route');
  await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.reload();
  await page.getByTestId('machine-detail-back').click();
  await page.waitForURL(`**/projects/${projectId}/settings`);
  pass('direct lease route refresh uses Project settings fallback');
  // F-15：从已滚动的设置页进入租约路由时，租约页从顶部开始，不继承来源页滚动量。
  await page.goto(`${base}/projects/${projectId}/settings`);
  await page.getByTestId('info-hub-project-machines').waitFor();
  const sourceScroll = await page.getByTestId('project-settings-page').evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    return node.scrollTop;
  });
  assert(sourceScroll > 0, 'settings scroll container genuinely scrolled before navigation');
  await page.getByTestId('lease-manage-link').first().click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  assert.equal(await page.getByTestId('machine-lease-page').evaluate((node) => node.scrollTop), 0, 'lease route starts at the top instead of inheriting the source scroll');
  await page.getByTestId('machine-detail-back').click();
  await page.waitForURL(`**/projects/${projectId}/settings`);
  pass('lease entry does not carry over the settings scroll position');
  await page.getByTestId('lease-manage-link').first().click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  // Machine 详情页不要求重选目标：目标就是当前这台。
  assert.equal(await page.getByTestId('machine-lease-section-overview-mutation-machine').count(),0,'no machine picker on the machine page');
  assert((await page.getByTestId('machine-lease-section-overview-mutation-target').innerText()).includes('Integration Mac'),'fixed target names the current Machine');
  await page.getByTestId('lease-transfer-target').waitFor();
  await page.getByTestId('lease-transfer-target').selectOption({ index: 1 });
  const handoffWithoutChat=page.getByRole('button',{name:'请求分身交接'});
  assert((await page.getByTestId('lease-transfer-machine').innerText()).includes('Integration Mac'));
  assert.notEqual(await page.getByTestId('lease-transfer-target').inputValue(),'');
  assert.equal(await handoffWithoutChat.isDisabled(),true,'handoff waits for explicit Chat selection');
  assert.equal(await page.getByTestId('lease-handoff-chat-required').innerText(),'请先在上方选择执行请求的 Chat，再请求分身交接。');
  // F-15：等待前置条件的提示用 warning 语义色，与其它前置等待态一致。
  const requiredWarning = page.getByTestId('lease-handoff-chat-required');
  const warningColor = await requiredWarning.evaluate((node) => getComputedStyle(node).color);
  const warningToken = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.className = 'text-status-warning';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    document.body.appendChild(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  assert.equal(warningColor, warningToken, 'precondition hint uses the shared warning semantic color');
  assert.notEqual(warningColor, await page.evaluate(() => getComputedStyle(document.body).color), 'precondition hint is not the default text color');
  await page.screenshot({path:join(evidence,'handoff-needs-chat.png'),fullPage:true});
  // F-15：选择器与动作同表单，页面上只有一个 Chat 选择器。
  assert.equal(await page.getByTestId('lease-chat-select').count(),1,'exactly one Chat selector is rendered');
  await page.getByTestId('lease-chat-select').selectOption(chatId);
  assert((await page.getByTestId('lease-chat-picked').innerText()).startsWith('执行请求的 Chat：'),'transfer card confirms the chosen Chat');
  assert.equal(await handoffWithoutChat.isEnabled(),true,'handoff is enabled after selecting a Chat');
  assert.equal(await page.getByTestId('lease-handoff-chat-required').count(),0);
  await page.screenshot({path:join(evidence,'handoff-chat-selected.png'),fullPage:true});
  const uiRequestIds=new Set();
  page.on('request',request=>{
    if(request.method()==='POST' && request.url().includes(ids.getLeaseRequestFn)) {
      const requestId=request.postData()?.match(/req_[0-9a-f-]{36}/)?.[0];
      if(requestId) uiRequestIds.add(requestId);
    }
  });
  const beforeAcquire=await call('getLeaseFn',{projectId,machineId});
  assert.equal(beforeAcquire.lease.state,'free','UI is the only acquire path');
  await armLease('acquire',{machineId,expectedGeneration:beforeAcquire.lease.generation});
  await page.getByTestId('machine-lease-section-overview-mutation-submit').click();
  let acquired;
  try {
    await until(async()=>{
      const error=page.getByTestId('machine-lease-section-overview-mutation-error');
      assert.equal(await error.count(),0,'UI acquire must not return a mutation error');
      return await page.getByTestId('machine-lease-section-overview-mutation-receipt').count();
    },'receipt from this UI acquire',180000);
    assert.equal(uiRequestIds.size,1,'one UI requestId');
    const requestId=[...uiRequestIds][0];
    const facts=await call('getLeaseRequestFn',{projectId,machineId,chatId,requestId});
    assert(facts.mutation,'receipt belongs to the UI request');
    const receiptDatabase=new Sqlite(env.DATABASE_URL,{readonly:true});
    try {
      const row=receiptDatabase.prepare('SELECT request_id AS requestId FROM lease_mutation WHERE id=?').get(facts.mutation.mutationId);
      assert.equal(row?.requestId,requestId,'mutationId is persisted for this UI requestId');
    } finally {receiptDatabase.close();}
    assert.equal(facts.mutation.action,'acquire');
    assert.equal(facts.mutation.expectedGeneration,beforeAcquire.lease.generation);
    assert(['pending','completed'].includes(facts.mutation.state));
    assert((await page.getByTestId('machine-lease-section-overview-mutation-receipt').innerText()).includes(facts.mutation.mutationId),'UI receipt matches this mutationId');
    assert.equal(await page.getByTestId('machine-lease-section-overview-mutation-error').count(),0);
    acquired=await until(async()=> {const lease=(await call('getLeaseFn',{projectId,machineId})).lease;return lease.state==='held'?lease:null;},'page acquire via real agent',180000);
  } catch (cause) {
    console.error('FAIL receipt assertion '+cause.message);
    // Preserve the error while observing whether this same request executes late.
    await until(async()=> (await call('getLeaseFn',{projectId,machineId})).lease.state==='held','late lease fact after receipt error',125000).catch(()=>null);
    const database=new Sqlite(env.DATABASE_URL,{readonly:true});
    try {
      const leases=database.prepare('SELECT state,generation,holder_instance_id AS holderInstanceId FROM machine_lease WHERE project_id=? AND machine_id=?').all(projectId,machineId);
      const mutations=database.prepare('SELECT id AS mutationId,request_id AS requestId,action,expected_generation AS expectedGeneration,state FROM lease_mutation WHERE project_id=? AND machine_id=?').all(projectId,machineId);
      const pendingMutationId=mutations.find(item=>item.state==='pending')?.mutationId??null;
      const runs=database.prepare('SELECT id,status,error_code AS errorCode,queued_at AS queuedAt,settled_at AS settledAt FROM agent_run WHERE project_id=?').all(projectId);
      const toolCalls=[];
      for(const row of database.prepare('SELECT config_snapshot AS snapshot FROM agent_run WHERE project_id=?').all(projectId)) {
        const sessionFile=row.snapshot && JSON.parse(row.snapshot).sessionFile;
        if(!sessionFile || !existsSync(sessionFile)) continue;
        for(const line of readFileSync(sessionFile,'utf8').split('\n').filter(Boolean)) {
          let entry; try {entry=JSON.parse(line);} catch {continue;}
          if(entry.message?.role!=='assistant') continue;
          for(const part of entry.message.content??[]) if(part.type==='toolCall') {
            const input=part.arguments??{};
            toolCalls.push({name:part.name,action:input.action,expectedGeneration:input.expectedGeneration,requestId:input.requestId});
          }
        }
      }
      console.error('FAIL receipt metadata '+JSON.stringify({submitted:{action:'acquire',expectedGeneration:beforeAcquire.lease.generation},uiRequestIds:[...uiRequestIds],leases,pendingMutationId,mutations,runs,toolCalls}));
      const uiError=await page.getByTestId('machine-lease-section-overview-mutation-error').innerText().catch(()=>null);
      console.error('FAIL receipt UI '+JSON.stringify({error:uiError}));
      await page.screenshot({path:join(evidence,'receipt-conflict-overview.png'),fullPage:true});
    } finally {database.close();}
    throw cause;
  }
  pass('page acquire -> authenticated Chat -> real Pi lease tool -> held lease');
  await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
  await until(async()=> (await page.getByTestId('machine-lease-detail').innerText()).includes(acquired.holderInstanceId),'Machine lease fact');
  await page.getByTestId('machine-lease-detail').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,'machine-held-light.png'),fullPage:true});
  const marker=join(root,projectId,'persist.txt');
  const shell = `printf integration-proof > '${marker}'; sleep 900`;
  const shellRequestId=`req_${randomUUID()}`;
  const shellBody=`Use sprout_remote_shell on machineId ${machineId}, authorizationGeneration ${acquired.generation}, requestId ${shellRequestId}. command: ${JSON.stringify(shell)}. waitMs: 1000. Call sprout_remote_execution_get if necessary. Do not use the local bash tool. Do not release the lease.`;
  await settled(chatId);
  armTool('operator',shellBody,'sprout_remote_shell',{machineId,authorizationGeneration:acquired.generation,requestId:shellRequestId,command:shell,waitMs:1000});
  await call('sendMessageFn',{chatId,body:shellBody});
  const execution = await until(async()=> (await call('listProjectExecutionsFn',{projectId,machineId})).find(e=>e.operation.kind==='shell' && e.result?.kind==='shell' && e.result.pid), 'real remote shell result',180000);
  assert(readFileSync(marker,'utf8')==='integration-proof','private sentinel matches');
  const pid=execution.result.pid; cleanupPid=pid; process.kill(pid,0);
  await page.reload();
  await page.getByTestId('machine-executions-list').waitFor({timeout:15000});
  // 卡片只在「调试详情」抽屉里：先打开抽屉再取证。
  await page.getByTestId(/^machine-executions-debug-[^ ]+-open$/).click();
  const debugDialog=page.getByTestId(/^machine-executions-debug-[^ ]+-dialog$/);
  await debugDialog.waitFor({timeout:15000});
  await page.getByTestId(/^machine-executions-debug-[^ ]+-item$/).first().waitFor({timeout:15000});
  const visible=await debugDialog.innerText(); assert(visible.includes('pid') || visible.includes('运行'));
  // 命令正文（含绝对路径与可能含密钥的内容）不得进入界面。
  assert(!visible.includes('integration-proof'),'command body and output are not echoed');
  assert(!visible.includes(marker),'target path is not echoed');
  assert(!visible.includes('sleep 900'),'shell command text is not echoed');
  const authorization=await page.getByTestId(/^machine-executions-debug-[^ ]+-item-authorization$/).first().innerText();
  assert(!/ins_[0-9a-f-]{36}/.test(authorization),`holder rendered by name, got ${authorization}`);
  assert(authorization.includes('由该分身的一次运行发起'),'run is described, not printed as a bare id');
  await page.getByTestId('machine-remote-executions').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,'machine-result-light.png'),fullPage:true});
  // 第 6 条：交接与收回也不用重选 Machine，目标就是本页这台。
  assert.equal(await page.getByLabel('交接或收回的 Machine').count(),0,'no machine picker for handoff/reclaim');
  assert((await page.getByTestId('lease-transfer-machine').innerText()).includes('Integration Mac'),'handoff target is the current Machine');
  pass('real remote shell and process result visible on production Machine page');
  await settled(chatId);
  const nonHolderProfile=await call('createAgentProfileFn',{name:'Non holder',persona:'Use the requested remote tool once, report its returned error, never acquire a lease.',...profileModel('nonHolder'),effort:'off'});
  await call('addProjectMemberFn',{projectId,agentProfileId:nonHolderProfile.id});
  const nonHolder=await call('createDirectChatFn',{projectId,agentProfileId:nonHolderProfile.id});
  const nonHolderChat=nonHolder.chat.id;
  await deniedTool(page,nonHolderChat,acquired.generation,'lease_not_holder',join(root,projectId,'non-holder-must-not-exist'),'nonHolder');
  pass('browser Chat request -> real non-holder grant HTTP rejection and absent sentinel');
  const read = await browserRpc(page,'getExecutionFn',{projectId,machineId,executionId:execution.executionId}); assert.equal(read.ok,true);
  const otherCookie=await signup('Other Human');
  for (const [name,input] of [ ['getLeaseFn',{projectId,machineId}], ['listProjectExecutionsFn',{projectId,machineId}], ['getExecutionFn',{projectId,machineId,executionId:execution.executionId}], ['reclaimLeaseFn',{action:'reclaim',projectId,machineId,expectedGeneration:acquired.generation,confirm:true,requestId:`req_${randomUUID()}`}] ]) {
    const unauth=await rpc(name,input,''); assert.equal(unauth.ok,false); assert.equal(unauth.error.code,'unauthorized');
    const stranger=await rpc(name,input,otherCookie); assert.equal(stranger.ok,false); assert.equal(stranger.error.code,'not_found');
  }
  const crossed=await browserRpc(page,'getExecutionFn',{projectId:projectB,machineId,executionId:execution.executionId}); assert.equal(crossed.ok,false); assert.equal(crossed.error.code,'not_found');
  const otherContext=await browser.newContext(); await otherContext.addCookies(otherCookie.split('; ').map(v=>{const i=v.indexOf('=');return {name:v.slice(0,i),value:v.slice(i+1),url:base};}));
  const foreignPage=await otherContext.newPage();await foreignPage.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`); await foreignPage.getByTestId('result-error').waitFor().catch(()=>{});
  assert((await foreignPage.locator('body').innerText()).includes('not_found'));
  await foreignPage.screenshot({path:join(evidence,'cross-user-denied.png'),fullPage:true}); await otherContext.close();
  pass('real HTTP unauthenticated/cross-user and browser cross-Project denial');
  await page.goto(`${base}/projects/${projectId}/chats/${chatId}?info=1`);
  await page.getByTestId('chat-machine-facts').waitFor();
  assert((await page.getByTestId('chat-machine-facts').innerText()).includes(acquired.holderInstanceId));
  await page.getByTestId('chat-machine-facts').scrollIntoViewIfNeeded();
  await page.screenshot({path:join(evidence,'chat-inspector-light.png'),fullPage:true,mask:[page.getByTestId('message-list')]});
  await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.getByTestId('lease-chat-select').selectOption(chatId);
  await armLease('release',{machineId,expectedGeneration:acquired.generation});
  await page.getByTestId('machine-lease-section-overview-mutation-submit').click();
  await until(async()=> (await call('getLeaseFn',{projectId,machineId})).lease.state==='free','page release through real agent',180000);
  process.kill(pid,0); assert(readFileSync(marker,'utf8')==='integration-proof','release preserves private sentinel');
  pass('page release preserves real process and file');
  await settled(chatId);
  await deniedTool(page,chatId,acquired.generation,'lease_stale_generation',join(root,projectId,'stale-must-not-exist'));
  process.kill(pid,0);
  pass('browser Chat request -> real old-generation HTTP rejection and absent sentinel');
  await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.getByTestId('lease-chat-select').selectOption(chatId);
  await armLease('acquire',{machineId,expectedGeneration:(await call('getLeaseFn',{projectId,machineId})).lease.generation});
  await page.getByTestId('machine-lease-section-overview-mutation-submit').click();
  const reacquired=await until(async()=> {const lease=(await call('getLeaseFn',{projectId,machineId})).lease;return lease.state==='held'?lease:null;},'reacquire from page',180000);
  await page.locator('[data-testid="machine-lease-section-overview-mutation-success"], [data-testid="machine-lease-section-overview-mutation-waiting"]').first().waitFor({timeout:65000});
  await settled(chatId);
  await page.getByLabel('交接目标分身').selectOption(nonHolder.instance.id);
  // 交接把上一任 holder 变成非 holder，产品会给它投递一条资源撤销通知并真正开始一轮；
  // 这一轮不是门禁驱动的，按前缀常驻认领，什么时候到都不会挤掉已布的计划。
  modelFixture?.arm('operator', { expectedUserPrefix: '资源撤销通知', repeat: true, steps: [], reply: '收到资源撤销通知，本轮不做操作。' });
  await armLease('handoff',{machineId,expectedGeneration:reacquired.generation,targetInstanceId:nonHolder.instance.id});
  await page.getByRole('button',{name:'请求分身交接'}).click();
  const transferred=await until(async()=> {const lease=(await call('getLeaseFn',{projectId,machineId})).lease;return lease.state==='held' && lease.holderInstanceId===nonHolder.instance.id ? lease:null;},'handoff through page and real holder tool',180000);
  assert(transferred.generation>reacquired.generation); process.kill(pid,0); assert(readFileSync(marker,'utf8')==='integration-proof','handoff preserves sentinel');
  await page.reload();
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.getByRole('button',{name:'收回租约',exact:true}).click();
  await until(async()=> (await call('getLeaseFn',{projectId,machineId})).lease.state==='free','authenticated Human reclaim');
  process.kill(pid,0); assert(readFileSync(marker,'utf8')==='integration-proof','reclaim preserves sentinel');
  pass('production handoff and Human reclaim preserve process and file');
  await page.reload();
  await page.getByTestId('machine-lease-detail').waitFor();
  await page.getByTestId('lease-chat-select').selectOption(chatId);
  await armLease('acquire',{machineId,expectedGeneration:(await call('getLeaseFn',{projectId,machineId})).lease.generation});
  await page.getByTestId('machine-lease-section-overview-mutation-submit').click();
  const forcedHolder=await until(async()=> {const lease=(await call('getLeaseFn',{projectId,machineId})).lease;return lease.state==='held'?lease:null;},'acquire for forced receipt',180000);
  await settled(chatId);
  const forceRequestId=`req_${randomUUID()}`;
  const forceBody=`Call sprout_remote_shell exactly once with machineId ${machineId}, authorizationGeneration ${forcedHolder.generation}, requestId ${forceRequestId}, command "sleep 20", waitMs 10000. Do not release the lease or use host tools.`;
  armTool('operator',forceBody,'sprout_remote_shell',{machineId,authorizationGeneration:forcedHolder.generation,requestId:forceRequestId,command:'sleep 20',waitMs:10000});
  await call('sendMessageFn',{chatId,body:forceBody});
  const inFlight=await until(async()=> (await call('listProjectExecutionsFn',{projectId,machineId})).find(item=>item.requestId===forceRequestId && item.state==='running'),'real operation running before Worker pause',180000);
  assert.equal(worker.kill('SIGSTOP'),true,'pause the real test Worker before drain acknowledgement');
  try {
    await page.reload();
    await page.getByTestId('machine-lease-detail').waitFor();
    await page.getByRole('button',{name:'收回租约',exact:true}).click();
    await until(async()=> (await call('getLeaseFn',{projectId,machineId})).lease.state==='fencing','reclaim waits for paused Worker');
    await page.reload();
    await page.getByTestId('machine-lease-detail').waitFor();
    const receipt=await assertForcedReceiptPersists({page,projectId,machineId,call,until,refreshFunctionId:ids.getProjectInfoHubFn});
    const unknown=await call('getExecutionFn',{projectId,machineId,executionId:inFlight.executionId});
    assert.equal(unknown.state,'unknown','forced reclaim does not claim in-flight work drained');
    process.kill(pid,0); assert(readFileSync(marker,'utf8')==='integration-proof','forced reclaim preserves existing process and file');
    await page.getByTestId(`machine-lease-section-overview-forced-receipt-${machineId}`).screenshot({path:join(evidence,'forced-receipt-after-refresh.png')});
    writeFileSync(join(evidence,'forced-receipt.json'),JSON.stringify({before:'fencing',after:'free',mutationId:receipt.mutationId,generation:receipt.generation,executionState:unknown.state},null,2));
    pass('forced receipt survives fencing unmount and automatic refresh, warns 未确认, and force controls disappear');
  } finally {
    worker.kill('SIGCONT');
  }
  await settled(chatId);
  await deniedTool(page,chatId,forcedHolder.generation,'lease_stale_generation',join(root,projectId,'forced-stale-must-not-exist'));
  pass('forced reclaim rejects old-generation remote operation and leaves no file');
  const free=(await call('getLeaseFn',{projectId,machineId})).lease; assert(free.generation>acquired.generation);
  for (const width of [390,900,1200]) {
    await page.setViewportSize({width,height:1000});
    for (const theme of ['light','dark']) {
      await page.evaluate(theme=>localStorage.setItem('sprout:theme',theme),theme);
      await page.emulateMedia({colorScheme:theme}); await page.goto(`${base}/machines/${machineId}/lease?projectId=${projectId}`);
      assert.equal(await page.evaluate(()=>document.documentElement.classList.contains('dark')),theme==='dark');
      await page.getByTestId('machine-lease-detail').waitFor();
      await page.getByTestId('machine-lease-detail').scrollIntoViewIfNeeded();
      assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
      await page.screenshot({path:join(evidence,`machine-${width}-${theme}.png`),fullPage:true});
    }
  }
  await page.setViewportSize({width:390,height:1000});
  await page.getByTestId('machine-detail-back').click(); await page.waitForURL(`**/projects/${projectId}/settings`);
  // 真实入口是关系行内的「管理租约与执行」链接；machine-item 现在是 li，不再可点。
  await page.getByTestId('machine-item').filter({hasText:'Integration Mac'}).getByTestId('lease-manage-link').click();
  await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`);
  await page.goBack(); await page.waitForURL(`**/projects/${projectId}/settings`);
  await page.goForward(); await page.waitForURL(`**/machines/${machineId}/lease?projectId=${projectId}`); await page.reload();
  pass('production stable URL refresh back/forward and 390/900/1200 light/dark');
  { const group=processGroupOf(pid); if(group) process.kill(-group,'SIGTERM'); } cleanupPid=undefined;
  await context.close(); await browser.close(); browser=undefined;
  modelFixture?.assertDrained();
  assert.equal(passes.length,14,'all original integration conditions passed');
  console.log(`Evidence: ${evidence}`);
} catch(error) {
  writeFileSync(join(evidence,'failure.txt'), String(error instanceof Error ? error.message : 'verification failure'));
  try {
    if (page) {
      await page.screenshot({path:join(evidence,'failure.png'),fullPage:true,mask:[page.getByTestId('message-list')]});
      const safePageText = await page.locator('body').evaluate(body=>{
        const copy=body.cloneNode(true);
        copy.querySelectorAll('[data-testid="message-list"],script,style').forEach(node=>node.remove());
        return copy.textContent;
      });
      writeFileSync(join(evidence,'failure-page.txt'), safePageText ?? '');
    }
  } catch {}
  console.error(error instanceof Error ? error.message : 'verification failure'); process.exitCode=1;
} finally {
  // Safe latency evidence only: never export sessions, credentials or operation content.
  let actualModels = [];
  if (existsSync(env.DATABASE_URL)) {
    const timingDb = new Sqlite(env.DATABASE_URL, { readonly: true });
    try {
      actualModels = timingDb.prepare('SELECT config_snapshot AS snapshot FROM agent_run WHERE config_snapshot IS NOT NULL ORDER BY queued_at').all().map(({snapshot}) => {const {provider,model,thinking}=JSON.parse(snapshot);return {provider,model,thinking};});
      const runs = timingDb.prepare('SELECT status, queued_at AS queuedAt, settled_at AS settledAt, (settled_at - queued_at) * 1000 AS elapsedMs FROM agent_run ORDER BY queued_at').all();
      const mutations = timingDb.prepare('SELECT action, state, (completed_at - created_at) AS elapsedMs FROM lease_mutation ORDER BY created_at').all();
      writeFileSync(join(evidence, 'timings.json'), JSON.stringify({ runs, mutations }, null, 2));
      console.log(`TIMING queuedAt-to-settledAt ${JSON.stringify(runs)}`);
    } catch { console.log('TIMING unavailable'); } finally { timingDb.close(); }
  }
  if (chatMode === 'model-fixture') {
    const pinned = modelFixture ? [modelFixture.model('operator'),modelFixture.model('nonHolder')] : [];
    if (actualModels.length === 0 || !actualModels.every(({provider,model,thinking}) => pinned.includes(`${provider}/${model}`) && thinking === 'off')) {
      console.error('FAIL actual Pi snapshots must use the pinned local fixture models with thinking off');
      process.exitCode = 1;
    }
  }
  const modelMetadata = { ...(modelFixture?.metadata() ?? {mode:chatMode,requestCount:null,completedPlans:null,unusedSteps:null}), actualModels };
  writeFileSync(join(evidence,'model-mode.json'),JSON.stringify(modelMetadata,null,2));
  console.log(`CHAT metadata ${JSON.stringify(modelMetadata)}`);
  await browser?.close();
  if(cleanupPid) {try { const group=processGroupOf(cleanupPid); if(group) process.kill(-group,'SIGTERM'); } catch {}}
  for(const child of children.reverse()) if(child.exitCode===null) child.kill('SIGTERM');
  await Promise.all(children.map(c=>Promise.race([c.done,new Promise(r=>setTimeout(r,3000))])));
  for(const child of children) if(child.exitCode===null) child.kill('SIGKILL');
  await Promise.all(children.map(c=>c.done));
  await modelFixture?.close();
  rmSync(privateDir,{recursive:true,force:true});
}
NODE
