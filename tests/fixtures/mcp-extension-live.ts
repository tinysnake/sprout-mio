import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { McpCatalogView, McpConfig } from "../../src/contracts/mcp";
import type { WorkerExchangeRemoteInput } from "../../src/contracts/worker";
import { sqlite } from "../../src/db";
import { loadPiMcp } from "../../src/extension/mcp-load";
import { connectSproutMcp } from "../../src/extension/mcp-client";
import { mcpToolName } from "../../src/extension/mcp-tools";
import { createRemoteClient } from "../../src/extension/remote-client";
import { readResponseForProbe } from "./mcp-extension-probe";
import { mcpHoldCount, mcpSessionExchange } from "../../src/server/mcp-relay";
import { createMachine } from "../../src/domain/machine";
import { enrollWorker, openWorker, exchangeWorker } from "../../src/server/worker-gateway";
import { McpRuntime } from "../../src/worker/mcp";
import { RemoteDispatcher } from "../../src/worker/remote";
import { mcpHash } from "../../src/domain/mcp/protocol";
import { probeNativePiVersion } from "./mcp-native-version";
import { measureWakeControls } from "./mcp-integration-wake";
import { remoteAgentResponse } from "../../src/server/remote-agent-gateway";
import { issueRemoteToolGrant } from "../../src/server/remote-agent-gateway";
import { PiSessionProcess } from "../../src/server/pi-host/process";
import { machineRuntimeContext, startRuntime } from "../../src/server/runtime";
import type { AgentRemoteContext } from "../../src/server/lease";

/** Real HTTP agent gateway, authenticated Worker exchanges and production dispatcher.
 * Only actor/lease fixtures are seeded; all MCP rows and frames come from production code.
 */

const evidencePath = process.env.X2_EVIDENCE ?? "/tmp/x2-mcp-extension-evidence.json";
const directory = process.env.X2_DIR ?? "/tmp/x2-mcp-extension";
mkdirSync(directory, { recursive: true });
const pass = (name: string) => console.log(`PASS ${name}`);
const HOUR = 3_600_000;

await startRuntime();
const runtime = await machineRuntimeContext();
const bootId = runtime.bootId;

// ---------------------------------------------------------------- 真实 Pi MCP 导出探测
const piMcp = await loadPiMcp();
const mcpPackage = JSON.parse(readFileSync(join(piMcp.root, "package.json"), "utf8"));
assert.equal(mcpPackage.name, "@earendil-works/pi-mcp");
const piMcpVersion = typeof mcpPackage.version === "string" ? mcpPackage.version : null;
const nativePiVersionEvidence = await probeNativePiVersion(join(piMcp.root, "dist/index.js"));
assert(piMcp.exportNames.includes("McpClient"));
assert(piMcp.exportNames.includes("parseJsonRpcMessage"));
pass(`真实 pi-mcp ${piMcpVersion} 已解析：${piMcp.exportNames.length} 个导出`);

// ---------------------------------------------------------------- 隔离库里的真实主体
const insert = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
insert(
  "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,'X2','x2@mcp.test',0,1,1)",
  "owner",
);
const projectId = newId(ID_PREFIXES.project);
insert("INSERT INTO project(id,name,created_by) VALUES (?,'X2','owner')", projectId);
const workerContext = {
  userId: "owner",
  bootId,
  now: new Date(),
  requestId: newId(ID_PREFIXES.request),
};
const machine = createMachine({ name: "Integration MCP" }, workerContext);
const machineId = machine.detail.machine.id;
insert(
  "INSERT INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,'owner',1,1,1)",
  projectId,
  machineId,
);
const workerSecret = randomBytes(32).toString("base64url");
const wire = {
  machineId,
  secret: workerSecret,
  version: 3 as const,
  requestId: newId(ID_PREFIXES.request),
};
enrollWorker({ ...wire, ticket: machine.ticket }, workerContext);
const worker = openWorker({ ...wire, attemptId: randomUUID() }, workerContext).session;
const capability = {
  platform: process.platform as "darwin",
  arch: process.arch as "arm64",
  workerVersion: "integration-source",
  shells: [],
  remoteOperations: ["file_read" as const],
  mcpRelay: {
    version: 1 as const,
    transports: ["stdio" as const],
    maxMessageBytes: 131072 as const,
  },
};

