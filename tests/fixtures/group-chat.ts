// 真实 SQLite + 真实领域入口：Group 建群、成员与 owner 治理、Agent 越权必拒、d6 兜底、d10 移出、d12 触发器。
// 不 mock 领域层：这里调用的都是 src/domain/chat.ts 的正式命令，只有「run 与消息」这类归 fanout 的
// 前置事实按 fixtures 的习惯直接写表，因为本单元不改 sendMessage 的扇出。
import assert from "node:assert/strict";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { createGroupChatInput } from "../../src/contracts/chat";
import { db, sqlite } from "../../src/db";
import { agentInstance, agentRun, agentRunInput, chat } from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import { createAgentProfile, addProjectMember } from "../../src/domain/agent";
import {
  addGroupMember,
  createDirectChat,
  createGroupChat,
  ensureInstance,
  getChat,
  listChatMembers,
  removeGroupMember,
  sendMessage,
  setChatOwner,
} from "../../src/domain/chat";
import type { ChatActor } from "../../src/domain/chat-actor";
import { createProject } from "../../src/domain/project";
import { eq } from "drizzle-orm";

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
function fieldErrorsOf(raw: unknown): string[] {
  const parsed = createGroupChatInput.safeParse(raw);
  if (parsed.success) return [];
  return Object.keys(parsed.error.flatten().fieldErrors).sort();
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_group_creator";
const strangerId = "usr_group_stranger";
for (const [id, label] of [
  [creatorId, "creator"],
  [strangerId, "stranger"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, label, `${label}@groups.test`);

const ctx = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const strangerCtx = { userId: strangerId, requestId: newId(ID_PREFIXES.request) };
const projectRow = createProject({ name: "群组门禁" }, ctx);

const agentA = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const agentB = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
const outsider = createAgentProfile({ name: "Outsider", persona: "", harness: "pi" }, ctx);
addProjectMember(projectRow.id, agentA.id, ctx);
addProjectMember(projectRow.id, agentB.id, ctx);

const human: ChatActor = { kind: "human", userId: creatorId, ctx };
const agentActor = (agentProfileId: string): ChatActor => ({
  kind: "agent",
  agentProfileId,
  instanceId: "ins_gate",
  runId: "run_gate",
  ctx,
});

// ---------------------------------------------------------------- 1. 契约收紧
const validInput = {
  projectId: projectRow.id,
  title: "协作群",
  members: [
    { kind: "human" as const, id: creatorId },
    { kind: "agent" as const, id: agentA.id },
  ],
  initialOwner: { kind: "agent" as const, id: agentA.id },
};
assert.deepEqual(fieldErrorsOf(validInput), []);
assert.deepEqual(
  fieldErrorsOf({
    ...validInput,
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentA.id },
    ],
  }),
  ["members"],
  "重复成员必须被契约拒绝",
);
assert.deepEqual(
  fieldErrorsOf({
    ...validInput,
    members: [
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentB.id },
    ],
  }),
  ["members"],
  "没有人类成员的群必须被契约拒绝",
);
assert.deepEqual(
  fieldErrorsOf({ ...validInput, members: [{ kind: "human", id: creatorId }] }),
  ["initialOwner"],
  "Agent 所有者必须是成员之一",
);
assert.deepEqual(
  fieldErrorsOf({
    ...validInput,
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: "not-an-agent-id" },
    ],
    initialOwner: { kind: "human", id: creatorId },
  }),
  ["members"],
  "成员条目的 Agent id 必须符合既有 agp_ 模式",
);
// 冻结前的过宽形状（裸字符串数组）已经不再是合法入参。
assert.equal(
  createGroupChatInput.safeParse({
    projectId: projectRow.id,
    members: [agentA.id, agentB.id],
    initialOwner: { kind: "agent", id: agentA.id },
  }).success,
  false,
);
pass("contract.members-tightened", {
  duplicate: "members",
  noHuman: "members",
  ownerNotMember: "initialOwner",
  badAgentId: "members",
  legacyShape: "rejected",
});

// 契约解析出的入参带默认唤醒策略，领域命令只吃这个形状。
const groupInput = createGroupChatInput.parse(validInput);

