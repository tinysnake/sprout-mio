// 真实 SQLite + 真实领域入口：Public Channel 的取得/创建、成员随 Project 同步、
// 直接增删被拒、跨 Project 隔离，以及频道发言权限与 DM 一致。
// 本单元不改 sendMessage 的扇出（归 p5a-fanout），所以 run 行按既有 fixtures 的习惯直接写表。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PUBLIC_CHANNEL_DISPLAY_TITLE } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { agentInstance, agentRun } from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import {
  addProjectMember,
  createAgentProfile,
  listProjectMembers,
  removeProjectMember,
} from "../../src/domain/agent";
import { listAgentRuns } from "../../src/domain/agent-run";
import {
  addGroupMember,
  createDirectChat,
  ensureInstance,
  getChat,
  listChatMembers,
  listChats,
  listMessages,
  removeGroupMember,
  sendMessage,
} from "../../src/domain/chat";
import {
  CHANNEL_MEMBERSHIP_MANAGED_MESSAGE,
  ensureProjectChannel,
  readChatEffectiveMembers,
} from "../../src/domain/channel";
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
function membersOf(chatId: string) {
  return listChatMembers(chatId, ctxA).map((member) => `${member.memberKind}:${member.memberId}`);
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorA = "usr_channel_creator_a";
const creatorB = "usr_channel_creator_b";
for (const [id, label] of [
  [creatorA, "a"],
  [creatorB, "b"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, label, `${label}@channel.test`);

const ctxA = { userId: creatorA, requestId: newId(ID_PREFIXES.request) };
const ctxB = { userId: creatorB, requestId: newId(ID_PREFIXES.request) };
const humanA: ChatActor = { kind: "human", userId: creatorA, ctx: ctxA };

const projectA = createProject({ name: "频道门禁 A" }, ctxA);
const agentA = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctxA);
const agentB = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctxA);
const outsider = createAgentProfile({ name: "Outsider", persona: "", harness: "pi" }, ctxA);

// ---------------------------------------------------------------- 1. Project 出生即带唯一频道
const channelId = ensureProjectChannel(projectA.id);
const projectChats = listChats(projectA.id, ctxA);
assert.equal(
  projectChats.filter((row) => row.kind === "public_channel").length,
  1,
  "新建 Project 后必须恰有一个公共频道",
);
assert.equal(ensureProjectChannel(projectA.id), channelId, "重复取得必须返回同一个频道");
assert.equal(
  (
    sqlite
      .prepare("SELECT count(*) AS n FROM chat WHERE project_id = ? AND kind = 'public_channel'")
      .get(projectA.id) as { n: number }
  ).n,
  1,
  "重复调用不能产生第二个频道",
);
assert.throws(
  () =>
    sqlite
      .prepare(
        "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?,?,'public_channel','human',?,?)",
      )
      .run(newId(ID_PREFIXES.chat), projectA.id, creatorA, creatorA),
  /UNIQUE constraint failed|chat_public_channel_project_unique/,
  "chat_public_channel_project_unique 必须挡住第二个频道",
);
const channel = getChat(channelId, ctxA);
assert.deepEqual(
  {
    kind: channel.kind,
    title: channel.title,
    owner: channel.owner,
    createdBy: channel.createdBy,
    wakePolicy: channel.wakePolicy,
    governanceRevision: channel.governanceRevision,
    archivedAt: channel.archivedAt,
  },
  {
    kind: "public_channel",
    title: undefined,
    owner: { kind: "human", id: creatorA },
    createdBy: creatorA,
    wakePolicy: "owner_led",
    governanceRevision: 0,
    archivedAt: undefined,
  },
  "频道 DTO：d8 的 title/created_by/owner/wake_policy 逐条成立",
);
assert.equal(PUBLIC_CHANNEL_DISPLAY_TITLE, "公共频道（Project 范围）");
assert.equal(
  (
    sqlite.prepare("SELECT count(*) AS n FROM chat_member WHERE chat_id = ?").get(channelId) as {
      n: number;
    }
  ).n,
  0,
  "频道成员不落 chat_member 行",
);
pass("channel.created-unique", {
  channelId,
  kind: channel.kind,
  owner: channel.owner,
  displayTitle: PUBLIC_CHANNEL_DISPLAY_TITLE,
  chatMemberRows: 0,
});

// ---------------------------------------------------------------- 2. Project 加成员 → 频道成员同读可见
addProjectMember(projectA.id, agentA.id, ctxA);
addProjectMember(projectA.id, agentB.id, ctxA);
assert.deepEqual(
  membersOf(channelId).sort(),
  [`agent:${agentA.id}`, `agent:${agentB.id}`, `human:${creatorA}`].sort(),
  "频道成员等于 Project Agent 成员加 Project 创建者",
);
assert.deepEqual(
  readChatEffectiveMembers(channelId, projectA.id)
    .map((member) => `${member.memberKind}:${member.memberId}`)
    .sort(),
  listProjectMembers(projectA.id, ctxA)
    .map((member) => `agent:${member.agentProfileId}`)
    .concat(`human:${creatorA}`)
    .sort(),
  "两次读视图的结果一致",
);
const agentSources = sqlite
  .prepare(
    "SELECT member_id AS id, source FROM chat_effective_member WHERE chat_id = ? AND member_kind = 'agent' ORDER BY member_id",
  )
  .all(channelId) as { id: string; source: string }[];
assert.deepEqual(
  agentSources,
  [
    { id: agentA.id, source: "project_member" },
    { id: agentB.id, source: "project_member" },
  ],
  "频道 Agent 成员来源必须是 project_member",
);
assert.equal(
  (
    sqlite.prepare("SELECT count(*) AS n FROM chat_member WHERE chat_id = ?").get(channelId) as {
      n: number;
    }
  ).n,
  0,
  "加 Project 成员不向频道写成员行",
);
pass("channel.members-follow-project", {
  members: membersOf(channelId).length,
  sources: agentSources.map((row) => row.source),
  chatMemberRows: 0,
});

// ---------------------------------------------------------------- 3. Project 级移除 → 频道成员同步消失，历史仍可读
const instanceA = ensureInstance(channelId, agentA.id, ctxA);
const agentMessage = sendMessage(
  channelId,
  { senderKind: "agent", senderId: agentA.id, body: "频道里的历史汇报" },
  ctxA,
);
const runId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runId,
    instanceId: instanceA.id,
    chatId: channelId,
    projectId: projectA.id,
    requestId: ctxA.requestId,
    status: "aborted",
    settledAt: new Date(),
    sessionId: instanceA.id,
  })
  .run();
