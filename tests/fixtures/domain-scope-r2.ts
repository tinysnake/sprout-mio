// 真实 SQLite + 真实领域入口：I-P5a 第二轮验收 R2-A03 / R2-A04 / R2-N04 的三条反证。
// 与 chat-scope.ts 分开写，是因为这三条要能「先红」：收集全部失败再退出，而不是第一条就中断，
// 修复前的脚本输出同时给出三条各自的红。领域入口一律直调（不 mock、不经过 HTTP 边界），
// 只有 user / run 行按 fixtures 的既有习惯直接写表。
import assert from "node:assert/strict";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { agentRun, message } from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import type { ProjectContext } from "../../src/domain/access";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import {
  clearChatTitle,
  createGroupChat,
  ensureInstance,
  getChat,
  listChatMembers,
  removeGroupMember,
  sendMessage,
  updateChatTitle,
} from "../../src/domain/chat";
import type { ChatActor } from "../../src/domain/chat-actor";
import { createGroupChatInput } from "../../src/contracts/chat";
import { createProject, getProject, listProjects, updateProject } from "../../src/domain/project";
import { eq } from "drizzle-orm";

migrateDatabase();

const checks: string[] = [];
const failures: string[] = [];
function record(label: string, ok: boolean, detail: unknown = {}) {
  checks.push(label);
  if (ok) {
    console.log(`PASS ${label} ${JSON.stringify(detail)}`);
    return;
  }
  failures.push(label);
  console.log(`FAIL ${label} ${JSON.stringify(detail)}`);
}
function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}
function resultOf<T>(run: () => T): { code: string; value?: T } {
  try {
    return { code: "ok", value: run() };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? `unknown:${(error as Error).message}` };
  }
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_r2_scope_creator";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(creatorId, "r2-creator", "r2-creator@scope.test");

const ctx: ProjectContext = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
// A/B 同属一个 Human：A04 的原始场景就是「同一 Human 下用 A 的 run 身份碰 B」。
const projectA = createProject({ name: "R2 范围 A" }, ctx);
const projectB = createProject({ name: "R2 范围 B" }, ctx);
const alpha = createAgentProfile({ name: "R2 Alpha", persona: "", harness: "pi" }, ctx);
addProjectMember(projectA.id, alpha.id, ctx);

const humanActor: ChatActor = { kind: "human", userId: creatorId, ctx };

function groupInput(projectId: string, title: string) {
  return createGroupChatInput.parse({
    projectId,
    title,
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: alpha.id },
    ],
    // 所有者是 Agent：唯一能把 Project 创建者本人移出群的治理路径（d6 的兜底）。
    initialOwner: { kind: "agent", id: alpha.id },
  });
}
// 两个群内容相同，区别只在「创建者 Human 还是不是这条 Chat 的有效成员」。
const groupKeep = createGroupChat(projectA.id, groupInput(projectA.id, "R2 保留成员"), humanActor);
const groupDrop = createGroupChat(projectA.id, groupInput(projectA.id, "R2 移出成员"), humanActor);

const instanceAlpha = ensureInstance(groupKeep.id, alpha.id, ctx);
const runAlphaId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runAlphaId,
    instanceId: instanceAlpha.id,
    chatId: groupKeep.id,
    projectId: projectA.id,
    requestId: ctx.requestId,
    status: "running",
    startedAt: new Date(),
    sessionId: instanceAlpha.id,
  })
  .run();
/** A 的真实 running run：agent_run → agent_instance → project 三者自洽（access.readRunScope）。 */
const ctxAlpha: ProjectContext = {
  userId: creatorId,
  requestId: newId(ID_PREFIXES.request),
  agent: { agentProfileId: alpha.id, instanceId: instanceAlpha.id, runId: runAlphaId },
};

// 把 Human 本人移出 `groupDrop`：owner 是 Agent 时 Project 创建者是唯一有权治理的人（d6）。
const droppedRevision = getChat(groupDrop.id, ctx).governanceRevision;
assert.equal(
  codeOf(() =>
    removeGroupMember(groupDrop.id, { kind: "human", id: creatorId }, droppedRevision, humanActor),
  ),
  "ok",
);
const dropMembers = listChatMembers(groupDrop.id, ctx);
const keepMembers = listChatMembers(groupKeep.id, ctx);
assert.equal(
  dropMembers.some((member) => member.memberKind === "human" && member.memberId === creatorId),
  false,
);
assert.equal(
  keepMembers.some((member) => member.memberKind === "human" && member.memberId === creatorId),
  true,
);