// ---------------------------------------------------------------- 2. Agent 建群被拒
assert.equal(
  codeOf(() => createGroupChat(projectRow.id, groupInput, agentActor(agentA.id))),
  "forbidden",
);
assert.equal(
  db.select().from(chat).where(eq(chat.projectId, projectRow.id)).all().length,
  0,
  "被拒的建群不能留下任何 chat 行",
);
pass("governance.agent-create-forbidden", { code: "forbidden", chatRows: 0 });

// ---------------------------------------------------------------- 3. Human 建群并指定 Agent owner
const group = createGroupChat(projectRow.id, groupInput, human);
assert.equal(group.kind, "group");
assert.deepEqual(group.owner, { kind: "agent", id: agentA.id });
assert.equal(group.governanceRevision, 0);
assert.equal(group.title, "协作群");
assert.equal(group.createdBy, creatorId);
const groupMembers = listChatMembers(group.id, ctx);
assert.deepEqual(
  groupMembers.map((member) => `${member.memberKind}:${member.memberId}`).sort(),
  [`agent:${agentA.id}`, `human:${creatorId}`].sort(),
);
pass("group.created", {
  chatId: group.id,
  kind: group.kind,
  owner: group.owner,
  revision: group.governanceRevision,
  members: groupMembers.length,
});

// ---------------------------------------------------------------- 4. Agent 加成员被拒（治理只有 Human 能做）
const beforeAgentAttempt = getChat(group.id, ctx);
assert.equal(
  codeOf(() =>
    addGroupMember(
      group.id,
      { kind: "agent", id: agentB.id },
      beforeAgentAttempt.governanceRevision,
      agentActor(agentA.id),
    ),
  ),
  "forbidden",
);
assert.equal(getChat(group.id, ctx).governanceRevision, beforeAgentAttempt.governanceRevision);
assert.equal(
  listChatMembers(group.id, ctx).some((member) => member.memberId === agentB.id),
  false,
  "被拒的加成员不能写成员行",
);
// 换 owner 与移出成员同样是治理动作：Agent 一律被拒。
assert.equal(
  codeOf(() => setChatOwner(group.id, { kind: "agent", id: agentB.id }, 0, agentActor(agentA.id))),
  "forbidden",
);
assert.equal(
  codeOf(() =>
    removeGroupMember(group.id, { kind: "human", id: creatorId }, 0, agentActor(agentA.id)),
  ),
  "forbidden",
);
pass("governance.agent-denied", {
  add: "forbidden",
  owner: "forbidden",
  remove: "forbidden",
  revision: getChat(group.id, ctx).governanceRevision,
});

// ---------------------------------------------------------------- 5. d6：Agent owner 时 Project 创建者兜底
const added = addGroupMember(
  group.id,
  { kind: "agent", id: agentB.id },
  getChat(group.id, ctx).governanceRevision,
  human,
);
assert.equal(added.governanceRevision, 1, "加成员推进治理版本");
assert.equal(
  listChatMembers(group.id, ctx).some((member) => member.memberId === agentB.id),
  true,
);
// Project 隔离先于能力判定：另一个 Human 读不到这个 Project，因此是 not_found 而不是 forbidden。
assert.equal(
  codeOf(() =>
    addGroupMember(group.id, { kind: "agent", id: outsider.id }, added.governanceRevision, {
      kind: "human",
      userId: strangerId,
      ctx: strangerCtx,
    }),
  ),
  "not_found",
);
pass("d6.project-creator-fallback", {
  revision: added.governanceRevision,
  member: agentB.id,
  stranger: "not_found",
});

// ---------------------------------------------------------------- 6. 重复加同一成员幂等
const repeated = addGroupMember(
  group.id,
  { kind: "agent", id: agentB.id },
  added.governanceRevision,
  human,
);
assert.equal(repeated.governanceRevision, added.governanceRevision, "幂等重复不推进版本");
assert.equal(
  listChatMembers(group.id, ctx).filter((member) => member.memberId === agentB.id).length,
  1,
);
pass("member.add-idempotent", { revision: repeated.governanceRevision, rows: 1 });

