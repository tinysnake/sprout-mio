import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { McpConfig } from "../../src/contracts/mcp";
import { sqlite } from "../../src/db";
import { loadPiMcp } from "../../src/extension/mcp-load";
import { connectSproutMcp } from "../../src/extension/mcp-client";
import { mcpToolName } from "../../src/extension/mcp-tools";
import { createRemoteClient } from "../../src/extension/remote-client";
import { readResponseForProbe } from "./mcp-extension-probe";
import { mcpSessionExchange, wakeMcpSession } from "../../src/server/mcp-relay";
import { remoteAgentResponse } from "../../src/server/remote-agent-gateway";
import { issueRemoteToolGrant } from "../../src/server/remote-agent-gateway";
import { PiSessionProcess } from "../../src/server/pi-host/process";
import { machineRuntimeContext, startRuntime } from "../../src/server/runtime";
import type { AgentRemoteContext } from "../../src/server/lease";

/**
 * x2 的驱动：真实 runtime + 真实 HTTP + 真实 SQLite + 真实 Pi MCP 客户端 + 真实 MCP server 进程。
 *
 * 唯一被替换的一环是 **Machine 侧 dispatcher**：本单元没有 `src/worker/**` 的写权限，
 * 而 `applyRemoteExchange` 的 `input.mcp` 消费属于 `r1-worker`。所以这里用脚本内的
 * 「stand-in dispatcher」代跑那一段：从 `mcp_frame` 取 c2s 帧 → 真实 MCP server stdin →
 * stdout 回写 `mcp_frame` 的 s2c 行 → `wakeMcpSession`。这正是 r1-worker 要做的动作，
 * 但它不是 r1-worker 的代码，因此端到端结论按 brief D 节标 INCONCLUSIVE。
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
const piMcpVersion = (
  JSON.parse(readFileSync(join(piMcp.root, "package.json"), "utf8")) as { version: string }
).version;
assert(piMcp.exportNames.includes("McpClient"));
assert(piMcp.exportNames.includes("parseJsonRpcMessage"));
pass(`真实 pi-mcp ${piMcpVersion} 已解析：${piMcp.exportNames.length} 个导出`);

// ---------------------------------------------------------------- 隔离库里的真实主体
const insert = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
insert(
  "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,'X2','x2@mcp.test',0,1,1)",
  "owner",
);
const machineId = newId(ID_PREFIXES.machine);
const projectId = newId(ID_PREFIXES.project);
insert(
  "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,'X2 Mac','owner',1,1)",
  machineId,
);
insert("INSERT INTO project(id,name,created_by) VALUES (?,'X2','owner')", projectId);
insert(
  "INSERT OR IGNORE INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,'owner',1,1,1)",
  projectId,
  machineId,
);
// 真实 Worker 打开连接时会写入 capability；这里直接落一条 open 连接（Worker 侧属 r1-worker）。
const attemptId = randomUUID();
insert(
  "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq,capability,last_payload_hash) VALUES (?,1,?,?,'open',?,?,1,?,?)",
  machineId,
  attemptId,
  bootId,
  Date.now(),
  Date.now(),
  JSON.stringify({
    platform: "darwin",
    arch: "arm64",
    workerVersion: "x2-stand-in",
    shells: [],
    remoteOperations: ["file_read"],
    mcpRelay: { version: 1, transports: ["stdio"], maxMessageBytes: 131072 },
  }),
  "a".repeat(64),
);
insert("INSERT INTO machine_connection_counter(machine_id,high_water) VALUES (?,1)", machineId);

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

// 显式登记 + 一条 running 的 process 行（真实 Worker 会通过 process_fact 写入）。
const registrationId = newId(ID_PREFIXES.mcpRegistration);
const processId = newId(ID_PREFIXES.mcpProcess);
const incarnationId = randomUUID();
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
insert(
  "INSERT INTO mcp_server_registration(id,revision,project_id,machine_id,name,transport,config_ref,config_hash,config_json,created_at,retired_at) VALUES (?,1,?,?,'everything','stdio','everything',?,?,?,NULL)",
  registrationId,
  projectId,
  machineId,
  "c".repeat(64),
  JSON.stringify(config),
  Date.now(),
);
insert(
  "INSERT INTO mcp_server_process(id,registration_id,registration_revision,project_id,machine_id,transport,config_hash,worker_incarnation_id,launch_nonce,pid,process_started_at,endpoint,state,state_revision,state_hash,created_at,last_observed_at,ended_at,exit_code,end_reason) VALUES (?,?,1,?,?,'stdio',?,?,?,?,?,NULL,'running',1,?,?,?,NULL,NULL,NULL)",
  processId,
  registrationId,
  projectId,
  machineId,
  "c".repeat(64),
  incarnationId,
  randomUUID(),
  process.pid,
  Date.now(),
  "d".repeat(64),
  Date.now(),
  Date.now(),
);

// ---------------------------------------------------------------- 真实 HTTP 边界
const server = createServer((request: IncomingMessage, response: ServerResponse) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", async () => {
    const body = Buffer.concat(chunks).toString("utf8");
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
    response.end(Buffer.from(await answer.arrayBuffer()));
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
})) as { registrations: { name: string; processes: { processId: string }[] }[] };
assert.equal(catalog.registrations.length, 1);
assert.equal(catalog.registrations[0]!.name, "everything");
assert.equal(catalog.registrations[0]!.processes.length, 1);
assert(!JSON.stringify(catalog).includes("server-everything@2.0.1"), "catalog 不返回命令或参数");
pass("真实 HTTP 的 mcp_catalog_get 只返回显式登记，不含命令/参数");

// ---------------------------------------------------------------- stand-in dispatcher
const responder = spawn("npx", ["-y", "@modelcontextprotocol/server-everything@2.0.1"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let stdoutBuffer = "";
let sessionId: string | null = null;
responder.stdout.on("data", (chunk: Buffer) => {
  stdoutBuffer += chunk.toString("utf8");
  for (let index = stdoutBuffer.indexOf("\n"); index >= 0; index = stdoutBuffer.indexOf("\n")) {
    const line = stdoutBuffer.slice(0, index).trim();
    stdoutBuffer = stdoutBuffer.slice(index + 1);
    if (!line || !sessionId) continue;
    enqueueInbound(sessionId, JSON.parse(line));
  }
});
responder.stderr.on("data", () => {});
const responderExited = once(responder, "exit").then(() => true);
responder.on("error", () => undefined);

function enqueueInbound(targetSession: string, message: unknown) {
  // 这是 r1-worker 在 `applyRemoteExchange` 里应做的动作：把 server→client 帧落库。
  const row = sqlite
    .prepare(
      "SELECT server_high_water AS hw, project_id AS p, machine_id AS m, authorization_generation AS g, holder_instance_id AS i, process_id AS d FROM mcp_session WHERE id=?",
    )
    .get(targetSession) as
    | { hw: number; p: string; m: string; g: number; i: string; d: string }
    | undefined;
  if (!row) return;
  const bytes = Buffer.from(JSON.stringify(message), "utf8");
  const seq = row.hw + 1;
  sqlite
    .prepare(
      "INSERT INTO mcp_frame(id,session_id,project_id,machine_id,authorization_generation,holder_instance_id,process_id,direction,seq,payload_base64,payload_bytes,payload_hash,state,created_at,expires_at,sent_at,terminal_at,disposition_reason) VALUES (?,?,?,?,?,?,?,'server_to_client',?,?,?,?,'queued',?,?,NULL,NULL,NULL)",
    )
    .run(
      newId(ID_PREFIXES.mcpFrame),
      targetSession,
      row.p,
      row.m,
      row.g,
      row.i,
      row.d,
      seq,
      bytes.toString("base64"),
      bytes.byteLength,
      hashOf(bytes),
      Date.now(),
      Date.now() + 60_000,
    );
  sqlite.prepare("UPDATE mcp_session SET server_high_water=? WHERE id=?").run(seq, targetSession);
  // 有新帧时立刻叫醒正在有界 hold 的 exchange。
  wakeMcpSession(targetSession);
}

function hashOf(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 把 queued 的 c2s 帧喂给真实 MCP server（等同 Worker 的 session 转发）。 */
function pumpOutbound() {
  if (!sessionId) return;
  const rows = sqlite
    .prepare(
      "SELECT id,payload_base64 AS b FROM mcp_frame WHERE session_id=? AND direction='client_to_server' AND state='queued' ORDER BY seq",
    )
    .all(sessionId) as { id: string; b: string }[];
  for (const row of rows) {
    responder.stdin.write(Buffer.from(row.b, "base64").toString("utf8") + "\n");
  }
}
void pumpOutbound;
setInterval(pumpOutbound, 20);