// ---------------------------------------------------------------- 1. R2-A03：非成员 Human 不能改标题
const dropTitleBefore = getChat(groupDrop.id, ctx).title;
const dropRename = codeOf(() => updateChatTitle(groupDrop.id, "非成员改名", humanActor));
record("r2-a03.non-member-rename-denied", dropRename === "not_found", {
  code: dropRename,
  expected: "not_found",
});
const dropTitleAfter = getChat(groupDrop.id, ctx).title;
record("r2-a03.non-member-rename-leaves-title", dropTitleAfter === dropTitleBefore, {
  before: dropTitleBefore,
  after: dropTitleAfter,
});
const dropClear = codeOf(() => clearChatTitle(groupDrop.id, humanActor));
record("r2-a03.non-member-clear-denied", dropClear === "not_found", {
  code: dropClear,
  expected: "not_found",
});
// 上界：同一条 Chat 的有效成员 Human 照旧能改名，而且标题写入不推进治理版本。
const keepRevisionBefore = getChat(groupKeep.id, ctx).governanceRevision;
const keepRename = codeOf(() => updateChatTitle(groupKeep.id, "有效成员改名", humanActor));
const keepTitle = getChat(groupKeep.id, ctx).title;
const keepRevisionAfter = getChat(groupKeep.id, ctx).governanceRevision;
record("r2-a03.member-rename-allowed", keepRename === "ok" && keepTitle === "有效成员改名", {
  code: keepRename,
  title: keepTitle,
});
record("r2-a03.member-rename-keeps-revision", keepRevisionAfter === keepRevisionBefore, {
  before: keepRevisionBefore,
  after: keepRevisionAfter,
});

// ---------------------------------------------------------------- 2. R2-A04：Agent 执行身份不能跨 Project，也不能改 Project
const crossRead = codeOf(() => getProject(projectB.id, ctxAlpha));
record("r2-a04.cross-project-read-denied", crossRead === "not_found", {
  code: crossRead,
  expected: "not_found",
});
const crossWrite = codeOf(() => updateProject(projectB.id, { name: "分身改的 B" }, ctxAlpha));
record("r2-a04.cross-project-write-denied", crossWrite === "not_found", {
  code: crossWrite,
  expected: "not_found",
});
record("r2-a04.cross-project-name-unchanged", getProject(projectB.id, ctx).name === "R2 范围 B", {
  name: getProject(projectB.id, ctx).name,
});
const ownRead = codeOf(() => getProject(projectA.id, ctxAlpha));
record("r2-a04.own-project-read-allowed", ownRead === "ok", { code: ownRead });
const ownWrite = codeOf(() => updateProject(projectA.id, { name: "分身改的 A" }, ctxAlpha));
record("r2-a04.own-project-write-denied", ownWrite === "forbidden", {
  code: ownWrite,
  expected: "forbidden",
});
record("r2-a04.own-project-name-unchanged", getProject(projectA.id, ctx).name === "R2 范围 A", {
  name: getProject(projectA.id, ctx).name,
});
const agentList = resultOf(() => listProjects(ctxAlpha));
const agentListIds = agentList.value?.map((row) => row.id) ?? [];
record(
  "r2-a04.list-limited-to-own-project",
  agentList.code === "ok" && agentListIds.length === 1 && agentListIds[0] === projectA.id,
  { code: agentList.code, ids: agentListIds, expected: [projectA.id] },
);
record(
  "r2-a04.human-list-unchanged",
  listProjects(ctx)
    .map((row) => row.id)
    .sort()
    .join(",") === [projectA.id, projectB.id].sort().join(","),
  { ids: listProjects(ctx).map((row) => row.id) },
);

// ---------------------------------------------------------------- 3. R2-N04：agent sender 必须带 run 身份
function messageCount(chatId: string): number {
  return db.select().from(message).where(eq(message.chatId, chatId)).all().length;
}
const beforeNoRun = messageCount(groupKeep.id);
const noRunSend = codeOf(() =>
  sendMessage(
    groupKeep.id,
    { senderKind: "agent", senderId: alpha.id, body: "不带 run 身份的发言" },
    ctx,
  ),
);
record("r2-n04.agent-send-without-run-denied", noRunSend === "forbidden", {
  code: noRunSend,
  expected: "forbidden",
});
record("r2-n04.no-run-send-leaves-rows", messageCount(groupKeep.id) === beforeNoRun, {
  before: beforeNoRun,
  after: messageCount(groupKeep.id),
});
// 上界：同一入口带上那次 run 的身份仍然可写，拒绝的是「没有身份」而不是「Agent 不能发言」。
const withRunSend = codeOf(() =>
  sendMessage(
    groupKeep.id,
    { senderKind: "agent", senderId: alpha.id, body: "带 run 身份的发言" },
    ctxAlpha,
  ),
);
record("r2-n04.agent-send-with-run-allowed", withRunSend === "ok", { code: withRunSend });
record("r2-n04.with-run-send-adds-one-row", messageCount(groupKeep.id) === beforeNoRun + 1, {
  before: beforeNoRun,
  after: messageCount(groupKeep.id),
});

if (failures.length > 0) {
  console.error(`FAIL i7-chat-scope-r2 ${failures.length}/${checks.length} checks failed`);
  for (const label of failures) console.error(`  - ${label}`);
  process.exit(1);
}
console.log(`PASS i7-chat-scope-r2 ${checks.length} checks`);
