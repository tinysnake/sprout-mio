// I-P8b 集成线验收：把「阻塞式申请遇阻等待」接到真实 Agent 工具链，并在真实链路与压缩时限下
// 验收挂靠超时提醒 / 2 小时升级 / 到点自决。
//
// 真实 SQLite + 真实 runtime + process-scoped grant + 真实 HTTP 网关（remoteAgentResponse）
// + 真实 extension 工具注册（registerRemoteTools）与真实 RemoteToolClient（createRemoteClient）。
// 时限由 project.wake_policy.leaseTimeouts 从 30 分钟 / 2 小时压到 4 秒 / 60 秒——改的是
// 同一个 Project 级配置，产品代码读的是同一常量（LEASE_TIMEOUT_DEFAULT_MS /
// LEASE_ESCALATION_DEFAULT_MS，只在 Project 未覆盖时生效），所以这里跑的不是测试替身。
//
// 超时提醒 / 升级走生产驱动路径：createContinuationScheduler 的 advance()，而不是直接调
// sweepLeaseEscrowTimeouts。
import { afterAll, describe, expect, it } from "vite-plus/test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SproutExtensionAPI } from "../src/extension/types";
type SproutToolDefinition = Parameters<SproutExtensionAPI["registerTool"]>[0];

// 环境必须在 import config/runtime 之前定好：config 在 import 时就冻结。
const directory = mkdtempSync(join(tmpdir(), "p8b-timeout-integration-"));
process.env.DATABASE_URL = join(directory, "integration.sqlite");
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
process.env.SPROUT_PI_ENABLED = "false";
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");

// 网关（remoteAgentResponse）与 extension client 都走回环；端口必须先监听再写进
// APP_ORIGIN/PORT，因为 config 在 import 时冻结、而 issueRemoteToolGrant 用 config.PORT 拼端点。
const seenRequests: { type: string; authorization: string }[] = [];
let gateway: (request: Request) => Promise<Response>;
const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const parsed = JSON.parse(raw) as { call?: { type?: string } };
    seenRequests.push({
      type: parsed.call?.type ?? "?",
      authorization: request.headers.authorization ?? "",
    });
    const answer = await gateway(
      new Request(`${origin}/api/remote/agent`, {
        method: "POST",
        headers: {
          authorization: request.headers.authorization ?? "",
          "content-type": "application/json",
        },
        body: raw,
      }),
    );
    const payload = await answer.text();
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(payload);
  } catch (error) {
    response.statusCode = 500;
    response.end(String(error));
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const bound = server.address();
if (!bound || typeof bound === "string") throw new Error("HTTP address missing");
const origin = `http://127.0.0.1:${bound.port}`;
process.env.APP_ORIGIN = origin;
process.env.PORT = String(bound.port);

const { startRuntime, shutdownRuntime, machineRuntimeContext } =
  await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { db } = await import("../src/db");
const { and, eq } = await import("drizzle-orm");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { agentRun, agentRunInput, chatContinuationControl, leaseEscrow, machineLease, message } =
  await import("../src/db/schema");
const { applyChatContinuationCommand } = await import("../src/domain/chat-continuation");
const { createProject, updateProjectWakePolicy } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createGroupChat, ensureInstance } = await import("../src/domain/chat");
const { createGroupChatInput } = await import("../src/contracts/chat");
const { createMachine, hashCredential, saveProjectMachineBinding } =
  await import("../src/domain/machine");
const { openInitialMembership } = await import("../src/server/membership");
const { acquireLease, escrowLease, getLease, leaseWhere } = await import("../src/server/lease");
type AgentRemoteContext = import("../src/server/lease").AgentRemoteContext;
const { createContinuationScheduler } = await import("../src/server/continuation-scheduler");
const { PiSessionProcess } = await import("../src/server/pi-host/process");
const { issueRemoteToolGrant, remoteAgentResponse } =
  await import("../src/server/remote-agent-gateway");
const { initializeRequestContext } = await import("../src/server/request-context");
const { createRemoteClient } = await import("../src/extension/remote-client");
const { registerRemoteTools } = await import("../src/extension/remote-tools");
gateway = (request) => {
  initializeRequestContext(request);
  return remoteAgentResponse(request);
};