const profileId = newId(ID_PREFIXES.agentProfile);
const chatId = newId(ID_PREFIXES.chat);
const instanceId = newId(ID_PREFIXES.instance);
const runId = newId(ID_PREFIXES.run);
let grantId = "";
insert("INSERT INTO agent_profile(id,name,created_by) VALUES (?,'X2 agent','owner')", profileId);
insert(
  "INSERT INTO chat(id,project_id,kind,created_by) VALUES (?,?,'dm','owner')",
  chatId,
  projectId,
);
insert(
  "INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)",
  chatId,
  profileId,
);
insert(
  "INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)",
  instanceId,
  profileId,
  chatId,
  projectId,
);
insert(
  "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
  runId,
  instanceId,
  chatId,
  projectId,
  newId(ID_PREFIXES.request),
  Date.now(),
  randomUUID(),
);
// 真实 grant 的 secret 形状：43 个 base64url 字符。
// grant 必须由生产入口签发：`authenticate` 还要求进程内 identity registry 里有活进程。
const runnerPath = join(directory, "grant-runner.mjs");
writeFileSync(
  runnerPath,
  "import {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', () => {});\n",
);
const grantProcess = new PiSessionProcess("x2-grant-holder", runnerPath);
const grant = issueRemoteToolGrant(runId, grantProcess, {
  bootId: runtime.bootId,
  requestId: newId(ID_PREFIXES.request),
  now: new Date(),
});
const secret = grant.secret;
// grant id 不对外暴露；session 行里取回。
grantId = (
  sqlite
    .prepare("SELECT id FROM remote_tool_grant WHERE project_id=? AND revoked_at IS NULL")
    .get(projectId) as { id: string }
).id;
assert.equal(grant.projectId, projectId);

insert(
  "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,?)",
  projectId,
  machineId,
  instanceId,
  Date.now(),
);
insert(
  "INSERT INTO lease_authorization(project_id,machine_id,generation,holder_instance_id,state,issued_at,reason) VALUES (?,?,1,?,'active',?,'acquire')",
  projectId,
  machineId,
  instanceId,
  Date.now(),
);

// Explicit configuration is consumed by the real Machine-side runtime.
const registrationId = newId(ID_PREFIXES.mcpRegistration);
const config: McpConfig = {
  transport: "stdio",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-everything@2.0.1"],
  workingDirectory: "/tmp",
  launch: "configured_service",
  autostart: true,
  exposure: "wire",
  roots: [{ uri: "file:///tmp" }],
  exposeSampling: true,
  elicitation: "cancel",
  requestTimeoutMs: 120_000,
};
const configured = {
  id: registrationId,
  revision: 1,
  projectId,
  machineId,
  name: "everything",
  transport: "stdio" as const,
  configRef: "everything",
  configHash: mcpHash(config),
  configJson: config,
  createdAt: Date.now(),
  retiredAt: null,
};
const workerRuntime = new McpRuntime([configured]);
await workerRuntime.start();
const dispatcher = new RemoteDispatcher(worker, capability, Date.now, workerRuntime);
let dispatcherAcceptedSeq = 0;
// Normal exchanges advance this row only when the authenticated gateway commits.
// Read it for every batch so a rejected or rolled-back exchange cannot consume a seq.
const committedExchangeSeq = () => {
  const row = sqlite
    .prepare("SELECT seq FROM machine_connection WHERE machine_id=? AND generation=?")
    .get(machineId, worker.generation) as { seq: number };
  return row.seq;
};
const exchangeBatch = (remote: WorkerExchangeRemoteInput) => {
  workerContext.now = new Date();
  const exchangeSeq = committedExchangeSeq() + 1;
  return exchangeWorker(
    {
      ...wire,
      session: worker,
      seq: exchangeSeq,
      mode: "normal",
      capability,
      observations: [],
      remote,
    },
    workerContext,
  );
};
let receivedFrames = 0;
let dispatchedFrames = 0;
const frameCommits: { sessionId: string; at: number }[] = [];
const httpExchanges: {
  elapsedMs: number;
  requestedHoldMs: number;
  holdEntered: boolean;
  frames: number;
  newFrameCommitted: boolean;
}[] = [];
const tick = () => {
  const outgoing = dispatcher.outgoing();
  const newFrames = outgoing.mcp.filter(
    (item) =>
      item.type === "frame" &&
      !sqlite.prepare("SELECT id FROM mcp_frame WHERE id=?").get(item.frameId),
  );
  const response = exchangeBatch(outgoing);
  for (const item of newFrames)
    if (item.type === "frame")
      frameCommits.push({ sessionId: item.sessionId, at: performance.now() });
  receivedFrames += outgoing.mcp.filter((item) => item.type === "frame").length;
  dispatchedFrames += response.remote.mcp.filter(
    (item: { type: string }) => item.type === "frame",
  ).length;
  dispatcher.accept(response, response.seq, []);
  dispatcherAcceptedSeq = response.seq;
};
tick();
// A rejected MCP fact must leave the committed sequence available for the next tick.
const rejectedExchangeBeforeSeq = committedExchangeSeq();
assert.throws(
  () =>
    exchangeBatch({
      ...dispatcher.outgoing(),
      mcp: [
        { type: "registration_fact", registration: { ...configured, configHash: "0".repeat(64) } },
      ],
    }),
  { code: "remote_request_conflict" },
);
const rejectedExchangeAfterSeq = committedExchangeSeq();
assert.equal(rejectedExchangeAfterSeq, rejectedExchangeBeforeSeq);
tick();
assert.equal(dispatcherAcceptedSeq, rejectedExchangeBeforeSeq + 1);
const processRow = sqlite
  .prepare("SELECT id,pid FROM mcp_server_process WHERE registration_id=? AND state='running'")
  .get(registrationId) as { id: string; pid: number };
