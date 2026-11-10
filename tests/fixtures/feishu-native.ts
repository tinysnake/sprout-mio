import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export async function feishuNativeFixture() {
  const directory = mkdtempSync(join(tmpdir(), "sprout-feishu-"));
  process.env.DATABASE_URL = join(directory, "native.sqlite");
  process.env.SPROUT_PI_ENABLED = "false";
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("hex");
  process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
  const { migrateDatabase } = await import("../../src/db/migrate");
  migrateDatabase();
  const { sqlite } = await import("../../src/db");
  const projects = await import("../../src/domain/project");
  const agents = await import("../../src/domain/agent");
  const chats = await import("../../src/domain/chat");
  const ctx = { userId: "feishu-human", requestId: "req_feishu" };
  for (const userId of [ctx.userId, "other-human"]) {
    sqlite
      .prepare(
        "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
      )
      .run(userId, userId, `${userId}@example.test`);
  }
  const project = projects.createProject({ name: "Feishu project" }, ctx);
  const helper = agents.createAgentProfile({ name: "Helper", purpose: "assistant" }, ctx);
  agents.addProjectMember(project.id, helper.id, ctx);
  const dm = chats.createDirectChat(project.id, helper.id, ctx).chat;
  return {
    directory,
    sqlite,
    ctx,
    project,
    helper,
    dm,
    projects,
    agents,
    chats,
    close() {
      sqlite.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
