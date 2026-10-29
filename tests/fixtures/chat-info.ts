// 真实 SQLite + 真实领域入口：多 Agent 会话读模型（群 / 频道 / DM）与 Info Hub 会话聚合。
//
// 不 mock 领域层：建项目、建群、建 DM、扇出唤醒都走 src/domain 的正式入口；只有「已结束的 run」
// 这类 fanout 之外的前置事实按 fixtures 的既有习惯直接写表（同 group-chat.ts / public-channel.ts）。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { PUBLIC_CHANNEL_DISPLAY_TITLE } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { agentRun } from "../../src/db/schema";
import { addProjectMember, createAgentProfile, listProjectMembers } from "../../src/domain/agent";
import {
  createDirectChat,
  createGroupChat,
  getChat,
  listChatMembers,
  listInstancesForChat,
  sendMessage,
} from "../../src/domain/chat";
import type { ChatActor } from "../../src/domain/chat-actor";
import { getChatSession } from "../../src/domain/chat-session";
import { ensureProjectChannel } from "../../src/domain/channel";
import { getChatInfo, getProjectInfoHub } from "../../src/domain/info-hub";
import { createProject } from "../../src/domain/project";

migrateDatabase();

const checks: string[] = [];
function pass(label: string, output: unknown = {}) {
  checks.push(label);
  console.log(`PASS ${label} ${JSON.stringify(output)}`);
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_chat_info_creator";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(creatorId, "chat-info", "creator@chat-info.test");

const ctx = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const human: ChatActor = { kind: "human", userId: creatorId, ctx };
const project = createProject({ name: "会话读模型门禁" }, ctx);
const agentA = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const agentB = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
const agentC = createAgentProfile({ name: "Gamma", persona: "", harness: "pi" }, ctx);
for (const agent of [agentA, agentB, agentC]) addProjectMember(project.id, agent.id, ctx);

const group = createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "三人协作群",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentB.id },
      { kind: "agent", id: agentC.id },
    ],
    initialOwner: { kind: "human", id: creatorId },
    wakePolicy: "owner_led",
  },
  human,
);

// ---------------------------------------------------------------- 1. 群里 3 个 Agent 各一条 run
// 一条人类消息点名三名 Agent：真实扇出给每个候选各开一条 queued run（同一 instance 至多一条活跃 run）。
sendMessage(
  group.id,
  { senderKind: "human", senderId: creatorId, body: "@Alpha @Beta @Gamma 各写一段" },
  ctx,
);
const groupRuns = db.select().from(agentRun).where(eq(agentRun.chatId, group.id)).all() as {
  id: string;
  instanceId: string;
}[];
assert.equal(groupRuns.length, 3, "一条点名消息必须在群里开出三条 run");

const groupSession = getChatSession(group.id, ctx);
assert.equal(groupSession.kind, "group");
assert.equal(
  groupSession.instances.length,
  3,
  "群里有 3 个 Agent 各一条 run 时，会话读模型必须返回 3 个 instance",
);
assert.deepEqual(
  groupSession.instances.map((entry) => entry.agentProfileId).sort(),
  [agentA.id, agentB.id, agentC.id].sort(),
  "3 个 instance 必须分属 3 个 Agent",
);
for (const entry of groupSession.instances) {
  const own = groupRuns.filter((run) => run.instanceId === entry.instanceId);
  assert.equal(own.length, 1, "每个 instance 恰有一条自己的 run");
  assert.equal(
    entry.activeRun?.runId,
    own[0].id,
    "每个 instance 的活跃 run 必须指向它自己的那条 run，不能串到同会话的别的 Agent",
  );
  assert.equal(entry.activeRun?.status, "queued");
  assert.equal(entry.activeRun?.pendingInputs, 1);
}
pass("group.session-three-instances", {
  instances: groupSession.instances.length,
  runs: groupRuns.length,
});

// ---------------------------------------------------------------- 2. 频道视角
// 成员来自 chat_effective_member（= Project 成员 + Project 创建者），未唤醒任何 Agent 时没有分身，
// 标题取契约里的固定文案（d8：频道没有 title 列）。
const channelId = ensureProjectChannel(project.id);
const channelSession = getChatSession(channelId, ctx);
assert.equal(channelSession.kind, "public_channel");
assert.equal(
  channelSession.displayTitle,
  PUBLIC_CHANNEL_DISPLAY_TITLE,
  "频道标题必须来自 PUBLIC_CHANNEL_DISPLAY_TITLE",
);
assert.deepEqual(channelSession.instances, [], "频道没有被唤醒过时必须返回空分身集合");
const memberKeys = channelSession.members
  .map((member) => `${member.memberKind}:${member.memberId}`)
  .sort();
const projectMemberKeys = [
  ...listProjectMembers(project.id, ctx).map((member) => `agent:${member.agentProfileId}`),
  `human:${creatorId}`,
].sort();
assert.deepEqual(memberKeys, projectMemberKeys, "频道成员必须与 Project 成员逐条相等");
assert.deepEqual(
  listChatMembers(channelId, ctx)
    .map((member) => `${member.memberKind}:${member.memberId}`)
    .sort(),
  projectMemberKeys,
  "频道成员读的是 chat_effective_member，不是 chat_member 行",
);
pass("channel.session-derivation", {
  members: memberKeys.length,
  instances: channelSession.instances.length,
  displayTitle: channelSession.displayTitle,
});