assert(processRow?.pid > 0, "real runtime advertised its spawned server PID");
const processId = processRow.id;
let tickError: unknown;
const timer = setInterval(() => {
  try {
    tick();
  } catch (error) {
    tickError = error;
    clearInterval(timer);
  }
}, 10);

// ---------------------------------------------------------------- 真实 HTTP 边界
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
    const call = JSON.parse(body).call;
    const startedAt = performance.now();
    const holdsBefore = mcpHoldCount();
    const headers = new Headers();
    for (const [key, value] of Object.entries(request.headers))
      if (typeof value === "string") headers.set(key, value);
    headers.set("x-sprout-request-id", newId(ID_PREFIXES.request));
    headers.set("content-type", "application/json");
    // 走生产网关的同一个函数；只跳过 nitro 的路由层。
    const answer = await remoteAgentResponse(
      new Request(`${origin.origin}/api/remote/agent`, {
        method: "POST",
        headers,
        body,
      }),
    );
    response.statusCode = answer.status;
    answer.headers.forEach((value, key) => response.setHeader(key, value));
    const resultBytes = Buffer.from(await answer.arrayBuffer());
    if (call.type === "mcp_session_exchange") {
      const result = JSON.parse(resultBytes.toString("utf8"));
      httpExchanges.push({
        elapsedMs: performance.now() - startedAt,
        requestedHoldMs: call.input.holdMs,
        holdEntered: mcpHoldCount() > holdsBefore,
        frames: result.data?.frames?.length ?? 0,
        newFrameCommitted: frameCommits.some(
          (frame) => frame.sessionId === call.input.sessionId && frame.at >= startedAt,
        ),
      });
    }
    response.end(resultBytes);
  });
});
// 网关（`remoteAgentResponse`）要求请求 origin 等于 `config.APP_ORIGIN`，而 config 在 import
// 时就冻结了，所以端口必须由 shell 先选定并通过 APP_ORIGIN 传入，不能 listen(0)。
const origin = new URL(process.env.APP_ORIGIN ?? "");
const port = Number(origin.port);
server.listen(port, origin.hostname);
await once(server, "listening");

const remote = createRemoteClient({
  endpoint: `${origin.origin}/api/remote/agent`,
  secret,
  projectId,
  expiresAt: new Date(Date.now() + HOUR).toISOString(),
});

// ---------------------------------------------------------------- catalog 走真实 HTTP
const catalog = (await readResponseForProbe(remote, {
  version: 2,
  call: { type: "mcp_catalog_get", input: { projectId, machineId, authorizationGeneration: 1 } },
})) as McpCatalogView;
assert.equal(catalog.registrations.length, 1);
assert.equal(catalog.registrations[0]!.name, "everything");
assert.equal(catalog.registrations[0]!.processes.length, 1);
assert(!JSON.stringify(catalog).includes("server-everything@2.0.1"), "catalog 不返回命令或参数");
pass("真实 HTTP 的 mcp_catalog_get 只返回显式登记，不含命令/参数");

