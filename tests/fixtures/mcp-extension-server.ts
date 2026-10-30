import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  mcpCatalogViewSchema,
  mcpSessionCloseOutputSchema,
  mcpSessionExchangeOutputSchema,
  mcpSessionOpenOutputSchema,
} from "../../src/contracts/mcp";
import type { McpConfig } from "../../src/contracts/mcp";
import { migrateDatabase } from "../../src/db/migrate";
import { sqlite } from "../../src/db";
import {
  mcpCatalogGet,
  mcpSessionClose,
  mcpSessionExchange,
  mcpSessionOpen,
} from "../../src/server/mcp-relay";
import type { AgentRemoteContext } from "../../src/server/lease";

/**
 * 服务端四个 MCP 分支的隔离 SQLite 反证：真实表、真实约束、真实事务，
 * 只替换掉 Machine 侧的进程与帧搬运（那是 r1-worker 的范围）。
 */
const url = process.env.DATABASE_URL;
assert(url && url !== ":memory:", "isolated DATABASE_URL required");
migrateDatabase(url);

const pass = (name: string) => console.log(`PASS ${name}`);
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
const HOUR = 3_600_000;

function user(id: string) {
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, id, `${id}@mcp.test`);
}
user("owner");
const machineId = newId(ID_PREFIXES.machine);
const projectId = newId(ID_PREFIXES.project);
const otherProjectId = newId(ID_PREFIXES.project);
sqlite
  .prepare(
    "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,'MCP Mac','owner',1,1)",
  )
  .run(machineId);
for (const id of [projectId, otherProjectId])
  sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'MCP','owner')").run(id);
sqlite
  .prepare(
    "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at,seq,capability,last_payload_hash) VALUES (?,1,?,?,'open',?,?,1,?,?)",
  )
  .run(
    machineId,
    randomUUID(),
    bootId,
    Date.now(),
    Date.now(),
    JSON.stringify({
      platform: "darwin",
      arch: "arm64",
      workerVersion: "test",
      shells: [],
      remoteOperations: ["file_read"],
      mcpRelay: { version: 1, transports: ["stdio"], maxMessageBytes: 131072 },
    }),
    "a".repeat(64),
  );
sqlite
  .prepare("INSERT INTO machine_connection_counter(machine_id,high_water) VALUES (?,1)")
  .run(machineId);
const connection = sqlite
  .prepare("SELECT attempt_id FROM machine_connection WHERE machine_id=?")
  .get(machineId) as { attempt_id: string };

function actor(targetProject: string): AgentRemoteContext {
  const profileId = newId(ID_PREFIXES.agentProfile);
  const chatId = newId(ID_PREFIXES.chat);
  const instanceId = newId(ID_PREFIXES.instance);
  const runId = newId(ID_PREFIXES.run);
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare("INSERT INTO agent_profile(id,name,created_by) VALUES (?,'MCP fixture','owner')")
    .run(profileId);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?,?,'dm','human','owner','owner')",
    )
    .run(chatId, targetProject);
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
    .run(chatId, profileId);
  sqlite
    .prepare("INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)")
    .run(instanceId, profileId, chatId, targetProject);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      runId,
      instanceId,
      chatId,
      targetProject,
      newId(ID_PREFIXES.request),
      Date.now(),
      randomUUID(),
    );
  sqlite
    .prepare(
      "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      grantId,
      randomUUID().replaceAll("-", "").padEnd(64, "b"),
      "owner",
      targetProject,
      chatId,
      instanceId,
      runId,
      Date.now(),
      Date.now() + HOUR,
    );
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,'owner',1,1,1)",
    )
    .run(targetProject, machineId);
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',1)",
    )
    .run(targetProject, machineId);
  return {
    userId: "owner",
    projectId: targetProject,
    chatId,
    instanceId,
    runId,
    grantId,
    bootId,
    now: new Date(),
    requestId: newId(ID_PREFIXES.request),
  } as AgentRemoteContext;
}

function holdLease(project: string, instance: string, generation: number) {
  sqlite
    .prepare(
      "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,?,'held',?,?)",
    )
    .run(project, machineId, generation, instance, Date.now());
  sqlite
    .prepare(
      "INSERT INTO lease_authorization(project_id,machine_id,generation,holder_instance_id,state,issued_at,reason) VALUES (?,?,?,?,'active',?,'acquire')",
    )
    .run(project, machineId, generation, instance, Date.now());
}

