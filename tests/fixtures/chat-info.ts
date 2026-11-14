// 真实 SQLite + 真实领域入口：Crew 与 DM 的会话读模型、Info Hub 会话聚合。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { agentRun } from "../../src/db/schema";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import { createDirectChat, getChat, sendMessage } from "../../src/domain/chat";
import type { ChatActor } from "../../src/domain/chat-actor";
import { getChatSession } from "../../src/domain/chat-session";
import { getChatInfo, getProjectInfoHub } from "../../src/domain/info-hub";
import { createProject } from "../../src/domain/project";
import { createCrewChat } from "./crew-chat";

migrateDatabase();

const checks: string[] = [];
function pass(label: string, output: unknown = {}) {
  checks.push(label);
  console.log(`PASS ${label} ${JSON.stringify(output)}`);
}

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

const crew = createCrewChat(
  project.id,
  {
    projectId: project.id,
    title: "三人协作 Crew",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentB.id },
      { kind: "agent", id: agentC.id },
    ],
    initialOwner: { kind: "agent", id: agentA.id },
  },
  human,
);
assert.equal(crew.kind, "crew");
assert.equal(crew.leadProfileId, agentA.id, "首个 Agent 成员按约定成为 lead");

// 一条人类消息点名三名 Agent：只有 lead 被唤醒，其他成员不级联。
sendMessage(
  crew.id,
  { senderKind: "human", senderId: creatorId, body: "@Alpha @Beta @Gamma 各写一段" },
  ctx,
);
const crewRuns = db.select().from(agentRun).where(eq(agentRun.chatId, crew.id)).all() as {
  id: string;
  instanceId: string;
}[];
assert.equal(crewRuns.length, 1, "Crew 的人类消息只交给 lead，不扇出给其他成员");
assert.equal(
  sqlite
    .prepare("SELECT agent_profile_id FROM agent_instance WHERE id=?")
    .get(crewRuns[0]!.instanceId)?.agent_profile_id,
  agentA.id,
  "被唤醒的必须是 lead",
);

const crewSession = getChatSession(crew.id, ctx);
assert.equal(crewSession.kind, "crew");
assert.equal(crewSession.chat.leadProfileId, agentA.id);
assert.equal(crewSession.instances.length, 1, "只有 lead 有 instance");
assert.equal(crewSession.instances[0]!.agentProfileId, agentA.id);
assert.equal(crewSession.instances[0]!.activeRun?.runId, crewRuns[0]!.id);
assert.equal(crewSession.instances[0]!.activeRun?.status, "queued");
pass("crew.session-lead-only", {
  instances: crewSession.instances.length,
  runs: crewRuns.length,
  lead: crewSession.chat.leadProfileId,
});

// 成员变更不改 lead；读模型里的成员来自 chat_member 的显式集合。
assert.equal(getChat(crew.id, ctx).leadProfileId, agentA.id);

// DM 读模型保持原样：多出 kind 与 governance，chat/instance 逐字段等于 getChat。
const dm = createDirectChat(project.id, agentA.id, ctx);
const dmSession = getChatSession(dm.chat.id, ctx);
assert.equal(dmSession.kind, "dm");
assert.deepEqual(Object.keys(dmSession).sort(), ["chat", "governance", "instance", "kind"]);
assert.deepEqual({ chat: dmSession.chat, instance: dmSession.instance }, dm);
assert.equal(dmSession.governance.canChangeMembers, false);
assert.equal(dmSession.governance.canChangeLead, false);
assert.equal(dmSession.governance.canRenameTitle, true);
pass("dm.session-shape", { title: dm.chat.title });

const hub = getProjectInfoHub(project.id, ctx);
const aggregateOf = (chatId: string) => hub.chats.find((entry) => entry.chatId === chatId);
const crewInfo = getChatInfo(crew.id, ctx);
assert.equal(crewInfo.chatId, crew.id);

const crewAggregate = aggregateOf(crew.id);
assert.ok(crewAggregate, "Info Hub 会话聚合必须包含 Crew");
assert.equal(crewAggregate.agentCount, 1, "Crew 只有 lead 被唤醒过");
assert.equal(crewAggregate.displayTitle, "三人协作 Crew");
assert.deepEqual(crewAggregate.statusCounts, [{ status: "queued", count: 1 }]);

const dmAggregate = aggregateOf(dm.chat.id);
assert.ok(dmAggregate, "Info Hub 会话聚合必须包含 DM");
assert.equal(dmAggregate.kind, "dm");

const agentEntry = hub.agents.agents.find((entry) => entry.agentProfileId === agentA.id);
assert.equal(agentEntry?.chatId, dm.chat.id, "Project → Agents 的 chatId 必须是 DM");
assert.equal(agentEntry?.instanceId, dm.instance.id);
pass("info-hub.chat-aggregation", {
  crew: crewAggregate.agentCount,
  dm: dmAggregate.agentCount,
  dmLink: agentEntry?.chatId,
});

console.log(`PASS i6-chat-info ${checks.length} checks`);
