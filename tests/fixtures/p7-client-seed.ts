import { eq } from "drizzle-orm";
import { db, sqlite } from "../../src/db";
import { chat, user } from "../../src/db/schema";
import { createProject } from "../../src/domain/project";
import { createAgentProfile, addProjectMember } from "../../src/domain/agent";
import { createDirectChat, createGroupChat } from "../../src/domain/chat";
import { createMachine } from "../../src/domain/machine";
import { createTask } from "../../src/domain/task";
const human = db.select().from(user).where(eq(user.email, process.env.P7_EMAIL!)).get()!;
const ctx = { userId: human.id, requestId: "req_p7-client-seed" };
const project = createProject({ name: "P7 深链 Project", description: "客户端门禁专用" }, ctx);
const agent = createAgentProfile(
  { name: "P7 Agent", persona: "只用于导航测试", harness: "pi" },
  ctx,
);
addProjectMember(project.id, agent.id, ctx);
const dm = createDirectChat(project.id, agent.id, ctx).chat;
const group = createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "P7 Group",
    members: [
      { kind: "human", id: human.id },
      { kind: "agent", id: agent.id },
    ],
    initialOwner: { kind: "human", id: human.id },
    wakePolicy: "owner_led",
  },
  { kind: "human", userId: human.id, ctx },
);
const channel = db
  .select()
  .from(chat)
  .where(eq(chat.projectId, project.id))
  .all()
  .find((row: { kind: string }) => row.kind === "public_channel")!;
const machine = createMachine(
  { name: "P7 Machine" },
  { ...ctx, bootId: "p7-client", now: new Date() },
);
const task = createTask({ projectId: project.id, title: "P7 Task" }, ctx);
console.log(
  JSON.stringify({
    projectId: project.id,
    agentId: agent.id,
    dmId: dm.id,
    groupId: group.id,
    channelId: channel.id,
    machineId: machine.detail.machine.id,
    taskId: task.detail.task.id,
    migration: sqlite
      .prepare("SELECT id, hash FROM __drizzle_migrations ORDER BY id DESC LIMIT 1")
      .get(),
  }),
);
sqlite.close();
