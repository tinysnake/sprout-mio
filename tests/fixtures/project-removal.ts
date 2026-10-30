// 真实 SQLite + 真实域入口：项目级移除一名 Agent 的完整处置（设计 §4.4，裁定 d10/d14/d19/d20）。
// 不是为了复用 i3/i4 的结论，而是把「阻断 / 在途 / 清理」三件事在一次调用里走完，
// 并从物理行、视图、读路径、发言门禁四个层面各取一条证据。
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { createGroupChatInput } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import {
  agentInstance,
  agentRun,
  agentRunInput,
  chat,
  chatMember,
  diagnosticEvent,
  message,
  projectMember,
} from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import { addProjectMember, createAgentProfile, removeProjectMember } from "../../src/domain/agent";
import { listAgentRunInputs, listAgentRuns, queuedRunWork } from "../../src/domain/agent-run";
import {
  createDirectChat,
  createGroupChat,
  ensureInstance,
  getChat,
  getInstance,
  listChatMembers,
  listMessages,
  sendMessage,
} from "../../src/domain/chat";
import { ensureProjectChannel } from "../../src/domain/channel";
import type { ChatActor } from "../../src/domain/chat-actor";
import { createProject } from "../../src/domain/project";

migrateDatabase();

const checks: string[] = [];
function pass(label: string, output: unknown = {}) {
  checks.push(label);
  console.log(`PASS ${label} ${JSON.stringify(output)}`);
}
function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}
function groupMemberRows(agentProfileId: string) {
  return db
    .select({ chatId: chatMember.chatId })
    .from(chatMember)
    .innerJoin(chat, eq(chat.id, chatMember.chatId))
    .where(
      and(
        eq(chat.kind, "group"),
        eq(chatMember.memberKind, "agent"),
        eq(chatMember.memberId, agentProfileId),
      ),
    )
    .all();
}

function projectMemberOf(projectId: string, agentProfileId: string) {
  return db
    .select()
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, projectId), eq(projectMember.agentProfileId, agentProfileId)),
    )
    .get();
}
function removalEvents(projectId: string) {
  return db
    .select()
    .from(diagnosticEvent)
    .where(
      and(
        eq(diagnosticEvent.projectId, projectId),
        eq(diagnosticEvent.event, "project_member.removed"),
      ),
    )
    .all().length;
}
function membersOf(chatId: string) {
  return listChatMembers(chatId, ctx).map((member) => `${member.memberKind}:${member.memberId}`);
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_removal_creator";
const strangerId = "usr_removal_stranger";
for (const [id, label] of [
  [creatorId, "creator"],
  [strangerId, "stranger"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, label, `${label}@removal.test`);

const ctx = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const human: ChatActor = { kind: "human", userId: creatorId, ctx };

const project = createProject({ name: "移除门禁" }, ctx);
const channelId = ensureProjectChannel(project.id);
const agentOwner = createAgentProfile({ name: "Owner", persona: "", harness: "pi" }, ctx);
const agentBusy = createAgentProfile({ name: "Busy", persona: "", harness: "pi" }, ctx);
const agentLeaving = createAgentProfile({ name: "Leaving", persona: "", harness: "pi" }, ctx);
for (const agent of [agentOwner, agentBusy, agentLeaving])
  addProjectMember(project.id, agent.id, ctx);

const ownedGroup = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "Owner 的群",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentOwner.id },
      { kind: "agent", id: agentLeaving.id },
    ],
    initialOwner: { kind: "agent", id: agentOwner.id },
  }),
  human,
);
const sharedGroup = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "共享群",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentBusy.id },
      { kind: "agent", id: agentLeaving.id },
    ],
    initialOwner: { kind: "human", id: creatorId },
  }),
  human,
);
// 从未建过 instance 的成员：没有 run、也没有输入，只剩一条普通群成员行要删。
const agentSilent = createAgentProfile({ name: "Silent", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agentSilent.id, ctx);
const silentGroup = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "沉默成员的群",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentSilent.id },
    ],
    initialOwner: { kind: "human", id: creatorId },
  }),
  human,
);

