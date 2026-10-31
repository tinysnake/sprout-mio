import "../../src/contracts/chat";
import { and, eq } from "drizzle-orm";
import { db, sqlite } from "../../src/db";
import {
  agentRun,
  agentRunInput,
  chatMember,
  machineLease,
  leaseMutation,
  message,
} from "../../src/db/schema";
import { addProjectMember, removeProjectMember } from "../../src/domain/agent";
import {
  appendHumanRunInput,
  markRunInputDelivered,
  queuedRunWork,
  recoverAgentRuns,
} from "../../src/domain/agent-run";
import { ensureInstance, getChat, sendMessage, setChatOwner } from "../../src/domain/chat";
import { claimDueEvaluation, reconcileChatSchedule } from "../../src/domain/chat-schedule";
import { readChatEffectiveMembers } from "../../src/domain/channel";
import { buildPeriodicInput, commitEvaluationResult } from "../../src/domain/continuation-delivery";
import { mutateTask } from "../../src/domain/task";
import {
  acquireLease,
  completeLeaseMutation,
  handoffLease,
  reclaimLease,
} from "../../src/server/lease";
import { seedRemoteActor } from "./remote-actors";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { assert, assertionCount, setup, snapshot, seedLease, blocked } from "./p6c-member-fixture";

const f = setup();
const pass = (name: string) => console.log(`PASS ${name}`);
const remove = () => removeProjectMember(f.project.id, f.agent.id, f.ctx);
const holder = seedRemoteActor(sqlite, f.ctx.userId, f.project.id, f.bootId);
const pending = seedLease(f, "fencing", holder.instanceId, f.instance.id);
const beforeHandoff = snapshot();
blocked(remove);
assert.deepEqual(snapshot(), beforeHandoff);
completeLeaseMutation(pending.key, new Date(), false);
assert.equal(
  db.select().from(machineLease).where(eq(machineLease.machineId, pending.key.machineId)).get()
    ?.holderInstanceId,
  f.instance.id,
);
reclaimLease(
  {
    ...pending.key,
    action: "reclaim",
    confirm: true,
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 2,
  },
  { ...f.machineCtx, now: new Date() },
);
assert.equal(
  db.select().from(machineLease).where(eq(machineLease.machineId, pending.key.machineId)).get()
    ?.state,
  "free",
);
pass("revoke.handoff-target.resolved-before-removal");

const handoffKey = f.makeMachine();
acquireLease(
  {
    ...handoffKey,
    action: "acquire",
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 0,
  },
  holder,
);
const oldMessages = [
  sendMessage(
    f.group.id,
    { senderKind: "human", senderId: f.ctx.userId, body: `@${f.agent.id} group` },
    f.ctx,
  ),
  sendMessage(
    f.channel.id,
    { senderKind: "human", senderId: f.ctx.userId, body: `@${f.agent.id} channel` },
    f.ctx,
  ),
  sendMessage(
    f.dm.chat.id,
    { senderKind: "human", senderId: f.ctx.userId, body: "DM pending" },
    f.ctx,
  ),
];
// Preserve actual terminal run history while leaving undelivered input for revocation.
for (const row of db.select().from(agentRun).where(eq(agentRun.projectId, f.project.id)).all()) {
  if (row.id !== holder.runId && (row.status === "queued" || row.status === "running"))
    db.update(agentRun)
      .set({ status: "aborted", settledAt: new Date() })
      .where(eq(agentRun.id, row.id))
      .run();
}
// A Group Task start can be admitted but undelivered; it must also be cancelled.
const human = { kind: "human" as const, userId: f.ctx.userId, ctx: f.ctx };
setChatOwner(
  f.group.id,
  { kind: "agent", id: f.agent.id },
  getChat(f.group.id, f.ctx).governanceRevision,
  human,
);
const taskCreated = mutateTask(
  "create",
  { projectId: f.project.id, title: "admitted Group task" },
  f.ctx,
).detail.task;
const taskAssigned = mutateTask(
  "assign",
  {
    taskId: taskCreated.id,
    expectedRevision: taskCreated.revision,
    targetChatId: f.group.id,
    startNow: true,
  },
  f.ctx,
).detail.task;
const startMessage = db.select().from(message).where(eq(message.taskId, taskAssigned.id)).get()!;
const startInput = db
  .select()
  .from(agentRunInput)
  .where(eq(agentRunInput.messageId, startMessage.id))
  .get()!;