// ---------------------------------------------------------------- 3. DM 读模型逐字段与改造前一致
// 改造前的 DM 会话形状是 `ChatDetail = { chat, instance }`（P2 起冻结）。新读模型只多一个联合判别
// 字段 `kind`；`chat` 与 `instance` 逐字段等于改造前的取值，P3 的 getChatInfo 视图一行未动。
const dm = createDirectChat(project.id, agentA.id, ctx);
const dmSession = getChatSession(dm.chat.id, ctx);
assert.equal(dmSession.kind, "dm");
assert.deepEqual(
  Object.keys(dmSession).sort(),
  ["chat", "instance", "kind"],
  "DM 会话读模型只多出联合判别字段 kind",
);
assert.deepEqual(
  { chat: dmSession.chat, instance: dmSession.instance },
  dm,
  "DM 的 chat 与 instance 必须与改造前的 ChatDetail 逐字段一致",
);
assert.deepEqual(dmSession.instance, listInstancesForChat(dm.chat.id, ctx)[0]);
assert.equal(getChat(dm.chat.id, ctx).kind, "dm");

// P3 的 Info Hub 会话视图（getChatInfo）是另一条冻结路径：字段集合与实例条目一个都不许变。
const dmInfo = getChatInfo(dm.chat.id, ctx);
assert.deepEqual(
  Object.keys(dmInfo).sort(),
  ["archived", "chatId", "instances", "kind", "members", "messages", "owner", "projectId", "runs"],
  "getChatInfo 的 DM 字段集合必须与改造前一致",
);
assert.deepEqual(Object.keys(dmInfo.instances[0]).sort(), [
  "agentProfileId",
  "instanceId",
  "profileName",
]);
assert.deepEqual(Object.keys(dmInfo.runs).sort(), ["active", "available", "hostEnabled", "recent"]);
pass("dm.session-frozen-shape", {
  sessionKeys: Object.keys(dmSession).sort(),
  infoKeys: Object.keys(dmInfo).sort(),
});

// ---------------------------------------------------------------- 4. Info Hub 会话聚合
// 同一 Agent 的多条 run 只计 1 个 Agent：给 Alpha 的 DM 补一条已结束 run（fixtures 惯例直写表），
// 于是这个会话里有 2 条 run、1 个 Agent。
sendMessage(dm.chat.id, { senderKind: "human", senderId: creatorId, body: "DM 第一条" }, ctx);
const settledAt = new Date();
db.insert(agentRun)
  .values({
    id: newId(ID_PREFIXES.run),
    instanceId: dm.instance.id,
    chatId: dm.chat.id,
    projectId: project.id,
    requestId: newId(ID_PREFIXES.request),
    status: "failed",
    queuedAt: new Date(settledAt.getTime() - 1000),
    startedAt: new Date(settledAt.getTime() - 500),
    settledAt,
    errorCode: "gate_fixture_failure",
    errorMessage: "门禁夹具里的一条已结束 run",
    sessionId: dm.instance.id,
  })
  .run();

const hub = getProjectInfoHub(project.id, {
  ...ctx,
  bootId: "boot_chat_info",
  now: new Date(),
});
const aggregateOf = (chatId: string) => hub.chats.find((entry) => entry.chatId === chatId);

const dmAggregate = aggregateOf(dm.chat.id);
assert.ok(dmAggregate, "Info Hub 会话聚合必须包含 DM 会话");
assert.equal(dmAggregate.agentCount, 1, "同一 Agent 的多条 run 在会话聚合里只计 1 个 Agent");
assert.deepEqual(dmAggregate.statusCounts, [
  { status: "queued", count: 1 },
  { status: "failed", count: 1 },
]);

const groupAggregate = aggregateOf(group.id);
assert.ok(groupAggregate, "Info Hub 会话聚合必须包含群组会话");
assert.equal(groupAggregate.agentCount, 3, "群里三条 run 分属三个 Agent");
assert.equal(groupAggregate.displayTitle, "三人协作群");
assert.deepEqual(groupAggregate.statusCounts, [{ status: "queued", count: 3 }]);

const channelAggregate = aggregateOf(channelId);
assert.ok(channelAggregate, "Info Hub 会话聚合必须包含频道会话，且不把它当成 DM");
assert.equal(channelAggregate.kind, "public_channel");
assert.equal(channelAggregate.displayTitle, PUBLIC_CHANNEL_DISPLAY_TITLE);
assert.equal(channelAggregate.agentCount, 0, "频道还没有 run 时参与的 Agent 数为 0");
assert.deepEqual(channelAggregate.statusCounts, []);
assert.deepEqual(channelAggregate.activeRunIds, []);

// 频道不是 DM：Project → Agents 的 DM 关联必须仍指向真正的 DM，而不是同 Project 的频道/群。
const agentEntry = hub.agents.agents.find((entry) => entry.agentProfileId === agentA.id);
assert.equal(agentEntry?.chatId, dm.chat.id, "Project → Agents 的 chatId 必须是 DM");
assert.equal(agentEntry?.instanceId, dm.instance.id);
pass("info-hub.chat-aggregation", {
  dm: dmAggregate.agentCount,
  group: groupAggregate.agentCount,
  channel: channelAggregate.agentCount,
  dmLink: agentEntry?.chatId,
});

console.log(`PASS i6-chat-info ${checks.length} checks`);
