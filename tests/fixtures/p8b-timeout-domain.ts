// I-P8b 验收：挂靠超时提醒 / 升级（T1–T12）与申请遇阻等待（N1–N8）。
// 真实 SQLite、真实 Project/Group/分身身份与真实租约；时限用项目级覆盖压到秒级，
// 所以这里验证的是同一套产品代码路径，而不是另写的测试替身。
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createGroupChatInput } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  agentRun,
  agentRunInput,
  chatContinuationControl,
  chatMember,
  leaseAuthorization,
  leaseEscrow,
  machineLease,
  message,
} from "../../src/db/schema";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import { createGroupChat, ensureInstance } from "../../src/domain/chat";
import { applyChatContinuationCommand } from "../../src/domain/chat-continuation";
import {
  leaseEscalationRecipients,
  sweepLeaseEscrowTimeouts,
} from "../../src/domain/lease-timeout";
import { waitForLease } from "../../src/domain/lease-wait";
import { createMachine, hashCredential, saveProjectMachineBinding } from "../../src/domain/machine";
import { createProject, updateProjectWakePolicy } from "../../src/domain/project";
import {
  acquireLease,
  claimLease,
  escrowLease,
  getLease,
  leaseWhere,
  type AgentRemoteContext,
} from "../../src/server/lease";
import { openInitialMembership } from "../../src/server/membership";

// 默认是 30 分钟 / 2 小时；这里由 Project 覆盖压到秒/分钟级，集成线不能真等 2.5 小时。
const TIMEOUT_MS = 4_000;
const ESCALATION_MS = 60_000;
const SENDER_ID = "sprout.lease-timeout";

const projectOwner = "p8b-owner";

function pass(message: string) {
  console.log(`p8b-timeout-domain: PASS ${message}`);
}

function boot() {
  const id = newId(ID_PREFIXES.boot);
  sqlite
    .prepare(
      "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
    )
    .run(id);
  return id;
}

const projectCtx = { userId: projectOwner, requestId: newId(ID_PREFIXES.request) };
const req = () => newId(ID_PREFIXES.request);

/** 一个真实分身身份：instance 在指定 chat，run running，grant 未过期未撤销。 */
function actor(userId: string, projectId: string, chatId: string, profileId: string) {
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
      Math.floor(Date.now() / 1000),
      randomBytes(16).toString("hex"),
    );
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare(
      "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      grantId,
      hashCredential(randomBytes(32).toString("base64url")),
      userId,
      projectId,
      chatId,
      instance.id,
      runId,
      Date.now(),
      Date.now() + 3600000,
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
  } satisfies AgentRemoteContext;
}

migrateDatabase();
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(projectOwner, projectOwner, "p8b-owner@example.test");

const project = createProject({ name: "P8b" }, projectCtx);
// 分身的归属人类就是能访问这个 Project 的那个人：`getAgentProfile` 与 `assertProjectAccess`
// 都按 createdBy 收口，所以本版里「挂靠发起者」与「Project owner」必然是同一个人类。
const initiatorAgent = createAgentProfile(
  { name: "Initiator", persona: "", harness: "pi" },
  projectCtx,
);
const ownerAgent = createAgentProfile({ name: "Owner", persona: "", harness: "pi" }, projectCtx);
const retryAgent = createAgentProfile({ name: "Retry", persona: "", harness: "pi" }, projectCtx);
const claimerAgent = createAgentProfile(
  { name: "Claimer", persona: "", harness: "pi" },
  projectCtx,
);
for (const profile of [initiatorAgent, ownerAgent, retryAgent, claimerAgent])
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
    title: "P8b Agent Owner Group",
    initialOwner: { kind: "agent", id: ownerAgent.id },
    members: members([ownerAgent.id, claimerAgent.id]),
  }),
  chatActor,
);
const groupHuman = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Human Owner Group",
    initialOwner: { kind: "human", id: projectOwner },
    members: members([]),
  }),
  chatActor,
);
const groupRetry = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Retry Group",
    initialOwner: { kind: "agent", id: retryAgent.id },
    members: members([retryAgent.id]),
  }),
  chatActor,
);
const groupQuiet = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P8b Quiet Group",
    initialOwner: { kind: "agent", id: ownerAgent.id },
    members: members([ownerAgent.id, claimerAgent.id]),
  }),
  chatActor,
);

