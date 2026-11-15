import { eq } from "drizzle-orm";
import { sqlite, db } from "../../src/db";
import { agentInstance, agentRun, chat, delegation, message } from "../../src/db/schema";
import { createAgentProfile, addProjectMember } from "../../src/domain/agent";
import { dispatchDelegation } from "../../src/domain/delegation";
import { sendMessage, createDirectChat } from "../../src/domain/chat";
import { createCrewChat } from "../../tests/fixtures/crew-chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";

const projectId = process.env.CREW_RAIL_PROJECT_ID!;
const owner = sqlite.prepare("SELECT created_by FROM project WHERE id=?").get(projectId) as {
  created_by: string;
};
const ctx = { userId: owner.created_by, requestId: "req_crew_rail_gate" };
const lead = createAgentProfile({ name: "Lead", persona: "统筹验证", harness: "pi" }, ctx);
const worker = createAgentProfile({ name: "Researcher", persona: "检查接口", harness: "pi" }, ctx);
for (const agent of [lead, worker]) addProjectMember(projectId, agent.id, ctx);
const crew = createCrewChat(
  projectId,
  {
    projectId,
    title: "Crew · 右栏验收",
    members: [
      { kind: "human", id: ctx.userId },
      { kind: "agent", id: lead.id },
      { kind: "agent", id: worker.id },
    ],
  },
  { kind: "human", userId: ctx.userId, ctx },
);
for (let i = 0; i < 200; i++)
  sendMessage(
    crew.id,
    {
      senderKind: "human",
      senderId: ctx.userId,
      body: `讨论 ${i + 1}：接口边界、数据隔离和交付验证。\n保留父对话阅读位置，便于从委派子对话返回。`,
    },
    ctx,
  );
// 分页按 created_at 取游标；同一秒内 200 条会让「更早」页无法区分，gate 加载不出 4 页。
const seededMessages = sqlite
  .prepare("SELECT id FROM message WHERE chat_id=? ORDER BY rowid")
  .all(crew.id) as { id: string }[];
const messageBase = Math.floor(Date.now() / 1000) - seededMessages.length;
const stampMessage = sqlite.prepare("UPDATE message SET created_at=? WHERE id=?");
for (const [index, row] of seededMessages.entries()) stampMessage.run(messageBase + index, row.id);
// 直接建一条运行中的委派：本机没有 pi provider 时真实 dispatch 会失败，验收卡会变成“需要你”。
const crewFacts = db
  .select({ epoch: chat.crewEpoch, lead: chat.leadProfileId })
  .from(chat)
  .where(eq(chat.id, crew.id))
  .get()!;
const activeChildId = newId(ID_PREFIXES.chat);
db.insert(chat)
  .values({
    id: activeChildId,
    projectId,
    kind: "delegation",
    title: "委派给 Researcher",
    parentCrewChatId: crew.id,
    ownerKind: "human",
    ownerId: ctx.userId,
    createdBy: ctx.userId,
  })
  .run();
const active = { delegationId: newId(ID_PREFIXES.delegation) };
db.insert(delegation)
  .values({
    id: active.delegationId,
    projectId,
    parentCrewChatId: crew.id,
    childChatId: activeChildId,
    dispatchLeadProfileId: crewFacts.lead!,
    crewEpoch: crewFacts.epoch,
    workerProfileId: worker.id,
    requestSummary: "核对接口与权限边界",
    status: "running",
    clientRequestId: "rail-gate-active",
    startedAt: new Date(Date.now() - 65000),
  })
  .run();
const completed = dispatchDelegation(
  {
    chatId: crew.id,
    workerProfileId: worker.id,
    request: "整理验收记录",
    clientRequestId: "rail-gate-completed",
  },
  ctx,
);
db.update(delegation)
  .set({
    status: "completed",
    terminalSummary: "已整理验收记录，覆盖导航与折叠偏好。",
    terminalReason: "completed",
    settledAt: new Date(),
    startedAt: new Date(Date.now() - 90000),
  })
  .where(eq(delegation.id, completed.delegationId))
  .run();
db.insert(message)
  .values({
    id: newId(ID_PREFIXES.message),
    chatId: crew.id,
    senderKind: "delegation_event",
    senderId: completed.delegationId,
    body: "已整理验收记录，覆盖导航与折叠偏好。",
    delegationId: completed.delegationId,
    createdAt: new Date(),
  })
  .run();
const runInstanceId = newId(ID_PREFIXES.instance);
const activeRunId = newId(ID_PREFIXES.run);
const activeStartedAt = new Date(Date.now() - 65000);
db.insert(agentInstance)
  .values({
    id: runInstanceId,
    agentProfileId: worker.id,
    chatId: activeChildId,
    projectId,
  })
  .run();
db.insert(agentRun)
  .values({
    id: activeRunId,
    instanceId: runInstanceId,
    chatId: activeChildId,
    projectId,
    requestId: "rail-gate-active-run",
    status: "running",
    queuedAt: activeStartedAt,
    startedAt: activeStartedAt,
    sessionId: runInstanceId,
    activity: {
      current: {
        id: "step_rail_gate",
        kind: "tool",
        label: "读取迁移",
        detail: "drizzle/0067_adorable_corsair.sql",
        startedAt: activeStartedAt.toISOString(),
        status: "running",
      },
      entries: [],
      updatedAt: new Date().toISOString(),
    },
  })
  .run();
const needsYou = dispatchDelegation(
  {
    chatId: crew.id,
    workerProfileId: worker.id,
    request: "确认失败重试策略",
    clientRequestId: "rail-gate-needsyou",
  },
  ctx,
);
db.update(delegation)
  .set({ status: "blocked", terminalSummary: "请确认重试次数与超时范围。" })
  .where(eq(delegation.id, needsYou.delegationId))
  .run();
let staleDelegationId: string | null = null;
const historyCases: {
  status: "completed" | "failed" | "canceled";
  request: string;
  ageMs?: number;
}[] = [
  { status: "completed", request: "补写使用说明" },
  { status: "completed", request: "整理历史记录" },
  { status: "failed", request: "检查迁移脚本" },
  { status: "canceled", request: "重跑过期任务" },
  { status: "completed", request: "归档超过一天的旧记录", ageMs: 25 * 60 * 60 * 1000 },
];
for (const [index, item] of historyCases.entries()) {
  const settled = dispatchDelegation(
    {
      chatId: crew.id,
      workerProfileId: worker.id,
      request: item.request,
      clientRequestId: `rail-gate-${item.status}-${item.request}`,
    },
    ctx,
  );
  db.update(delegation)
    .set({
      status: item.status,
      terminalSummary:
        item.status === "completed" ? `${item.request}已完成。` : `${item.request}已结束。`,
      terminalReason: item.status,
      settledAt: new Date(Date.now() - (item.ageMs ?? 0)),
      updatedAt: new Date(Date.now() - (item.ageMs ?? 120000 + index * 1000)),
    })
    .where(eq(delegation.id, settled.delegationId))
    .run();
  if (item.ageMs) staleDelegationId = settled.delegationId;
}
const dm = createDirectChat(projectId, worker.id, ctx);
console.log(
  JSON.stringify({
    crewChatId: crew.id,
    childChatId: completed.childChatId,
    dmChatId: dm.chat.id,
    staleDelegationId,
    projectId,
  }),
);
sqlite.close();