// ---------------------------------------------------------------- 真实 Pi MCP 客户端 + 我们的 transport
// session 由 `SproutRelayTransport.start()` 自己经真实 HTTP 打开（这是被测路径），
// 所以这里不手工预开 session；open 之后从库里取回 id 让 stand-in dispatcher 使用。
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

// stand-in dispatcher 在 attach 之前就要能识别 session，因此 open 前后都轮询一次。
const attachTimer = setInterval(() => {
  const row = sqlite
    .prepare("SELECT id,attached_at FROM mcp_session WHERE process_id=? ORDER BY created_at DESC")
    .get(processId) as { id: string; attached_at: number | null } | undefined;
  if (!row || row.attached_at !== null) return;
  sessionId = row.id;
  // 同 r1-worker 的 `session_fact(attached)`：把 session 标成已 attach。
  sqlite.prepare("UPDATE mcp_session SET attached_at=? WHERE id=?").run(Date.now(), row.id);
  wakeMcpSession(row.id);
}, 20);

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
clearInterval(attachTimer);
sessionId = connection.transport.sessionId!;
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

const toolNames = connection.tools.map((tool) => mcpToolName("everything", tool.name)).sort();
assert(toolNames.length > 0, "tools/list 返回了工具");
assert(toolNames.every((name) => name.startsWith("mcp__everything__")));
pass(`真实 tools/list 返回 ${toolNames.length} 个工具`);

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
const runnerEvidence = await loadExtensionInRealRunner();

