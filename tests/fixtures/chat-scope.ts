// 真实 SQLite + 真实域入口：Agent 执行身份的对话范围（验收 A03/A04/N04）与项目驱动移除的治理版本（裁定 d30）。
// 不 mock 领域层：每条反证都调 src/domain/chat.ts / access.ts 的正式入口，只有 run 行按 fixtures 的习惯直接写表
// （本单元不改唤醒与扇出，归 p5a-fanout）。
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import { createGroupChatInput } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { agentRun, message } from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import type { ProjectContext } from "../../src/domain/access";
import { addProjectMember, createAgentProfile, removeProjectMember } from "../../src/domain/agent";
import {
  addGroupMember,
  clearChatTitle,
  createGroupChat,
  ensureInstance,
  getChat,
  getInstance,
  listChatMembers,
  listChats,
  listMessages,
  sendMessage,
  updateChatTitle,
} from "../../src/domain/chat";
import {
  assertChatCapability,
  CHAT_ACTIONS,
  CHAT_CAPABILITIES,
} from "../../src/domain/chat-capabilities";
import type { ChatActor } from "../../src/domain/chat-actor";
import { ensureProjectChannel } from "../../src/domain/channel";
import { createProject } from "../../src/domain/project";

migrateDatabase();

const checks: string[] = [];
function pass(label: string, output: unknown = {}) {
  checks.push(label);
  console.log(`PASS ${label} ${JSON.stringify(output)}`);
}
function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return (error as { code?: string }).code ?? `unknown:${(error as Error).message}`;
  }
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_scope_creator";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(creatorId, "creator", "creator@scope.test");

const ctx: ProjectContext = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
// 两个 Project 属于同一个 Human：验收 A04 的原始场景就是「同一 Human 下用 A 的 run 身份读 B」。
const projectA = createProject({ name: "权限范围 A" }, ctx);
const projectB = createProject({ name: "权限范围 B" }, ctx);

const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
const gamma = createAgentProfile({ name: "Gamma", persona: "", harness: "pi" }, ctx);
const epsilon = createAgentProfile({ name: "Epsilon", persona: "", harness: "pi" }, ctx);
for (const agent of [alpha, gamma, epsilon]) addProjectMember(projectA.id, agent.id, ctx);
addProjectMember(projectB.id, beta.id, ctx);

const human: ChatActor = { kind: "human", userId: creatorId, ctx };
function groupInput(projectId: string, title: string, agentProfileId: string) {
  return createGroupChatInput.parse({
    projectId,
    title,
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentProfileId },
    ],
    initialOwner: { kind: "human", id: creatorId },
  });
}
// 主群：Alpha 有一个真实的 running run，A03/A04/N04 的短路径都在这里打。
const groupMain = createGroupChat(projectA.id, groupInput(projectA.id, "群 A", alpha.id), human);
// 对照群：没有任何成员会被移除，用来证明 d30 的版本推进只落在受影响的群上。
const groupControl = createGroupChat(
  projectA.id,
  groupInput(projectA.id, "对照群", gamma.id),
  human,
);
// 移除群：Epsilon 的历史（instance、已结束的 run、历史消息）都在这里，随后被项目级移除。
const groupLeaving = createGroupChat(
  projectA.id,
  groupInput(projectA.id, "移除群", epsilon.id),
  human,
);
const groupB = createGroupChat(projectB.id, groupInput(projectB.id, "群 B", beta.id), human);
const channelA = ensureProjectChannel(projectA.id);
const channelB = ensureProjectChannel(projectB.id);

/** 真实 running run 的执行身份；`userId` 仍是 Project 归属，`agent` 是这次运行。 */
function agentContext(runId: string, instanceId: string, agentProfileId: string): ProjectContext {
  return {
    userId: creatorId,
    requestId: newId(ID_PREFIXES.request),
    agent: { agentProfileId, instanceId, runId },
  };
}
const instanceAlpha = ensureInstance(groupMain.id, alpha.id, ctx);
const runAlphaId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runAlphaId,
    instanceId: instanceAlpha.id,
    chatId: groupMain.id,
    projectId: projectA.id,
    requestId: ctx.requestId,
    status: "running",
    startedAt: new Date(),
    sessionId: instanceAlpha.id,
  })
  .run();