// 与 p8b-timeout-domain.ts 同一套压缩值：30 分钟 → 4 秒、2 小时 → 60 秒。
const TIMEOUT_MS = 4_000;
const ESCALATION_MS = 60_000;
const SENDER_ID = "sprout.lease-timeout";
const NOW = new Date();
const projectOwner = "p8b-int-owner";
const req = () => newId(ID_PREFIXES.request);

function boot() {
  const id = newId(ID_PREFIXES.boot);
  sqlite
    .prepare(
      "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
    )
    .run(id);
  return id;
}

/** 一个真实分身身份：instance 在指定 chat，run running；withGrant=false 时留给 issueRemoteToolGrant 建。 */
function actor(
  userId: string,
  projectId: string,
  chatId: string,
  profileId: string,
  withGrant = true,
) {
  const instance = ensureInstance(chatId, profileId, { userId, requestId: req() });
  const runId = newId(ID_PREFIXES.run);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      runId,
      instance.id,
      chatId,
      projectId,
      req(),
      Math.floor(NOW.getTime() / 1000),
      randomBytes(16).toString("hex"),
    );
  const secret = randomBytes(32).toString("base64url");
  const grantId = withGrant ? newId(ID_PREFIXES.remoteToolGrant) : "";
  if (withGrant)
    sqlite
      .prepare(
        "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
      )
      .run(
        grantId,
        hashCredential(secret),
        userId,
        projectId,
        chatId,
        instance.id,
        runId,
        NOW.getTime(),
        NOW.getTime() + 3_600_000,
      );
  return {
    userId,
    projectId,
    chatId,
    instanceId: instance.id,
    runId,
    grantId,
    bootId: boot(),
    now: NOW,
    requestId: req(),
    secret,
  } satisfies AgentRemoteContext & { secret: string };
}

sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(projectOwner, projectOwner, "p8b-int-owner@example.test");
const projectCtx = { userId: projectOwner, requestId: req() };
const project = createProject({ name: "P8b integration" }, projectCtx);
const initiatorAgent = createAgentProfile(
  { name: "Initiator", persona: "", harness: "pi" },
  projectCtx,
);
const ownerAgent = createAgentProfile({ name: "Owner", persona: "", harness: "pi" }, projectCtx);
const claimerAgent = createAgentProfile(
  { name: "Claimer", persona: "", harness: "pi" },
  projectCtx,
);
for (const profile of [initiatorAgent, ownerAgent, claimerAgent])
  addProjectMember(project.id, profile.id, projectCtx);

const chatActor = { kind: "human", userId: projectOwner, ctx: projectCtx } as const;
const members = (agents: readonly string[]) => [
  { kind: "human" as const, id: projectOwner },
  { kind: "agent" as const, id: initiatorAgent.id },
  ...agents.map((id) => ({ kind: "agent" as const, id })),
];
const groupOwner = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Integration Agent Owner",
    initialOwner: { kind: "agent", id: ownerAgent.id },
    members: members([ownerAgent.id, claimerAgent.id]),
  }),
  chatActor,
);
const groupHuman = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Integration Human Owner",
    initialOwner: { kind: "human", id: projectOwner },
    members: members([]),
  }),
  chatActor,
);

const groupQuiet = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Integration Quiet Owner",
    initialOwner: { kind: "agent", id: ownerAgent.id },
    members: members([ownerAgent.id, claimerAgent.id]),
  }),
  chatActor,
);
// T10：即使这条 chat 的自动接续被 Human 关掉，超时提醒与升级照样发。
const quietControl = db
  .select()
  .from(chatContinuationControl)
  .where(eq(chatContinuationControl.chatId, groupQuiet.id))
  .get();
applyChatContinuationCommand(
  {
    projectId: project.id,
    chatId: groupQuiet.id,
    action: "disable",
    expectedRevision: quietControl?.revision ?? 1,
    requestId: req(),
    reason: "p8b-int",
  },
  projectCtx,
  NOW,
);
const quietMode = db
  .select()
  .from(chatContinuationControl)
  .where(eq(chatContinuationControl.chatId, groupQuiet.id))
  .get();
