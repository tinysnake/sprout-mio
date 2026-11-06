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
# I-P8a 集成线：挂靠 / 领取 / 撤销挂靠的真实 Agent 工具链路。
# 生产 HTTP 服务 -> 真人消息 -> 真实 Pi runner -> sprout_lease_* 工具 -> 真实 macOS Worker。
# 没有人类入口：三条命令都只由分身发起，人类只有可见性与强制收回。
# 私有 SQLite、凭据、会话与命令正文都留在 mktemp 里。
source "$(dirname "$0")/lib/ensure-worker-artifact.sh"
ensure_worker_artifact
[ -f .output/server/index.mjs ] || node scripts/verify/prepare.mjs server
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
import Sqlite from 'better-sqlite3';
import { startModelFixture, leaseTurn } from './scripts/verify/lib/model-fixture.mjs';
const chatMode = process.env.SPROUT_VERIFY_CHAT_MODE;
console.log(`CHAT mode=${chatMode} runner=scripts/pi-host-runner.mjs`);
let modelFixture;
const privateDir = mkdtempSync(join(tmpdir(), 'sprout-p8a-lease-integration-'));
const evidenceRoot = resolve('.verify/p8a-int/evidence');
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
function launch(args, name) {
  const fd = openSync(join(privateDir, `${name}.log`), 'a', 0o600);
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', fd, fd] });
  closeSync(fd); children.push(child);
  child.done = new Promise(r => child.once('exit', code => r(code))); return child;
}
const req = createRequire(import.meta.resolve('@tanstack/react-start'));
const clientReq = createRequire(req.resolve('@tanstack/start-client-core/package.json'));
const { fromCrossJSON, toJSON } = clientReq('seroval');
function walk(path) { return readdirSync(path, { withFileTypes: true }).flatMap(i => i.isDirectory() ? walk(join(path, i.name)) : i.name.endsWith('.mjs') ? [readFileSync(join(path, i.name), 'utf8')] : []); }
const ids = Object.fromEntries([...walk('.output/server').join('\n').matchAll(/id: "([0-9a-f]{64})",\s*\n\s*name: "(\w+)"/g)].map(m => [m[2], m[1]]));
let cookie, projectId, projectB, machineId, profileA, profileB, chatA, chatG, chatQ, humanId;
const passes = [];
function pass(name) { passes.push(name); writeFileSync(join(evidence, 'results.json'), JSON.stringify({ base, passes }, null, 2)); console.log(`PASS ${name}`); }
function profileModel(role) { return modelFixture ? { model: modelFixture.model(role) } : process.env.SPROUT_VERIFY_PI_MODEL ? { model: process.env.SPROUT_VERIFY_PI_MODEL } : {}; }
function armTool(role, body, name, parameters) { modelFixture?.arm(role, { expectedUserText:body, steps:[{name,arguments:parameters}], reply:'Local model fixture received the actual tool result; inspect the server facts.' }); }
const reqId = () => `req_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
const leasePrefix = (action) => `请使用 sprout_lease_${action} 工具执行以下租约请求，参数必须保持一致。先读取当前租约，若代次已变化请报告冲突，不要自动重试。只操作这台明确指定的 Machine；不要运行 shell 或修改文件。参数：`;
const leaseSuffix = '。完成后报告服务端收据。';
const leaseBody = (action, parameters, requestId) => `${leasePrefix(action)}${JSON.stringify({...parameters, requestId})}${leaseSuffix}`;
async function until(fn, label, timeout = 60000) { const start = Date.now(); while (Date.now() - start < timeout) { modelFixture?.assertHealthy(); const value = await fn(); if (value) return value; await new Promise(r => setTimeout(r, 350)); } throw new Error(`timeout: ${label}`); }
async function rpc(name, data) {
  assert(ids[name], `registered ${name}`);
  const response = await fetch(`${base}/_serverFn/${ids[name]}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-tsr-serverfn': 'true', origin: base, ...(cookie ? {cookie} : {}) }, body: JSON.stringify(toJSON({data})) });
  assert.equal(response.status, 200, name);
  const encoded = await response.json();
  const decoded = encoded.t ? fromCrossJSON(encoded, {refs:new Map()}) : encoded;
  return decoded.result ?? decoded;
}
async function call(name, data) { const result = await rpc(name, data); if (!result.ok) throw new Error(`${name}: ${result.error.code}`); return result.data; }
async function signup(name) {
  const response = await fetch(`${base}/api/auth/sign-up/email`, { method: 'POST', headers: {'content-type': 'application/json', origin: base}, body: JSON.stringify({ name, email: `${randomUUID()}@lease.test`, password: randomBytes(20).toString('hex') }) });
  assert.equal(response.status, 200);
  // Pi runner 的授权来自 Cookie 会话；用户 id 只用来把真人加进 Group。
  const db = new Sqlite(env.DATABASE_URL, { readonly: true });
  try { humanId = db.prepare('SELECT id FROM user LIMIT 1').get()?.id; } finally { db.close(); }
  assert(typeof humanId === 'string' && humanId.length > 0, 'signed-up human id');
  return response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ');
}
/** 聊天的 run 状态：只有 latest 的 inputs 能对上本次消息，所以按输入反查。 */
async function sendAndSettle(chatId, body) {
  const sent = await call('sendMessageFn', { chatId, body });
  const run = await until(async () => {
    const state = await call('getChatRunStateFn', { chatId });
    const input = state.inputs.find(i => i.messageId === sent.id);
    const latest = state.latest;
    return latest && latest.id === input?.runId && !['queued', 'running'].includes(latest.status) && latest.sessionFile ? latest : null;
  }, `run for ${body.slice(0, 40)} settles`, 180000);
  assert.equal(run.status, 'completed', `real run completed: ${run.status}`);
  const entries = readFileSync(run.sessionFile, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { run, entries };
}
function toolCall(entries, name, requestId) {
  const calls = entries.flatMap(entry => entry.message?.role === 'assistant' ? entry.message.content.filter(c => c.type === 'toolCall' && c.name === name) : []);
  if (requestId !== undefined) assert.equal(calls.filter(c => c.arguments?.requestId === requestId).length, 1, `${name} called exactly once with the requested requestId`);
  const call = requestId === undefined ? calls[0] : calls.find(c => c.arguments?.requestId === requestId);
  assert(call, `${name} was really called`);
  const result = entries.find(entry => entry.message?.role === 'toolResult' && entry.message.toolCallId === call.id)?.message;
  assert(result, `${name} has a real tool result`);
  return { call, result };
}
async function leaseAction({ role, chatId, action, parameters }) {
  const requestId = reqId();
  const body = leaseBody(action, parameters, requestId);
  await settled(chatId);
  if (modelFixture) modelFixture.arm(role, leaseTurn(action, parameters));
  const { run, entries } = await sendAndSettle(chatId, body);
  const { call, result } = toolCall(entries, `sprout_lease_${action}`, requestId);
  return { requestId, run, body, call, result };
}
/** 等一次真实工具的远端执行落地，返回带 result 的执行事实。 */
async function executionFor(requestId, label) {
  return until(async () => {
    const found = (await call('listProjectExecutionsFn', { projectId, machineId, limit: 100 })).find(e => e.requestId === requestId);
    return found?.result ? found : null;
  }, label, 180000);
}
/** 一次真实工具调用（任意远端工具）：arm → 真实发送 → 读回真实 toolResult。 */
async function toolRun({ role, chatId, tool, parameters, body }) {
  await settled(chatId);
  armTool(role, body, tool, parameters);
  const { entries } = await sendAndSettle(chatId, body);
  const { result } = toolCall(entries, tool, parameters.requestId);
  return result;
}
async function settled(chatId) {
  await until(async () => {
    const state = await call('getChatRunStateFn', { chatId });
    const run = state.latest;
    return !run || !['queued', 'running'].includes(run.status) ? (run ?? true) : null;
  }, 'previous real agent settles', 180000);
}
/** 期望被拒的一次真实工具调用：读回真实 HTTP 错误码并核对没有副作用。 */
async function deniedLease({ role, chatId, action, parameters, code }) {
  const attempt = await leaseAction({ role, chatId, action, parameters });
  assert.equal(attempt.result.details?.outcome, 'failed', `${action} must be rejected`);
  assert.equal(attempt.result.details?.error?.code, code, `real server error code for ${action}`);
  return attempt;
}
async function deniedShell({ role, chatId, generation, code, marker, label }) {
  const requestId = reqId();
  const parameters = { machineId, authorizationGeneration: generation, requestId, command: `printf blocked > '${marker}'`, waitMs: 1000 };
  const body = `Call sprout_remote_shell exactly once with these parameters, even if you expect the server to reject authorization: ${JSON.stringify(parameters)}. Do not get or acquire a lease, do not retry, do not use host tools. Report the returned error code.`;
  await settled(chatId);
  armTool(role, body, 'sprout_remote_shell', parameters);
  const { entries } = await sendAndSettle(chatId, body);
  const { result } = toolCall(entries, 'sprout_remote_shell', requestId);
  assert.equal(result.details?.error?.code, code, `real grant rejection for ${label}`);
  assert(!existsSync(marker), `${label} leaves no file`);
  assert(!(await call('listProjectExecutionsFn', { projectId, machineId, limit: 100 })).some(e => e.requestId === requestId), `${label} was not enqueued`);
  writeFileSync(join(evidence, `denied-${label}.json`), JSON.stringify({ generation, code, error: result.details.error, markerExists: existsSync(marker) }, null, 2));
}
async function allowedShell({ role, chatId, generation, holder, marker, label }) {
  const requestId = reqId();
  const parameters = { machineId, authorizationGeneration: generation, requestId, command: `printf ${label} > '${marker}'`, waitMs: 1000 };
  const body = `Use sprout_remote_shell on machineId ${machineId}, authorizationGeneration ${generation}, requestId ${requestId}. command: ${JSON.stringify(parameters.command)}. waitMs: 1000. Call sprout_remote_execution_get if necessary. Do not use the local bash tool. Do not release the lease.`;
  await settled(chatId);
  armTool(role, body, 'sprout_remote_shell', parameters);
  const { entries } = await sendAndSettle(chatId, body);
  const { result } = toolCall(entries, 'sprout_remote_shell', requestId);
  assert.equal(result.details?.error, undefined, `${label} is accepted by the real grant`);
  const execution = await until(async () => (await call('listProjectExecutionsFn', { projectId, machineId, limit: 100 })).find(e => e.requestId === requestId && e.result), `${label} execution result`, 180000);
  await until(() => existsSync(marker) || null, `${label} writes on the real Worker`, 60000);
  assert.equal(readFileSync(marker, 'utf8'), label, `${label} private sentinel matches`);
  // 记录下来的授权是领取/撤销之后的那一代与那个持有者：执行本身已被真实 Worker 跑完。
  assert.equal(execution.holderInstanceId, holder, `${label} runs under the current holder`);
  assert.equal(execution.authorizationGeneration, generation, `${label} runs on the current generation`);
  writeFileSync(join(evidence, `allowed-${label}.json`), JSON.stringify({ generation, requestId, executionId: execution.id, state: execution.state, holder, authority: execution.authority }, null, 2));
  return execution;
}
const leaseKey = () => ({ projectId, machineId });
const leaseNow = async () => (await call('getLeaseFn', leaseKey())).lease;
const escrowNow = async (escrowId) => (await call('getLeaseEscrowFn', { ...leaseKey(), escrowId })).escrow;
function snapshot(name, value) { writeFileSync(join(evidence, name), JSON.stringify(value, null, 2)); }
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
  projectId = (await call('createProjectFn', {name:'Lease escrow integration', description:'Real Machine, Group and Agent tools'})).id;
  projectB = (await call('createProjectFn', {name:'Independent Project'})).id;
  const persona = 'Use the named Sprout remote and lease tools exactly as requested. Never substitute host tools for remote tools. Report tool errors faithfully and do not retry changed generations.';
  profileA = await call('createAgentProfileFn', {name:'Lease holder', persona, ...profileModel('operator'), effort:'off'});
  profileB = await call('createAgentProfileFn', {name:'Lease claimant', persona, ...profileModel('nonHolder'), effort:'off'});
  await call('addProjectMemberFn', {projectId, agentProfileId:profileA.id});
  await call('addProjectMemberFn', {projectId, agentProfileId:profileB.id});
  await call('addProjectMemberFn', {projectId:projectB, agentProfileId:profileA.id});
  const directA = await call('createDirectChatFn', {projectId, agentProfileId:profileA.id});
  chatA = directA.chat?.id ?? directA.id;
  const directQ = await call('createDirectChatFn', {projectId:projectB, agentProfileId:profileA.id});
  chatQ = directQ.chat?.id ?? directQ.id;
  const group = await call('createGroupChatFn', {projectId, title:'挂靠目标 Group', members:[{kind:'human',id:humanId},{kind:'agent',id:profileB.id}], initialOwner:{kind:'agent',id:profileB.id}, wakePolicy:'owner_led'});
  chatG = group.chat?.id ?? group.id;
  const enrollment = await call('createMachineFn', {name:'Escrow Mac'});
  machineId = enrollment.detail.machine.id;
  await call('saveMachineRootDirectoryFn', {machineId, directory:root, expectedRevision:enrollment.detail.machine.rootRevision});
  await call('saveProjectMachineBindingFn', {machineId, projectId, description:'primary', expectedRevision:null});
  mkdirSync(join(root, projectId), { recursive:true });
  const ticketFile = join(privateDir,'ticket'); writeFileSync(ticketFile,enrollment.ticket,{mode:0o600});
  const workerArgs = [resolve('dist/worker/main.js')];
  const init = launch([...workerArgs,'init','--server',base,'--machine',machineId,'--state-dir',join(privateDir,'worker'),'--ticket-file',ticketFile,'--allow-http',base], 'worker-init');
  assert.equal(await init.done,0,'Worker init exits successfully'); unlinkSync(ticketFile);
  launch([...workerArgs,'run','--state-dir',join(privateDir,'worker')], 'worker');
  await until(async () => (await call('getMachineFn',{machineId})).connection.kind==='online','Worker online');
  await until(async () => (await call('getMachineFn',{machineId,projectId})).bindings[0]?.observation?.fact?.result?.kind==='accessible','directory ready');

  // 1) 分身 A 在自己 DM 里用真实工具取得租约。
  const acquired = await leaseAction({ role:'operator', chatId:chatA, action:'acquire', parameters:{machineId, expectedGeneration:0} });
  assert.equal(acquired.result.details?.outcome, 'succeeded', 'acquire tool result');
  const held1 = await leaseNow();
  const instanceA = acquired.run.instanceId;
  assert.equal(held1.state, 'held'); assert.equal(held1.generation, 1); assert.equal(held1.holderInstanceId, instanceA); assert.equal(held1.escrow, null);
  snapshot('lease-1-held.json', { generation: held1.generation, holderInstanceId: held1.holderInstanceId });
  pass('agent tool sprout_lease_acquire through a real Agent run holds the lease');


  // 1b) 进程延续的前提：持有者通过真实工具启动一个长进程，记录 pid。
  const pidRequestId = reqId();
  const longCommand = 'sleep 900';
  const startBody = `Use sprout_remote_shell on machineId ${machineId}, authorizationGeneration ${held1.generation}, requestId ${pidRequestId}. command: ${JSON.stringify(longCommand)}. waitMs: 1000. Call sprout_remote_execution_get if necessary. Do not use the local bash tool. Do not release the lease.`;
  const startResult = await toolRun({ role:'operator', chatId:chatA, tool:'sprout_remote_shell', parameters:{machineId, authorizationGeneration:held1.generation, requestId:pidRequestId, command:longCommand, waitMs:1000}, body:startBody });
  assert.equal(startResult.details?.error, undefined, 'the holder starts a long process through the real tool');
  const longExecution = await until(async () => (await call('listProjectExecutionsFn', { projectId, machineId, limit:100 })).find(e => e.requestId === pidRequestId && e.result?.kind === 'shell' && e.result.pid), 'long process pid', 180000);
  const longPid = longExecution.result.pid;
  process.kill(longPid, 0);
  pass('the holder leaves a real long-running process on the Machine before any escrow');

  // 2) 目标范围：DM 与跨 Project 都必须被拒，且租约事实不变。
  await deniedLease({ role:'operator', chatId:chatA, action:'escrow', parameters:{machineId, expectedGeneration:1, chatId:chatA}, code:'lease_escrow_dm_unsupported' });
  await deniedLease({ role:'operator', chatId:chatA, action:'escrow', parameters:{machineId, expectedGeneration:1, chatId:chatQ}, code:'lease_escrow_cross_project' });
  const afterRefusals = await leaseNow();
  assert.deepEqual({ generation: afterRefusals.generation, state: afterRefusals.state, escrow: afterRefusals.escrow }, { generation: 1, state: 'held', escrow: null }, 'refused escrows leave the lease untouched');
  snapshot('lease-2-refused-escrow.json', { generation: afterRefusals.generation, errors:['lease_escrow_dm_unsupported','lease_escrow_cross_project'] });
  pass('sprout_lease_escrow refuses DM and cross-Project targets through the real gateway');

  // 3) 挂到 Group：代次 +1，Machine 仍占用，持有者不变，操作权转 escrowed。
  const escrowAttempt = await leaseAction({ role:'operator', chatId:chatA, action:'escrow', parameters:{machineId, expectedGeneration:1, chatId:chatG} });
  assert.equal(escrowAttempt.result.details?.outcome, 'succeeded', 'escrow tool result');
  const escrowData = escrowAttempt.result.details.data;
  const escrowed = await leaseNow();
  const escrowId = escrowData.escrow.escrowId;
  assert.equal(escrowData.lease.generation, 2); assert.equal(escrowData.escrow.state, 'escrowed');
  assert.equal(escrowed.generation, 2); assert.equal(escrowed.state, 'held'); assert.equal(escrowed.holderInstanceId, instanceA, 'escrow does not move the holder');
  assert.equal(escrowed.escrow.escrowId, escrowId); assert.equal(escrowed.escrow.chatId, chatG); assert.equal(escrowed.escrow.escrowGeneration, 2);
  const escrowRow = await escrowNow(escrowId);
  assert.equal(escrowRow.state, 'escrowed'); assert.equal(escrowRow.claimedByInstanceId, null);
  process.kill(longPid, 0);
  snapshot('lease-3-escrowed.json', { generation: escrowed.generation, holderInstanceId: escrowed.holderInstanceId, escrow: escrowRow });
  pass('escrow to the target Group keeps the Machine occupied, bumps generation and hands over operation authority');

  // 4) 旧凭据被拒：同一个真实 run 链路，只是换了当前代次。
  await deniedShell({ role:'operator', chatId:chatA, generation:2, code:'lease_not_holder', marker:join(root, projectId, 'escrowed-holder-must-not-exist'), label:'escrowed-holder' });
  const stillEscrowed = await leaseNow();
  assert.equal(stillEscrowed.generation, 2); assert.equal(stillEscrowed.escrow?.state, 'escrowed');
  pass('the escrowing holder is rejected as an operator with a real lease_not_holder response and no side effects');

  // 5) 领取：A 不在目标 Group 内，B 才是合法领取者。
  await deniedLease({ role:'operator', chatId:chatA, action:'claim', parameters:{machineId, expectedGeneration:2, escrowId}, code:'lease_claim_out_of_scope' });
  const claimAttempt = await leaseAction({ role:'nonHolder', chatId:chatG, action:'claim', parameters:{machineId, expectedGeneration:2, escrowId} });
  assert.equal(claimAttempt.result.details?.outcome, 'succeeded', 'claim tool result');
  const claimed = await leaseNow();
  const instanceB = claimAttempt.run.instanceId;
  assert.equal(claimed.generation, 3, 'claim bumps the generation');
  assert.equal(claimed.holderInstanceId, instanceB, 'claim moves the holder to the Group member instance');
  assert.notEqual(instanceB, instanceA);
  assert.equal(claimed.escrow, null, 'a claimed escrow is no longer live');
  const claimedRow = await escrowNow(escrowId);
  assert.equal(claimedRow.state, 'claimed'); assert.equal(claimedRow.claimedByInstanceId, instanceB); assert.equal(claimedRow.claimedGeneration, 3);
  assert.equal(claimAttempt.result.details.data.lease.holderInstanceId, instanceB);
  snapshot('lease-4-claimed.json', { generation: claimed.generation, holderInstanceId: instanceB, escrow: claimedRow });
  pass('a Group member instance claims the escrow; generation +1 and the holder changes');

  await deniedLease({ role:'nonHolder', chatId:chatG, action:'claim', parameters:{machineId, expectedGeneration:3, escrowId}, code:'lease_not_escrowed' });
  pass('claiming an already claimed escrow is rejected with lease_not_escrowed');

  // 6) 新旧持有者：旧持有者不能发起远端操作，新持有者可以。
  await deniedShell({ role:'operator', chatId:chatA, generation:3, code:'lease_not_holder', marker:join(root, projectId, 'deposed-holder-must-not-exist'), label:'deposed-holder' });
  const markerB = join(root, projectId, 'claimant-proof.txt');
  await allowedShell({ role:'nonHolder', chatId:chatG, generation:3, holder:instanceB, marker:markerB, label:'claimant-proof' });
  snapshot('lease-5-authority-switched.json', { generation: claimed.generation, deposed: instanceA, holder: instanceB });
  pass('the new holder runs a real remote operation while the deposed holder stays rejected');


  // 6b) 领取者可以查看并控制原持有者启动的进程；旧持有者已被真实拒绝。
  const listRequestId = reqId();
  const listBody = `Use sprout_remote_process_list on machineId ${machineId}, authorizationGeneration ${claimed.generation}, requestId ${listRequestId}, limit 200. Report the returned items. Do not use the local bash tool. Do not release the lease.`;
  const listResult = await toolRun({ role:'nonHolder', chatId:chatG, tool:'sprout_remote_process_list', parameters:{machineId, authorizationGeneration:claimed.generation, requestId:listRequestId, limit:200}, body:listBody });
  assert.equal(listResult.details?.error, undefined, 'the claimant lists processes through the real tool');
  const listExecution = await executionFor(listRequestId, 'claimant process list result');
  assert.equal(listExecution.operation.kind, 'process_list');
  const listed = listExecution.result.items;
  // process_list 只回前 200 条（worker 用 ps -axo，按 pid 升序）：繁忙主机上 pid 可能被截掉，
  // 所以「看得见」用 shell 精确复核，列表只记录条数与截断事实。
  const listNote = { count: listed.length, truncated: listExecution.result.truncated, containsPid: listed.some(item => item.pid === longPid) };
  const viewRequestId = reqId();
  const viewCommand = `ps -p ${longPid} -o pid=,comm=`;
  const viewBody = `Use sprout_remote_shell on machineId ${machineId}, authorizationGeneration ${claimed.generation}, requestId ${viewRequestId}. command: ${JSON.stringify(viewCommand)}. waitMs: 2000. Do not use the local bash tool. Do not release the lease.`;
  const viewResult = await toolRun({ role:'nonHolder', chatId:chatG, tool:'sprout_remote_shell', parameters:{machineId, authorizationGeneration:claimed.generation, requestId:viewRequestId, command:viewCommand, waitMs:2000}, body:viewBody });
  assert.equal(viewResult.details?.error, undefined, 'the claimant inspects the inherited process');
  const viewExecution = await executionFor(viewRequestId, 'claimant process view result');
  assert(viewExecution.result.stdout.includes(String(longPid)), `the claimant sees pid ${longPid} through a real shell`);
  const signalRequestId = reqId();
  const signalBody = `Use sprout_remote_process_signal on machineId ${machineId}, authorizationGeneration ${claimed.generation}, requestId ${signalRequestId}, pid ${longPid}, signal "TERM". Report the returned result. Do not use the local bash tool. Do not release the lease.`;
  const signalResult = await toolRun({ role:'nonHolder', chatId:chatG, tool:'sprout_remote_process_signal', parameters:{machineId, authorizationGeneration:claimed.generation, requestId:signalRequestId, pid:longPid, signal:'TERM'}, body:signalBody });
  assert.equal(signalResult.details?.error, undefined, 'the claimant signals the inherited process');
  const signalExecution = await executionFor(signalRequestId, 'claimant process signal result');
  assert.equal(signalExecution.result.kind, 'process_signal'); assert.equal(signalExecution.result.pid, longPid); assert.equal(signalExecution.result.delivered, true);
  await until(() => { try { process.kill(longPid, 0); return null; } catch { return true; } }, 'the inherited process stops', 60000);
  snapshot('lease-7-process-continuity.json', { pid: longPid, list: listNote, viewed: true, signalled: true });
  pass('the claimant views and signals the process the previous holder started');

  // 7) 失去持有者身份后不能再挂靠。
  await deniedLease({ role:'operator', chatId:chatA, action:'escrow', parameters:{machineId, expectedGeneration:3, chatId:chatG}, code:'lease_not_holder' });
  pass('a non-holder cannot escrow the lease');

  // 8) 撤销挂靠：只有发起者能撤销，操作权回到发起者，Machine 不释放。
  const secondEscrow = await leaseAction({ role:'nonHolder', chatId:chatG, action:'escrow', parameters:{machineId, expectedGeneration:3, chatId:chatG} });
  assert.equal(secondEscrow.result.details?.outcome, 'succeeded', 'second escrow tool result');
  const escrow2 = secondEscrow.result.details.data.escrow.escrowId;
  assert.equal((await leaseNow()).generation, 4);
  await deniedLease({ role:'operator', chatId:chatA, action:'escrow_cancel', parameters:{machineId, expectedGeneration:4, escrowId:escrow2}, code:'lease_not_holder' });
  const cancelled = await leaseAction({ role:'nonHolder', chatId:chatG, action:'escrow_cancel', parameters:{machineId, expectedGeneration:4, escrowId:escrow2} });
  assert.equal(cancelled.result.details?.outcome, 'succeeded', 'cancel tool result');
  const afterCancel = await leaseNow();
  assert.equal(afterCancel.generation, 5); assert.equal(afterCancel.state, 'held'); assert.equal(afterCancel.holderInstanceId, instanceB, 'authority returns to the escrowing instance'); assert.equal(afterCancel.escrow, null);
  const cancelledRow = await escrowNow(escrow2);
  assert.equal(cancelledRow.state, 'cancelled'); assert.equal(cancelledRow.escrowedByInstanceId, instanceB);
  const markerCancel = join(root, projectId, 'cancel-returned-proof.txt');
  await allowedShell({ role:'nonHolder', chatId:chatG, generation:5, holder:instanceB, marker:markerCancel, label:'cancel-returned-proof' });
  assert.equal((await leaseNow()).generation, 5);
  snapshot('lease-6-cancelled.json', { generation: afterCancel.generation, holderInstanceId: afterCancel.holderInstanceId, escrow: cancelledRow });
  pass('only the escrower can cancel; authority returns to it with generation +1 and the Machine stays occupied');

  // 9) 数据库侧事实：代次授权链与挂靠行状态。
  const factsDb = new Sqlite(env.DATABASE_URL, { readonly: true });
  try {
    const authorizations = factsDb.prepare('SELECT generation, state, reason FROM lease_authorization WHERE project_id=? AND machine_id=? ORDER BY generation').all(projectId, machineId);
    const escrows = factsDb.prepare('SELECT state, escrow_generation, claimed_generation FROM lease_escrow WHERE project_id=? AND machine_id=? ORDER BY escrowed_at').all(projectId, machineId);
    const lease = factsDb.prepare('SELECT state, generation, holder_instance_id AS holder FROM machine_lease WHERE project_id=? AND machine_id=?').get(projectId, machineId);
    assert.deepEqual(authorizations.map(r => [r.generation, r.state, r.reason]), [
      [0, 'revoked', 'initial'],
      [1, 'revoked', 'acquire'],
      [2, 'revoked', 'escrow'],
      [3, 'revoked', 'claim'],
      [4, 'revoked', 'escrow'],
      [5, 'active', 'escrow_cancel'],
    ]);
    assert.deepEqual(escrows.map(r => [r.state, r.escrow_generation, r.claimed_generation]), [['claimed', 2, 3], ['cancelled', 4, null]]);
    assert.equal(lease.state, 'held'); assert.equal(lease.generation, 5); assert.equal(lease.holder, instanceB);
    writeFileSync(join(evidence, 'database-facts.json'), JSON.stringify({ authorizations, escrows, lease }, null, 2));
  } finally { factsDb.close(); }
  pass('database authorization chain records escrowed, claimed and cancelled generations in order');

  modelFixture?.assertDrained();
  assert.equal(passes.length, 12, 'all escrow integration conditions passed');
  console.log(`Evidence: ${evidence}`);
} catch(error) {
  writeFileSync(join(evidence,'failure.txt'), String(error instanceof Error ? error.message : 'verification failure'));
  console.error(error instanceof Error ? error.message : 'verification failure'); process.exitCode=1;
} finally {
  let actualModels = [];
  if (existsSync(env.DATABASE_URL)) {
    const timingDb = new Sqlite(env.DATABASE_URL, { readonly: true });
    try {
      actualModels = timingDb.prepare('SELECT config_snapshot AS snapshot FROM agent_run WHERE config_snapshot IS NOT NULL ORDER BY queued_at').all().map(({snapshot}) => {const {provider,model,thinking}=JSON.parse(snapshot);return {provider,model,thinking};});
      const runs = timingDb.prepare('SELECT status, queued_at AS queuedAt, settled_at AS settledAt, (settled_at - queued_at) * 1000 AS elapsedMs FROM agent_run ORDER BY queued_at').all();
      const escrows = timingDb.prepare('SELECT state, escrow_generation AS escrowGeneration, claimed_generation AS claimedGeneration, (claimed_at - escrowed_at) AS claimElapsedMs FROM lease_escrow ORDER BY escrowed_at').all();
      writeFileSync(join(evidence, 'timings.json'), JSON.stringify({ runs, escrows }, null, 2));
    } catch (error) { console.log(`TIMING unavailable: ${error instanceof Error ? error.message : error}`); } finally { timingDb.close(); }
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
  for(const child of children.reverse()) if(child.exitCode===null) child.kill('SIGTERM');
  await Promise.all(children.map(c=>Promise.race([c.done,new Promise(r=>setTimeout(r,3000))])));
  for(const child of children) if(child.exitCode===null) child.kill('SIGKILL');
  await Promise.all(children.map(c=>c.done));
  await modelFixture?.close();
  rmSync(privateDir,{recursive:true,force:true});
}
NODE