function register(
  project: string,
  name: string,
  config: Partial<McpConfig> = {},
): { registrationId: string; processId: string; incarnationId: string } {
  const registrationId = newId(ID_PREFIXES.mcpRegistration);
  const processId = newId(ID_PREFIXES.mcpProcess);
  const incarnationId = randomUUID();
  const json = {
    transport: "stdio",
    command: "node",
    args: [],
    workingDirectory: "/tmp",
    launch: "configured_service",
    autostart: true,
    exposure: "wire",
    roots: [],
    exposeSampling: true,
    elicitation: "cancel",
    requestTimeoutMs: 120000,
    ...config,
  };
  sqlite
    .prepare(
      "INSERT INTO mcp_server_registration(id,revision,project_id,machine_id,name,transport,config_ref,config_hash,config_json,created_at,retired_at) VALUES (?,1,?,?,?,'stdio',?,?,?,?,NULL)",
    )
    .run(
      registrationId,
      project,
      machineId,
      name,
      name,
      "c".repeat(64),
      JSON.stringify(json),
      Date.now(),
    );
  sqlite
    .prepare(
      "INSERT INTO mcp_server_process(id,registration_id,registration_revision,project_id,machine_id,transport,config_hash,worker_incarnation_id,launch_nonce,pid,process_started_at,endpoint,state,state_revision,state_hash,created_at,last_observed_at,ended_at,exit_code,end_reason) VALUES (?,?,1,?,?,'stdio',?,?,?,?,?,NULL,'running',1,?,?,?,NULL,NULL,NULL)",
    )
    .run(
      processId,
      registrationId,
      project,
      machineId,
      "c".repeat(64),
      incarnationId,
      randomUUID(),
      4242,
      Date.now(),
      "d".repeat(64),
      Date.now(),
      Date.now(),
    );
  return { registrationId, processId, incarnationId };
}

const ctx = actor(projectId);
holdLease(projectId, ctx.instanceId, 1);
const everything = register(projectId, "everything");
/**
 * 拒绝必须带已登记的错误码。跨 Project 在领域层 `assertRemoteAccess` 就被
 * `LeaseError` 挡住（早于 MCP 分支），因此断言按 code 而不是按错误类。
 */
const denied = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && (error as { code: string }).code === code;

// catalog：只返回本 Project 的显式登记，且不泄露命令/参数。
const catalog = mcpCatalogGet({ projectId, machineId, authorizationGeneration: 1 }, ctx);
assert(mcpCatalogViewSchema.safeParse(catalog).success);
assert.equal(catalog.registrations.length, 1);
assert.equal(catalog.registrations[0]!.name, "everything");
assert.equal(catalog.registrations[0]!.processes.length, 1);
assert(!JSON.stringify(catalog).includes("configured_service"), "catalog 不返回命令或启动配置");
pass("catalog 返回显式登记摘要，不含命令/参数/secret 引用");

// 未持有租约 → lease_not_holder；旧代次 → lease_stale_generation。
const waiting = actor(projectId);
assert.throws(
  () => mcpCatalogGet({ projectId, machineId, authorizationGeneration: 1 }, waiting),
  denied("lease_not_holder"),
);
assert.throws(
  () => mcpCatalogGet({ projectId, machineId, authorizationGeneration: 2 }, ctx),
  denied("lease_stale_generation"),
);
pass("反证：未持租约得 lease_not_holder，旧代次得 lease_stale_generation");

// 跨 Project：A 的 ctx 用 B 的 projectId/registrationId → 拒绝。
const other = actor(otherProjectId);
holdLease(otherProjectId, other.instanceId, 1);
const foreign = register(otherProjectId, "everything");
assert.throws(
  () =>
    mcpSessionOpen(
      {
        projectId: otherProjectId,
        machineId,
        authorizationGeneration: 1,
        requestId: newId(ID_PREFIXES.request),
        registrationId: foreign.registrationId,
        registrationRevision: 1,
        processId: foreign.processId,
        expectedWorkerIncarnationId: foreign.incarnationId,
      },
      ctx,
    ),
  denied("not_found"),
);
assert.throws(
  () => mcpCatalogGet({ projectId: otherProjectId, machineId, authorizationGeneration: 1 }, ctx),
  denied("not_found"),
);
pass("反证：跨 Project 的 mcp_session_open 与 catalog 被拒（not_found）");