assert.equal(quietMode?.mode, "off", "quiet chat 的自动接续必须确实是 off");

const machineCtx = { userId: projectOwner, bootId: boot(), requestId: req(), now: NOW };
const keys = [0, 1, 2, 3].map((index) => {
  const enrolled = createMachine({ name: `P8b Integration Machine ${index}` }, machineCtx);
  const key = { projectId: project.id, machineId: enrolled.detail.machine.id };
  saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
  openInitialMembership(db, { ...key, now: NOW });
  return key;
});

updateProjectWakePolicy(
  { projectId: project.id, provider: "llm", expectedConfigRevision: 1, requestId: req() },
  projectCtx,
  {
    thresholdVersion: "p8b-int",
    leaseTimeouts: { timeoutMs: TIMEOUT_MS, escalationMs: ESCALATION_MS },
  },
  NOW,
);

const escrowerOwner = actor(projectOwner, project.id, groupOwner.id, initiatorAgent.id);
const escrowerHuman = actor(projectOwner, project.id, groupHuman.id, initiatorAgent.id);
const escrowerQuiet = actor(projectOwner, project.id, groupQuiet.id, initiatorAgent.id);
const claimer = actor(projectOwner, project.id, groupOwner.id, claimerAgent.id, false);

function escrow(key: (typeof keys)[number], chatId: string, ctx: AgentRemoteContext) {
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, ctx);
  return escrowLease(
    { ...key, action: "escrow", requestId: req(), expectedGeneration: 1, chatId },
    ctx,
  );
}
const main = escrow(keys[0]!, groupOwner.id, escrowerOwner);
escrow(keys[1]!, groupHuman.id, escrowerHuman);
const quiet = escrow(keys[3]!, groupQuiet.id, escrowerQuiet);

const reminders = (chatId: string): (typeof message.$inferSelect)[] =>
  db
    .select()
    .from(message)
    .where(and(eq(message.chatId, chatId), eq(message.senderId, SENDER_ID)))
    .all();
const runsInChat = (chatId: string): (typeof agentRun.$inferSelect)[] =>
  db.select().from(agentRun).where(eq(agentRun.chatId, chatId)).all();
const escrowRow = (escrowId: string) =>
  db.select().from(leaseEscrow).where(eq(leaseEscrow.id, escrowId)).get()!;
const at = (ms: number) => new Date(NOW.getTime() + ms);

// ------------------------------------------------------------------ 真实工具链路
const runnerPath = join(directory, "grant-transport.mjs");
writeFileSync(
  runnerPath,
  `import {createInterface} from 'node:readline';\ncreateInterface({input:process.stdin}).on('line', line => {if(JSON.parse(line).type==='close')process.exit(0)});\n`,
);
const processes: InstanceType<typeof PiSessionProcess>[] = [];
function grantFor(
  actorRow: AgentRemoteContext & { secret: string },
  runtime: { bootId: string; now: Date; requestId: string },
) {
  const process = new PiSessionProcess(actorRow.runId, runnerPath);
  processes.push(process);
  return issueRemoteToolGrant(actorRow.runId, process, runtime);
}

const runtime = { ...(await machineRuntimeContext()), requestId: req() };
const claimerGrant = grantFor(claimer, runtime);
const remoteTools = new Map<string, SproutToolDefinition>();
registerRemoteTools(
  {
    registerTool: (tool) => {
      remoteTools.set(tool.name, tool);
    },
  },
  createRemoteClient(claimerGrant, { instanceId: claimer.instanceId }),
);

