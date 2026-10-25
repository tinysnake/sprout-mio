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
  if(executions[name].timedOut||executions[name].launchError||!sources[name]) throw new EvidenceUnavailable(`${name} evidence unavailable`);
  assert.equal(executions[name].exitCode,0,`${name} completed with failing assertions`);
};
const requireProbe=name=>{
  if(!c[name]) throw new EvidenceUnavailable(`missing C probe ${name}`);
  assert.equal(c[name].status,'PASS',`${name} must pass`);
  assert(!c.setup,'C probe setup/cleanup must complete');
  return c[name];
};
const http=sources.y2, extension=sources.x2, surface=sources.x3;
const clauses=[
  ()=>{passed('y2');passed('x2'); assert(http.pass);assert(http.worker.realCli&&http.worker.bundled); assert(extension.workerDispatcherClientFrames>0&&extension.workerDispatcherServerFrames>0);assert.equal(extension.endToEndToolsList,'pass');return {stdio:{toolCount:extension.toolCount,realDispatcher:true,clientFrames:extension.workerDispatcherClientFrames,serverFrames:extension.workerDispatcherServerFrames},streamableHttp:{realWorkerCli:http.worker.realCli,transports:http.worker.transports,ownerManagedTarget:!!http.ownerManaged.catalogTarget,configuredServiceSpawned:http.configuredService.spawnedServerPidMatched},officialSdk:requireProbe('officialSdk')};},
  ()=>{passed('x2'); assert.equal(extension.catalogOnlyExplicitRegistrations,true);return requireProbe('surface');},
  ()=>({isolation:requireProbe('isolation'),disappearance:requireProbe('disappearance')}),
  ()=>{passed('x3');assert(surface.image.matchesServerBytes&&surface.image.structuredContentMatchesServer);return requireProbe('image');},
  ()=>{passed('y2');passed('x3');assert(http.sessions.sameProcessId&&http.sessions.newSessionId&&http.sessions.sqliteConcurrentActiveRejected);assert(surface.listChanged.newToolDeclared&&surface.listChanged.newToolCallable&&surface.listChanged.stillDeclaredAfterExplicitRefresh);assert.equal(surface.refreshOnBlockedSurface.outcome,'failed');return {resources:requireProbe('resources'),sessionRebuild:requireProbe('detach'),timeout:requireProbe('timeout'),oldGeneration:requireProbe('release').oldGenerationRejected,listChanged:{newToolDeclared:surface.listChanged.newToolDeclared,newToolCallable:surface.listChanged.newToolCallable,explicitRefreshKeepsTool:surface.listChanged.stillDeclaredAfterExplicitRefresh,blockedSurfaceVisibleFailure:true},activeSessionUniqueness:http.sessions.sqliteConcurrentActiveRejected};},
  ()=>{passed('y2');assert.equal(http.ownerManaged.autostart,false);assert(http.ownerManaged.noSpawn&&http.ownerManaged.aliveAfterWorkerExit&&http.ownerManaged.runningAfterDelete);assert.equal(http.configuredService.aliveAfterWorkerExit,false);return {detach:requireProbe('detach'),release:requireProbe('release'),ownerManaged:{autostart:false,noSpawn:true,catalogCallableTarget:true,aliveAfterDelete:true,aliveAfterWorkerExit:true},configuredService:{spawned:true,terminatedAfterWorkerExit:true}};},
  ()=>{for(const file of ['docs/r1/summary.md','docs/r1/design.md']) assert(existsSync(file),`${file} exists`);const design=readFileSync('docs/r1/design.md','utf8'), summary=readFileSync('docs/r1/summary.md','utf8');assert(design.includes('薄 bridge')&&design.includes('帧中继')&&design.includes('Pi 原生客户端')&&design.includes('SDK')&&design.includes('长连接'));assert(summary.includes('P4c')&&summary.includes('纳入一期'));assert(existsSync('docs/r1/evidence'));assert(!summary.includes('待 z3 运行'));const scope=readFileSync('docs/core-scope.md','utf8');assert(scope.includes('**MCP tools 接入**')&&scope.includes('P4c'));return {summary:'docs/r1/summary.md',design:'docs/r1/design.md',stage:'P4c 之后纳入一期',humanConfirmationRequired:true};},
];
const results=[];
for(const [index,check] of clauses.entries()) {
  let status='PASS',assertions,error;
  try { assertions=check(); } catch(e) {
    // Missing evidence is inconclusive; an executed probe's failed assertion is a failure.
    status=e instanceof EvidenceUnavailable?'INCONCLUSIVE':'FAIL'; error=e.message;
  }
  const path=join(dir,`clause-${index+1}.json`);
  const record={clause:index+1,status,...(assertions?{assertions}:{}),...(error?{error}:{}),executions};
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');
  const evidencePath=relative(process.cwd(),path);
  results.push({clause:index+1,status,evidencePath});
  console.log(`${status} R1-${index+1} ${evidencePath}`);
}
writeFileSync(join(dir,'evidence.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:createHash('sha256').update(readFileSync('scripts/verify/z3-mcp-acceptance.sh')).digest('hex'),results,executions},null,2)+'\n');
writeFileSync(join(dir,'run.log'),results.map(r=>`${r.status} R1-${r.clause} ${r.evidencePath}`).join('\n')+'\n');
process.exitCode=results.every(r=>r.status==='PASS')?0:1;
RUNNER
node "$run_dir/run.mjs"