// ---------------------------------------------------------------- 7. 过期 governance_revision 被拒
const beforeStale = getChat(group.id, ctx);
assert.equal(
  codeOf(() =>
    setChatOwner(
      group.id,
      { kind: "human", id: creatorId },
      beforeStale.governanceRevision - 1,
      human,
    ),
  ),
  "conflict",
);
const afterStale = getChat(group.id, ctx);
assert.deepEqual(afterStale.owner, beforeStale.owner);
assert.equal(afterStale.governanceRevision, beforeStale.governanceRevision, "被拒的写入不能改版本");
// 加成员同样带版本：过期即 conflict，不悄悄放行（这里用已是成员的 Beta 走幂等分支：
// 版本过期时优先报并发冲突，而不是报「已经是成员」的成功）。
assert.equal(
  codeOf(() => addGroupMember(group.id, { kind: "agent", id: agentB.id }, 0, human)),
  "conflict",
);
pass("governance.stale-revision", {
  ownerAfter: afterStale.owner,
  revision: afterStale.governanceRevision,
});

// ---------------------------------------------------------------- 8. 换 owner
const owned = setChatOwner(
  group.id,
  { kind: "agent", id: agentB.id },
  getChat(group.id, ctx).governanceRevision,
  human,
);
assert.deepEqual(owned.owner, { kind: "agent", id: agentB.id });
assert.equal(owned.governanceRevision, afterStale.governanceRevision + 1);
// 当前所有者不能被直接移出。
assert.equal(
  codeOf(() =>
    removeGroupMember(group.id, { kind: "agent", id: agentB.id }, owned.governanceRevision, human),
  ),
  "conflict",
);
// 换回 Human owner：Human owner 必须是 project.created_by。
assert.equal(
  codeOf(() =>
    setChatOwner(group.id, { kind: "human", id: strangerId }, owned.governanceRevision, human),
  ),
  "forbidden",
);
const backToHuman = setChatOwner(
  group.id,
  { kind: "human", id: creatorId },
  owned.governanceRevision,
  human,
);
assert.deepEqual(backToHuman.owner, { kind: "human", id: creatorId });
pass("owner.change", {
  agentOwnerRevision: owned.governanceRevision,
  humanOwnerRevision: backToHuman.governanceRevision,
  removeOwner: "conflict",
  foreignHumanOwner: "forbidden",
});

// ---------------------------------------------------------------- 9. ensureInstance 单一入口
const instanceA = ensureInstance(group.id, agentA.id, ctx);
assert.equal(instanceA.chatId, group.id);
assert.equal(instanceA.projectId, projectRow.id);
assert.equal(instanceA.agentProfileId, agentA.id);
assert.equal(ensureInstance(group.id, agentA.id, ctx).id, instanceA.id, "重复取同一 instance");
assert.equal(
  codeOf(() => ensureInstance(group.id, outsider.id, ctx)),
  "not_found",
  "非成员的 Agent 拿不到 instance",
);
pass("instance.ensure", { instanceId: instanceA.id, outsider: "not_found" });

// ---------------------------------------------------------------- 10. d10：活跃 run 时移除被拒
const humanMessage = sendMessage(
  group.id,
  { senderKind: "human", senderId: creatorId, body: "开始协作" },
  ctx,
);
const runId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runId,
    instanceId: instanceA.id,
    chatId: group.id,
    projectId: projectRow.id,
    requestId: ctx.requestId,
    status: "queued",
    sessionId: instanceA.id,
  })
  .run();
db.insert(agentRunInput)
  .values({ runId, messageId: humanMessage.id, disposition: "pending" })
  .run();
const beforeRemove = getChat(group.id, ctx);
assert.equal(
  codeOf(() =>
    removeGroupMember(
      group.id,
      { kind: "agent", id: agentA.id },
      beforeRemove.governanceRevision,
      human,
    ),
  ),
  "conflict",
  "有活跃 run 时移除被拒",
);
assert.equal(
  listChatMembers(group.id, ctx).some((member) => member.memberId === agentA.id),
  true,
  "被拒的移除不能删成员行",
);
// 拒绝优先：被拒的那一次不许产生取消副作用。
assert.equal(
  db.select().from(agentRunInput).where(eq(agentRunInput.runId, runId)).get()?.disposition,
  "pending",
);
assert.equal(db.select().from(agentRun).where(eq(agentRun.id, runId)).get()?.status, "queued");
pass("d10.active-run-blocks-removal", {
  code: "conflict",
  disposition: "pending",
  runStatus: "queued",
});