describe("I-P8b 集成线：阻塞式等待接到真实工具链", () => {
  it("等待到点返回失败加原因，全程只读、不抢占不释放、持有者不可见", async () => {
    const machineId = keys[0]!.machineId;
    const leaseBefore = JSON.stringify(
      db.select().from(machineLease).where(leaseWhere(keys[0]!)).get(),
    );
    const escrowBefore = JSON.stringify(escrowRow(main.escrow.escrowId));
    const messagesBefore = reminders(groupOwner.id).length;
    const runsBefore = runsInChat(groupOwner.id).length;
    seenRequests.length = 0;

    const started = Date.now();
    const result = await remoteTools
      .get("sprout_lease_wait")!
      .execute("call", { machineId, waitMs: 1_000 });
    const elapsed = Date.now() - started;

    // 到点：失败 + 原因，交给申请方自己决定是否结束 run。
    expect(result.isError, JSON.stringify(result.details)).toBe(true);
    expect(result.details).toMatchObject({
      outcome: "timed_out",
      reason: "timed_out",
      requestedMs: 1_000,
    });
    expect(JSON.stringify(result.details)).toContain("是否结束当前 run 由你自行决定");
    expect(elapsed).toBeGreaterThanOrEqual(1_000);

    // 真实 HTTP 链路上只出现只读的 lease_get，且都带申请方自己的 grant。
    assert.ok(seenRequests.length > 1, `期望多次轮询，实际 ${seenRequests.length} 次`);
    assert.deepEqual(
      [...new Set(seenRequests.map((entry) => entry.type))],
      ["lease_get"],
      "等待期间只允许读租约",
    );

    // 持有者一侧完全不可见：没有消息、没有新 run、租约与挂靠行一字未动。
    assert.equal(reminders(groupOwner.id).length, messagesBefore);
    assert.equal(runsInChat(groupOwner.id).length, runsBefore);
    assert.equal(JSON.stringify(escrowRow(main.escrow.escrowId)), escrowBefore);
    assert.equal(
      JSON.stringify(db.select().from(machineLease).where(leaseWhere(keys[0]!)).get()),
      leaseBefore,
    );
  }, 30_000);

  it("空闲机器上立即成功（不空等）", async () => {
    seenRequests.length = 0;
    const started = Date.now();
    const result = await remoteTools
      .get("sprout_lease_wait")!
      .execute("call", { machineId: keys[2]!.machineId, waitMs: 1_000 });
    expect(result.isError, JSON.stringify(result.details)).toBe(false);
    expect(result.details).toMatchObject({ outcome: "succeeded" });
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(seenRequests.map((entry) => entry.type)).toEqual(["lease_get"]);
  }, 30_000);
});