// ---------------------------------------------------------------- 1. 所有者阻断：整次移除被拒，成员仍在
const eventsBeforeOwner = removalEvents(project.id);
const ownerRejected = codeOf(() => removeProjectMember(project.id, agentOwner.id, ctx));
assert.equal(ownerRejected, "conflict", "所有者的项目级移除必须先换 owner 再移");
assert.ok(projectMemberOf(project.id, agentOwner.id), "被拒的移除不能删 project_member 行");
assert.equal(getChat(ownedGroup.id, ctx).owner.id, agentOwner.id, "被拒的移除不能改动群组所有者");
assert.equal(
  groupMemberRows(agentOwner.id).length,
  1,
  "被拒的移除不能删普通群的 chat_member 行（它只在 owner 群里）",
);
assert.equal(
  removalEvents(project.id),
  eventsBeforeOwner,
  "被拒的移除不写 project_member.removed 诊断事件",
);
pass("owner.blocked", {
  code: ownerRejected,
  projectMember: "retained",
  groupOwner: agentOwner.id,
  chatMemberRows: 1,
});

// ---------------------------------------------------------------- 2. 在途阻断：有活跃 run 时同样被拒，且不产生取消副作用
const busyInstance = ensureInstance(sharedGroup.id, agentBusy.id, ctx);
const busyMessage = sendMessage(
  sharedGroup.id,
  { senderKind: "human", senderId: creatorId, body: "开始干活" },
  ctx,
);
const busyRunId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: busyRunId,
    instanceId: busyInstance.id,
    chatId: sharedGroup.id,
    projectId: project.id,
    requestId: ctx.requestId,
    status: "queued",
    sessionId: busyInstance.id,
  })
  .run();
db.insert(agentRunInput)
  .values({ runId: busyRunId, messageId: busyMessage.id, disposition: "pending" })
  .run();
const eventsBeforeBusy = removalEvents(project.id);
const busyRejected = codeOf(() => removeProjectMember(project.id, agentBusy.id, ctx));
assert.equal(busyRejected, "conflict", "d10：有活跃 run 时移除被拒（拒绝优先于取消）");
assert.equal(
  db.select().from(agentRun).where(eq(agentRun.id, busyRunId)).get()?.status,
  "queued",
  "被拒的移除不动 run 状态",
);
assert.equal(
  db.select().from(agentRunInput).where(eq(agentRunInput.runId, busyRunId)).get()?.disposition,
  "pending",
  "被拒的移除不取消 pending 输入",
);
assert.ok(projectMemberOf(project.id, agentBusy.id), "被拒的移除保留 Project 成员行");
assert.equal(groupMemberRows(agentBusy.id).length, 1, "被拒的移除保留普通群成员行");
assert.equal(removalEvents(project.id), eventsBeforeBusy, "被拒的移除不写诊断事件");
pass("active-run.blocked", {
  code: busyRejected,
  runStatus: "queued",
  disposition: "pending",
  chatMemberRows: 1,
});

// ---------------------------------------------------------------- 3. 清理：普通群成员行消失、DM 行保留、pending 输入取消
// agentLeaving 有一份跨对话的历史：群、DM、频道各一条自己的消息，一条已结束的 run 带 pending 输入，
// 另一条已结束的 run 带 delivered 输入（d11：只有未下发的能转 cancelled）。
const leavingGroupInstance = ensureInstance(sharedGroup.id, agentLeaving.id, ctx);
const leavingDm = createDirectChat(project.id, agentLeaving.id, ctx);
const leavingChannelInstance = ensureInstance(channelId, agentLeaving.id, ctx);
const groupAgentMessage = sendMessage(
  sharedGroup.id,
  { senderKind: "agent", senderId: agentLeaving.id, body: "群里的历史汇报" },
  ctx,
);
const channelAgentMessage = sendMessage(
  channelId,
  { senderKind: "agent", senderId: agentLeaving.id, body: "频道里的历史汇报" },
  ctx,
);
const dmAgentMessage = sendMessage(
  leavingDm.chat.id,
  { senderKind: "agent", senderId: agentLeaving.id, body: "DM 里的历史汇报" },
  ctx,
);

const humanInGroup = sendMessage(
  sharedGroup.id,
  { senderKind: "human", senderId: creatorId, body: "两条待发输入" },
  ctx,
);
const settledRunId = newId(ID_PREFIXES.run);
const deliveredRunId = newId(ID_PREFIXES.run);
for (const runId of [settledRunId, deliveredRunId]) {
  db.insert(agentRun)
    .values({
      id: runId,
      instanceId: leavingGroupInstance.id,
      chatId: sharedGroup.id,
      projectId: project.id,
      requestId: ctx.requestId,
      status: "aborted",
      settledAt: new Date(),
      sessionId: leavingGroupInstance.id,
    })
    .run();
  db.insert(agentRunInput)
    .values({ runId, messageId: humanInGroup.id, disposition: "pending" })
    .run();
}
// delivered 行要满足 CHECK：disposition=delivered 必须带 delivered_at、不能带取消事实。
db.update(agentRunInput)
  .set({ disposition: "delivered", deliveredAt: new Date() })
  .where(eq(agentRunInput.runId, deliveredRunId))
  .run();