// 时限全部相对这个基准算；基准落到真实过去，是因为只读视图（leaseView）按真实 now 投影
// 「超时待处理」，而 sweep 用注入的基准时间——两者必须一致才能断言同一个事实。
const NOW = new Date(Date.now() - 600_000);
const machineCtx = { userId: projectOwner, bootId: boot(), requestId: req(), now: NOW };
const keys = [0, 1, 2, 3, 4].map((index) => {
  const enrolled = createMachine({ name: `P8b Machine ${index}` }, machineCtx);
  const key = { projectId: project.id, machineId: enrolled.detail.machine.id };
  saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
  openInitialMembership(db, { ...key, now: NOW });
  return key;
});

// Project 级覆盖：把两个时限压到秒/分钟级，其余字段沿用既有判定器配置。
updateProjectWakePolicy(
  { projectId: project.id, provider: "llm", expectedConfigRevision: 1, requestId: req() },
  projectCtx,
  {
    thresholdVersion: "p8b-test",
    leaseTimeouts: { timeoutMs: TIMEOUT_MS, escalationMs: ESCALATION_MS },
  },
  NOW,
);

const escorer = actor(projectOwner, project.id, groupOwner.id, initiatorAgent.id);
const escorerHumanChat = actor(projectOwner, project.id, groupHuman.id, initiatorAgent.id);
const escorerRetry = actor(projectOwner, project.id, groupRetry.id, initiatorAgent.id);
const escorerQuiet = actor(projectOwner, project.id, groupQuiet.id, initiatorAgent.id);
const claimer = actor(projectOwner, project.id, groupOwner.id, claimerAgent.id);

/** 各 Machine 的挂靠：发起者先持有，再把租约挂到目标 Group。 */
function escrow(key: (typeof keys)[number], chatId: string, ctx: AgentRemoteContext) {
  acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, ctx);
  return escrowLease(
    { ...key, action: "escrow", requestId: req(), expectedGeneration: 1, chatId },
    ctx,
  );
}

const main = escrow(keys[0], groupOwner.id, escorer);
const human = escrow(keys[1], groupHuman.id, escorerHumanChat);
const retry = escrow(keys[2], groupRetry.id, escorerRetry);
escrow(keys[3], groupQuiet.id, escorerQuiet);
const waited = escrow(keys[4], groupQuiet.id, escorerQuiet);
pass("五个挂靠就位（租约仍被原持有者占用）");
// T8 前置：retry 群里的 owner 分身已经被移出成员，第一次唤醒就必然失败。
db.delete(chatMember)
  .where(
    and(
      eq(chatMember.chatId, groupRetry.id),
      eq(chatMember.memberKind, "agent"),
      eq(chatMember.memberId, retryAgent.id),
    ),
  )
  .run();

// T10 的前置：这条 chat 被人类走真实产品命令关掉了自动唤醒，超时提醒仍必须照发。
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
    reason: "p8b-test",
  },
  projectCtx,
  NOW,
);
assert.equal(
  db
    .select()
    .from(chatContinuationControl)
    .where(eq(chatContinuationControl.chatId, groupQuiet.id))
    .get()?.mode,
  "off",
  "前置：人类已暂停这条 chat 的自动唤醒",
);

const at = (ms: number) => new Date(NOW.getTime() + ms);
const escrowRow = (escrowId: string) =>
  db.select().from(leaseEscrow).where(eq(leaseEscrow.id, escrowId)).get()!;
const reminders = (chatId: string) =>
  db
    .select()
    .from(message)
    .where(and(eq(message.chatId, chatId), eq(message.senderId, SENDER_ID)))
    .all();
const runsFor = (chatId: string, instanceId: string) =>
  db
    .select()
    .from(agentRun)
    .where(and(eq(agentRun.chatId, chatId), eq(agentRun.instanceId, instanceId)))
    .all();
const runInputs = (messageId: string) =>
  db.select().from(agentRunInput).where(eq(agentRunInput.messageId, messageId)).all();
/** 唤醒 = 新 run + run_input；先记基线，才能证明某条提醒没有唤醒任何人。 */
const runsInChat = (chatId: string) =>
  db.select().from(agentRun).where(eq(agentRun.chatId, chatId)).all().length;

/**
 * 租约占用与权限的快照：超时提醒绝不允许改动其中任何一项（T6）。
 * 四个 timeout_* 列是超时机制自己的只读标记，所以刻意排除；它们的变化由 T5/T9 单独断言。
 */