const instanceBeta = ensureInstance(groupB.id, beta.id, ctx);
const runBetaId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runBetaId,
    instanceId: instanceBeta.id,
    chatId: groupB.id,
    projectId: projectB.id,
    requestId: ctx.requestId,
    status: "running",
    startedAt: new Date(),
    sessionId: instanceBeta.id,
  })
  .run();
const ctxAlpha = agentContext(runAlphaId, instanceAlpha.id, alpha.id);
const ctxBeta = agentContext(runBetaId, instanceBeta.id, beta.id);

function messageCount(chatId: string): number {
  return db.select().from(message).where(eq(message.chatId, chatId)).all().length;
}

// ---------------------------------------------------------------- 1. A03：Agent 对标题的治理被拒，Human 行为不变
const agentActor: ChatActor = {
  kind: "agent",
  agentProfileId: alpha.id,
  instanceId: instanceAlpha.id,
  runId: runAlphaId,
  ctx: ctxAlpha,
};
assert.equal(
  codeOf(() => updateChatTitle(groupMain.id, "分身改的名字", ctxAlpha)),
  "forbidden",
  "A03：Agent 执行身份改标题必须被拒",
);
assert.equal(getChat(groupMain.id, ctx).title, "群 A", "被拒的改名不能写标题");
assert.equal(
  codeOf(() => clearChatTitle(groupMain.id, ctxAlpha)),
  "forbidden",
  "A03：Agent 执行身份清标题必须被拒",
);
assert.equal(getChat(groupMain.id, ctx).title, "群 A", "被拒的清标题不能清掉标题");
// 上界：同一个入口对人类不变。
assert.equal(updateChatTitle(groupMain.id, "人类改的名字", ctx).title, "人类改的名字");
assert.equal(clearChatTitle(groupMain.id, ctx).title, undefined, "人类清标题回到默认展示");
pass("a03.agent-title-forbidden", {
  agentUpdate: "forbidden",
  agentClear: "forbidden",
  humanUpdate: "ok",
  humanClear: "ok",
});

// ---------------------------------------------------------------- 2. A04：跨 Project 与跨对话的 Agent 读写被拒
assert.equal(
  codeOf(() => getChat(groupB.id, ctxAlpha)),
  "not_found",
  "A04：A 的 run 读不到 B 的群",
);
assert.equal(
  codeOf(() => getChat(channelB, ctxAlpha)),
  "not_found",
  "A04：A 的 run 读不到 B 的频道",
);
assert.equal(
  codeOf(() => listChatMembers(channelB, ctxAlpha)),
  "not_found",
);
assert.equal(
  codeOf(() => listMessages(groupB.id, ctxAlpha)),
  "not_found",
);
assert.equal(
  codeOf(() => listChats(projectB.id, ctxAlpha)),
  "not_found",
  "B 的会话列表也读不到",
);
assert.equal(
  codeOf(() => getInstance(instanceBeta.id, ctxAlpha)),
  "not_found",
  "A04：也拿不到 B 的 instance",
);
const messagesInB = messageCount(channelB) + messageCount(groupB.id);
assert.equal(
  codeOf(() =>
    sendMessage(
      groupB.id,
      { senderKind: "agent", senderId: beta.id, body: "跨 Project 发言" },
      ctxAlpha,
    ),
  ),
  "not_found",
  "A04：A 的 run 不能往 B 的群发言",
);
assert.equal(
  codeOf(() =>
    sendMessage(
      channelB,
      { senderKind: "agent", senderId: beta.id, body: "跨 Project 频道发言" },
      ctxAlpha,
    ),
  ),
  "not_found",
  "A04：A 的 run 不能往 B 的频道发言",
);
assert.equal(
  messageCount(channelB) + messageCount(groupB.id),
  messagesInB,
  "被拒的跨 Project 发言不能落库",
);
// 同一个 Project 里的另一个对话同样不在这次运行的范围里。
assert.equal(
  codeOf(() => getChat(channelA, ctxAlpha)),
  "not_found",
  "A04：run 绑定自己所在的对话，不是整个 Project",
);
assert.equal(
  codeOf(() => getInstance(instanceAlpha.id, ctxBeta)),
  "not_found",
  "B 的 run 拿不到 A 的 instance",
);
pass("a04.cross-project-denied", {
  crossProjectRead: "not_found",
  crossProjectSend: "not_found",
  crossChatRead: "not_found",
  rowsUnchanged: true,
});