// Native Pi performs initialize and tools/list through the real dispatcher.
const handlerOrder: string[] = [];
const Base = piMcp.McpClient as unknown as new (options: never) => {
  setRequestHandler(method: string, handler: unknown): () => void;
  connect(transport: unknown): Promise<unknown>;
};
class ObservedClient extends Base {
  override setRequestHandler(method: string, handler: unknown) {
    handlerOrder.push(`handler:${method}`);
    return super.setRequestHandler(method, handler);
  }
  override async connect(transport: unknown) {
    handlerOrder.push("connect");
    return super.connect(transport);
  }
}

const connection = await connectSproutMcp(
  { ...piMcp, McpClient: ObservedClient as unknown as typeof piMcp.McpClient },
  remote,
  {
    registration: catalog.registrations[0] as never,
    process: catalog.registrations[0]!.processes[0] as never,
    authorizationGeneration: 1,
    holdMs: 2000,
    handlers: {
      sampling: async () => ({ role: "assistant", content: { type: "text", text: "fixture" } }),
      elicitation: async () => ({ action: "cancel" }),
    },
  },
);
if (tickError) throw tickError;
const sessionId = connection.transport.sessionId!;
assert(sessionId, "transport 打开了 MCP session");
assert.deepEqual(handlerOrder.slice(-1), ["connect"]);
assert.deepEqual(handlerOrder.slice(0, -1).sort(), [
  "handler:elicitation/create",
  "handler:roots/list",
  "handler:sampling/createMessage",
]);
const attached = sqlite
  .prepare("SELECT state,attached_at,connected_at,protocol_version FROM mcp_session WHERE id=?")
  .get(sessionId) as {
  state: string;
  attached_at: number | null;
  connected_at: number | null;
  protocol_version: string | null;
};
assert.equal(attached.state, "connected");
assert(attached.attached_at !== null && attached.connected_at !== null);
assert(attached.protocol_version !== null);
pass("真实 Pi McpClient 通过 Sprout 通道完成 initialize 与 tools/list");