function authoritySnapshot(key: (typeof keys)[number], escrowId: string) {
  const {
    timeoutNotifiedAt: _notifiedAt,
    timeoutNoticeAttempt: _noticeAttempt,
    timeoutNoticeNextAt: _noticeNextAt,
    timeoutEscalatedAt: _escalatedAt,
    ...escrow
  } = escrowRow(escrowId);
  return JSON.stringify({
    lease: db.select().from(machineLease).where(leaseWhere(key)).get(),
    authorizations: db
      .select()
      .from(leaseAuthorization)
      .where(eq(leaseAuthorization.projectId, key.projectId))
      .all(),
    escrow,
  });
}

// —— T1 计时起点 = 挂靠被接受时刻；T2 默认 30 分钟（这里被 Project 覆盖）。
// 基线：actor 装配已经在这个 chat 里留了 1 个 run，超时提醒不允许再多出任何 run。
const humanChatRunsBefore = runsInChat(groupHuman.id);
assert.equal(main.escrow.escrowedAt, NOW.toISOString());
assert.deepEqual(sweepLeaseEscrowTimeouts(at(TIMEOUT_MS - 1)), {
  reminded: 0,
  rewoken: 0,
  escalated: 0,
});
assert.equal(reminders(groupOwner.id).length, 0, "未到点不提醒");
assert.equal(escrowRow(main.escrow.escrowId).timeoutNotifiedAt, null);
pass("T1/T2：计时起点是挂靠被接受的时刻，未到点不提醒");

const before = authoritySnapshot(keys[0], main.escrow.escrowId);
const ownerInstance = ensureInstance(groupOwner.id, ownerAgent.id, projectCtx);

// —— T3/T7：owner 是 Agent → 直接唤醒，内容要说清要处理什么。
const reminded = sweepLeaseEscrowTimeouts(at(TIMEOUT_MS));
assert.equal(reminded.reminded, 5, "五个挂靠同时到点");
const only = reminders(groupOwner.id);
assert.equal(only.length, 1);
const reminder = only[0]!;
assert.equal(reminder.senderKind, "agent");
assert.equal(reminder.chatId, groupOwner.id, "提醒落在挂靠所在的那条 chat");
assert.ok(reminder.body.includes("P8b Machine 0"), "提醒说明要用哪台 Machine");
assert.ok(reminder.body.includes("P8b Agent Owner Group"), "提醒说明租约挂在哪个 Group");
assert.ok(reminder.body.includes("Initiator"), "提醒说明是谁要用");
assert.ok(
  reminder.body.includes("归还") && reminder.body.includes("继续占用"),
  "提醒要求 owner 决定归还还是继续占用",
);
assert.equal(
  escrowRow(main.escrow.escrowId).timeoutNotifiedAt?.getTime(),
  at(TIMEOUT_MS).getTime(),
);
const ownerRuns = runsFor(groupOwner.id, ownerInstance.id);
assert.equal(ownerRuns.length, 1, "agent owner 被直接唤醒（queued run）");
assert.equal(ownerRuns[0]!.status, "queued");
const inputs = runInputs(reminder.id);
assert.equal(inputs.length, 1);
assert.equal(inputs[0]!.runId, ownerRuns[0]!.id);
assert.equal(inputs[0]!.disposition, "pending");
pass("T3/T7：Agent owner 被直接唤醒，唤醒内容说清要处理什么");

// —— T5：「只提醒一次」；超时待处理常驻。
assert.deepEqual(sweepLeaseEscrowTimeouts(at(TIMEOUT_MS + 500)), {
  reminded: 0,
  rewoken: 0,
  escalated: 0,
});
assert.equal(reminders(groupOwner.id).length, 1, "不重复提醒");
const timeout = getLease({ ...keys[0] }, machineCtx).lease.escrow!.timeout;
assert.equal(timeout.deadlineAt, at(TIMEOUT_MS).toISOString());
assert.equal(timeout.notifiedAt, at(TIMEOUT_MS).toISOString());
assert.equal(timeout.awaitingHandling, true, "超时待处理常驻，直到被处理");
assert.equal(timeout.ownerAutoAttemptsPaused, false);
pass("T5：只提醒一次，超时待处理状态常驻");

