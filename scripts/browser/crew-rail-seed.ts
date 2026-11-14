import { eq } from "drizzle-orm";
import { sqlite, db } from "../../src/db";
import { delegation } from "../../src/db/schema";
import { createAgentProfile, addProjectMember } from "../../src/domain/agent";
import { dispatchDelegation } from "../../src/domain/delegation";
import { sendMessage, createDirectChat } from "../../src/domain/chat";
import { createCrewChat } from "../../tests/fixtures/crew-chat";

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
for (let i = 0; i < 30; i++)
  sendMessage(
    crew.id,
    {
      senderKind: "human",
      senderId: ctx.userId,
      body: `讨论 ${i + 1}：接口边界、数据隔离和交付验证。\n保留父对话阅读位置，便于从委派子对话返回。`,
    },
    ctx,
  );
const active = dispatchDelegation(
  {
    chatId: crew.id,
    workerProfileId: worker.id,
    request: "核对接口与权限边界",
    clientRequestId: "rail-gate-active",
  },
  ctx,
);
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
  .set({ status: "running", startedAt: new Date(Date.now() - 65000) })
  .where(eq(delegation.id, active.delegationId))
  .run();
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
const dm = createDirectChat(projectId, worker.id, ctx);
console.log(
  JSON.stringify({
    crewChatId: crew.id,
    childChatId: completed.childChatId,
    dmChatId: dm.chat.id,
    projectId,
  }),
);
sqlite.close();