const rawToolNames = connection.tools.map((tool) => tool.name).sort();
// z2 owns the pinned server's expected names. Read its JavaScript assertion without
// executing the shell script, so x2 and z2 cannot silently drift to different lists.
const integrationScript = readFileSync(resolve("scripts/verify/z2-mcp-integration.sh"), "utf8");
const integrationJs = integrationScript.split("<<'NODE'\n")[1]?.split("\nNODE")[0];
assert(integrationJs, "z2 必须提供 NODE 验收脚本");
const integrationAst = ts.createSourceFile(
  "z2.mjs",
  integrationJs,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const expectedArrays: ts.ArrayLiteralExpression[] = [];
const visitExpectedTools = (node: ts.Node): void => {
  if (
    ts.isVariableDeclaration(node) &&
    ts.isIdentifier(node.name) &&
    node.name.text === "expectedEverythingTools"
  ) {
    const initializer = node.initializer;
    assert(
      initializer &&
        ts.isCallExpression(initializer) &&
        ts.isPropertyAccessExpression(initializer.expression),
    );
    assert.equal(initializer.expression.name.text, "sort");
    assert(ts.isArrayLiteralExpression(initializer.expression.expression));
    expectedArrays.push(initializer.expression.expression);
  }
  ts.forEachChild(node, visitExpectedTools);
};
visitExpectedTools(integrationAst);
assert.equal(expectedArrays.length, 1, "z2 必须有唯一 expectedEverythingTools 数组");
const expectedToolNames = expectedArrays[0]!.elements
  .map((element) => {
    assert(ts.isStringLiteral(element), "z2 预期工具名必须为字符串字面量");
    return element.text;
  })
  .sort();
const toolsListMatchesExpected = isDeepStrictEqual(rawToolNames, expectedToolNames);
const toolNames = connection.tools.map((tool) => mcpToolName("everything", tool.name)).sort();
// 数量从 z2 的期望名单推导（上一段已用 AST 读出并断言同名），不另存一份常量。
assert.equal(toolNames.length, expectedToolNames.length, "pinned server-everything tools/list");
assert(toolNames.every((name) => name.startsWith("mcp__everything__")));
pass(`真实 tools/list 返回 ${toolNames.length} 个工具`);
const realFrameWakes = httpExchanges.filter(
  (exchange) =>
    exchange.requestedHoldMs === 2000 &&
    exchange.holdEntered &&
    exchange.newFrameCommitted &&
    exchange.frames > 0,
);
assert(
  realFrameWakes.some((exchange) => exchange.elapsedMs < 500),
  "a real MCP server frame must wake an active HTTP hold before timeout",
);

// ---------------------------------------------------------------- drain 交互
const drainScope = globalThis as typeof globalThis & {
  sproutHttpDrain?: { draining?: boolean };
};
drainScope.sproutHttpDrain = { draining: true };
const drainStart = Date.now();
await mcpSessionExchange(
  {
    projectId,
    machineId,
    authorizationGeneration: 1,
    sessionId: connection.transport.sessionId!,
    frames: [],
    ackServerSeq: 0,
    cancelClientSeqs: [],
    protocolVersion: null,
    confirmInitialized: false,
    holdMs: 2000,
  },
  {
    ...runtime,
    userId: "owner",
    projectId,
    chatId,
    instanceId,
    runId,
    grantId,
    requestId: newId(ID_PREFIXES.request),
  } as AgentRemoteContext,
);
const drainMs = Date.now() - drainStart;
assert(drainMs < 100, `draining 期间 exchange 必须 < 100 ms，实测 ${drainMs} ms`);
drainScope.sproutHttpDrain = undefined;
pass(`draining 期间 mcp_session_exchange 响应 ${drainMs} ms（< 100 ms）`);

// ---------------------------------------------------------------- 真实 Pi 加载扩展
const runtimeEvidence = await loadExtensionInRealRuntime();

// ---------------------------------------------------------------- close
clearInterval(timer);
if (tickError) throw tickError;
assert.equal(dispatcherAcceptedSeq, committedExchangeSeq());
await connection.close();
assert(process.kill(processRow.pid, 0), "closing Pi session preserves the actual server process");
// A process identity is currently single-use (mcp_session_process_unique).
// Timing controls use a second real process, leaving the measured MCP client alone.
const controlRuntime = new McpRuntime([configured]);
await controlRuntime.start();
const controlDispatcher = new RemoteDispatcher(worker, capability, Date.now, controlRuntime);
// The main dispatcher is stopped. Advertise the independent control runtime through
// its own committed exchange; that response must not advance dispatcherAcceptedSeq.
const controlResponse = exchangeBatch(controlDispatcher.outgoing());
const controlProcess = sqlite
  .prepare(
    "SELECT id,worker_incarnation_id FROM mcp_server_process WHERE registration_id=? AND id<>? AND state='running'",
  )
  .get(registrationId, processId) as { id: string; worker_incarnation_id: string };
assert(controlProcess);
const wakeControls = await measureWakeControls({
  remote,
  runtime,
  projectId,
  machineId,
  chatId,
  instanceId,
  runId,
  grantId,
  worker,
  workerContext,
  capability,
  wire,
  nextSeq: () => committedExchangeSeq() + 1,
  registration: catalog.registrations[0]!,
  process: {
    processId: controlProcess.id,
    workerIncarnationId: controlProcess.worker_incarnation_id,
    lastObservedAt: Date.now(),
  },
});
assert.equal(controlResponse.seq, dispatcherAcceptedSeq + 1);
// Only the successful wake trial commits; the outer-rollback trial consumes no seq.
assert.equal(committedExchangeSeq(), controlResponse.seq + 1);
await controlRuntime.stop();
assert.equal(
  sqlite.prepare("SELECT state FROM mcp_server_process WHERE id=?").get(processId)?.state,
  "running",
);
// 收尾：真实 grant 进程与 runner 一起退出。
await grantProcess.close().catch(() => undefined);
pass("关闭 Pi 侧 session 后 Machine 上的 server 进程行状态仍 running（standing order 6）");

const evidence = {
  ...nativePiVersionEvidence,
  piMcpVersion,
  piMcpRoot: piMcp.root,
  piMcpExports: piMcp.exportNames,
  handlerOrder,
  catalogRegistrations: catalog.registrations.length,
  catalogOnlyExplicitRegistrations:
    catalog.registrations.length === 1 &&
    catalog.registrations[0]!.registrationId === registrationId,
  catalogHidesLaunchConfig: !JSON.stringify(catalog).includes(config.command),
  hostDrainsInTime: drainMs < 100,
  drainExchangeMs: drainMs,
  endToEndToolsList:
    dispatchedFrames > 0 && receivedFrames > 0 && toolsListMatchesExpected ? "pass" : "failed",
  toolsListMatchesExpected,
  realServer: config.args[1],
  realServerToolCount: toolNames.length,
  toolCount: toolNames.length,
  workerExchanges: committedExchangeSeq(),
  sequenceEvidence: {
    dispatcherAcceptedSeq,
    controlCommittedSeq: controlResponse.seq,
    finalCommittedSeq: committedExchangeSeq(),
    rejectedExchangeBeforeSeq,
    rejectedExchangeAfterSeq,
  },
  workerDispatcherClientFrames: dispatchedFrames,
  workerDispatcherServerFrames: receivedFrames,
  serverPid: processRow.pid,
  attached,
  wakeControls,
  toolNames,
  rawToolNames,
  realFrameWakes,
  extensionRuntimeToolCount: runtimeEvidence.tools.length,
  extensionRuntimeTools: runtimeEvidence.tools,
  extensionRuntimeSdk: runtimeEvidence.sdkVersion,
  scope:
    "Native Pi client, HTTP agent gateway, authenticated exchangeWorker/applyRemoteExchange, production RemoteDispatcher/McpRuntime, spawned MCP stdio process. Worker dispatcher runs in fixture process; dist/worker/main.js is not used here.",
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
await workerRuntime.stop();
server.closeAllConnections();
server.close();
// Runtime and SDK loaders retain handles; after cleanup and evidence, exit explicitly.
// 避免验收脚本挂在「进程不退出」而不是「断言失败」上。
console.log("DONE x2 mcp extension");
process.exit(0);

/**
 * 真实 pi-host-runner 加载本 extension 的探针：复用既有 runner 与托管 SDK。
 *
 * 注意：`scripts/pi-host-runner.mjs` 用 `createJiti` 加载 extension 入口，而它的 resolve 钩子
 * 只把 `@earendil-works/pi-ai/compat` 重定向到托管 SDK；extension 入口里 `../contracts/version`
 * 这类**无扩展名**相对导入在纯 ESM 解析下不成立（`pi/sprout-extension.ts` 没有深层导入，
 * 所以既有夹具没暴露这一点）。因此这里用托管 SDK 的 `DefaultResourceLoader` + 同一个
 * `extensionFactories` 机制加载真实 extension 代码与真实 `pi` API，不再走 runner 的 stdin 协议。
 * 这一条不是「真实 Pi session 跑完一轮」，只是「真实 Pi 扩展运行时装到了本 extension」。
 */
async function loadExtensionInRealRuntime(): Promise<{ tools: string[]; sdkVersion: string }> {
  const piMcp = await loadPiMcp();
  const sdkRoot = join(piMcp.root, "..", "pi-coding-agent");
  const sdk = (await import(pathToFileURL(join(sdkRoot, "dist", "index.js")).href)) as {
    DefaultResourceLoader: new (options: Record<string, unknown>) => {
      reload(): Promise<void>;
      getExtensions(): { errors: unknown[]; extensions: { path: string }[] };
    };
    SettingsManager: { inMemory(snapshot: Record<string, unknown>): unknown };
  };
  const registered = new Map<string, unknown>();
  const { default: sproutExtension } = (await import(
    pathToFileURL(join(resolve("."), "src", "extension", "main.ts")).href
  )) as { default: (pi: never) => void };
  const loader = new sdk.DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, ".sprout-pi"),
    settingsManager: sdk.SettingsManager.inMemory({ retry: { enabled: false } }),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    extensionFactories: [
      {
        name: "sprout-extension",
        factory: (pi: { registerTool(tool: { name: string }): void }) => {
          // 先接管再调用扩展，否则扩展注册的第一批工具不会经过探针。
          const register = pi.registerTool.bind(pi);
          pi.registerTool = (tool: { name: string }) => {
            registered.set(tool.name, tool);
            register(tool);
          };
          sproutExtension(pi as never);
        },
      },
    ],
  });
  await loader.reload();
  const loaded = loader.getExtensions();
  assert.equal(loaded.errors.length, 0, "真实 Pi resource loader 无扩展加载错误");
  const tools = [...registered.keys()].sort();
  assert(tools.includes("sprout_status"), "真实 Pi 装到了本 extension 的工具");
  assert(
    !tools.some((name) => name.startsWith("mcp__")),
    "未登记的 server 不得进入工具面（不扫描宿主 mcp.json）",
  );
  const pkg = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8")) as {
    name: string;
    version: string;
  };
  assert.equal(pkg.name, "@earendil-works/pi-coding-agent");
  pass(
    `真实 Pi ${pkg.version} DefaultResourceLoader 装到 extension：${tools.length} 个工具，无 mcp__ 前缀`,
  );
  return { tools, sdkVersion: pkg.version };
}