const channelMembersBefore = membersOf(channelId);
assert.ok(
  channelMembersBefore.includes(`agent:${agentLeaving.id}`),
  "移除前频道成员里必须有这名 Agent（视图来自 project_member）",
);
assert.equal(groupMemberRows(agentLeaving.id).length, 2, "移除前两个普通群各有一条成员行");
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, leavingDm.chat.id), eq(chatMember.memberId, agentLeaving.id)))
    .all().length,
  1,
  "移除前 DM 也有一条成员行",
);
assert.equal(
  db.select().from(chatMember).where(eq(chatMember.chatId, channelId)).all().length,
  0,
  "频道本来就没有 chat_member 行，成员是派生事实",
);
const eventsBeforeRemoval = removalEvents(project.id);
assert.equal(getChat(leavingDm.chat.id, ctx).archivedAt, undefined, "移除前 DM 未归档（对照组）");
const removed = codeOf(() => removeProjectMember(project.id, agentLeaving.id, ctx));
assert.equal(removed, "ok", "无在途运行时移除成功");
assert.equal(projectMemberOf(project.id, agentLeaving.id), undefined, "Project 成员行删除");
assert.equal(groupMemberRows(agentLeaving.id).length, 0, "普通群的 chat_member 行物理删除");
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, leavingDm.chat.id), eq(chatMember.memberId, agentLeaving.id)))
    .all().length,
  1,
  "DM 的成员行保留（d14），历史仍可读",
);
const cancelledInput = db
  .select()
  .from(agentRunInput)
  .where(eq(agentRunInput.runId, settledRunId))
  .get();
assert.equal(cancelledInput?.disposition, "cancelled", "未下发的 pending 输入转 cancelled");
assert.equal(cancelledInput?.cancelReason, "membership_revoked", "取消原因用既有枚举值");
assert.ok(cancelledInput?.cancelledAt instanceof Date, "取消事实必须带时间");
assert.equal(cancelledInput?.deliveredAt, null, "cancelled 行不能带下发时间");
const deliveredInput = db
  .select()
  .from(agentRunInput)
  .where(eq(agentRunInput.runId, deliveredRunId))
  .get();
assert.equal(deliveredInput?.disposition, "delivered", "d11：delivered 输入不转 cancelled");
assert.equal(deliveredInput?.cancelReason, null, "delivered 输入不写取消原因");
assert.equal(
  removalEvents(project.id),
  eventsBeforeRemoval + 1,
  "一次真正生效的移除写一条 project_member.removed 诊断事件",
);
pass("cleanup.applied", {
  code: removed,
  groupMemberRows: 0,
  dmMemberRow: 1,
  pendingInput: { disposition: cancelledInput?.disposition, reason: cancelledInput?.cancelReason },
  deliveredInput: {
    disposition: deliveredInput?.disposition,
    reason: deliveredInput?.cancelReason,
  },
});

// ---------------------------------------------------------------- 3b. 从未建过 instance 的成员也要清成员行
assert.equal(groupMemberRows(agentSilent.id).length, 1, "沉默成员在群里只有一条成员行");
assert.equal(
  db
    .select()
    .from(agentInstance)
    .where(
      and(
        eq(agentInstance.projectId, project.id),
        eq(agentInstance.agentProfileId, agentSilent.id),
      ),
    )
    .all().length,
  0,
  "这个成员确实没有 instance",
);
assert.equal(
  codeOf(() => removeProjectMember(project.id, agentSilent.id, ctx)),
  "ok",
  "没有 instance 不是「无事可做」：成员行照样要清",
);
assert.equal(groupMemberRows(agentSilent.id).length, 0, "无 instance 的成员在普通群的行也要删");
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, silentGroup.id), eq(chatMember.memberId, agentSilent.id)))
    .all().length,
  0,
  "按群核一遍：沉默成员的行按 chat 也确实没了",
);
pass("cleanup.without-instance", { groupMemberRows: 0, instanceRows: 0 });

// ---------------------------------------------------------------- 4. 重复移除幂等：成功且零副作用
const snapshot = () =>
  JSON.stringify({
    projectMember: db.select().from(projectMember).all(),
    chatMember: db.select().from(chatMember).all(),
    agentRun: db.select().from(agentRun).all(),
    agentRunInput: db.select().from(agentRunInput).all(),
    diagnosticEvent: db.select().from(diagnosticEvent).all(),
  });
