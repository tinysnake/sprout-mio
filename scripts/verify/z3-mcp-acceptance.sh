#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .verify
run_dir="$(mktemp -d "$PWD/.verify/z3-mcp-acceptance-XXXXXX")"
export Z3_DIR="$run_dir"
export NO_PROXY="localhost,127.0.0.1,::1"
export no_proxy="$NO_PROXY"
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy || true

# Generated probes stay private. Published evidence contains assertions and counts only.
cat > "$run_dir/root-server.mjs" <<'SERVER'
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
const root = resolve(process.argv[2]);
let subscribed = false;
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...value})+'\n');
const tools = ['read','write','notify','never_reply'].map(name => ({name, inputSchema:{type:'object',properties:{path:{type:'string'},text:{type:'string'}}}}));
createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  let result;
  try {
    switch (m.method) {
      case 'initialize': result = {protocolVersion:m.params.protocolVersion, capabilities:{tools:{listChanged:true},resources:{subscribe:true}},serverInfo:{name:'z3-root',version:'1'}}; break;
      case 'ping': result = {}; break;
      case 'tools/list': result = {tools}; break;
      case 'resources/list': result = {resources:[{uri:'z3://root/value',name:'value',mimeType:'text/plain'}]}; break;
      case 'resources/read': result = {contents:[{uri:'z3://root/value',text:readFileSync(resolve(root,'value.txt'),'utf8')}]}; break;
      case 'resources/subscribe': subscribed = true; result = {}; break;
      case 'resources/unsubscribe': subscribed = false; result = {}; break;
      case 'tools/call': {
        const {name,arguments:a={}} = m.params;
        if (name === 'never_reply') { writeFileSync(resolve(root,'request-observed'),'1'); return; }
        if (name === 'notify') {
          if (subscribed) send({method:'notifications/resources/updated',params:{uri:'z3://root/value'}});
          result = {content:[{type:'text',text:'notified'}]}; break;
        }
        const path = resolve(root,a.path);
        if (!path.startsWith(root+sep)) throw new Error('outside_root');
        if (name === 'write') writeFileSync(path,a.text);
        else if (name !== 'read') throw new Error('unknown_tool');
        result = {content:[{type:'text',text:name === 'read' ? readFileSync(path,'utf8') : 'written'}]}; break;
      }
      default: send({id:m.id,error:{code:-32601,message:'method_not_found'}}); return;
    }
    send({id:m.id,result});
  } catch { send({id:m.id,error:{code:-32602,message:'rejected'}}); }
});
SERVER

cat > "$run_dir/c-live.mts" <<'PROBE'
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ID_PREFIXES, newId } from '../../src/contracts/ids.ts';
import { migrateDatabase } from '../../src/db/migrate.ts';
import { sqlite } from '../../src/db/index.ts';
import { createMachine, saveProjectMachineBinding } from '../../src/domain/machine.ts';
import { acquireLease, releaseLease } from '../../src/server/lease.ts';
import { enrollWorker, openWorker, exchangeWorker } from '../../src/server/worker-gateway.ts';
import { mcpCatalogGet, mcpSessionOpen, mcpSessionExchange, mcpSessionClose } from '../../src/server/mcp-relay.ts';
import { McpRuntime } from '../../src/worker/mcp.ts';
import { RemoteDispatcher } from '../../src/worker/remote.ts';
import { loadPiMcp } from '../../src/extension/mcp-load.ts';
import { connectSproutMcp } from '../../src/extension/mcp-client.ts';
import { registerMcpTools } from '../../src/extension/mcp-tools.ts';
import { seedRemoteActor } from '../../tests/fixtures/remote-actors.ts';
import { registration, waitFor } from '../../tests/fixtures/mcp-runtime.ts';
import { startHttpMcpServer } from '../../tests/fixtures/mcp-http-server.ts';