db.update(agentRunInput)
  .set({ admittedAt: new Date() })
  .where(
    and(
      eq(agentRunInput.runId, startInput.runId),
      eq(agentRunInput.messageId, startInput.messageId),
    ),
  )
  .run();
db.update(agentRun)
  .set({ status: "aborted", settledAt: new Date() })
  .where(eq(agentRun.id, startInput.runId))
  .run();
setChatOwner(
  f.group.id,
  { kind: "human", id: f.ctx.userId },
  getChat(f.group.id, f.ctx).governanceRevision,
  human,
);
const pendingInputs = db.select().from(agentRunInput).all();
assert.ok(pendingInputs.length >= 4);
const originalRuns = db.select().from(agentRun).all();
const oldAgentContext = {
  ...f.ctx,
  agent: { agentProfileId: f.agent.id, instanceId: f.instance.id, runId: startInput.runId },
};
remove();
for (const input of pendingInputs) {
  const actual = db
    .select()
    .from(agentRunInput)
    .where(and(eq(agentRunInput.runId, input.runId), eq(agentRunInput.messageId, input.messageId)))
    .get()!;
  assert.equal(actual.disposition, "cancelled");
  assert.equal(actual.cancelReason, "membership_revoked");
  assert.deepEqual(actual.admittedAt, input.admittedAt);
}
assert.deepEqual(db.select().from(agentRun).all(), originalRuns);
assert.ok(getChat(f.dm.chat.id, f.ctx).archivedAt);
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, f.group.id), eq(chatMember.memberId, f.agent.id)))
    .all().length,
  0,
);
pass("revoke.pending.all-chats-and-admitted-cancelled");

const revokedSnapshot = snapshot();
for (const old of oldMessages) {
  if (old.chatId === f.dm.chat.id)
    assert.throws(() => appendHumanRunInput(old, f.ctx), { code: "conflict" });
  else appendHumanRunInput(old, f.ctx);
}
assert.deepEqual(
  snapshot(),
  revokedSnapshot,
  "old message dispatch creates zero run/input/participation writes",
);
assert.throws(() => ensureInstance(f.group.id, f.agent.id, f.ctx), { code: "not_found" });
assert.throws(
  () =>
    sendMessage(
      f.group.id,
      { senderKind: "agent", senderId: f.agent.id, body: "old identity" },
      oldAgentContext,
    ),
  { code: "not_found" },
);
assert.throws(
  () => markRunInputDelivered(startInput.runId, startInput.messageId, oldAgentContext),
  { code: "not_found" },
);
assert.deepEqual(snapshot(), revokedSnapshot);
const beforeNewMessageRuns = db.select().from(agentRun).all();
const beforeNewMessageInputs = db.select().from(agentRunInput).all();
sendMessage(
  f.group.id,
  { senderKind: "human", senderId: f.ctx.userId, body: `@${f.agent.id} removed` },
  f.ctx,
);
sendMessage(
  f.channel.id,
  { senderKind: "human", senderId: f.ctx.userId, body: `@${f.agent.id} removed` },
  f.ctx,
);
assert.deepEqual(db.select().from(agentRun).all(), beforeNewMessageRuns);
assert.deepEqual(db.select().from(agentRunInput).all(), beforeNewMessageInputs);
assert.ok(
  !queuedRunWork().some((work) =>
    originalRuns.some(
      (run: typeof agentRun.$inferSelect) => run.id === work.run.id && run.id !== holder.runId,
    ),
  ),
);
pass("revoke.stale-message-and-old-run-grant.zero-delivery");