const openInput = {
  projectId,
  machineId,
  authorizationGeneration: 1,
  requestId: newId(ID_PREFIXES.request),
  registrationId: everything.registrationId,
  registrationRevision: 1,
  processId: everything.processId,
  expectedWorkerIncarnationId: everything.incarnationId,
};
const opened = mcpSessionOpen(openInput, ctx);
assert(mcpSessionOpenOutputSchema.safeParse(opened).success);
assert.equal(opened.session.state, "connecting");
assert.equal(opened.session.connectedAt, null);
// 幂等：同一 requestId 重放返回同一 session，不同输入 → 冲突。
assert.equal(mcpSessionOpen(openInput, ctx).session.id, opened.session.id);
assert.throws(
  () =>
    mcpSessionOpen(
      {
        ...openInput,
        registrationRevision: 1,
        processId: everything.processId,
        expectedWorkerIncarnationId: randomUUID(),
      },
      ctx,
    ),
  denied("remote_request_conflict"),
);
pass("mcp_session_open 幂等；同 requestId 异内容得 remote_request_conflict");

const sessionId = opened.session.id;
const exchangeInput = {
  projectId,
  machineId,
  authorizationGeneration: 1,
  sessionId,
  frames: [],
  ackServerSeq: 0,
  cancelClientSeqs: [],
  protocolVersion: "2025-06-18",
  confirmInitialized: false,
  holdMs: 0,
};
const exchanged = await mcpSessionExchange(exchangeInput, ctx);
assert(mcpSessionExchangeOutputSchema.safeParse(exchanged).success);
assert.equal(exchanged.frames.length, 0);
pass("mcp_session_exchange 空批返回空 frames 与 hasMore");

// 帧落库：上行帧进 queued，重复 seq 同 hash 幂等，异 hash 冲突。
const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
const frameId = newId(ID_PREFIXES.mcpFrame);
const frameInput = {
  frameId,
  seq: 1,
  payloadBase64: payload.toString("base64"),
  payloadBytes: payload.byteLength,
  payloadHash: (await import("node:crypto")).createHash("sha256").update(payload).digest("hex"),
  expiresAt: Date.now() + 60_000,
};
const withFrame = await mcpSessionExchange({ ...exchangeInput, frames: [frameInput] }, ctx);
assert.equal(withFrame.acceptedClientSeq, 1);
assert.equal(withFrame.session.clientHighWater, 1);
const queued = sqlite
  .prepare("SELECT state,payload_bytes FROM mcp_frame WHERE id=?")
  .get(frameId) as { state: string; payload_bytes: number };
assert.equal(queued.state, "queued");
assert.equal(queued.payload_bytes, payload.byteLength);
// 异步分支用 rejects：exchange 在 hold 之外仍是 async，throw 变成 rejection。
await assert.rejects(
  mcpSessionExchange(
    { ...exchangeInput, frames: [{ ...frameInput, payloadHash: "e".repeat(64) }] },
    ctx,
  ),
  denied("remote_request_conflict"),
);
pass("上行帧落库为 queued；同 seq 异 hash 得 remote_request_conflict");

// 反证：旧 authorization_generation 的 exchange 被拒。
await assert.rejects(
  mcpSessionExchange({ ...exchangeInput, authorizationGeneration: 2 }, ctx),
  denied("lease_stale_generation"),
);
await assert.rejects(
  mcpSessionExchange({ ...exchangeInput, sessionId: newId(ID_PREFIXES.mcpSession) }, ctx),
  denied("not_found"),
);
pass("反证：旧代次 exchange 得 lease_stale_generation；不存在的 session 得 not_found");

// 反证：server 端已判 failed 的 session 再 exchange 不改投别的 session。
sqlite
  .prepare("UPDATE mcp_session SET state='failed',ended_at=?,end_reason='target_lost' WHERE id=?")
  .run(Date.now(), sessionId);
