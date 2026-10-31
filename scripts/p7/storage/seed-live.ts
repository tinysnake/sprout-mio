// 真实生产入口造一份可备份的库：账号、Project、群聊消息、Task、租约、运行中的 run 与已下发执行。
// 只用于 p7 存储门禁；所有写入都经过 src 的领域/服务层，不为门禁直写业务行。
import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../../src/contracts/ids";
import { sqlite } from "../../../src/db";
import { migrateDatabase } from "../../../src/db/migrate";
import { addProjectMember, createAgentProfile } from "../../../src/domain/agent";
import { createGroupChat, sendMessage } from "../../../src/domain/chat";
import type { ChatActor } from "../../../src/domain/chat-actor";
import { createProject } from "../../../src/domain/project";
import { createTask } from "../../../src/domain/task";
import { createMachine, saveProjectMachineBinding } from "../../../src/domain/machine";
import { auth } from "../../../src/lib/auth";
import { acquireLease } from "../../../src/server/lease";
import { requestExecution } from "../../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../../src/server/worker-gateway";
import { seedRemoteActor } from "../../../tests/fixtures/remote-actors";

const email = process.env.SEED_EMAIL ?? "snapshot@sprout.test";
const password = process.env.SEED_PASSWORD ?? "snapshot-password-9f4c";
migrateDatabase();

const signedUp = await auth.api.signUpEmail({ body: { email, password, name: "Snapshot Human" } });
const userId = signedUp.user.id;
const ctx = { userId, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "快照项目" }, ctx);
const agent = createAgentProfile({ name: "快照 Agent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agent.id, ctx);
const human: ChatActor = { kind: "human", userId, ctx };
const group = createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "快照群聊",
    members: [
      { kind: "human", id: userId },
      { kind: "agent", id: agent.id },
    ],
    initialOwner: { kind: "human", id: userId },
    wakePolicy: "owner_led",
  },
  human,
);
sendMessage(
  group.id,
  { senderKind: "human", senderId: userId, body: "备份时刻之前写下的历史消息" },
  ctx,
);
const task = createTask(
  { projectId: project.id, title: "快照任务", description: "备份要保持的任务行" },
  ctx,
);

const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',2147483647,'snapshot-seed')",
  )
  .run(bootId);
const remote = seedRemoteActor(sqlite, userId, project.id, bootId);
const machine = createMachine({ name: "快照 Machine" }, remote);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId: project.id, machineId, description: "snapshot fixture", expectedRevision: null },
  remote,
);
const lease = acquireLease(
  {
    projectId: project.id,
    machineId,
    action: "acquire",
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 0,
  },
  remote,
);
const authorizationGeneration = lease.completedGeneration ?? 1;
const secret = "w".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: newId(ID_PREFIXES.request) };
enrollWorker({ ...wire, ticket: machine.ticket }, remote);
const session = openWorker({ ...wire, attemptId: randomUUID() }, remote).session;
let seq = 0;
const exchange = (remoteInput = { results: [], fenceAcks: [], mcp: [], mcpCursors: [] }) =>
  exchangeWorker(
    {
      version: 3,
      requestId: wire.requestId,
      secret,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "snapshot-seed",
        shells: [
          {
            path: "/bin/sh",
            kind: "sh",
            version: null,
            checkedAt: remote.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
      },
      observations: [],
      remote: remoteInput,
    } as Parameters<typeof exchangeWorker>[0],
    remote,
  );
exchange();
const submitRequestId = newId(ID_PREFIXES.request);
const submitted = requestExecution(
  {
    projectId: project.id,
    machineId,
    requestId: submitRequestId,
    authorizationGeneration,
    operation: { kind: "shell", command: "printf snapshot", cwd: "/tmp", waitMs: 1000 },
  },
  remote,
);
const dispatched = exchange();
if (dispatched.remote.commands.length !== 1) throw new Error("快照夹具没有下发预期的远端命令");

console.log(
  "SEED " +
    JSON.stringify({
      userId,
      email,
      password,
      projectId: project.id,
      chatId: group.id,
      messageBody: "备份时刻之前写下的历史消息",
      taskId: task.detail.task.id,
      taskTitle: task.detail.task.title,
      runId: remote.runId,
      executionId: submitted.executionId,
      executionRequestId: remote.requestId,
      bootId,
      lease: {
        machineId,
        generation: authorizationGeneration,
        holderInstanceId: remote.instanceId,
      },
    }),
);
sqlite.close();