const beforeRejectedHandoff = snapshot();
assert.throws(
  () =>
    handoffLease(
      {
        ...handoffKey,
        action: "handoff",
        requestId: newId(ID_PREFIXES.request),
        expectedGeneration: 1,
        targetInstanceId: f.instance.id,
      },
      holder,
    ),
  { code: "not_found" },
);
assert.deepEqual(
  snapshot(),
  beforeRejectedHandoff,
  "invalid handoff target must not persist a mutation",
);
pass("revoke.handoff-new-request.denied-with-zero-writes");

const cancelledInputs = db.select().from(agentRunInput).all();
const historicalRuns = db.select().from(agentRun).all();
addProjectMember(f.project.id, f.agent.id, f.ctx);
const members = (chatId: string) =>
  readChatEffectiveMembers(chatId, f.project.id).some(
    (member) => member.memberKind === "agent" && member.memberId === f.agent.id,
  );
assert.equal(members(f.channel.id), true);
assert.equal(members(f.dm.chat.id), true);
assert.equal(members(f.group.id), false);
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(and(eq(chatMember.chatId, f.group.id), eq(chatMember.memberId, f.agent.id)))
    .all().length,
  0,
);
assert.equal(getChat(f.dm.chat.id, f.ctx).archivedAt, undefined);
assert.throws(() => ensureInstance(f.group.id, f.agent.id, f.ctx), { code: "not_found" });
// An old Group instance cannot become a handoff target merely by rejoining the Project.
const beforeRejoinedHandoff = snapshot();
assert.throws(
  () =>
    handoffLease(
      {
        ...handoffKey,
        action: "handoff",
        requestId: newId(ID_PREFIXES.request),
        expectedGeneration: 1,
        targetInstanceId: f.instance.id,
      },
      holder,
    ),
  { code: "not_found" },
);
assert.deepEqual(snapshot(), beforeRejoinedHandoff);
const released = db
  .select()
  .from(machineLease)
  .where(eq(machineLease.machineId, pending.key.machineId))
  .get()!;
completeLeaseMutation(pending.key, new Date(), false);
assert.deepEqual(
  db.select().from(machineLease).where(eq(machineLease.machineId, pending.key.machineId)).get(),
  released,
);
assert.equal(
  db.select().from(leaseMutation).where(eq(leaseMutation.id, pending.pendingMutationId!)).get()
    ?.state,
  "completed",
);
assert.equal(released.holderInstanceId, null);
for (const old of oldMessages) appendHumanRunInput(old, f.ctx);
assert.deepEqual(db.select().from(agentRunInput).all(), cancelledInputs);
assert.deepEqual(db.select().from(agentRun).all(), historicalRuns);
recoverAgentRuns();
assert.deepEqual(
  db.select().from(agentRunInput).all(),
  cancelledInputs,
  "restart recovery cannot revive cancelled input",
);
const dmBefore = f.dm.chat.id;
const fresh = sendMessage(
  dmBefore,
  { senderKind: "human", senderId: f.ctx.userId, body: "New work after rejoin" },
  f.ctx,
);
assert.equal(fresh.chatId, dmBefore);
assert.equal(
  db.select().from(agentRunInput).where(eq(agentRunInput.messageId, fresh.id)).all().length,
  1,
);
assert.deepEqual(
  db
    .select()
    .from(agentRunInput)
    .all()
    .filter((row: typeof agentRunInput.$inferSelect) => row.messageId !== fresh.id),
  cancelledInputs,
);
pass("rejoin.only-channel-and-existing-dm.new-input-only");

