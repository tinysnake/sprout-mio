import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 真实 SQLite + 真实领域入口：本文件只断言「参与权撤销后还能不能改成员」这一条边界。
// 与被测模块一致，先把连接指到临时库再动态载入（domain/chat.ts 装载时就建立连接）。
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "p5a-member-")), "p5a.sqlite");

const { migrateDatabase } = await import("../src/db/migrate");
const { sqlite } = await import("../src/db");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { createGroupChatInput } = await import("../src/contracts/chat");
const { createProject } = await import("../src/domain/project");
const { addProjectMember, createAgentProfile } = await import("../src/domain/agent");
const { addGroupMember, createGroupChat, getChat, isEffectiveMember, removeGroupMember } =
  await import("../src/domain/chat");
type ChatActor = import("../src/domain/chat-actor").ChatActor;

migrateDatabase();

const creatorId = "usr_r3_creator";
const otherId = "usr_r3_other";
for (const [id, label] of [
  [creatorId, "creator"],
  [otherId, "other"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, label, `${label}@r3-fixes.test`);

const ctx = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "R3 参与权" }, ctx);
const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, alpha.id, ctx);
addProjectMember(project.id, beta.id, ctx);

const creator: ChatActor = { kind: "human", userId: creatorId, ctx };
const other: ChatActor = { kind: "human", userId: otherId, ctx };

const group = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "R3 参与者撤出",
    members: [
      { kind: "human", id: creatorId },
      { kind: "human", id: otherId },
      { kind: "agent", id: alpha.id },
    ],
    initialOwner: { kind: "human", id: otherId },
  }),
  creator,
);

const left = removeGroupMember(group.id, { kind: "human", id: creatorId }, 0, creator);

function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}
function messageOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as Error).message;
  }
}

describe("被移出群的 Human 不能再调整成员（d42 的参与权撤销）", () => {
  it("移出自己之后 revision 已经推进，且调用者不再是有效成员", () => {
    expect(left.governanceRevision).toBe(1);
    expect(isEffectiveMember(creator, left)).toBe(false);
    expect(isEffectiveMember(other, left)).toBe(true);
  });

  it("former member 加成员被拒为 not_found，与标题写入同码同文案", () => {
    const run = () =>
      addGroupMember(group.id, { kind: "agent", id: beta.id }, left.governanceRevision, creator);
    expect(codeOf(run)).toBe("not_found");
    expect(messageOf(run)).toBe("对话成员不存在");
  });

  it("former member 移出成员被拒为 not_found，与加成员同一道判定", () => {
    const run = () =>
      removeGroupMember(
        group.id,
        { kind: "agent", id: alpha.id },
        left.governanceRevision,
        creator,
      );
    expect(codeOf(run)).toBe("not_found");
    expect(messageOf(run)).toBe("对话成员不存在");
  });

  it("两次被拒都没有推进 governanceRevision", () => {
    codeOf(() =>
      addGroupMember(group.id, { kind: "agent", id: beta.id }, left.governanceRevision, creator),
    );
    codeOf(() =>
      removeGroupMember(
        group.id,
        { kind: "agent", id: alpha.id },
        left.governanceRevision,
        creator,
      ),
    );
    expect(getChat(group.id, ctx).governanceRevision).toBe(left.governanceRevision);
  });

  it("仍在群里的非 owner Human 照常能增删成员（d42 不退回 owner 档）", () => {
    const added = addGroupMember(
      group.id,
      { kind: "agent", id: beta.id },
      left.governanceRevision,
      other,
    );
    expect(added.governanceRevision).toBe(left.governanceRevision + 1);
    const removed = removeGroupMember(
      group.id,
      { kind: "agent", id: beta.id },
      added.governanceRevision,
      other,
    );
    expect(removed.governanceRevision).toBe(added.governanceRevision + 1);
  });
});
