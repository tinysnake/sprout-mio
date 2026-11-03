process.env.SPROUT_AUTOMATION_ENABLED = "false";

const { migrateDatabase } = await import("../../src/db/migrate");
migrateDatabase();
const { sqlite } = await import("../../src/db");
const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
const projectDomain = await import("../../src/domain/project");
const agentDomain = await import("../../src/domain/agent");
const chatDomain = await import("../../src/domain/chat");

const ctx = { userId: "usr_mw_disabled", requestId: newId(ID_PREFIXES.request) };
const actor = { kind: "human" as const, userId: ctx.userId, ctx };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES(?,?,?,0,1,1)",
  )
  .run(ctx.userId, "Message Wake Disabled", "message-wake-disabled@example.test");

const project = projectDomain.createProject({ name: "Message wake disabled" }, ctx);
const owner = agentDomain.createAgentProfile(
  { name: "Owner", persona: "推进对话", harness: "pi" },
  ctx,
);
agentDomain.addProjectMember(project.id, owner.id, ctx);
const chat = chatDomain.createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "自动化关闭",
    wakePolicy: "contextual",
    members: [
      { kind: "human", id: ctx.userId },
      { kind: "agent", id: owner.id },
    ],
    initialOwner: { kind: "agent", id: owner.id },
  },
  actor,
);
chatDomain.sendMessage(
  chat.id,
  { body: "自动化关闭时仍然叫 owner", senderKind: "human", senderId: ctx.userId },
  ctx,
);

const wake = sqlite
  .prepare("SELECT count(*) AS count FROM chat_message_wake WHERE chat_id=?")
  .get(chat.id) as { count: number };
const runs = sqlite
  .prepare("SELECT count(*) AS count FROM agent_run WHERE chat_id=?")
  .get(chat.id) as { count: number };

console.log(JSON.stringify({ wake: wake.count, runs: runs.count }));

export {};