// ─────────────────────────────── 撤销参与权时正在落地的周期检查
// 候选已经 materialize（wake_evaluation_task 有行、评估为 claimed），此时撤销该 Agent 在 Chat
// 的参与权，再放行模型结果：落地闸必须把它判成 stale 并丢弃结果，不能再造 run/input/message。
// 用公共频道而不是 Group：频道的成员由 Project 派生，撤销只改 project_member，不改 chat 行，
// 因此 `p6a_chat_changed` 触发器不会提前把它标 stale，真正被考的是落地闸本身。
const barrierChat = f.channel.id;
const barrierTask = mutateTask(
  "create",
  { projectId: f.project.id, title: "Periodic barrier task" },
  f.ctx,
).detail.task;
mutateTask(
  "assign",
  {
    taskId: barrierTask.id,
    expectedRevision: barrierTask.revision,
    targetChatId: barrierChat,
    startNow: false,
  },
  f.ctx,
);
const barrierNow = new Date();
reconcileChatSchedule(barrierChat, barrierNow);
sqlite
  .prepare("UPDATE chat_schedule SET next_due_at=? WHERE chat_id=?")
  .run(barrierNow.getTime(), barrierChat);
const claimed = claimDueEvaluation({
  now: barrierNow,
  requestId: newId(ID_PREFIXES.request),
  workerId: "p6c-barrier",
});
assert.ok(claimed, "barrier: a due periodic check must be claimed");
assert.equal(claimed!.state, "claimed");
assert.equal(
  (
    sqlite
      .prepare("SELECT count(*) AS n FROM wake_evaluation_task WHERE evaluation_id=?")
      .get(claimed!.id) as { n: number }
  ).n,
  1,
  "barrier: the assigned Task candidate must be materialized before revocation",
);
const barrierInput = buildPeriodicInput(claimed!, barrierNow);
const barrierResult = {
  decision: "continue" as const,
  reason: "周期检查认为负责人需要继续推进。",
  reasonCode: "p6c_barrier",
  recipients: barrierInput.candidates.map((candidate) => ({
    recipient: candidate.recipient,
    decision: "yes" as const,
    reason: "当前责任人",
    probability: null,
  })),
  selectedRecipients: barrierInput.candidates.map((candidate) => candidate.recipient),
  probability: null,
  provider: barrierInput.policy.provider,
  model: barrierInput.policy.model,
  version: barrierInput.policy.thresholdVersion,
  snapshotHash: barrierInput.snapshotHash,
  errorCode: null,
};
// 撤销需要没有活跃 run；之前新消息留下的排队 run 先收尾，屏障只考察这条已 claimed 的评估。
for (const row of db.select().from(agentRun).where(eq(agentRun.projectId, f.project.id)).all())
  if (row.status === "queued" || row.status === "running")
    db.update(agentRun)
      .set({ status: "aborted", settledAt: new Date() })
      .where(eq(agentRun.id, row.id))
      .run();
const beforeRevocationRuns = db.select().from(agentRun).all();
const beforeRevocationInputs = db.select().from(agentRunInput).all();
const beforeRevocationMessages = db.select().from(message).all();
remove();
assert.equal(
  (
    sqlite.prepare("SELECT state FROM wake_evaluation WHERE id=?").get(claimed!.id) as {
      state: string;
    }
  ).state,
  "claimed",
  "barrier: revocation must leave the evaluation claimed so the landing gate fences it",
);
assert.equal(
  commitEvaluationResult(claimed!, barrierInput, barrierResult, barrierNow),
  null,
  "barrier: a result landing after participation revocation must be fenced",
);
const stale = sqlite
  .prepare("SELECT state,result FROM wake_evaluation WHERE id=?")
  .get(claimed!.id) as { state: string; result: string | null };
assert.equal(stale.state, "stale");
assert.equal(stale.result, null);
assert.equal(db.select().from(agentRun).all().length, beforeRevocationRuns.length);
assert.equal(db.select().from(agentRunInput).all().length, beforeRevocationInputs.length);
assert.equal(db.select().from(message).all().length, beforeRevocationMessages.length);
pass("revoke.async-wake.stale-candidate");
console.log(`p6c-participation-revocation: ${assertionCount} assertions passed`);
