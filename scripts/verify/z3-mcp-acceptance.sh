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
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
const root = resolve(process.argv[2]);
// The gate owns the directory; this server, not the probe, records what it received.
// Only the tool name, the JSON-RPC id and whether the resolved path stayed inside the root
// are written: no path text and no file content ever reaches this log.
const callLog = join(dirname(root), `calls-${basename(root)}.log`);
const logCall = entry => appendFileSync(callLog, `${JSON.stringify(entry)}\n`);
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
        if (name === 'never_reply') { logCall({tool:name,id:m.id,outcome:'no_reply'}); writeFileSync(resolve(root,'request-observed'),'1'); return; }
        if (name === 'notify') {
          logCall({tool:name,id:m.id,outcome:'ok'});
          if (subscribed) send({method:'notifications/resources/updated',params:{uri:'z3://root/value'}});
          result = {content:[{type:'text',text:'notified'}]}; break;
        }
        const path = resolve(root,a.path);
        const insideRoot = path.startsWith(root+sep);
        if (!insideRoot) { logCall({tool:name,id:m.id,insideRoot,outcome:'rejected'}); throw new Error('outside_root'); }
        logCall({tool:name,id:m.id,insideRoot,outcome:'ok'});
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
    const entries=readdirSync('node_modules/.pnpm').filter(name=>name.startsWith('@modelcontextprotocol+sdk@'));
    assert.equal(entries.length,1,'one unambiguous installed official SDK');
    const sdkRoot=join(process.cwd(),'node_modules/.pnpm',entries[0]!,'node_modules/@modelcontextprotocol/sdk');
    const sdkVersion=JSON.parse(readFileSync(join(sdkRoot,'package.json'),'utf8')).version;
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
      // The gate, not the probe, owns the expected names. Only the names each transport actually
      // returned are written, and only to the private run directory.
      writeFileSync(join(dir,'sdk-observations.json'),JSON.stringify({stdioTools:stdioTools.tools.map((tool:any)=>tool.name),httpTools:httpTools.tools.map((tool:any)=>tool.name)}),{mode:0o600});
      await httpTransport.terminateSession();
      return {version:sdkVersion,stdioConnected:true,stdioToolCount:stdioTools.tools.length,streamableHttpConnected:true,httpToolCount:httpTools.tools.length,referenceOnly:true};
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
    const callsA=readFileSync(join(dir,'calls-root-a.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const callsB=readFileSync(join(dir,'calls-root-b.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const crossReadObserved=callsA.some((call:any)=>call.tool==='read'&&call.outcome==='rejected');
    const crossWriteObserved=callsB.some((call:any)=>call.tool==='write'&&call.outcome==='rejected');
    return {simultaneousSessions:2,distinctProcesses:true,ownReads:true,ownWrites:true,crossRootReadRejected:crossReadObserved,crossRootWriteRejected:crossWriteObserved};
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
    const calls=readFileSync(join(dir,'calls-root-b.log'),'utf8').trim().split('\n').map(line=>JSON.parse(line));
    const requestObserved=calls.some((call:any)=>call.tool==='never_reply'&&call.outcome==='no_reply');
    return {requestReachedServer:requestObserved,outcome:result.details.outcome};
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
    // 只有真的捕获到错误才写这份原始观察值：没有发生调用就没有文件，门禁据此判 FAIL。
    try {ctx.now=new Date(); await mcpSessionExchange({projectId,machineId,authorizationGeneration:1,sessionId:connections.at(-1).transport.sessionId,frames:[],ackServerSeq:0,cancelClientSeqs:[],protocolVersion:null,confirmInitialized:false,holdMs:0},ctx);} catch(e) {code=(e as any).code; writeFileSync(join(dir,'release-observation.json'),JSON.stringify({code:code??null,framesBefore:framesBefore.n,framesAfter:(sqlite.prepare('SELECT count(*) AS n FROM mcp_frame').get() as any).n}));}
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
import Database from 'better-sqlite3';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
const dir=process.env.Z3_DIR;
const executions={};
const sources={};
const read=path=>JSON.parse(readFileSync(path,'utf8'));
async function run(name,command,args,env={},prefix,evidenceFile) {
  const before=new Set(readdirSync('.verify'));
  const startedAt=new Date().toISOString();
  const start=performance.now();
  const child=spawn(command,args,{env:{...process.env,...env},stdio:'ignore',detached:true});
  let timedOut=false;
  const timer=setTimeout(()=>{timedOut=true; try{process.kill(-child.pid,'SIGKILL');}catch{}},300000);
  const result=await new Promise(resolve=>{child.on('error',()=>resolve({exitCode:null,launchError:true}));child.on('exit',(exitCode,signal)=>resolve({exitCode,signal}));});
  clearTimeout(timer);
  executions[name]={command:[command,...args].map(x=>x.replace(dir,'$Z3_DIR')),startedAt,elapsedMs:Math.round(performance.now()-start),...result,timedOut};
  if(evidenceFile) {
    // The harness names the artifact, so it never has to infer which directory a probe chose.
    if(existsSync(evidenceFile)) sources[name]=read(evidenceFile);
  } else if(prefix) {
    const fresh=readdirSync('.verify').filter(x=>x.startsWith(prefix)&&!before.has(x));
    if(fresh.length===1&&existsSync(join('.verify',fresh[0],'evidence.json'))) sources[name]=read(join('.verify',fresh[0],'evidence.json'));
  }
}
// Existing A/B scripts remain the single owners of their probes; no copied assertions/pumps here.
const x3EvidencePath=join(dir,'x3-evidence.json');
const x3ObservationPath=join(dir,'x3-observations.json');
await run('y2','bash',['scripts/verify/y2-mcp-http-worker.sh'],{Y2_GATE_RAW:join(dir,'y2-child.json')},'y2-mcp-http-worker-');
await run('x2','bash',['scripts/verify/x2-mcp-extension.sh'],{X2_GATE_RAW:join(dir,'x2-tools.json')},'x2-mcp-extension-');
await run('x3','bash',['scripts/verify/x3-mcp-extension-surface.sh'],{X3_DIR:dir,X3_EVIDENCE:x3EvidencePath,X3_RAW:x3ObservationPath},null,x3EvidencePath);
await run('c','node',['--import','tsx',join(dir,'c-live.mts')],{DATABASE_URL:join(dir,'private.sqlite'),SPROUT_PI_ENABLED:'false'});
const c=existsSync(join(dir,'c-evidence.json'))?read(join(dir,'c-evidence.json')):{};
// Missing output of a probe that never finished is unknown; missing output of a probe that
// reported success is a contradiction. The first is INCONCLUSIVE, the second is FAIL.
class EvidenceUnavailable extends Error {}
class ObservationContract extends Error {}
const passed=name=>{
  const execution=executions[name];
  // 跑完但断言不成立 = FAIL；没跑完/超时/缺产物 = INCONCLUSIVE。次序不能倒过来，
  // 否则一个真正失败的断言会被报成「无法判定」而掩盖回归。
  if(execution.timedOut||execution.launchError) throw new EvidenceUnavailable(`${name} did not finish`);
  assert.equal(execution.exitCode,0,`${name} completed with failing assertions`);
  // For the probes whose output path is discovered by glob, a missing file is ambiguous:
  // unproven, not contradicted. x3's path is named by the harness, so its own check below
  // treats a missing artifact as a contradiction instead.
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

// ---------------------------------------------------------------- R1-1 official SDK connection
// The C probe writes the tool names each transport actually returned into a private artifact.
// The gate owns the expected names and compares them itself; the probe's connected/count
// booleans are not read. Deleting the real connect()/listTools() calls leaves no artifact, so
// a probe that still reports success contradicts its own output and the clause is FAIL.
const sdkObservationPath=join(dir,'sdk-observations.json');
const expectedSdkStdioTools=['never_reply','notify','read','write'];
const expectedSdkHttpTools=['wire_echo'];
const sdkState={status:'pending'};
try {
  const execution=executions.c;
  if(!execution||execution.timedOut||execution.launchError) throw new EvidenceUnavailable('c did not finish');
  if(execution.exitCode!==0) throw new ObservationContract('c completed with failing assertions');
  const probe=c.officialSdk;
  if(!probe) throw new EvidenceUnavailable('c published no officialSdk probe');
  if(probe.status!=='PASS') throw new ObservationContract('officialSdk probe did not pass');
  if(!existsSync(sdkObservationPath)) throw new ObservationContract('officialSdk reported success but left no connection observation');
  const observation=read(sdkObservationPath);
  const stdio=observation.stdioTools, httpTools=observation.httpTools;
  if(!Array.isArray(stdio)||!Array.isArray(httpTools)) throw new ObservationContract('officialSdk connection observation is malformed');
  assert.deepEqual([...stdio].sort(),expectedSdkStdioTools,'stdio tools must be the gate-owned expected set');
  assert.deepEqual([...httpTools].sort(),expectedSdkHttpTools,'streamableHttp tools must be the gate-owned expected set');
  Object.assign(sdkState,{status:'computed',stdioConnected:stdio.length>0,streamableHttpConnected:httpTools.length>0,stdioToolCount:stdio.length,httpToolCount:httpTools.length});
} catch(e) {
  Object.assign(sdkState,{status:e instanceof EvidenceUnavailable?'unavailable':'failed',error:e.message});
}
if(sdkState.status==='computed') sources.sdk={
  stdioConnected:sdkState.stdioConnected,
  streamableHttpConnected:sdkState.streamableHttpConnected,
  stdioToolCount:sdkState.stdioToolCount,
  httpToolCount:sdkState.httpToolCount,
};
// R1-2's tool surface is a fixed set the gate owns. The probe only supplies the names Pi reports.
const expectedMcpSurfaceTools=['mcp__everything__get-structured-content','mcp__everything__get-tiny-image','mcp__root-1__never_reply','mcp__root-1__read','mcp__root-1__write'];

// ---------------------------------------------------------------- R1-4 raw observations
// A check is a triple: the probe's exit code, bounded raw values captured from the real Pi call
// and from an independent server call, and a comparison the gate computes itself. The probe's
// `matchesServerBytes`/`structuredContentMatchesServer` booleans are not evidence and are not
// read here.
//
// Two different failures stay different:
//   * the probe never claimed raw observations, or never finished → INCONCLUSIVE;
//   * the probe claimed them and then did not deliver → FAIL, because a probe that reports
//     success and cannot produce its own artifacts contradicts itself.
const maxObservationBytes=256*1024;
const pngSignature='89504e47';
const base64Sha256=value=>createHash('sha256').update(value,'utf8').digest('hex');
const boundedBase64=value=>typeof value==='string'&&value.length>100&&Buffer.byteLength(value,'utf8')<=maxObservationBytes;
const boundedJson=value=>{
  try {
    const serialized=JSON.stringify(value);
    return serialized!==undefined&&Buffer.byteLength(serialized,'utf8')<=maxObservationBytes;
  } catch { return false; }
};
const pngLike=value=>{
  try { return Buffer.from(value,'base64').subarray(0,4).toString('hex')===pngSignature; } catch { return false; }
};
const observe=()=>{
  const execution=executions.x3;
  // Exit status is part of the evidence. Not finishing is unknown; a failing probe is a failure.
  if(!execution||execution.timedOut||execution.launchError) throw new EvidenceUnavailable('x3 did not finish');
  if(execution.exitCode!==0) throw new ObservationContract('x3 completed with failing assertions');
  if(!surface) throw new ObservationContract('x3 exited 0 but published no evidence');
  const commitment=surface.image?.rawObservations;
  // A probe that publishes evidence without claiming raw observations leaves the comparison
  // unproven; that is an absence of evidence, not a contradiction.
  if(!commitment) throw new EvidenceUnavailable('x3 published evidence without raw observations');
  if(typeof commitment.sha256!=='string'||!/^[0-9a-f]{64}$/.test(commitment.sha256)) throw new ObservationContract('x3 raw observation commitment is malformed');
  if(!existsSync(x3ObservationPath)) throw new ObservationContract('x3 committed raw observations but left no artifact');
  let serialized;
  try { serialized=readFileSync(x3ObservationPath,'utf8'); } catch { throw new ObservationContract('x3 raw observation artifact is unreadable'); }
  if(base64Sha256(serialized)!==commitment.sha256) throw new ObservationContract('x3 raw observation artifact does not match its commitment');
  let observed;
  try { observed=JSON.parse(serialized); } catch { throw new ObservationContract('x3 raw observation artifact is not JSON'); }
  const usable=
    observed!==null&&typeof observed==='object'&&
    boundedBase64(observed.piImageBase64)&&boundedBase64(observed.serverImageBase64)&&
    pngLike(observed.piImageBase64)&&pngLike(observed.serverImageBase64)&&
    observed.piImageBase64.length===surface.image?.base64Length&&
    observed.piStructuredContent!==undefined&&observed.serverStructuredContent!==undefined&&
    boundedJson(observed.piStructuredContent)&&boundedJson(observed.serverStructuredContent);
  if(!usable) throw new ObservationContract('x3 raw observations are out of contract');
  // The gate owns the comparisons: strict string equality for bytes, deep equality for JSON.
  return {
    imageBytesEqual:observed.piImageBase64===observed.serverImageBase64,
    structuredContentEqual:isDeepStrictEqual(observed.piStructuredContent,observed.serverStructuredContent),
  };
};
// Resolved once, before any clause reads a value, so the R1-4 requirement paths exist.
const observationState={status:'pending'};
try {
  Object.assign(observationState,{status:'computed'},observe());
} catch(e) {
  Object.assign(observationState,{status:e instanceof EvidenceUnavailable?'unavailable':'failed',error:e.message});
}
if(observationState.status==='computed') sources.observed={...(sources.observed??{}),x3:{
  imageBytesEqual:observationState.imageBytesEqual,
  structuredContentEqual:observationState.structuredContentEqual,
}};
const x2RawPath=join(dir,'x2-tools.json');
// 固定清单由门禁自己持有：探针交来的两个数组都要对上它，改任何一侧都逃不过。
const expectedEverythingTools=['echo','get-annotated-message','get-env','get-header-params','get-resource-links','get-resource-reference','get-roots-list','get-structured-content','get-sum','get-tiny-image','gzip-file-as-resource','toggle-simulated-logging','toggle-subscriber-updates','trigger-elicitation-request','trigger-list-changed','trigger-log-messages','trigger-long-running-operation','trigger-multi-step-elicitation','trigger-resource-update','trigger-sampling-request'].sort();
let toolsMatch=false;
try {
  const commitment=read(`${x2RawPath}.commitment`);
  const bytes=readFileSync(x2RawPath);
  if(bytes.length===commitment.bytes&&createHash('sha256').update(bytes).digest('hex')===commitment.sha256) {
    const raw=JSON.parse(bytes.toString('utf8'));
    toolsMatch=Array.isArray(raw.rawToolNames)&&isDeepStrictEqual([...raw.rawToolNames].sort(),expectedEverythingTools)
      &&Array.isArray(raw.expectedToolNames)&&isDeepStrictEqual([...raw.expectedToolNames].sort(),expectedEverythingTools);
  }
} catch {}
const y2RawPath=join(dir,'y2-child.json');
let configuredServiceExited=false;
try { const y2Raw=read(y2RawPath); try { process.kill(y2Raw.managedPid,0); } catch (error) { configuredServiceExited=error.code==='ESRCH'; } } catch {}
const observed={
  toolsListMatchesExpected:toolsMatch,
  configuredServiceExited,
  crossRootReadRejected:readFileSync(join(dir,'calls-root-a.log'),'utf8').split('\n').some(line=>{try{const call=JSON.parse(line);return call.tool==='read'&&call.outcome==='rejected';}catch{return false;}}),
  crossRootWriteRejected:readFileSync(join(dir,'calls-root-b.log'),'utf8').split('\n').some(line=>{try{const call=JSON.parse(line);return call.tool==='write'&&call.outcome==='rejected';}catch{return false;}}),
  timeoutRequestReachedServer:readFileSync(join(dir,'calls-root-b.log'),'utf8').split('\n').some(line=>{try{const call=JSON.parse(line);return call.tool==='never_reply'&&call.outcome==='no_reply';}catch{return false;}}),
};
if(observationState.status==='computed') observed.x3={imageBytesEqual:observationState.imageBytesEqual,structuredContentEqual:observationState.structuredContentEqual};
let oldGenerationRejected=false;
try {
  const release=read(join(dir,'release-observation.json'));
  // 帧数不取自探针：门禁自己打开这份私有库数一遍，探针的自述只用来和它对齐。
  const database=new Database(join(dir,'private.sqlite'));
  const frames=database.prepare('SELECT count(*) AS n FROM mcp_frame').get().n;
  database.close();
  oldGenerationRejected=release.code==='lease_stale_generation'&&release.framesBefore===release.framesAfter&&release.framesAfter===frames&&frames>0;
} catch {}
observed.oldGenerationRejected=oldGenerationRejected;
sources.observed=observed;

// The harness owns both the evidence path and the expected behavior. A clause's
// projection is checked separately; choosing an unrelated equal value is invalid.
class ClauseContract extends Error {}
const sdkEntries=readdirSync('node_modules/.pnpm').filter(name=>name.startsWith('@modelcontextprotocol+sdk@'));
assert.equal(sdkEntries.length,1,'one unambiguous installed official SDK');
const expectedSdkVersion=read(join('node_modules/.pnpm',sdkEntries[0],'node_modules/@modelcontextprotocol/sdk/package.json')).version;
assert.equal(typeof expectedSdkVersion,'string');
const predicates={
  positiveCount:value=>Number.isInteger(value)&&value>0,
  imageData:value=>Number.isInteger(value)&&value>100,
  mcpTools:value=>Array.isArray(value)&&value.length>0&&value.every(name=>typeof name==='string'&&name.startsWith('mcp__')),
};
const REQUIRED = {
  1: {
    toolCount:{path:'x2.toolCount',expect:20},
    toolsListMatchesExpected:{path:'observed.toolsListMatchesExpected',expect:true},
    clientFrames:{path:'x2.workerDispatcherClientFrames',expect:{predicate:'positiveCount'}},
    serverFrames:{path:'x2.workerDispatcherServerFrames',expect:{predicate:'positiveCount'}},
    endToEndToolsList:{path:'x2.endToEndToolsList',expect:'pass'},
    officialSdkVersion:{path:'c.officialSdk.version',expect:expectedSdkVersion},
    officialSdkStdioConnected:{path:'sdk.stdioConnected',expect:true},
    officialSdkStreamableHttpConnected:{path:'sdk.streamableHttpConnected',expect:true},
    officialSdkStdioToolCount:{path:'sdk.stdioToolCount',expect:{predicate:'positiveCount'}},
    officialSdkHttpToolCount:{path:'sdk.httpToolCount',expect:{predicate:'positiveCount'}},
  },
  2: {
    activeMcpTools:{path:'c.surface.activeMcpTools',expect:expectedMcpSurfaceTools},
    allowlistExcludedNotify:{path:'c.surface.allowlistExcludedNotify',expect:true},
    allowedToolExecuted:{path:'c.surface.allowedToolExecuted',expect:true},
    hostServerNotStarted:{path:'c.surface.hostServerNotStarted',expect:true},
    hostServerAbsent:{path:'c.surface.hostServerAbsent',expect:true},
  },
  3: {
    distinctProcesses:{path:'c.isolation.distinctProcesses',expect:true},
    crossRootReadRejected:{path:'observed.crossRootReadRejected',expect:true},
    crossRootWriteRejected:{path:'observed.crossRootWriteRejected',expect:true},
    callRejected:{path:'c.disappearance.callRejected',expect:true},
    sessionTargetsUnchanged:{path:'c.disappearance.sessionTargetsUnchanged',expect:true},
    noWriteOnSurvivor:{path:'c.disappearance.noWriteOnSurvivor',expect:true},
  },
  4: {
    blockType:{path:'c.image.blockType',expect:'image'},
    mimeType:{path:'c.image.mimeType',expect:'image/png'},
    base64Length:{path:'c.image.base64Length',expect:{predicate:'imageData'}},
    bytesEqual:{path:'c.image.bytesEqual',expect:true},
    structuredContentEqual:{path:'c.image.structuredContentEqual',expect:true},
    throughSproutRelay:{path:'c.image.throughSproutRelay',expect:true},
    throughRealPiToolDefinition:{path:'c.image.throughRealPiToolDefinition',expect:true},
    // Gate-computed, not probe-declared: both values come from bounded raw observations the
    // probe wrote, compared here with strict string equality and isDeepStrictEqual.
    x3ImageBytesEqual:{path:'observed.x3.imageBytesEqual',expect:true},
    x3StructuredContentEqual:{path:'observed.x3.structuredContentEqual',expect:true},
  },
  5: {
    newToolDeclared:{path:'x3.listChanged.newToolDeclared',expect:true},
    newToolCallable:{path:'x3.listChanged.newToolCallable',expect:true},
    callReturned:{path:'x3.listChanged.callReturned',expect:true},
    callTextMatchesServer:{path:'x3.listChanged.callTextMatchesServer',expect:true},
    stillDeclaredAfterExplicitRefresh:{path:'x3.listChanged.stillDeclaredAfterExplicitRefresh',expect:true},
    blockedSurfaceOutcome:{path:'x3.refreshOnBlockedSurface.outcome',expect:'failed'},
    requestReachedServer:{path:'observed.timeoutRequestReachedServer',expect:true},
    oldGenerationRejected:{path:'observed.oldGenerationRejected',expect:true},
  },
  6: {
    autostart:{path:'y2.ownerManaged.autostart',expect:false},
    noSpawn:{path:'y2.ownerManaged.noSpawn',expect:true},
    aliveAfterDelete:{path:'y2.ownerManaged.runningAfterDelete',expect:true},
    aliveAfterWorkerExit:{path:'y2.ownerManaged.aliveAfterWorkerExit',expect:true},
    configuredServiceExited:{path:'observed.configuredServiceExited',expect:true},
    configuredServiceAliveAfterWorkerExit:{path:'y2.configuredService.aliveAfterWorkerExit',expect:false},
  },
  7: {
    summaryExists:{path:'docs.summaryExists',expect:true},
    designExists:{path:'docs.designExists',expect:true},
    evidenceIndexExists:{path:'docs.evidenceIndexExists',expect:true},
    keyCombinationsPresent:{path:'docs.keyCombinationsPresent',expect:true},
    evidenceScriptCurrent:{path:'docs.evidenceScriptCurrent',expect:true},
    evidenceSourceCommitAncestor:{path:'docs.evidenceSourceCommitAncestor',expect:true},
  },
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
// Which probe outputs each clause actually read. After all clauses run, every one of those probes
// must have exited 0; that binding lives here, not in a `passed()` call a clause body can omit.
const clauseProbeRefs = new Map();
const evidenceAt = (field,path) => {
  const value = resolvePath(path);
  if (value === undefined) {
    // A gate-computed value is missing for exactly one reason, and that reason decides the verdict:
    // the probe never captured observations (unproven) versus captured then broke its contract.
    if(path.startsWith('observed.')&&observationState.status!=='computed') {
      if(observationState.status==='unavailable') throw new EvidenceUnavailable(observationState.error);
      throw new ObservationContract(observationState.error);
    }
    if(path.startsWith('sdk.')&&sdkState.status!=='computed') {
      if(sdkState.status==='unavailable') throw new EvidenceUnavailable(sdkState.error);
      throw new ObservationContract(sdkState.error);
    }
    throw new ClauseContract(`R1-${currentClause}: 证据路径 ${path} 取不到值`);
  }
  projections.push({clause:currentClause,field,path,value});
  const probe=path.split('.')[0];
  if(['y2','x2','x3','c'].includes(probe)) {
    const refs=clauseProbeRefs.get(currentClause)??new Set();
    refs.add(probe); clauseProbeRefs.set(currentClause,refs);
  }
  return value;
};

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
  scopeMentionsMcpAndPhase:scope.includes('**MCP tools 接入**')&&scope.includes('已纳入一期'),
  evidenceScriptSha256:snapshot.scriptSha256,
  currentScriptSha256:currentScriptSha,
  evidenceScriptCurrent:snapshot.scriptSha256===currentScriptSha,
  evidenceSourceCommit:snapshot.sourceCommit,
  head,
  evidenceSourceCommitAncestor:ancestor,
};

const clauses = [
  // R1-1：stdio 与 streamableHttp 都真的跑通。y2 是编译后的真实 Worker CLI，x2 走真实中继。
  ()=>{
    passed('y2');passed('x2');
    assert.equal(evidenceAt('realWorkerCli','y2.worker.realCli'),true,'y2 跑的是编译后的真实 Worker CLI');
    assert.equal(evidenceAt('bundled','y2.worker.bundled'),true,'y2 的 Worker 是打包产物');
    assert.equal(evidenceAt('ownerManagedTarget','y2.ownerManaged.catalogTarget')!==undefined,true,'y2 的 owner_managed 是真实 catalog 目标');
    assert.equal(evidenceAt('configuredServiceSpawned','y2.configuredService.spawnedServerPidMatched'),true,'y2 的 configured_service 确实被 spawn');
    requireProbe('officialSdk');
    return {
      toolsListMatchesExpected:evidenceAt('toolsListMatchesExpected','observed.toolsListMatchesExpected'),
      toolCount:evidenceAt('toolCount','x2.toolCount'),
      clientFrames:evidenceAt('clientFrames','x2.workerDispatcherClientFrames'),
      serverFrames:evidenceAt('serverFrames','x2.workerDispatcherServerFrames'),
      endToEndToolsList:evidenceAt('endToEndToolsList','x2.endToEndToolsList'),
      officialSdkVersion:evidenceAt('officialSdkVersion','c.officialSdk.version'),
      officialSdkStdioConnected:evidenceAt('officialSdkStdioConnected','sdk.stdioConnected'),
      officialSdkStreamableHttpConnected:evidenceAt('officialSdkStreamableHttpConnected','sdk.streamableHttpConnected'),
      officialSdkStdioToolCount:evidenceAt('officialSdkStdioToolCount','sdk.stdioToolCount'),
      officialSdkHttpToolCount:evidenceAt('officialSdkHttpToolCount','sdk.httpToolCount'),
      transports:evidenceAt('transports','y2.worker.transports'),
    };
  },
  // R1-2：Pi 工具面、allowlist 与显式登记。
  ()=>{
    passed('x2');
    const surfaceProbe=requireProbe('surface');
    assert.equal(evidenceAt('catalogOnlyExplicitRegistrations','x2.catalogOnlyExplicitRegistrations'),true,'catalog 只含显式登记');
    const activeMcpTools=evidenceAt('activeMcpTools','c.surface.activeMcpTools');
    return {
      activeMcpTools,
      allowlistExcludedNotify:evidenceAt('allowlistExcludedNotify','c.surface.allowlistExcludedNotify'),
      allowedToolExecuted:evidenceAt('allowedToolExecuted','c.surface.allowedToolExecuted'),
      hostServerNotStarted:evidenceAt('hostServerNotStarted','c.surface.hostServerNotStarted'),
      hostServerAbsent:evidenceAt('hostServerAbsent','c.surface.hostServerAbsent'),
      probeStatus:surfaceProbe.status,
    };
  },
  // R1-3：指定实例、不同 root 隔离、不改投。
  ()=>{
    requireProbe('isolation');requireProbe('disappearance');
    return {
      distinctProcesses:evidenceAt('distinctProcesses','c.isolation.distinctProcesses'),
      crossRootReadRejected:evidenceAt('crossRootReadRejected','observed.crossRootReadRejected'),
      crossRootWriteRejected:evidenceAt('crossRootWriteRejected','observed.crossRootWriteRejected'),
      callRejected:evidenceAt('callRejected','c.disappearance.callRejected'),
      sessionTargetsUnchanged:evidenceAt('sessionTargetsUnchanged','c.disappearance.sessionTargetsUnchanged'),
      noWriteOnSurvivor:evidenceAt('noWriteOnSurvivor','c.disappearance.noWriteOnSurvivor'),
      simultaneousSessions:evidenceAt('simultaneousSessions','c.isolation.simultaneousSessions'),
    };
  },
  // R1-4：图片与 structuredContent 送达 Pi。C 探针的 bytesEqual/structuredContentEqual 来自它
  // 自己的逐字节与深度比较；x3 的两项由门禁从原始观察值重算（见 observationState）。本条款
  // 不写死任何一个值，也不接受探针自称的布尔。
  ()=>{
    passed('x3');
    requireProbe('image');
    // The clause's own evidence is the raw observations. Their classification decides the
    // verdict: nothing captured is unproven (INCONCLUSIVE); captured-then-missing is a
    // contradiction (FAIL).
    if(observationState.status==='unavailable') throw new EvidenceUnavailable(observationState.error);
    if(observationState.status!=='computed') throw new ObservationContract(observationState.error);
    return {
      blockType:evidenceAt('blockType','c.image.blockType'),
      mimeType:evidenceAt('mimeType','c.image.mimeType'),
      base64Length:evidenceAt('base64Length','c.image.base64Length'),
      bytesEqual:evidenceAt('bytesEqual','c.image.bytesEqual'),
      structuredContentEqual:evidenceAt('structuredContentEqual','c.image.structuredContentEqual'),
      throughSproutRelay:evidenceAt('throughSproutRelay','c.image.throughSproutRelay'),
      throughRealPiToolDefinition:evidenceAt('throughRealPiToolDefinition','c.image.throughRealPiToolDefinition'),
      x3ImageBytesEqual:evidenceAt('x3ImageBytesEqual','observed.x3.imageBytesEqual'),
      x3StructuredContentEqual:evidenceAt('x3StructuredContentEqual','observed.x3.structuredContentEqual'),
    };
  },
  // R1-5：资源、目录变化、重建、超时与旧代次。`newToolCallable` 必须来自 x3 那次真实调用
  // （调用回了 content 且文本等于 server 回的 `called:added-1`），不是字面量。
  ()=>{
    passed('y2');passed('x3');
    assert.equal(evidenceAt('sameProcessId','y2.sessions.sameProcessId'),true,'同一 process 重开 session');
    assert.equal(evidenceAt('newSessionId','y2.sessions.newSessionId'),true,'重开拿到新 session id');
    assert.equal(evidenceAt('sqliteConcurrentActiveRejected','y2.sessions.sqliteConcurrentActiveRejected'),true,'并发活动 session 被 SQLite 拒绝');
    assert.equal(evidenceAt('blockedSurfaceDiagnostic','x3.refreshOnBlockedSurface.diagnosticPresent'),true,'受阻工具面留下诊断');
    return {
      newToolDeclared:evidenceAt('newToolDeclared','x3.listChanged.newToolDeclared'),
      newToolCallable:evidenceAt('newToolCallable','x3.listChanged.newToolCallable'),
      callReturned:evidenceAt('callReturned','x3.listChanged.callReturned'),
      callTextMatchesServer:evidenceAt('callTextMatchesServer','x3.listChanged.callTextMatchesServer'),
      stillDeclaredAfterExplicitRefresh:evidenceAt('stillDeclaredAfterExplicitRefresh','x3.listChanged.stillDeclaredAfterExplicitRefresh'),
      blockedSurfaceOutcome:evidenceAt('blockedSurfaceOutcome','x3.refreshOnBlockedSurface.outcome'),
      oldGenerationRejected:evidenceAt('oldGenerationRejected','observed.oldGenerationRejected'),
      requestReachedServer:evidenceAt('requestReachedServer','observed.timeoutRequestReachedServer'),
      resources:requireProbe('resources'),
      sessionRebuild:requireProbe('detach'),
      timeout:requireProbe('timeout'),
    };
  },
  // R1-6：生命周期与已有服务登记。
  ()=>{
    passed('y2');
    requireProbe('detach');requireProbe('release');
    return {
      autostart:evidenceAt('autostart','y2.ownerManaged.autostart'),
      noSpawn:evidenceAt('noSpawn','y2.ownerManaged.noSpawn'),
      aliveAfterDelete:evidenceAt('aliveAfterDelete','y2.ownerManaged.runningAfterDelete'),
      aliveAfterWorkerExit:evidenceAt('aliveAfterWorkerExit','y2.ownerManaged.aliveAfterWorkerExit'),
      configuredServiceExited:evidenceAt('configuredServiceExited','observed.configuredServiceExited'),
      configuredServiceAliveAfterWorkerExit:evidenceAt('configuredServiceAliveAfterWorkerExit','y2.configuredService.aliveAfterWorkerExit'),
      detach:requireProbe('detach'),
      release:requireProbe('release'),
    };
  },
  // R1-7：只校验**可以机器判定**的东西 —— 文档存在、关键组合词出现、证据快照与当前脚本/代码
  // 一致。文档内容是否与代码相符需要人读，本条款不保证，也不假装保证（见 summary 已知限制）。
  ()=>{
    assert.equal(evidenceAt('summaryMentionsStage','docs.summaryMentionsStage'),true,'summary.md 写了纳入阶段');
    assert.equal(evidenceAt('summaryHasNoPendingMarker','docs.summaryHasNoPendingMarker'),true,'summary.md 没有留下「待 z3 运行」');
    assert.equal(evidenceAt('scopeMentionsMcpAndPhase','docs.scopeMentionsMcpAndPhase'),true,'范围文档写了 MCP 接入且已纳入一期');
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
const pending=[];
for(const [index,check] of clauses.entries()) {
  currentClause=index+1;
  let status='PASS',assertions,error;
  const requirements=REQUIRED[currentClause];
  const verified={};
  projections=[];
  try {
    // Always read canonical paths and evaluate expectations before entering the body.
    for(const [field,{path,expect}] of Object.entries(requirements)) {
      const value=evidenceAt(field,path);
      if(expect!==null&&typeof expect==='object'&&'predicate' in expect) {
        assert(predicates[expect.predicate](value),`R1-${currentClause}: ${field} at ${path} must satisfy ${expect.predicate}`);
      } else {
        assert.deepEqual(value,expect,`R1-${currentClause}: ${field} at ${path} must equal ${JSON.stringify(expect)}`);
      }
      verified[field]={path,expect,value};
    }
    projections=[]; // Only body reads can supply its projection provenance.
    assertions=check();
  }
  catch(e) {
    // Missing evidence is inconclusive; an executed probe's failed assertion or a broken
    // evidence commitment is a failure.
    status=e instanceof EvidenceUnavailable?'INCONCLUSIVE':'FAIL'; error=e.message;
  }
  if(status==='PASS') {
    try {
      // The returned projection must be complete and use the harness-owned path.
      if(assertions===null||typeof assertions!=='object') throw new ClauseContract(`R1-${currentClause}: 条款必须返回断言对象，实测 ${JSON.stringify(assertions)}`);
      const missing=Object.keys(requirements).filter(field=>!Object.hasOwn(assertions,field));
      if(missing.length) throw new ClauseContract(`R1-${currentClause}: 缺少必需字段 ${missing.join(', ')} —— 条款没有真的核过这些要求`);
      for(const [field,{path}] of Object.entries(requirements)) {
        const reads=projections.filter(p=>p.field===field);
        if(!reads.length) throw new ClauseContract(`R1-${currentClause}: 字段 ${field} 没有任何证据取值路径（疑似写死）`);
        if(reads.some(p=>p.path!==path)) throw new ClauseContract(`R1-${currentClause}: 字段 ${field} 必须取自 ${path}，实测 ${reads.map(p=>p.path).join(', ')}`);
        assert.deepEqual(assertions[field],verified[field].value,`R1-${currentClause}: 字段 ${field} 与证据 ${path} 不一致（写死的值不等于实测值）`);
      }
    } catch(e) {
      status=e instanceof EvidenceUnavailable?'INCONCLUSIVE':'FAIL'; assertions=undefined; error=e.message;
    }
  }
  const path=join(dir,`clause-${currentClause}.json`);
  const provenances=[...new Map(projections.map(p=>[`${p.field}@${p.path}`,p])).values()].map(({field,path})=>({field,path}));
  // Every executed value is persisted: comparisons the gate computed, never the values behind
  // them. Raw observations stay in the private run directory and are never serialized here.
  const gateComputed=currentClause===4?{
    rawObservationState:observationState.status,
    ...(observationState.status==='computed'?{
      imageBytesEqual:observationState.imageBytesEqual,
      structuredContentEqual:observationState.structuredContentEqual,
    }:{}),
    ...(observationState.error?{reason:observationState.error}:{}),
  }:undefined;
  const record={clause:currentClause,status,verified,...(assertions?{assertions}:{}),...(status==='PASS'?{projections:provenances}:{}),...(error?{error}:{}),...(gateComputed?{gateComputed}:{}),executions};
  const evidencePath=relative(process.cwd(),path);
  pending.push({path,record});
  results.push({clause:currentClause,status,evidencePath});
}
// Structural exit-code binding: a clause cannot opt out of it. Every probe whose output a clause
// read must have exited 0; a timeout, launch failure or non-zero exit is FAIL here regardless of
// what the clause body did or which `passed()` calls it remembered to make.
for(const {record} of pending) {
  const refs=clauseProbeRefs.get(record.clause)??new Set();
  const failed=[...refs].filter(name=>{
    const execution=executions[name];
    return !execution||execution.timedOut||execution.launchError||execution.exitCode!==0;
  });
  if(failed.length) {
    record.status='FAIL';
    record.error=`探针退出码非 0：${failed.join(', ')}`;
    delete record.assertions; delete record.projections;
  }
}
for(const [index,{path,record}] of pending.entries()) {
  writeFileSync(path,JSON.stringify(record,null,2)+'\n');
  results[index].status=record.status;
  console.log(`${record.status} R1-${record.clause} ${results[index].evidencePath}`);
}
writeFileSync(join(dir,'evidence.json'),JSON.stringify({schemaVersion:1,generatedAt:new Date().toISOString(),sourceCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),scriptSha256:createHash('sha256').update(readFileSync('scripts/verify/z3-mcp-acceptance.sh')).digest('hex'),results,executions},null,2)+'\n');
writeFileSync(join(dir,'run.log'),results.map(r=>`${r.status} R1-${r.clause} ${r.evidencePath}`).join('\n')+'\n');
process.exitCode=results.every(r=>r.status==='PASS')?0:1;
RUNNER
node "$run_dir/run.mjs"