const dir = process.env.Z3_DIR!;
const evidence: Record<string,unknown> = {};
const save = () => writeFileSync(join(dir,'c-evidence.json'),JSON.stringify(evidence,null,2)+'\n');
const checked = async (name:string, action:()=>Promise<unknown>) => {
  try { evidence[name] = {status:'PASS', ...(await action() as object)}; }
  catch (error) { evidence[name] = {status:'FAIL',errorType:(error as Error).name,failureSite:(error as Error).stack?.split('\n').find(line=>line.includes('c-live.mts'))}; }
  save();
};
migrateDatabase();
const insert = (sql:string,...args:unknown[]) => sqlite.prepare(sql).run(...args);
const bootId = newId(ID_PREFIXES.boot);
insert("INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'z3')",bootId);
insert("INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','z3@example.test',0,1,1)");
const projectId = newId(ID_PREFIXES.project);
insert("INSERT INTO project(id,name,created_by) VALUES (?,'Z3','owner')",projectId);
const ctx = seedRemoteActor(sqlite,'owner',projectId,bootId);
const machine = createMachine({name:'Z3 roots'},ctx);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding({projectId,machineId,description:'Z3',expectedRevision:null},ctx);
acquireLease({projectId,machineId,action:'acquire',requestId:newId(ID_PREFIXES.request),expectedGeneration:0},ctx);
const wire = {machineId,secret:'z'.repeat(43),version:3 as const,requestId:newId(ID_PREFIXES.request)};
enrollWorker({...wire,ticket:machine.ticket},ctx);
const worker = openWorker({...wire,attemptId:randomUUID()},ctx).session;
const capability = {platform:'darwin' as const,arch:'arm64' as const,workerVersion:'z3-source',shells:[],remoteOperations:[],mcpRelay:{version:1 as const,transports:['stdio' as const],maxMessageBytes:131072 as const}};
const roots = ['a','b'].map(name => join(dir,'root-'+name));
for (const [i,root] of roots.entries()) { mkdirSync(root); writeFileSync(join(root,'value.txt'),'root-'+i); }
const configured = roots.map((root,i) => ({...registration({transport:'stdio',command:process.execPath,args:[join(dir,'root-server.mjs'),root],workingDirectory:dir,launch:'configured_service',autostart:true,exposure:'wire',roots:[{uri:pathToFileURL(root).href}],exposeSampling:false,elicitation:'absent',requestTimeoutMs:1500},machineId,projectId),name:'root-'+i}));
configured.push({...registration({transport:'stdio',command:'npx',args:['--offline','-y','@modelcontextprotocol/server-everything@2.0.1'],workingDirectory:dir,launch:'configured_service',autostart:true,exposure:'wire',roots:[],exposeSampling:false,elicitation:'absent',requestTimeoutMs:20000},machineId,projectId),name:'everything'});
const runtime = new McpRuntime(configured);
const connections:any[] = [];
let timer:NodeJS.Timeout|undefined;
let piSession:any;
try {
  await runtime.start();
  const dispatcher = new RemoteDispatcher(worker,capability,Date.now,runtime);
  let seq = 0;
  let tickError:unknown;
  const tick = () => {
    ctx.now = new Date();
    const response = exchangeWorker({...wire,session:worker,seq:seq+1,mode:'normal',capability,observations:[],remote:dispatcher.outgoing()},ctx);
    seq = response.seq;
    dispatcher.accept(response,seq,[]);
  };
  tick();
  timer = setInterval(()=>{try {tick();} catch(e) {tickError=e;}},10);
  const remote:any = {projectId,async request(request:any) {
    // Yield like the real HTTP boundary, including terminal sessions with no hold.
    await new Promise(resolve=>setImmediate(resolve));
    ctx.now = new Date();
    try {
      const handlers:any = {mcp_catalog_get:mcpCatalogGet,mcp_session_open:mcpSessionOpen,mcp_session_exchange:mcpSessionExchange,mcp_session_close:mcpSessionClose};
      const data = await handlers[request.call.type](request.call.input,ctx);
      return {outcome:'response',result:{ok:true,data,requestId:ctx.requestId}};
    } catch(e) {return {outcome:'response',result:{ok:false,error:{code:(e as any).code ?? 'internal',message:'rejected',requestId:ctx.requestId}}};}
  }};
  const pi = await loadPiMcp();
  await checked('officialSdk',async()=>{
    const entry=readdirSync('node_modules/.pnpm').find(name=>name.startsWith('@modelcontextprotocol+sdk@1.32.1'));
    assert(entry,'locked SDK 1.32.1 available offline');
    const sdkRoot=join(process.cwd(),'node_modules/.pnpm',entry!,'node_modules/@modelcontextprotocol/sdk');
    const {Client}=await import(pathToFileURL(join(sdkRoot,'dist/esm/client/index.js')).href);
    const {StdioClientTransport}=await import(pathToFileURL(join(sdkRoot,'dist/esm/client/stdio.js')).href);
    const {StreamableHTTPClientTransport}=await import(pathToFileURL(join(sdkRoot,'dist/esm/client/streamableHttp.js')).href);
    const stdio=new Client({name:'z3-sdk-reference',version:'1'});
    const http=new Client({name:'z3-sdk-reference',version:'1'});
    const server=await startHttpMcpServer();
    const httpTransport=new StreamableHTTPClientTransport(new URL(server.url));
    try {
      await stdio.connect(new StdioClientTransport({command:process.execPath,args:[join(dir,'root-server.mjs'),roots[0]!],stderr:'ignore'}));
      const stdioTools=await stdio.listTools(); assert(stdioTools.tools.some((tool:any)=>tool.name==='read'));
      await http.connect(httpTransport);
      const httpTools=await http.listTools(); assert(httpTools.tools.some((tool:any)=>tool.name==='wire_echo'));
      await httpTransport.terminateSession();
      return {version:'1.32.1',stdioConnected:true,stdioToolCount:stdioTools.tools.length,streamableHttpConnected:true,httpToolCount:httpTools.tools.length,referenceOnly:true};
    } finally {await stdio.close();await http.close();await server.close();}
  });
  const catalog = () => mcpCatalogGet({projectId,machineId,authorizationGeneration:1},ctx);
  const connect = async (name:string) => {
    ctx.now = new Date();
    const reg = catalog().registrations.find(r=>r.name===name)!;
    assert(reg?.processes.length===1,'one target per registration');
    const conn = await connectSproutMcp(pi,remote,{registration:reg,process:reg.processes[0]!,authorizationGeneration:1,holdMs:20});
    connections.push(conn); return conn;
  };
  const a = await connect('root-0'), b = await connect('root-1'), everything = await connect('everything');
  const facts = sqlite.prepare("SELECT id,pid FROM mcp_server_process WHERE state='running' ORDER BY registration_id").all() as {id:string,pid:number}[];
  const alive = (pid:number) => {try {process.kill(pid,0); return true;} catch {return false;}};
  const processA = sqlite.prepare('SELECT id,pid FROM mcp_server_process WHERE registration_id=?').get(configured[0]!.id) as {id:string,pid:number};
  const processB = sqlite.prepare('SELECT id,pid FROM mcp_server_process WHERE registration_id=?').get(configured[1]!.id) as {id:string,pid:number};
  await checked('isolation',async()=>{
    assert.equal((await a.client.callTool('read',{path:'value.txt'})).content![0]!.text,'root-0');
    assert.equal((await b.client.callTool('read',{path:'value.txt'})).content![0]!.text,'root-1');
    await a.client.callTool('write',{path:'written.txt',text:'A'});
    await b.client.callTool('write',{path:'written.txt',text:'B'});
    assert.equal(readFileSync(join(roots[0]!,'written.txt'),'utf8'),'A');
    assert.equal(readFileSync(join(roots[1]!,'written.txt'),'utf8'),'B');
    await assert.rejects(a.client.callTool('read',{path:join(roots[1]!,'value.txt')}));
    await assert.rejects(b.client.callTool('write',{path:join(roots[0]!,'forbidden.txt'),text:'bad'}));
    assert(!existsSync(join(roots[0]!,'forbidden.txt')));
    assert.notEqual(a.transport.sessionId,b.transport.sessionId);
    assert.notEqual(processA.id,processB.id);
    return {simultaneousSessions:2,distinctProcesses:true,ownReads:true,ownWrites:true,crossRootReadRejected:true,crossRootWriteRejected:true};
  });
  await checked('resources',async()=>{
    const client:any = b.client;
    const resources = await client.listResources();
    assert.equal(resources.length,1);
    assert.equal((await client.readResource(resources[0].uri)).contents[0].text,'root-1');
    let updates=0;
    const off=client.onNotification('notifications/resources/updated',()=>{updates++;});
    await client.request('resources/subscribe',{uri:resources[0].uri});
    await client.callTool('notify',{});
    await waitFor(()=>updates===1,5000);
    await client.request('resources/unsubscribe',{uri:resources[0].uri}); off();
    return {listed:1,readMatches:true,subscriptionUpdates:updates,unsubscribed:true};
  });
  const registered=new Map<string,any>();
  const allowed=['read','write','never_reply'];
  registerMcpTools({registerTool:(tool:any)=>registered.set(tool.name,tool)} as any,pi,{...b,registration:{...b.registration,toolAllowlist:allowed}});
  registerMcpTools({registerTool:(tool:any)=>registered.set(tool.name,tool)} as any,pi,{...everything,registration:{...everything.registration,toolAllowlist:['get-tiny-image','get-structured-content']}});
  const sdk:any = await import(pathToFileURL(join(pi.root,'..','pi-coding-agent','dist/index.js')).href);
  const work=join(dir,'pi-cwd'), agentDir=join(work,'agent'); mkdirSync(agentDir,{recursive:true});
  // Isolated host config sentinel: startup would leave a marker if Pi scanned this file.
  const marker=join(dir,'host-server-started');
  writeFileSync(join(agentDir,'mcp.json'),JSON.stringify({mcpServers:{host_sentinel:{command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'1')`]}}}));
  const settings=sdk.SettingsManager.inMemory({});
  const loader=new sdk.DefaultResourceLoader({cwd:work,agentDir,settingsManager:settings,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true,noContextFiles:true,extensionFactories:[{name:'z3-relay',factory:(api:any)=>{for(const tool of registered.values()) api.registerTool(tool);}}]});
  await loader.reload(); assert.equal(loader.getExtensions().errors.length,0);
  const session=await sdk.createAgentSession({cwd:work,agentDir,resourceLoader:loader,settingsManager:settings,sessionManager:sdk.SessionManager.inMemory(),tools:['read','mcp__*']});
  piSession=session.session;
  const execute=(name:string,args:unknown)=>piSession.getToolDefinition(name).execute('z3',args,undefined,undefined,{});
  await checked('surface',async()=>{
    const active=piSession.getActiveToolNames().filter((name:string)=>name.startsWith('mcp__')).sort();
    const expected=[...registered.keys()].sort(); assert.deepEqual(active,expected);
    assert(active.includes('mcp__root-1__read'));
    assert(!active.some((name:string)=>name.includes('notify')||name.includes('host_sentinel')));
    assert(!existsSync(marker));
    const result=await execute('mcp__root-1__read',{path:'value.txt'}); assert.equal(result.details.outcome,'succeeded');
    assert(!catalog().registrations.some(r=>r.name==='host_sentinel'));
    return {activeMcpTools:active,allowlistExcludedNotify:true,allowedToolExecuted:true,hostConfigSentinelPresent:true,hostServerAbsent:true,hostServerNotStarted:true};
  });
  await checked('image',async()=>{
    const image=await execute('mcp__everything__get-tiny-image',{});
    const direct=await everything.client.callTool('get-tiny-image',{});
    const block=image.content.find((x:any)=>x.type==='image');
    const original=direct.content!.find((x:any)=>x.type==='image')!;
    assert(block); assert.equal(block.data,original.data); assert.equal(block.mimeType,original.mimeType);
    assert.equal(image.details.outcome,'succeeded');
    const structured=await execute('mcp__everything__get-structured-content',{location:'Chicago'});
    const raw=await everything.client.callTool('get-structured-content',{location:'Chicago'});
    assert(raw.structuredContent!==undefined); assert.deepEqual(structured.details.structuredContent,raw.structuredContent);
    assert.equal(structured.details.outcome,'succeeded');
    return {blockType:block.type,mimeType:block.mimeType,base64Length:block.data.length,bytesEqual:true,structuredContentEqual:true,throughSproutRelay:true,throughRealPiToolDefinition:true};
  });
  await checked('timeout',async()=>{
    const result=await execute('mcp__root-1__never_reply',{});
    assert(existsSync(join(roots[1]!,'request-observed')));
    assert.equal(result.details.outcome,'unknown');
    return {requestReachedServer:true,outcome:result.details.outcome};
  });
  await checked('disappearance',async()=>{
    const before=sqlite.prepare('SELECT id,process_id FROM mcp_session ORDER BY id').all();
    process.kill(processA.pid,'SIGTERM');
    await waitFor(()=>!alive(processA.pid),5000);
    await waitFor(()=> (sqlite.prepare('SELECT state FROM mcp_server_process WHERE id=?').get(processA.id) as any)?.state!=='running',5000);
    await assert.rejects(a.client.callTool('write',{path:'after-death.txt',text:'must-not-land'}));
    const after=sqlite.prepare('SELECT id,process_id FROM mcp_session ORDER BY id').all();
    assert.deepEqual(after,before); assert(alive(processB.pid));
    assert(!existsSync(join(roots[1]!,'after-death.txt')));
    assert.equal((await b.client.callTool('read',{path:'value.txt'})).content![0]!.text,'root-1');
    return {targetExited:true,callRejected:true,sessionCountBefore:before.length,sessionCountAfter:after.length,sessionTargetsUnchanged:true,survivorAlive:true,noWriteOnSurvivor:true};
  });
  await checked('detach',async()=>{
    const oldId=b.transport.sessionId;
    piSession.dispose(); piSession=null;
    await b.close();
    await waitFor(()=> (sqlite.prepare('SELECT state FROM mcp_session WHERE id=?').get(oldId) as any)?.state==='closed',5000);
    assert(alive(processB.pid));
    const reopened=await connect('root-1');
    assert.notEqual(reopened.transport.sessionId,oldId);
    const oldTarget=sqlite.prepare('SELECT process_id FROM mcp_session WHERE id=?').get(oldId) as any;
    const newTarget=sqlite.prepare('SELECT process_id FROM mcp_session WHERE id=?').get(reopened.transport.sessionId) as any;
    assert.equal(newTarget.process_id,oldTarget.process_id); assert.equal(newTarget.process_id,processB.id);
    assert.equal((await reopened.client.callTool('read',{path:'value.txt'})).content![0]!.text,'root-1');
    return {piSessionDisposed:true,piClientClosedSession:true,serverStillAlive:true,reopenedNewSession:true,sameProcess:true};
  });
  await checked('release',async()=>{
    ctx.now=new Date();
    const released=releaseLease({projectId,machineId,action:'release',requestId:newId(ID_PREFIXES.request),expectedGeneration:1},ctx);
    await waitFor(()=> {tick(); return (sqlite.prepare('SELECT state FROM machine_lease WHERE project_id=? AND machine_id=?').get(projectId,machineId) as any).state==='free';},5000);
    const row=sqlite.prepare('SELECT generation,state FROM machine_lease WHERE project_id=? AND machine_id=?').get(projectId,machineId) as any;
    assert.equal(row.state,'free'); assert(row.generation>1);
    assert(alive(processB.pid));
    const running=facts.filter(f=>f.id!==processA.id); assert(running.every(f=>alive(f.pid)));
    let code:string|undefined;
    const framesBefore=sqlite.prepare('SELECT count(*) AS n FROM mcp_frame').get() as any;
    try {ctx.now=new Date(); await mcpSessionExchange({projectId,machineId,authorizationGeneration:1,sessionId:connections.at(-1).transport.sessionId,frames:[],ackServerSeq:0,cancelClientSeqs:[],protocolVersion:null,confirmInitialized:false,holdMs:0},ctx);} catch(e) {code=(e as any).code;}
    assert.equal(code,'lease_stale_generation');
    assert.deepEqual(sqlite.prepare('SELECT count(*) AS n FROM mcp_frame').get(),framesBefore);
    return {leaseState:row.state,generationAdvanced:true,remainingServerProcessesAlive:running.length,oldGenerationRejected:code};
  });
  assert(!tickError,'worker exchange pump must remain healthy');
  dispatcher.disconnect();
} catch(error) {
  evidence.setup={status:'FAIL',errorType:(error as Error).name,failureSite:(error as Error).stack?.split('\n').find(line=>line.includes('c-live.mts'))}; save(); process.exitCode=1;
} finally {
  piSession?.dispose();
  for(const connection of connections) await connection.close().catch(()=>{});
  if(timer) clearInterval(timer);
  await runtime.stop(); sqlite.close(); save();
}
// Pi SDK loaders retain handles after dispose; all owned servers and DB are closed above.
process.exit(process.exitCode ?? 0);
PROBE

cat > "$run_dir/run.mjs" <<'RUNNER'
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
const dir=process.env.Z3_DIR;
const executions={};
const sources={};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
async function run(name,command,args,env={},prefix) {
  const before=new Set(readdirSync('.verify'));
  const startedAt=new Date().toISOString();
  const start=performance.now();
  const child=spawn(command,args,{env:{...process.env,...env},stdio:'ignore',detached:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true; try{process.kill(-child.pid,'SIGKILL');}catch{}},300000);
  const result=await new Promise(resolve=>{child.on('error',()=>resolve({exitCode:null,launchError:true}));child.on('exit',(exitCode,signal)=>resolve({exitCode,signal}));});
  clearTimeout(timer);
  executions[name]={command:[command,...args].map(x=>x.replace(dir,'$Z3_DIR')),startedAt,elapsedMs:Math.round(performance.now()-start),...result,timedOut};
  if(prefix) {
    const fresh=readdirSync('.verify').filter(x=>x.startsWith(prefix)&&!before.has(x));
    if(fresh.length===1&&existsSync(join('.verify',fresh[0],'evidence.json'))) sources[name]=read(join('.verify',fresh[0],'evidence.json'));
  }
}
// Existing A/B scripts remain the single owners of their probes; no copied assertions/pumps here.
await run('y2','bash',['scripts/verify/y2-mcp-http-worker.sh'],{},'y2-mcp-http-worker-');
await run('x2','bash',['scripts/verify/x2-mcp-extension.sh'],{},'x2-mcp-extension-');
await run('x3','bash',['scripts/verify/x3-mcp-extension-surface.sh'],{},'x3-mcp-extension-surface-');
await run('c','node',['--import','tsx',join(dir,'c-live.mts')],{DATABASE_URL:join(dir,'private.sqlite'),SPROUT_PI_ENABLED:'false'});
const c=existsSync(join(dir,'c-evidence.json'))?read(join(dir,'c-evidence.json')):{};
class EvidenceUnavailable extends Error {}
const passed=name=>{
  const execution=executions[name];
  // 跑完但断言不成立 = FAIL；没跑完/超时/缺产物 = INCONCLUSIVE。次序不能倒过来，
  // 否则一个真正失败的断言会被报成「无法判定」而掩盖回归。
  if(execution.timedOut||execution.launchError) throw new EvidenceUnavailable(`${name} did not finish`);
  assert.equal(execution.exitCode,0,`${name} completed with failing assertions`);
  if(!sources[name]) throw new EvidenceUnavailable(`${name} evidence unavailable`);
};
const requireProbe=name=>{
  if(!c[name]) throw new EvidenceUnavailable(`missing C probe ${name}`);
  assert.equal(c[name].status,'PASS',`${name} must pass`);
  assert(!c.setup,'C probe setup/cleanup must complete');
  return c[name];
};
const http=sources.y2, extension=sources.x2, surface=sources.x3;
sources.c=c;

// ---------------------------------------------------------------- 条款 ⇄ 证据的投影契约
// 每条条款的 `assertions` 不是自由格式：`REQUIRED` 是一张**独立于条款 body 的必需字段表**，
// 每个字段都必须由本条款用 `evidenceAt(field,path)` 从上面前置执行产出的 probe 证据里按路径取到值，
// 并且 `assertions[field]` 必须**等于**那次取到的值。核对跑在下面遍历条款的循环里，不在条款
// body 里，所以条款 body 无论被改成什么（返回 `{}`、返回 `{note:'…'}`、直接返回字面量）都躲不过：
//   1. 必需字段必须齐全            → 条款被整条清空 = FAIL；
//   2. 每个必需字段必须有取值路径  → 手写字面量没有路径 = FAIL；
//   3. 断言值必须等于取到的证据值  → 写死的值与实测不符 = FAIL。
// 这三种形状都用突变验过，输出贴在 orchestrate/sprout-mio-r1/reports/gate-hardening.md。
class ClauseContract extends Error {}
const REQUIRED = {
  1: ['toolCount','clientFrames','serverFrames','endToEndToolsList','officialSdkVersion'],
  2: ['activeMcpTools','allowlistExcludedNotify','allowedToolExecuted','hostServerNotStarted','hostServerAbsent'],
  3: ['distinctProcesses','crossRootReadRejected','crossRootWriteRejected','callRejected','sessionTargetsUnchanged','noWriteOnSurvivor'],
  4: ['blockType','mimeType','base64Length','bytesEqual','structuredContentEqual','throughSproutRelay','throughRealPiToolDefinition','x3BytesEqual','x3StructuredContentEqual'],
  5: ['newToolDeclared','newToolCallable','callReturned','callTextMatchesServer','stillDeclaredAfterExplicitRefresh','blockedSurfaceOutcome','oldGenerationRejected'],
  6: ['autostart','noSpawn','aliveAfterDelete','aliveAfterWorkerExit','configuredServiceAliveAfterWorkerExit'],
  7: ['summaryExists','designExists','evidenceIndexExists','keyCombinationsPresent','evidenceScriptCurrent','evidenceSourceCommitAncestor'],
};
const resolvePath = path => {
  const [source,...rest] = path.split('.');
  let node = sources[source];
  for (const key of rest) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[key];
  }
  return node;
};
let currentClause = 0;
let projections = [];
const evidenceAt = (field,path) => {
  const value = resolvePath(path);
  if (value === undefined) throw new ClauseContract(`R1-${currentClause}: 证据路径 ${path} 取不到值`);
  projections.push({clause:currentClause,field,path,value});
  return value;
};

const clauses = [
  // R1-1：stdio 与 streamableHttp 都真的跑通。y2 是编译后的真实 Worker CLI，x2 走真实中继。
  ()=>{
    passed('y2');passed('x2');
    assert.equal(evidenceAt('endToEndToolsList','x2.endToEndToolsList'),'pass','x2 的端到端帧往返成立');
    assert(evidenceAt('clientFrames','x2.workerDispatcherClientFrames')>0,'x2 有客户端帧');
    assert(evidenceAt('serverFrames','x2.workerDispatcherServerFrames')>0,'x2 有服务端帧');
    assert.equal(evidenceAt('toolCount','x2.toolCount'),20,'x2 取得真实 server-everything 的 20 个工具');
    assert.equal(evidenceAt('realWorkerCli','y2.worker.realCli'),true,'y2 跑的是编译后的真实 Worker CLI');
    assert.equal(evidenceAt('bundled','y2.worker.bundled'),true,'y2 的 Worker 是打包产物');
    assert.equal(evidenceAt('ownerManagedTarget','y2.ownerManaged.catalogTarget')!==undefined,true,'y2 的 owner_managed 是真实 catalog 目标');
    assert.equal(evidenceAt('configuredServiceSpawned','y2.configuredService.spawnedServerPidMatched'),true,'y2 的 configured_service 确实被 spawn');
    requireProbe('officialSdk');
    return {
      toolCount:evidenceAt('toolCount','x2.toolCount'),
      clientFrames:evidenceAt('clientFrames','x2.workerDispatcherClientFrames'),
      serverFrames:evidenceAt('serverFrames','x2.workerDispatcherServerFrames'),
      endToEndToolsList:evidenceAt('endToEndToolsList','x2.endToEndToolsList'),
      officialSdkVersion:evidenceAt('officialSdkVersion','c.officialSdk.version'),
      transports:evidenceAt('transports','y2.worker.transports'),
    };
  },
  // R1-2：Pi 工具面、allowlist 与显式登记。
  ()=>{
    passed('x2');
    const surfaceProbe=requireProbe('surface');
    assert.equal(evidenceAt('catalogOnlyExplicitRegistrations','x2.catalogOnlyExplicitRegistrations'),true,'catalog 只含显式登记');
    assert.equal(evidenceAt('allowlistExcludedNotify','c.surface.allowlistExcludedNotify'),true,'未获准的 notify 不进工具面');
    assert.equal(evidenceAt('allowedToolExecuted','c.surface.allowedToolExecuted'),true,'获准的 read 真的被执行');
    assert.equal(evidenceAt('hostServerNotStarted','c.surface.hostServerNotStarted'),true,'隔离宿主里的 host_sentinel 没被启动');
    assert.equal(evidenceAt('hostServerAbsent','c.surface.hostServerAbsent'),true,'host_sentinel 不在工具面');
    const activeMcpTools=evidenceAt('activeMcpTools','c.surface.activeMcpTools');
    assert(activeMcpTools.length>0&&activeMcpTools.every(name=>name.startsWith('mcp__')),'活动工具面里只有 mcp__ 工具');
    return {
      activeMcpTools,
      allowlistExcludedNotify:true,
      allowedToolExecuted:true,
      hostServerNotStarted:true,
      hostServerAbsent:true,
      probeStatus:surfaceProbe.status,
    };
  },
  // R1-3：指定实例、不同 root 隔离、不改投。
  ()=>{
    requireProbe('isolation');requireProbe('disappearance');
    assert.equal(evidenceAt('distinctProcesses','c.isolation.distinctProcesses'),true,'两个 server 是不同进程');
    assert.equal(evidenceAt('crossRootReadRejected','c.isolation.crossRootReadRejected'),true,'跨 root 读被拒');
    assert.equal(evidenceAt('crossRootWriteRejected','c.isolation.crossRootWriteRejected'),true,'跨 root 写被拒');
    assert.equal(evidenceAt('callRejected','c.disappearance.callRejected'),true,'目标消失后调用被拒');
    assert.equal(evidenceAt('sessionTargetsUnchanged','c.disappearance.sessionTargetsUnchanged'),true,'session 绑定不变');
    assert.equal(evidenceAt('noWriteOnSurvivor','c.disappearance.noWriteOnSurvivor'),true,'存活 server 上没有误投的文件');
    return {
      distinctProcesses:true,
      crossRootReadRejected:true,
      crossRootWriteRejected:true,
      callRejected:true,
      sessionTargetsUnchanged:true,
      noWriteOnSurvivor:true,
      simultaneousSessions:evidenceAt('simultaneousSessions','c.isolation.simultaneousSessions'),
    };
  },
  // R1-4：图片与 structuredContent 送达 Pi。每一项都取自真实探针的实测断言：C 探针的
  // bytesEqual/structuredContentEqual 来自它自己的逐字节与深度比较，x3 的两份布尔来自 x3 与
  // 真实 server 返回值的比较。本条款不写死任何一个值，也不允许自己被清空。
  ()=>{
    passed('x3');
    requireProbe('image');
    assert.equal(evidenceAt('x3BytesEqual','x3.image.matchesServerBytes'),true,'x3 测到的 base64 与真实 server 返回值逐字节相同');
    assert.equal(evidenceAt('x3StructuredContentEqual','x3.image.structuredContentMatchesServer'),true,'x3 测到的 details.structuredContent 与真实 server 返回值一致');
    assert.equal(evidenceAt('blockType','c.image.blockType'),'image','图片块没有被降级成文本');
    assert.equal(evidenceAt('mimeType','c.image.mimeType'),'image/png','mimeType 原样');
    assert(evidenceAt('base64Length','c.image.base64Length')>100,'base64 内容非空');
    assert.equal(evidenceAt('bytesEqual','c.image.bytesEqual'),true,'base64 与真实 server 返回值逐字节相同');
    assert.equal(evidenceAt('structuredContentEqual','c.image.structuredContentEqual'),true,'details.structuredContent 与真实 server 返回值深度相等');
    assert.equal(evidenceAt('throughSproutRelay','c.image.throughSproutRelay'),true,'结果确实经过 Sprout 中继');
    assert.equal(evidenceAt('throughRealPiToolDefinition','c.image.throughRealPiToolDefinition'),true,'结果确实经 Pi 持有的工具定义执行');
    return {
      blockType:evidenceAt('blockType','c.image.blockType'),
      mimeType:evidenceAt('mimeType','c.image.mimeType'),
      base64Length:evidenceAt('base64Length','c.image.base64Length'),
      bytesEqual:evidenceAt('bytesEqual','c.image.bytesEqual'),
      structuredContentEqual:evidenceAt('structuredContentEqual','c.image.structuredContentEqual'),
      throughSproutRelay:evidenceAt('throughSproutRelay','c.image.throughSproutRelay'),
      throughRealPiToolDefinition:evidenceAt('throughRealPiToolDefinition','c.image.throughRealPiToolDefinition'),
      x3BytesEqual:evidenceAt('x3BytesEqual','x3.image.matchesServerBytes'),
      x3StructuredContentEqual:evidenceAt('x3StructuredContentEqual','x3.image.structuredContentMatchesServer'),
    };
  },
  // R1-5：资源、目录变化、重建、超时与旧代次。`newToolCallable` 必须来自 x3 那次真实调用
  // （调用回了 content 且文本等于 server 回的 `called:added-1`），不是字面量。
  ()=>{
    passed('y2');passed('x3');
    assert.equal(evidenceAt('sameProcessId','y2.sessions.sameProcessId'),true,'同一 process 重开 session');
    assert.equal(evidenceAt('newSessionId','y2.sessions.newSessionId'),true,'重开拿到新 session id');
    assert.equal(evidenceAt('sqliteConcurrentActiveRejected','y2.sessions.sqliteConcurrentActiveRejected'),true,'并发活动 session 被 SQLite 拒绝');
    assert.equal(evidenceAt('newToolDeclared','x3.listChanged.newToolDeclared'),true,'真实 list_changed 后新工具进入模型工具面');
    assert.equal(evidenceAt('callReturned','x3.listChanged.callReturned'),true,'x3 对新工具的那次真实调用返回了 content');
    assert.equal(evidenceAt('callTextMatchesServer','x3.listChanged.callTextMatchesServer'),true,'那次调用真的到 server（返回 called:added-1）');
    assert.equal(evidenceAt('newToolCallable','x3.listChanged.newToolCallable'),true,'新工具在模型工具面里可调用（由那次真实调用算出）');
    assert.equal(evidenceAt('stillDeclaredAfterExplicitRefresh','x3.listChanged.stillDeclaredAfterExplicitRefresh'),true,'显式 refresh 后新工具不丢');
    assert.equal(evidenceAt('blockedSurfaceOutcome','x3.refreshOnBlockedSurface.outcome'),'failed','目录已变但工具面没跟进时必须报 failed，不能假装 ok');
    assert.equal(evidenceAt('blockedSurfaceDiagnostic','x3.refreshOnBlockedSurface.diagnosticPresent'),true,'受阻工具面留下诊断');
    assert.equal(evidenceAt('oldGenerationRejected','c.release.oldGenerationRejected'),'lease_stale_generation','旧代次 exchange 被拒');
    return {
      newToolDeclared:evidenceAt('newToolDeclared','x3.listChanged.newToolDeclared'),
      newToolCallable:evidenceAt('newToolCallable','x3.listChanged.newToolCallable'),
      callReturned:evidenceAt('callReturned','x3.listChanged.callReturned'),
      callTextMatchesServer:evidenceAt('callTextMatchesServer','x3.listChanged.callTextMatchesServer'),
      stillDeclaredAfterExplicitRefresh:evidenceAt('stillDeclaredAfterExplicitRefresh','x3.listChanged.stillDeclaredAfterExplicitRefresh'),
      blockedSurfaceOutcome:evidenceAt('blockedSurfaceOutcome','x3.refreshOnBlockedSurface.outcome'),
      oldGenerationRejected:evidenceAt('oldGenerationRejected','c.release.oldGenerationRejected'),
      resources:requireProbe('resources'),
      sessionRebuild:requireProbe('detach'),
      timeout:requireProbe('timeout'),
    };
  },
  // R1-6：生命周期与已有服务登记。
  ()=>{
    passed('y2');
    assert.equal(evidenceAt('autostart','y2.ownerManaged.autostart'),false,'owner_managed 的服务 autostart 必须是 false');
    assert.equal(evidenceAt('noSpawn','y2.ownerManaged.noSpawn'),true,'Worker 没有为 owner_managed 目标 spawn 进程');
    assert.equal(evidenceAt('aliveAfterDelete','y2.ownerManaged.runningAfterDelete'),true,'DELETE 之后 owner_managed 服务仍在运行');
    assert.equal(evidenceAt('aliveAfterWorkerExit','y2.ownerManaged.aliveAfterWorkerExit'),true,'Worker 退出后 owner_managed 服务仍存活');
    assert.equal(evidenceAt('configuredServiceAliveAfterWorkerExit','y2.configuredService.aliveAfterWorkerExit'),false,'configured_service 必须随 Worker 退出而终止');
    requireProbe('detach');requireProbe('release');
    return {
      autostart:evidenceAt('autostart','y2.ownerManaged.autostart'),
      noSpawn:evidenceAt('noSpawn','y2.ownerManaged.noSpawn'),
      aliveAfterDelete:evidenceAt('aliveAfterDelete','y2.ownerManaged.runningAfterDelete'),
      aliveAfterWorkerExit:evidenceAt('aliveAfterWorkerExit','y2.ownerManaged.aliveAfterWorkerExit'),
      configuredServiceAliveAfterWorkerExit:evidenceAt('configuredServiceAliveAfterWorkerExit','y2.configuredService.aliveAfterWorkerExit'),
      detach:requireProbe('detach'),
      release:requireProbe('release'),
    };
  },
  // R1-7：只校验**可以机器判定**的东西 —— 文档存在、关键组合词出现、证据快照与当前脚本/代码
  // 一致。文档内容是否与代码相符需要人读，本条款不保证，也不假装保证（见 summary 已知限制）。
  ()=>{
    const snapshot=JSON.parse(readFileSync('docs/r1/evidence/evidence.json','utf8'));
    const design=readFileSync('docs/r1/design.md','utf8'), summary=readFileSync('docs/r1/summary.md','utf8');
    const scope=readFileSync('docs/core-scope.md','utf8');
    const designPhrases=['薄 bridge','帧中继','Pi 原生客户端','SDK','长连接'];
    const missingPhrases=designPhrases.filter(phrase=>!design.includes(phrase));
    const currentScriptSha=createHash('sha256').update(readFileSync('scripts/verify/z3-mcp-acceptance.sh')).digest('hex');
    const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
    let ancestor=false;
    try { execFileSync('git',['merge-base','--is-ancestor',snapshot.sourceCommit,head],{stdio:'ignore'}); ancestor=true; } catch { ancestor=false; }
    sources.docs={
      summaryExists:existsSync('docs/r1/summary.md'),
      designExists:existsSync('docs/r1/design.md'),
      evidenceIndexExists:existsSync('docs/r1/evidence/evidence.json'),
      keyCombinationsPresent:missingPhrases.length===0,
      missingKeyCombinations:missingPhrases,
      summaryMentionsStage:summary.includes('P4c')&&summary.includes('纳入一期'),
      summaryHasNoPendingMarker:!summary.includes('待 z3 运行'),
      scopeMentionsMcpAndPhase:scope.includes('**MCP tools 接入**')&&scope.includes('P4c'),
      evidenceScriptSha256:snapshot.scriptSha256,
      currentScriptSha256:currentScriptSha,
      evidenceScriptCurrent:snapshot.scriptSha256===currentScriptSha,
      evidenceSourceCommit:snapshot.sourceCommit,
      head,
      evidenceSourceCommitAncestor:ancestor,
    };
    assert.equal(evidenceAt('summaryExists','docs.summaryExists'),true,'docs/r1/summary.md 存在');
    assert.equal(evidenceAt('designExists','docs.designExists'),true,'docs/r1/design.md 存在');
    assert.equal(evidenceAt('evidenceIndexExists','docs.evidenceIndexExists'),true,'docs/r1/evidence/evidence.json 存在');
    assert.equal(evidenceAt('keyCombinationsPresent','docs.keyCombinationsPresent'),true,`design.md 缺少关键组合词：${missingPhrases.join(', ')}`);
    assert.equal(evidenceAt('summaryMentionsStage','docs.summaryMentionsStage'),true,'summary.md 写了纳入阶段');
    assert.equal(evidenceAt('summaryHasNoPendingMarker','docs.summaryHasNoPendingMarker'),true,'summary.md 没有留下「待 z3 运行」');
    assert.equal(evidenceAt('scopeMentionsMcpAndPhase','docs.scopeMentionsMcpAndPhase'),true,'范围文档写了 MCP 接入与 P4c');
    assert.equal(
      evidenceAt('evidenceScriptCurrent','docs.evidenceScriptCurrent'),
      true,
      `docs/r1/evidence/evidence.json 的 scriptSha256 (${snapshot.scriptSha256}) 必须等于当前 z3 脚本的 SHA-256 (${currentScriptSha})：改脚本后要重跑 z3 并复制证据`,
    );
    assert.equal(
      evidenceAt('evidenceSourceCommitAncestor','docs.evidenceSourceCommitAncestor'),
      true,
      `证据的 sourceCommit ${snapshot.sourceCommit} 必须是当前 HEAD ${head} 的祖先或等于它（证据不能与代码脱钩）`,
    );
    return {
      summaryExists:evidenceAt('summaryExists','docs.summaryExists'),
      designExists:evidenceAt('designExists','docs.designExists'),
      evidenceIndexExists:evidenceAt('evidenceIndexExists','docs.evidenceIndexExists'),
      keyCombinationsPresent:evidenceAt('keyCombinationsPresent','docs.keyCombinationsPresent'),
      evidenceScriptCurrent:evidenceAt('evidenceScriptCurrent','docs.evidenceScriptCurrent'),
      evidenceSourceCommitAncestor:evidenceAt('evidenceSourceCommitAncestor','docs.evidenceSourceCommitAncestor'),
      evidenceScriptSha256:snapshot.scriptSha256,
      evidenceSourceCommit:snapshot.sourceCommit,
      head,
      scope:'条款 7 只校验文档存在、关键组合词与证据来源一致；文档语义由独立验收者逐条核对，本门禁不保证',
    };
  },
];
const results=[];
for(const [index,check] of clauses.entries()) {
  currentClause=index+1;
  let status='PASS',assertions,error;
  projections=[];
  try { assertions=check(); }
  catch(e) {
    // Missing evidence is inconclusive; an executed probe's failed assertion is a failure.
    status=e instanceof EvidenceUnavailable?'INCONCLUSIVE':'FAIL'; error=e.message;
  }
  if(status==='PASS') {
    try {
      // 投影契约：必需字段齐全 / 每个字段有真实取值路径 / 断言值等于取到的证据值。
      if(assertions===null||typeof assertions!=='object') throw new ClauseContract(`R1-${currentClause}: 条款必须返回断言对象，实测 ${JSON.stringify(assertions)}`);
      const required=REQUIRED[currentClause]??[];
      const missing=required.filter(field=>!(field in assertions));
      if(missing.length) throw new ClauseContract(`R1-${currentClause}: 缺少必需字段 ${missing.join(', ')} —— 条款没有真的核过这些要求`);
      for(const field of required) {
        const projection=projections.find(p=>p.field===field);
        if(!projection) throw new ClauseContract(`R1-${currentClause}: 字段 ${field} 没有任何证据取值路径（疑似写死）`);
        assert.deepEqual(assertions[field],projection.value,`R1-${currentClause}: 字段 ${field} 与证据 ${projection.path} 不一致（写死的值不等于实测值）`);
      }
    } catch(e) {
      status=e instanceof EvidenceUnavailable?'INCONCLUSIVE':'FAIL'; assertions=undefined; error=e.message;
    }
  }
  const path=join(dir,`clause-${currentClause}.json`);
  const record={clause:currentClause,status,...(assertions?{assertions}:{}),...(status==='PASS'?{projections:projections.map(({clause,field,path})=>({field,path}))}:{}),...(error?{error}:{}),executions};
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');
  const evidencePath=relative(process.cwd(),path);
  results.push({clause:currentClause,status,evidencePath});
  console.log(`${status} R1-${currentClause} ${evidencePath}`);
}
writeFileSync(join(dir,'evidence.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:createHash('sha256').update(readFileSync('scripts/verify/z3-mcp-acceptance.sh')).digest('hex'),results,executions},null,2)+'\n');
writeFileSync(join(dir,'run.log'),results.map(r=>`${r.status} R1-${r.clause} ${r.evidencePath}`).join('\n')+'\n');
process.exitCode=results.every(r=>r.status==='PASS')?0:1;
RUNNER
node "$run_dir/run.mjs"