// 无活跃 run 时同一个移除成功，未下发的 pending 输入按 membership_revoked 取消。
db.update(agentRun)
  .set({ status: "aborted", settledAt: new Date() })
  .where(eq(agentRun.id, runId))
  .run();
const removed = removeGroupMember(
  group.id,
  { kind: "agent", id: agentA.id },
  beforeRemove.governanceRevision,
  human,
);
const cancelledInput = db.select().from(agentRunInput).where(eq(agentRunInput.runId, runId)).get();
assert.equal(cancelledInput?.disposition, "cancelled");
assert.equal(cancelledInput?.cancelReason, "membership_revoked");
assert.ok(cancelledInput?.cancelledAt instanceof Date, "取消事实必须带时间");
assert.equal(cancelledInput?.deliveredAt, null);
assert.equal(
  listChatMembers(group.id, ctx).some((member) => member.memberId === agentA.id),
  false,
);
assert.equal(removed.governanceRevision, beforeRemove.governanceRevision + 1);
// 移出后 instance 行保留（历史消息与 run 还要引用它），但参与权由视图收回。
assert.equal(
  db.select().from(agentInstance).where(eq(agentInstance.id, instanceA.id)).all().length,
  1,
);
assert.equal(
  codeOf(() => ensureInstance(group.id, agentA.id, ctx)),
  "not_found",
  "移出后不能再拿到 instance",
);
pass("d10.pending-input-cancelled", {
  disposition: cancelledInput?.disposition,
  reason: cancelledInput?.cancelReason,
  revision: removed.governanceRevision,
  instanceRetained: true,
  participation: "not_found",
});

// ---------------------------------------------------------------- 11. d12：Public Channel 只能被 insert 触发器和领域层拒绝
const channelId = newId(ID_PREFIXES.chat);
db.insert(chat)
  .values({
    id: channelId,
    projectId: projectRow.id,
    kind: "public_channel",
    ownerKind: "human",
    ownerId: creatorId,
    createdBy: creatorId,
  })
  .run();
assert.throws(
  () =>
    sqlite
      .prepare("INSERT INTO chat_member (chat_id, member_kind, member_id) VALUES (?, 'agent', ?)")
      .run(channelId, agentA.id),
  /public_channel_members_derived/,
);
assert.equal(
  codeOf(() =>
    addGroupMember(
      channelId,
      { kind: "agent", id: agentA.id },
      getChat(channelId, ctx).governanceRevision,
      human,
    ),
  ),
  "channel_membership_managed",
);
assert.equal(
  codeOf(() =>
    removeGroupMember(
      channelId,
      { kind: "agent", id: agentA.id },
      getChat(channelId, ctx).governanceRevision,
      human,
    ),
  ),
  "channel_membership_managed",
);
// DM 没有可调整的成员集，走 forbidden；搭一个真实 DM 证明边界不是只对 group 生效。
const dm = createDirectChat(projectRow.id, agentB.id, ctx);
assert.equal(
  codeOf(() =>
    addGroupMember(
      dm.chat.id,
      { kind: "agent", id: agentA.id },
      getChat(dm.chat.id, ctx).governanceRevision,
      human,
    ),
  ),
  "forbidden",
);
const chatMemberTriggers = (
  sqlite
    .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'chat_member'")
    .all() as { name: string }[]
)
  .map((row) => row.name)
  .sort();
assert.deepEqual(
  chatMemberTriggers,
  ["chat_member_identity_immutable", "chat_member_no_channel_insert"],
  "d12：chat_member 只保留 insert 触发器与身份不可变触发器",
);
pass("d12.channel-insert-trigger-only", {
  insertTrigger: "public_channel_members_derived",
  add: "channel_membership_managed",
  remove: "channel_membership_managed",
  dm: "forbidden",
  triggers: chatMemberTriggers,
});

// 成员行的跨 Project 读取仍然 not_found：群组没有把 Project 隔离打开。
assert.equal(
  codeOf(() => listChatMembers(group.id, strangerCtx)),
  "not_found",
);
pass("isolation.group", { strangerRead: "not_found" });

console.log(`PASS i2-group-chat ${checks.length} checks`);