// —— T6：超时只加只读标记，绝不释放租约。
assert.equal(
  authoritySnapshot(keys[0], main.escrow.escrowId),
  before,
  "超时提醒不改租约、授权与挂靠行",
);
assert.equal(
  db.select().from(machineLease).where(leaseWhere(keys[0])).get()!.holderInstanceId,
  escorer.instanceId,
  "挂靠期间租约仍是原持有者的",
);
assert.equal(escrowRow(main.escrow.escrowId).state, "escrowed");
assert.ok(reminder.body.includes("在你处理之前，租约占用与权限保持不变"));
pass("T6：超时只加只读标记，绝不释放租约");

// —— T3/T4 分流：owner 是人类 → 只在该 Group 的 chat 发一条消息，不唤醒、不自动接续、不再升级。
const humanReminders = reminders(groupHuman.id);
assert.equal(humanReminders.length, 1);
assert.ok(humanReminders[0]!.body.includes("不触发唤醒"));
assert.equal(runInputs(humanReminders[0]!.id).length, 0, "人类 owner 的提醒不产生任何 run 输入");
assert.equal(runsInChat(groupHuman.id), humanChatRunsBefore, "人类 owner 的提醒不唤醒任何分身");
pass("T3/T4：人类 owner 只收到一条 chat 提醒，不唤醒也不自动接续");

// —— T10：人类关掉自动唤醒也不影响超时提醒（明确例外）。
assert.equal(
  db
    .select()
    .from(chatContinuationControl)
    .where(eq(chatContinuationControl.chatId, groupQuiet.id))
    .get()!.mode,
  "off",
);
assert.equal(reminders(groupQuiet.id).length, 2, "被暂停的 chat 里超时照常提醒（machine 3/4）");
pass("T10：人类暂停自动唤醒不影响超时提醒与升级");

// —— T8：唤醒失败复用既有重试规则——提醒只发一次，只重投唤醒。
// （owner 分身已在装配时移出群成员，所以这次唤醒是失败的。）
assert.equal(reminders(groupRetry.id).length, 1, "唤醒失败也保留提醒消息");
const retryRow = escrowRow(retry.escrow.escrowId);
assert.equal(retryRow.timeoutNoticeAttempt, 1);
assert.equal(
  retryRow.timeoutNoticeNextAt?.getTime(),
  at(TIMEOUT_MS + 5_000).getTime(),
  "重试间隔取自既有 agent-run 规则（首个间隔 5 秒）",
);
assert.deepEqual(sweepLeaseEscrowTimeouts(at(TIMEOUT_MS + 4_000)), {
  reminded: 0,
  rewoken: 0,
  escalated: 0,
});
assert.equal(escrowRow(retry.escrow.escrowId).timeoutNoticeAttempt, 1, "未到重试时刻不重投");
db.insert(chatMember)
  .values({ chatId: groupRetry.id, memberKind: "agent", memberId: retryAgent.id })
  .run();
const rewoken = sweepLeaseEscrowTimeouts(at(TIMEOUT_MS + 5_000));
assert.equal(rewoken.rewoken, 1);
const retryRow2 = escrowRow(retry.escrow.escrowId);
assert.equal(retryRow2.timeoutNoticeAttempt, null);
assert.equal(retryRow2.timeoutNoticeNextAt, null);
assert.equal(reminders(groupRetry.id).length, 1, "重试只重投唤醒，不重发提醒");
const retryInstance = ensureInstance(groupRetry.id, retryAgent.id, projectCtx);
assert.equal(
  runsFor(groupRetry.id, retryInstance.id).filter(
    (row: typeof agentRun.$inferSelect) => row.status === "queued",
  ).length,
  1,
);
pass("T8：唤醒失败按既有重试规则重投，提醒仍然只有一条");