removeProjectMember(projectA.id, agentA.id, ctxA);
assert.deepEqual(
  membersOf(channelId).sort(),
  [`agent:${agentB.id}`, `human:${creatorA}`].sort(),
  "项目级移除后频道成员同步消失",
);
assert.deepEqual(
  listMessages(channelId, ctxA).map((message) => message.body),
  [agentMessage.body],
  "历史消息仍然可读",
);
assert.equal(
  db.select().from(agentInstance).where(eq(agentInstance.id, instanceA.id)).all().length,
  1,
  "历史 instance 行物理保留",
);
assert.deepEqual(
  listAgentRuns(channelId, ctxA).map((run) => run.id),
  [runId],
  "历史 run 仍然可读",
);
assert.equal(
  codeOf(() => ensureInstance(channelId, agentA.id, ctxA)),
  "not_found",
);
assert.equal(
  codeOf(() =>
    sendMessage(
      channelId,
      { senderKind: "agent", senderId: agentA.id, body: "移出后还想发言" },
      ctxA,
    ),
  ),
  "not_found",
  "参与权收回后不能再往频道发言",
);
pass("channel.member-removed-history-kept", {
  members: membersOf(channelId).length,
  messages: listMessages(channelId, ctxA).length,
  runRetained: true,
  participation: "not_found",
});

