import { sqlite } from "../../src/db";
import { sendMessage } from "../../src/domain/chat";

const projectId = process.env.CREW_RAIL_PROJECT_ID!;
const crewId = process.env.CREW_RAIL_CREW_ID!;
const owner = sqlite.prepare("SELECT created_by FROM project WHERE id=?").get(projectId) as {
  created_by: string;
};
const ctx = { userId: owner.created_by, requestId: "req_crew_rail_append" };
sendMessage(
  crewId,
  {
    senderKind: "human",
    senderId: ctx.userId,
    body: "验收后续消息：确认恢复后的锚点仍然保留。",
  },
  ctx,
);
console.log(JSON.stringify({ ok: true, crewId }));