describe("I-P8b 集成线：超时提醒与升级由生产 scheduler 驱动", () => {
  it("人类 owner 只提醒一次；Agent owner 被唤醒；再过升级时限升级 Human 并暂停 owner 自动尝试", async () => {
    const ownerInstance = ensureInstance(groupOwner.id, ownerAgent.id, projectCtx);
    const humanRunsBefore = runsInChat(groupHuman.id).length;
    const ownerRunsBefore = runsInChat(groupOwner.id).length;

    let clockNow = NOW.getTime();
    const clockErrors: unknown[] = [];
    const scheduler = createContinuationScheduler({
      clock: { now: () => new Date(clockNow), setTimeout: () => 0, clearTimeout: () => {} },
      onError: (error) => clockErrors.push(error),
    });
    try {
      scheduler.start();
      // 未到点：scheduler 走一遍也不该提醒。
      assert.deepEqual(reminders(groupOwner.id).length, 0);
      assert.deepEqual(reminders(groupHuman.id).length, 0);

      // 到点：生产调度器（advance → sweepLeaseEscrowTimeouts）驱动提醒。
      clockNow = NOW.getTime() + TIMEOUT_MS;
      await scheduler.advance();

      const ownerReminder = reminders(groupOwner.id);
      assert.equal(ownerReminder.length, 1, "Agent owner 提醒一次");
      assert.ok(ownerReminder[0]!.body.includes("P8b Integration Machine 0"));
      assert.ok(ownerReminder[0]!.body.includes("Initiator"));

      // Agent owner：真的造出 queued run 并附 run_input，说明要处理什么。
      const ownerRuns = runsInChat(groupOwner.id);
      assert.equal(ownerRuns.length, ownerRunsBefore + 1, "Agent owner 被直接唤醒");
      const woken = ownerRuns.find((run) => run.instanceId === ownerInstance.id)!;
      assert.equal(woken.status, "queued");
      const inputs = db
        .select()
        .from(agentRunInput)
        .where(eq(agentRunInput.messageId, ownerReminder[0]!.id))
        .all();
      assert.equal(inputs.length, 1);
      assert.equal(inputs[0]!.runId, woken.id);

      // 人类 owner：一条 chat 提醒，零唤醒、零自动接续。
      const humanReminder = reminders(groupHuman.id);
      assert.equal(humanReminder.length, 1, "人类 owner 提醒一次");
      assert.equal(runsInChat(groupHuman.id).length, humanRunsBefore, "人类 owner 不产生 run");
      assert.equal(
        db
          .select()
          .from(agentRunInput)
          .where(eq(agentRunInput.messageId, humanReminder[0]!.id))
          .all().length,
        0,
      );

      // T10：这条 chat 的自动接续被 Human 关掉，提醒照样发。
      const quietReminder = reminders(groupQuiet.id);
      assert.equal(quietReminder.length, 1, "mode=off 也要提醒");
      assert.ok(quietReminder[0]!.body.includes("P8b Integration Machine 3"));

      // 反复 sweep 不产生第二条提醒。
      clockNow = NOW.getTime() + TIMEOUT_MS + 500;
      await scheduler.advance();
      assert.equal(reminders(groupOwner.id).length, 1, "不重复提醒");
      assert.equal(reminders(groupHuman.id).length, 1, "人类 owner 不重复提醒");
      assert.equal(reminders(groupQuiet.id).length, 1, "mode=off 也不重复提醒");
      assert.equal(runsInChat(groupOwner.id).length, ownerRunsBefore + 1);

      // 超时后再过升级时限仍然没人处理 → 升级 Human，并暂停 owner 的自动尝试。
      clockNow = NOW.getTime() + TIMEOUT_MS + ESCALATION_MS;
      await scheduler.advance();

      const escalated = reminders(groupOwner.id).filter((row) => row.body.includes("挂靠超时升级"));
      assert.equal(escalated.length, 1, "Agent owner 升级一次");
      assert.ok(escalated[0]!.body.includes("收件人"));
      assert.ok(escalated[0]!.body.includes("系统已暂停该 owner 在这个挂靠上的自动尝试"));
      assert.equal(runsInChat(groupOwner.id).length, ownerRunsBefore + 1, "升级不再新增 run");

      const timeout = getLease({ ...keys[0]! }, machineCtx).lease.escrow!.timeout;
      assert.equal(timeout.escalatedAt, at(TIMEOUT_MS + ESCALATION_MS).toISOString());
      assert.equal(timeout.ownerAutoAttemptsPaused, true, "owner 自动尝试被暂停");

      // T10：升级也照样发，不受 mode=off 影响。
      assert.equal(
        escrowRow(quiet.escrow.escrowId).timeoutEscalatedAt?.getTime(),
        at(TIMEOUT_MS + ESCALATION_MS).getTime(),
        "mode=off 的 chat 同样被升级",
      );
      assert.equal(
        reminders(groupQuiet.id).filter((row) => row.body.includes("挂靠超时升级")).length,
        1,
      );

      // 人类 owner 永远不会被升级。
      assert.equal(
        reminders(groupHuman.id).filter((row) => row.body.includes("挂靠超时升级")).length,
        0,
      );

      // 超时绝不释放租约：持有者仍是发起者，挂靠行还在。
      const lease = getLease({ ...keys[0]! }, machineCtx).lease;
      assert.equal(lease.state, "held");
      assert.equal(lease.holderInstanceId, escrowerOwner.instanceId);
      assert.equal(lease.escrow?.state, "escrowed");
      assert.equal(
        escrowRow(main.escrow.escrowId).timeoutNotifiedAt?.getTime(),
        at(TIMEOUT_MS).getTime(),
      );
      assert.equal(escrowRow(main.escrow.escrowId).escrowedByInstanceId, escrowerOwner.instanceId);
      assert.deepEqual(clockErrors, []);
    } finally {
      scheduler.stop();
    }
  }, 30_000);
});

afterAll(async () => {
  for (const process of processes) await process.close();
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  await shutdownRuntime("p8b-timeout-integration-done");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});