// 上界：它自己的对话照旧可读可写，Human 的读取能力不受影响。
assert.equal(getChat(groupMain.id, ctxAlpha).id, groupMain.id);
assert.equal(getInstance(instanceAlpha.id, ctxAlpha).id, instanceAlpha.id);
assert.deepEqual(listChatMembers(groupMain.id, ctxAlpha).length, 2);
assert.equal(
  sendMessage(
    groupMain.id,
    { senderKind: "agent", senderId: alpha.id, body: "本对话汇报" },
    ctxAlpha,
  ).body,
  "本对话汇报",
);
assert.equal(getChat(groupB.id, ctx).id, groupB.id, "同一 Human 仍然读得到 B 的群");
assert.equal(listChats(projectB.id, ctx).length, 2, "Human 的会话列表不受 Agent 收口影响");
pass("a04.own-scope-allowed", {
  selfRead: "ok",
  selfSend: "ok",
  humanRead: "ok",
});

// ---------------------------------------------------------------- 3. N04：领域 sendMessage 自己验证 run
const beforeFakeRun = messageCount(groupMain.id);
assert.equal(
  codeOf(() =>
    sendMessage(
      groupMain.id,
      { senderKind: "agent", senderId: alpha.id, body: "不存在的 run" },
      {
        ...ctx,
        agent: { agentProfileId: alpha.id, instanceId: instanceAlpha.id, runId: "run_missing" },
      },
    ),
  ),
  "not_found",
  "N04：不存在的 run 不能发言",
);
assert.equal(
  codeOf(() =>
    sendMessage(
      groupMain.id,
      { senderKind: "agent", senderId: alpha.id, body: "instance 不匹配" },
      {
        ...ctx,
        agent: { agentProfileId: alpha.id, instanceId: "ins_not_mine", runId: runAlphaId },
      },
    ),
  ),
  "not_found",
  "N04：run 不属于这个 instance 时不能发言",
);
// 已结束的 run：身份仍然存在，但它不再是「活跃执行」。
db.update(agentRun)
  .set({ status: "aborted", settledAt: new Date() })
  .where(eq(agentRun.id, runBetaId))
  .run();
assert.equal(
  codeOf(() =>
    sendMessage(
      groupB.id,
      { senderKind: "agent", senderId: beta.id, body: "已结束的 run" },
      ctxBeta,
    ),
  ),
  "forbidden",
  "N04：已结束的 run 不能继续发言",
);
assert.equal(messageCount(groupMain.id), beforeFakeRun, "被拒的发言不落消息行");
assert.equal(messageCount(groupB.id), 0, "已结束 run 的发言不落消息行");
pass("n04.domain-validates-run", {
  missingRun: "not_found",
  foreignInstance: "not_found",
  settledRun: "forbidden",
  rowsUnchanged: true,
});

// ---------------------------------------------------------------- 4. A04：被移出之后，运行身份读不到那个对话
const instanceEpsilon = ensureInstance(groupLeaving.id, epsilon.id, ctx);
const epsilonHistory = sendMessage(
  groupLeaving.id,
  { senderKind: "agent", senderId: epsilon.id, body: "移出前的历史汇报" },
  ctx,
);
const epsilonRunId = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: epsilonRunId,
    instanceId: instanceEpsilon.id,
    chatId: groupLeaving.id,
    projectId: projectA.id,
    requestId: ctx.requestId,
    status: "aborted",
    settledAt: new Date(),
    sessionId: instanceEpsilon.id,
  })
  .run();
const ctxEpsilon = agentContext(epsilonRunId, instanceEpsilon.id, epsilon.id);
assert.equal(getChat(groupLeaving.id, ctxEpsilon).id, groupLeaving.id, "移出前自己的对话可读");