const beforeRepeat = snapshot();
const repeat = codeOf(() => removeProjectMember(project.id, agentLeaving.id, ctx));
assert.equal(repeat, "ok", "已经不在项目的 Agent 再移除一次不报错");
assert.equal(snapshot(), beforeRepeat, "重复移除不产生任何行级副作用（含诊断事件）");
// 拼错的 profile id 仍是 not_found：幂等只覆盖「合法 profile 但已不是成员」。
const unknownProfile = codeOf(() =>
  removeProjectMember(project.id, newId(ID_PREFIXES.agentProfile), ctx),
);
assert.equal(unknownProfile, "not_found", "不存在的 profile 仍是 not_found，不靠幂等吞掉拼错的 id");
pass("idempotent.repeat", { code: repeat, rowsUnchanged: true, unknownProfile });

// ---------------------------------------------------------------- 5. 历史可读、发言被拒
assert.deepEqual(
  listMessages(sharedGroup.id, ctx)
    .filter((entry) => entry.senderKind === "agent" && entry.senderId === agentLeaving.id)
    .map((entry) => entry.id),
  [groupAgentMessage.id],
  "移除后群里仍能读到它的历史消息",
);
assert.deepEqual(
  listMessages(channelId, ctx)
    .filter((entry) => entry.senderKind === "agent" && entry.senderId === agentLeaving.id)
    .map((entry) => entry.id),
  [channelAgentMessage.id],
  "移除后频道里仍能读到它的历史消息",
);
assert.deepEqual(
  listMessages(leavingDm.chat.id, ctx).map((entry) => entry.id),
  [dmAgentMessage.id],
  "移除后 DM 的历史仍可读",
);
assert.equal(getChat(sharedGroup.id, ctx).id, sharedGroup.id, "移除后对话本身仍可读");
assert.equal(
  getInstance(leavingGroupInstance.id, ctx).id,
  leavingGroupInstance.id,
  "历史 instance 行物理保留且仍可读",
);
assert.deepEqual(
  listAgentRuns(sharedGroup.id, ctx)
    .filter((run) => run.instanceId === leavingGroupInstance.id)
    .map((run) => run.id),
  [settledRunId, deliveredRunId],
  "移除后它的历史 run 仍可读",
);
assert.deepEqual(
  listAgentRunInputs(settledRunId, ctx).map((input) => input.disposition),
  ["cancelled"],
  "历史输入连同取消事实一起可读",
);
assert.equal(
  codeOf(() => ensureInstance(sharedGroup.id, agentLeaving.id, ctx)),
  "not_found",
  "移除后拿不到新 instance",
);
const deniedSpeech = [
  codeOf(() =>
    sendMessage(
      sharedGroup.id,
      { senderKind: "agent", senderId: agentLeaving.id, body: "群里还想发言" },
      ctx,
    ),
  ),
  codeOf(() =>
    sendMessage(
      channelId,
      { senderKind: "agent", senderId: agentLeaving.id, body: "频道里还想发言" },
      ctx,
    ),
  ),
  codeOf(() =>
    sendMessage(
      leavingDm.chat.id,
      { senderKind: "agent", senderId: agentLeaving.id, body: "DM 里还想发言" },
      ctx,
    ),
  ),
];
assert.deepEqual(deniedSpeech, ["not_found", "not_found", "not_found"], "三个对话的发言一律被拒");
assert.equal(
  db
    .select()
    .from(message)
    .where(and(eq(message.senderKind, "agent"), eq(message.senderId, agentLeaving.id)))
    .all().length,
  3,
  "被拒的发言不落消息行（3 条历史 + 0 条新增）",
);
pass("history.readable.speech.denied", {
  messages: 3,
  runs: 2,
  cancelledInput: "readable",
  denied: deniedSpeech,
});

// ---------------------------------------------------------------- 6. 频道成员随移除同步消失（端到端）
const channelMembersAfter = membersOf(channelId);
const remainingAgentMembers = db
  .select()
  .from(projectMember)
  .where(eq(projectMember.projectId, project.id))
  .all()
  .map((row: { agentProfileId: string }) => `agent:${row.agentProfileId}`);