// ---------------------------------------------------------------- 4. 直接增删频道成员被拒
const beforeGovernance = getChat(channelId, ctxA);
assert.equal(
  codeOf(() =>
    addGroupMember(
      channelId,
      { kind: "agent", id: outsider.id },
      beforeGovernance.governanceRevision,
      humanA,
    ),
  ),
  "channel_membership_managed",
);
assert.equal(
  codeOf(() =>
    removeGroupMember(
      channelId,
      { kind: "agent", id: agentB.id },
      beforeGovernance.governanceRevision,
      humanA,
    ),
  ),
  "channel_membership_managed",
);
assert.throws(
  () =>
    sqlite
      .prepare("INSERT INTO chat_member (chat_id, member_kind, member_id) VALUES (?, 'agent', ?)")
      .run(channelId, outsider.id),
  /public_channel_members_derived/,
);
const rejection = (() => {
  try {
    addGroupMember(
      channelId,
      { kind: "agent", id: outsider.id },
      beforeGovernance.governanceRevision,
      humanA,
    );
  } catch (error) {
    return error as Error;
  }
  throw new Error("addGroupMember on a channel must fail");
})();
assert.equal(rejection.message, CHANNEL_MEMBERSHIP_MANAGED_MESSAGE);
assert.match(rejection.message, /Project/, "错误文案必须指向 Project 成员同步");
assert.equal(
  getChat(channelId, ctxA).governanceRevision,
  beforeGovernance.governanceRevision,
  "被拒的治理写入不推进版本",
);
assert.deepEqual(
  membersOf(channelId).sort(),
  [`agent:${agentB.id}`, `human:${creatorA}`].sort(),
  "被拒的增删不改成员集",
);
pass("channel.membership-managed", {
  add: "channel_membership_managed",
  remove: "channel_membership_managed",
  message: rejection.message,
  trigger: "public_channel_members_derived",
  revision: beforeGovernance.governanceRevision,
});

// ---------------------------------------------------------------- 5. 两个 Project 的频道互不可见
const projectB = createProject({ name: "频道门禁 B" }, ctxB);
const channelB = ensureProjectChannel(projectB.id);
assert.notEqual(channelB, channelId);
assert.deepEqual(
  listChatMembers(channelB, ctxB).map((member) => `${member.memberKind}:${member.memberId}`),
  [`human:${creatorB}`],
  "B 的频道只看得到 B 的 Project 成员（人类创建者，暂无 Agent）",
);
assert.equal(
  listChatMembers(channelId, ctxA).some((member) => member.memberId === creatorB),
  false,
  "A 的频道看不到 B 的创建者",
);
assert.equal(
  listChatMembers(channelB, ctxB).some((member) => member.memberId === agentB.id),
  false,
  "B 的频道看不到 A 的 Project Agent",
);
assert.equal(
  codeOf(() => getChat(channelB, ctxA)),
  "not_found",
);
assert.equal(
  codeOf(() => listChatMembers(channelB, ctxA)),
  "not_found",
);
assert.equal(
  codeOf(() => listChats(projectB.id, ctxA)),
  "not_found",
);
assert.deepEqual(
  listChats(projectB.id, ctxB).map((row) => row.id),
  [channelB],
  "B 的会话列表只有自己的频道",
);
pass("channel.cross-project-isolation", {
  channelA: channelId,
  channelB,
  crossRead: "not_found",
});

// ---------------------------------------------------------------- 6. 频道发言权限与 DM 一致
const dm = createDirectChat(projectA.id, agentB.id, ctxA);
assert.equal(
  codeOf(() =>
    sendMessage(dm.chat.id, { senderKind: "agent", senderId: agentB.id, body: "DM 发言" }, ctxA),
  ),
  "ok",
);
// 两条路径都要求先拿到 instance（DM 在创建时就有了，频道靠首次参与建立），
// 参与权判定一致由 `chat_effective_member` 提供。
ensureInstance(channelId, agentB.id, ctxA);
assert.equal(
  codeOf(() =>
    sendMessage(channelId, { senderKind: "agent", senderId: agentB.id, body: "频道发言" }, ctxA),
  ),
  "ok",
  "当前成员在频道里可以发言",
);
const outsiderInDm = codeOf(() =>
  sendMessage(dm.chat.id, { senderKind: "agent", senderId: outsider.id, body: "非成员" }, ctxA),
);
const outsiderInChannel = codeOf(() =>
  sendMessage(channelId, { senderKind: "agent", senderId: outsider.id, body: "非成员" }, ctxA),
);
assert.equal(outsiderInDm, "not_found");
assert.equal(outsiderInChannel, outsiderInDm, "同一个非成员在 DM 与频道得到同一个判定");
assert.equal(
  codeOf(() =>
    sendMessage(channelId, { senderKind: "human", senderId: creatorA, body: "人类发言" }, ctxA),
  ),
  "ok",
);
assert.deepEqual(
  listMessages(channelId, ctxA).map((message) => `${message.senderKind}:${message.body}`),
  ["agent:频道里的历史汇报", "agent:频道发言", "human:人类发言"],
);
pass("channel.send-parity-with-dm", {
  memberDm: "ok",
  memberChannel: "ok",
  nonMemberDm: outsiderInDm,
  nonMemberChannel: outsiderInChannel,
});

console.log(`PASS i3-public-channel ${checks.length} checks`);