// ---------------------------------------------------------------- 5. d30：项目驱动的成员变化推进受影响群的治理版本
const revisionBefore = getChat(groupLeaving.id, ctx).governanceRevision;
const controlBefore = getChat(groupControl.id, ctx).governanceRevision;
const mainBefore = getChat(groupMain.id, ctx).governanceRevision;
assert.equal(
  codeOf(() => removeProjectMember(projectA.id, epsilon.id, ctx)),
  "ok",
);
const revisionAfter = getChat(groupLeaving.id, ctx).governanceRevision;
assert.equal(revisionAfter, revisionBefore + 1, "d30：删掉群成员行的移除必须推进治理版本");
assert.equal(
  getChat(groupControl.id, ctx).governanceRevision,
  controlBefore,
  "没有成员行被删的群不动版本",
);
assert.equal(
  getChat(groupMain.id, ctx).governanceRevision,
  mainBefore,
  "同一 Project 的其它群不受这次移除影响",
);
// 反证：移除前读到的 expectedRevision 在移除后必须冲突，不能留着陈旧 CAS 落地。
assert.equal(
  codeOf(() =>
    addGroupMember(groupLeaving.id, { kind: "agent", id: gamma.id }, revisionBefore, human),
  ),
  "conflict",
  "d30：移除前的 expectedRevision 在移除后必须冲突",
);
const staleRejected = getChat(groupLeaving.id, ctx);
assert.equal(staleRejected.governanceRevision, revisionAfter, "被拒的过期写入不能再推进版本");
assert.equal(
  listChatMembers(groupLeaving.id, ctx).some((member) => member.memberId === gamma.id),
  false,
  "被拒的过期写入不能改成员集",
);
// 上界：拿到当前版本就能正常治理，版本推进不是「一律拒绝」。
const applied = addGroupMember(
  groupLeaving.id,
  { kind: "agent", id: gamma.id },
  staleRejected.governanceRevision,
  human,
);
assert.equal(applied.governanceRevision, revisionAfter + 1, "新版本可用");
// 幂等：已经不在 Project 的 Agent 再移除一次不推进版本。
assert.equal(
  codeOf(() => removeProjectMember(projectA.id, epsilon.id, ctx)),
  "ok",
);
assert.equal(
  getChat(groupLeaving.id, ctx).governanceRevision,
  applied.governanceRevision,
  "重复移除不推进版本",
);
pass("d30.project-removal-bumps-revision", {
  before: revisionBefore,
  after: revisionAfter,
  stale: "conflict",
  applied: applied.governanceRevision,
  controlUnchanged: true,
});

// 移出后：运行身份读不到那个对话，Human 仍读得到历史。
assert.equal(
  codeOf(() => getChat(groupLeaving.id, ctxEpsilon)),
  "not_found",
);
assert.equal(
  codeOf(() => getInstance(instanceEpsilon.id, ctxEpsilon)),
  "not_found",
);
assert.equal(
  codeOf(() => listMessages(groupLeaving.id, ctxEpsilon)),
  "not_found",
);
assert.equal(
  codeOf(() =>
    sendMessage(
      groupLeaving.id,
      { senderKind: "agent", senderId: epsilon.id, body: "移出后还想发言" },
      ctxEpsilon,
    ),
  ),
  "not_found",
);
assert.deepEqual(
  listMessages(groupLeaving.id, ctx)
    .filter((entry) => entry.senderId === epsilon.id)
    .map((entry) => entry.id),
  [epsilonHistory.id],
  "Human 仍读得到移出者的历史消息",
);
pass("a04.removed-identity-denied", {
  chat: "not_found",
  instance: "not_found",
  messages: "not_found",
  send: "not_found",
  historyKept: true,
});

// ---------------------------------------------------------------- 6. 能力表覆盖标题写入（A03 的「定义在一处」）
assert.ok(
  (CHAT_ACTIONS as readonly string[]).includes("title_change"),
  "标题写入必须出现在能力表里，而不是散在调用点的 if",
);
assert.equal(CHAT_CAPABILITIES.title_change.agent, "never");
assert.equal(CHAT_CAPABILITIES.title_change.human, "member");
const ownerFacts = { ownerKind: "human" as const, ownerId: creatorId, projectCreatedBy: creatorId };
for (const action of CHAT_ACTIONS) {
  if (action === "message_send") continue;
  assert.equal(
    codeOf(() => assertChatCapability(action, agentActor, ownerFacts)),
    "forbidden",
    `${action} 的 Agent 档必须是 never`,
  );
}
assert.equal(
  codeOf(() => assertChatCapability("message_send", agentActor, ownerFacts)),
  "ok",
);
assert.equal(
  codeOf(() => assertChatCapability("title_change", human, ownerFacts)),
  "ok",
);
pass("capability.title-in-table", {
  actions: CHAT_ACTIONS.length,
  titleAgent: CHAT_CAPABILITIES.title_change.agent,
  titleHuman: CHAT_CAPABILITIES.title_change.human,
});

console.log(`PASS i7-chat-scope ${checks.length} checks`);