// —— T9：超时后再过 2 小时（压成 1 分钟）仍未处理 → 升级给人类，并暂停该 owner 的自动尝试。
const escalated = sweepLeaseEscrowTimeouts(at(TIMEOUT_MS + ESCALATION_MS));
assert.equal(escalated.escalated, 4, "四个 agent-owner 挂靠同时升级");
const escalation = reminders(groupOwner.id).filter((row: typeof message.$inferSelect) =>
  row.body.includes("挂靠超时升级"),
);
// 升级收件人是「挂靠发起者 + Project owner」去重后的集合：本版两个角色是人，所以恰好一条。
assert.deepEqual(leaseEscalationRecipients(escrowRow(main.escrow.escrowId)), [
  { kind: "human", userId: projectOwner },
]);
assert.equal(escalation.length, 1, "升级只发 chat 消息，收件人去重后一条");
assert.ok(escalation[0]!.body.includes("收件人"), "升级消息点名收件人");
assert.ok(
  escalation.every((row: typeof message.$inferSelect) =>
    row.body.includes("已暂停该 owner 在这个挂靠上的自动尝试"),
  ),
);
assert.equal(runInputs(escalation[0]!.id).length, 0, "升级不触发唤醒");
const escalatedTimeout = getLease({ ...keys[0] }, machineCtx).lease.escrow!.timeout;
assert.equal(escalatedTimeout.escalatedAt, at(TIMEOUT_MS + ESCALATION_MS).toISOString());
assert.equal(escalatedTimeout.ownerAutoAttemptsPaused, true);
assert.equal(
  escrowRow(main.escrow.escrowId).timeoutNoticeAttempt,
  null,
  "升级后停止该 owner 的自动尝试",
);
assert.equal(runsFor(groupOwner.id, ownerInstance.id).length, 1, "升级后不再为该 owner 重投唤醒");
assert.equal(
  db.select().from(machineLease).where(leaseWhere(keys[0])).get()!.holderInstanceId,
  escorer.instanceId,
  "升级仍然不是自动收回",
);
// 人类 owner 的挂靠过了升级时刻也没有升级（它本来就没有升级这一档）。
assert.equal(escrowRow(human.escrow.escrowId).timeoutEscalatedAt, null);
assert.equal(reminders(groupHuman.id).length, 1, "人类 owner 不再升级");
assert.deepEqual(sweepLeaseEscrowTimeouts(at(TIMEOUT_MS + 2 * ESCALATION_MS)), {
  reminded: 0,
  rewoken: 0,
  escalated: 0,
});
pass("T9：2 小时未处理升级给人类，并暂停该 owner 的自动尝试");

// —— T12/T6：处理动作仍然成立——超时不影响领取。
const claimed = claimLease(
  {
    ...keys[0],
    action: "claim",
    requestId: req(),
    expectedGeneration: 2,
    escrowId: main.escrow.escrowId,
  },
  claimer,
);
assert.equal(claimed.escrow.state, "claimed");
assert.equal(claimed.lease.holderInstanceId, claimer.instanceId);
assert.equal(escrowRow(main.escrow.escrowId).state, "claimed", "被处理即消失");
pass("T6/T12：超时不影响处理动作，领取照常成功");

// —— N1–N8：申请遇阻等待。阻塞当前 run、只读、对持有者完全不可见。
const waitKey = keys[4];
const waitLease = () => getLease({ ...waitKey }, machineCtx).lease;
const waitSnapshot = authoritySnapshot(waitKey, waited.escrow.escrowId);
const quietReminders = reminders(groupQuiet.id).length;
const waitStart = at(2 * ESCALATION_MS);
let elapsed = 0;
const blocked = await waitForLease<ReturnType<typeof waitLease>>({
  requesterInstanceId: claimer.instanceId,
  requestedMs: 1_000,
  pollMs: 400,
  deps: {
    readLease: waitLease,
    now: () => new Date(waitStart.getTime() + elapsed),
    sleep: async (ms) => {
      elapsed += ms;
    },
  },
});
assert.deepEqual(blocked, { ok: false, reason: "timed_out" }, "到点仍拿不到 → 同步返回失败 + 原因");
assert.equal(elapsed, 1_000, "等待严格受申请方传入的时长约束");
assert.equal(authoritySnapshot(waitKey, waited.escrow.escrowId), waitSnapshot, "等待期间零写入");
assert.equal(reminders(groupQuiet.id).length, quietReminders, "等待不向持有者发任何消息");
const held = await waitForLease({
  requesterInstanceId: escorerQuiet.instanceId,
  requestedMs: 1_000,
  deps: {
    readLease: waitLease,
    now: () => new Date(waitStart.getTime() + elapsed),
    sleep: async () => {},
  },
});
assert.equal(held.ok, true, "已经持有就不进入等待");
assert.equal(elapsed, 1_000, "没有对象时不空等");
pass("N1–N8：等待阻塞到点同步返回失败，不抢占、不打扰持有者");

console.log("p8b-timeout-domain: PASS all");