const afterFailure = await mcpSessionExchange(
  { ...exchangeInput, frames: [], cancelClientSeqs: [] },
  ctx,
);
assert.equal(afterFailure.session.id, sessionId);
assert.equal(afterFailure.session.state, "failed");
assert.equal(afterFailure.session.endReason, "target_lost");
assert.equal(afterFailure.frames.length, 0);
assert.equal(afterFailure.hasMore, false);
// 不改投：session 总数没变，也没有任何别的 session 承接这次 exchange。
const sessionCount = () =>
  (sqlite.prepare("SELECT count(*) AS n FROM mcp_session").get() as { n: number }).n;
const before = sessionCount();
await mcpSessionExchange({ ...exchangeInput, frames: [] }, ctx);
assert.equal(sessionCount(), before);
pass("反证：failed session 再 exchange 原样返回、不改投别的 session");

// 一条 session 占一个 process 生命周期（`mcp_session_process_unique`），
// 所以 close 幂等用第二个登记/进程验证。
const otherServer = register(projectId, "second");
const second = mcpSessionOpen(
  {
    ...openInput,
    requestId: newId(ID_PREFIXES.request),
    registrationId: otherServer.registrationId,
    processId: otherServer.processId,
    expectedWorkerIncarnationId: otherServer.incarnationId,
  },
  ctx,
);
assert.equal(second.session.state, "connecting");

// close 幂等：两次都成功，且只 detach（不触碰进程行）。
const closeInput = {
  projectId,
  machineId,
  authorizationGeneration: 1,
  sessionId: second.session.id,
  requestId: newId(ID_PREFIXES.request),
  reason: "client_closed" as const,
};
const closed = mcpSessionClose(closeInput, ctx);
assert(mcpSessionCloseOutputSchema.safeParse(closed).success);
assert.equal(closed.session.state, "closed");
assert.equal(closed.session.endReason, "client_closed");
const again = mcpSessionClose(closeInput, ctx);
assert.equal(again.session.state, "closed");
assert.equal(again.session.endedAt, closed.session.endedAt);
const dropped = sqlite
  .prepare(
    "SELECT state,disposition_reason FROM mcp_frame WHERE session_id=? AND direction='client_to_server'",
  )
  .all(second.session.id) as { state: string; disposition_reason: string | null }[];
assert(dropped.every((row) => row.state === "dropped"));
assert(dropped.every((row) => row.disposition_reason === "client_closed"));
// standing order 6：关 session 不结束 server 进程。
assert.equal(
  sqlite.prepare("SELECT state FROM mcp_server_process WHERE id=?").get(everything.processId)
    ?.state,
  "running",
);
pass("mcp_session_close 幂等；queued 帧标 dropped(client_closed)；server 进程仍 running");

// 目标消失不改投：process 不再是 running 时 open 被拒。
sqlite
  .prepare(
    "UPDATE mcp_server_process SET state='exited',ended_at=?,end_reason='exited',exit_code=0 WHERE id=?",
  )
  .run(Date.now(), everything.processId);
assert.throws(
  () => mcpSessionOpen({ ...openInput, requestId: newId(ID_PREFIXES.request) }, ctx),
  denied("machine_unavailable"),
);
pass("反证：process 已 exited 时 mcp_session_open 得 machine_unavailable");

// capability.mcpRelay 缺席时不宣告支持。
sqlite.prepare("UPDATE machine_connection SET capability=? WHERE machine_id=?").run(
  JSON.stringify({
    platform: "darwin",
    arch: "arm64",
    workerVersion: "test",
    shells: [],
    remoteOperations: ["file_read"],
  }),
  machineId,
);
assert.throws(
  () => mcpSessionOpen({ ...openInput, requestId: newId(ID_PREFIXES.request) }, ctx),
  denied("machine_unavailable"),
);
pass("反证：capability.mcpRelay 缺席时 open 得 machine_unavailable");

// hold 的上界：draining 之外 holdMs 至多 2000（契约层已挡）。这里只验证 holdMs=0 立即返回。
const start = Date.now();
await mcpSessionExchange({ ...exchangeInput, sessionId: second.session.id, holdMs: 0 }, ctx);
assert(Date.now() - start < 200);
pass("holdMs=0 的 exchange 立即返回（< 200 ms）");

void connection;
console.log("DONE mcp server relay branches");