assert.deepEqual(
  [...channelMembersAfter].sort((left, right) => left.localeCompare(right)),
  [`human:${creatorId}`, ...remainingAgentMembers].sort((left, right) => left.localeCompare(right)),
  "频道成员是 Project 成员的派生事实：移除后同步消失，剩下的成员逐个对上",
);
assert.equal(
  channelMembersAfter.includes(`agent:${agentLeaving.id}`),
  false,
  "被移除的 Agent 不在频道成员里",
);
assert.equal(
  channelMembersBefore.includes(`agent:${agentLeaving.id}`),
  true,
  "同一断言对照组：移除前它确实在频道成员里",
);
assert.equal(
  channelMembersAfter.includes(`human:${creatorId}`),
  true,
  "频道 owner（Project 创建者）仍在成员里",
);
assert.equal(
  db.select().from(agentInstance).where(eq(agentInstance.id, leavingChannelInstance.id)).all()
    .length,
  1,
  "频道里的 instance 行物理保留（历史 run 仍引用它）",
);
pass("channel.membership.synced", {
  before: channelMembersBefore.length,
  after: channelMembersAfter.length,
  human: `human:${creatorId}`,
});

// ---------------------------------------------------------------- 7. A02：移除后旧 DM 归档，Human 发言被明确拒绝
// 规格 `docs/communication-decisions.md`「一期」：正常移除后其 DM 归档、不可继续聊天。
// 修复前：Human 向旧 DM 发消息返回 ok、消息与排队 run 都落库，直到执行时才以 remote_run_inactive
// 失败——先成功再失败。这里断言拒绝发生在写入之前：码明确、不落消息、不排队必败 run。
assert.ok(
  getChat(leavingDm.chat.id, ctx).archivedAt,
  "移除后该 Agent 的 DM 归档（communication-decisions「其 DM 归档」）",
);
const dmMessagesBefore = listMessages(leavingDm.chat.id, ctx).length;
const dmRunsBefore = listAgentRuns(leavingDm.chat.id, ctx).length;
const dmQueuedBefore = queuedRunWork().filter(
  (work) => work.run.chatId === leavingDm.chat.id,
).length;
const humanAfterRemoval = codeOf(() =>
  sendMessage(
    leavingDm.chat.id,
    { senderKind: "human", senderId: creatorId, body: "移除后 Human 还想继续聊" },
    ctx,
  ),
);
assert.equal(
  humanAfterRemoval,
  "conflict",
  "移除后 Human 向旧 DM 发言得到明确拒绝，不是先成功再失败",
);
assert.equal(listMessages(leavingDm.chat.id, ctx).length, dmMessagesBefore, "被拒的消息不落库");
assert.equal(listAgentRuns(leavingDm.chat.id, ctx).length, dmRunsBefore, "被拒的消息不排队 run");
assert.equal(
  queuedRunWork().filter((work) => work.run.chatId === leavingDm.chat.id).length,
  dmQueuedBefore,
  "被拒的消息不留下必败的排队 run",
);

// 重新加入：既有 DM 恢复（communication-decisions「同一 Agent 重新加入 Project 时恢复既有 DM」）。
addProjectMember(project.id, agentLeaving.id, ctx);
assert.equal(
  getChat(leavingDm.chat.id, ctx).archivedAt,
  undefined,
  "重新加入 Project 后既有 DM 取消归档",
);
const revivedMessage = sendMessage(
  leavingDm.chat.id,
  { senderKind: "human", senderId: creatorId, body: "重新加入后的第一条" },
  ctx,
);
assert.ok(revivedMessage.id);
assert.equal(
  queuedRunWork().filter((work) => work.run.chatId === leavingDm.chat.id).length,
  1,
  "重新加入后 DM 又能开出一条 run",
);
pass("a02.removed-dm-archived", {
  archivedAt: null,
  humanSendCode: humanAfterRemoval,
  messagesUnchanged: dmMessagesBefore,
  runsUnchanged: dmRunsBefore,
  revivedRun: queuedRunWork().filter((work) => work.run.chatId === leavingDm.chat.id).length,
});

// 项目级移除不能变成跨 Project 的越权入口。
const strangerCtx = { userId: strangerId, requestId: newId(ID_PREFIXES.request) };
assert.equal(
  codeOf(() => removeProjectMember(project.id, agentBusy.id, strangerCtx)),
  "not_found",
  "非创建者不能借项目级移除处置别人的成员",
);
assert.ok(projectMemberOf(project.id, agentBusy.id), "越权调用不产生副作用");
pass("isolation.stranger", { code: "not_found" });

console.log(`PASS i5-project-removal ${checks.length} checks`);
