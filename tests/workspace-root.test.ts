import { afterAll, expect, it } from "vite-plus/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 租约的存在与否与「能不能看工作区」无关：这里不启动任何 run、不申请租约，
 * 只按会话身份解析根。跨 Project 的读取必须在解析根这一步就被拒。
 */
const directory = mkdtempSync(join(tmpdir(), "workspace-root-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_DATA_DIR = join(directory, "pi");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
const { startRuntime, shutdownRuntime } = await import("../src/server/runtime");
await startRuntime();
const { sqlite } = await import("../src/db");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const chats = await import("../src/domain/chat");
const { listWorkspaceTree, resolveWorkspaceRoot } = await import("../src/domain/workspace");

const owner = { userId: "workspace-owner", requestId: "req_workspace" };
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(owner.userId, "Human", "attachments@test.local");
const project = createProject({ name: "Workspace" }, owner);
const profile = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, owner);
addProjectMember(project.id, profile.id, owner);
const chat = chats.createDirectChat(project.id, profile.id, owner).chat;
// 实例由建 DM 时一起创建；这里再取一次 id，验证「同一对话的工作区是稳定的」。
const instanceId = (
  sqlite.prepare("SELECT id FROM agent_instance WHERE chat_id=?").get(chat.id) as { id: string }
).id;

afterAll(async () => {
  await shutdownRuntime("workspace-root-test");
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

it("没有仓库时根落在该 Chat 的实例工作区，且不需要租约或运行中的 agent", () => {
  const root = resolveWorkspaceRoot(project.id, chat.id, owner);
  expect(root?.kind).toBe("workspace");
  expect(root?.path).toBe(join(process.env.SPROUT_PI_DATA_DIR as string, instanceId, "workspace"));
});

it("根目录不存在时按 not_found 呈现，不在磁盘上留下空壳", async () => {
  const root = resolveWorkspaceRoot(project.id, chat.id, owner);
  expect(root).toBeDefined();
  await expect(listWorkspaceTree(root!, "")).rejects.toMatchObject({ code: "not_found" });
});

it("实例工作区里写入的文件可以被列出与预览分流", async () => {
  const root = resolveWorkspaceRoot(project.id, chat.id, owner);
  mkdirSync(root!.path, { recursive: true });
  writeFileSync(join(root!.path, "notes.md"), "# 记录\n");
  const tree = await listWorkspaceTree(root!, "");
  expect(tree.root).toBe("workspace");
  expect(tree.entries.map((entry) => [entry.name, entry.previewKind])).toEqual([
    ["notes.md", "markdown"],
  ]);
});

it("别人的 Project 在解析根时就被拒，看不到工作区是否存在", () => {
  const stranger = { userId: "workspace-stranger", requestId: "req_stranger" };
  expect(() => resolveWorkspaceRoot(project.id, chat.id, stranger)).toThrow();
});