// ---------------------------------------------------------------- close
await connection.close();
responder.stdin.end();
await Promise.race([responderExited, new Promise((r) => setTimeout(r, 5000))]);
if (responder.exitCode === null) responder.kill("SIGTERM");
assert.equal(
  sqlite.prepare("SELECT state FROM mcp_server_process WHERE id=?").get(processId)?.state,
  "running",
);
// 收尾：真实 grant 进程与 runner 一起退出。
await grantProcess.close().catch(() => undefined);
pass("关闭 Pi 侧 session 后 Machine 上的 server 进程行状态仍 running（standing order 6）");

const evidence = {
  piMcpVersion,
  piMcpRoot: piMcp.root,
  piMcpExports: piMcp.exportNames,
  handlerOrder,
  catalogRegistrations: catalog.registrations.length,
  catalogOnlyExplicitRegistrations: true,
  catalogHidesLaunchConfig: true,
  hostDrainsInTime: drainMs < 100,
  drainExchangeMs: drainMs,
  endToEndToolsList: "blocked",
  blockedAt: "src/server/remote.ts:applyRemoteExchange（r1-worker 的 input.mcp 消费）",
  blockedReason:
    "本单元无 src/worker/** 与 applyRemoteExchange 的写权限；c2s/s2c 帧的落库与 session_fact 由 r1-worker 实现，x2 用脚本内 stand-in dispatcher 代跑该环以证明其余各环真实可用",
  realServerToolsList: "pass",
  realServer: "@modelcontextprotocol/server-everything@2.0.1",
  realServerToolCount: toolNames.length,
  toolNames,
  extensionLoadedInRealPiRunner: runnerEvidence.tools.length,
  extensionRunnerTools: runnerEvidence.tools,
  extensionRunnerSdk: runnerEvidence.sdkVersion,
  scope:
    "真实 pi-mcp 1.4.0 McpClient、真实 HTTP /api/remote/agent（生产网关函数）、真实隔离 SQLite、真实 spawn 的 MCP server 进程。未被真实覆盖的一环是 r1-worker 的 dispatcher/applyRemoteExchange。",
};
writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
server.closeAllConnections();
server.close();
// 真实 runtime、SDK 资源装载器与 stand-in dispatcher 都有长生命周期句柄；证据落盘后显式退出，
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
async function loadExtensionInRealRunner(): Promise<{ tools: string[]; sdkVersion: string }> {
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
    version: string;
  };
  pass(
    `真实 Pi ${pkg.version} DefaultResourceLoader 装到 extension：${tools.length} 个工具，无 mcp__ 前缀`,
  );
  return { tools, sdkVersion: pkg.version };
}
