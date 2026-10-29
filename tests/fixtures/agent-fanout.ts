// I-P5a 第三步执行链门禁：真实 SQLite + 真实领域入口 + 真实 host 轮询。
//
// 不 mock 领域层：扇出、唤醒路由、run 状态转换、发送资格都走 src/domain 的正式命令。
// host 只把 prepareRun 换成「记录被拾起的 run 并把它标成失败」的替身——门禁不启动 LLM 子进程，
// loadWork 仍是真实的 queuedRunWork()，所以「一个会话里的多个 run 是否都被拾起」是真轮询证据。
import assert from "node:assert/strict";
import { Effect, ManagedRuntime } from "effect";
import { eq } from "drizzle-orm";
import { PUBLIC_CHANNEL_DISPLAY_TITLE } from "../../src/contracts/chat";
import type { ProjectContext } from "../../src/domain/project";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { agentInstance, agentRun, chatMember } from "../../src/db/schema";
import { migrateDatabase } from "../../src/db/migrate";
import { addProjectMember, createAgentProfile, removeProjectMember } from "../../src/domain/agent";
import {
  interruptActiveAgentRuns,
  listAgentRunInputs,
  listAgentRuns,
  pendingRunInputs,
  queuedRunWork,
  transitionAgentRun,
} from "../../src/domain/agent-run";
import type { ChatActor } from "../../src/domain/chat-actor";
import {
  createDirectChat,
  createGroupChat,
  getChat,
  listMessages,
  sendMessage,
} from "../../src/domain/chat";
import { ensureProjectChannel, readChatEffectiveMembers } from "../../src/domain/channel";
import { createProject } from "../../src/domain/project";
import { makePiHostLayer, startPiHost, stopPiHost } from "../../src/server/pi-host/host";
import type { Work } from "../../src/server/pi-host/run";

migrateDatabase();

function pass(label: string, output: unknown = {}) {
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
function profileOfInstance(instanceId: string): string {
  const row = db.select().from(agentInstance).where(eq(agentInstance.id, instanceId)).get();
  if (!row) throw new Error(`instance ${instanceId} 不存在`);
  return row.agentProfileId;
}
function inputsOf(runId: string): string[] {
  return listAgentRunInputs(runId, ctx)
    .map((input) => input.messageId)
    .sort();
}
function scalar(sql: string, ...params: unknown[]): number {
  const row = sqlite.prepare(sql).get(...params) as { n: number };
  return row.n;
}
function runsOf(chatId: string) {
  return listAgentRuns(chatId, ctx).sort((left, right) => left.id.localeCompare(right.id));
}

// ---------------------------------------------------------------- 夹具（真实 SQLite 行）
const creatorId = "usr_fanout_creator";
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
  )
  .run(creatorId, "fanout", "{{EMAIL_35e2e1e1}}");

const ctx: ProjectContext = { userId: creatorId, requestId: newId(ID_PREFIXES.request) };
const human: ChatActor = { kind: "human", userId: creatorId, ctx };
const project = createProject({ name: "扇出门禁" }, ctx);
const agentA = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const agentB = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agentA.id, ctx);
addProjectMember(project.id, agentB.id, ctx);

const group = createGroupChat(
  project.id,
  {
    projectId: project.id,
    title: "扇出群",
    members: [
      { kind: "human", id: creatorId },
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentB.id },
    ],
    initialOwner: { kind: "agent", id: agentA.id },
    wakePolicy: "owner_led",
  },
  human,
);
assert.equal(group.owner.kind, "agent");

// ---------------------------------------------------------------- 1. 群里一条消息扇出到两个 instance
// 规则链里 owner_led 只补一个候选，两个 run 只能来自点名：这条消息同时点名 owner Alpha 与被点名的 Beta。
const firstMessage = sendMessage(
  group.id,
  { senderKind: "human", senderId: creatorId, body: "Alpha 和 Beta 一起看这条渠道回归" },
  ctx,
);
const groupRuns = runsOf(group.id);
assert.equal(groupRuns.length, 2, "一条人类消息在群里必须开出两条 run");
assert.deepEqual(
  groupRuns.map((run) => profileOfInstance(run.instanceId)).sort(),
  [agentA.id, agentB.id].sort(),
  "两条 run 必须各自挂在被唤醒 Agent 的 instance 上",
);
assert.notEqual(groupRuns[0].instanceId, groupRuns[1].instanceId);
assert.equal(
  scalar("SELECT count(*) AS n FROM agent_run_input WHERE message_id = ?", firstMessage.id),
  2,
  "同一条消息必须挂到两条 run 的输入上（主键含 run_id）",
);
for (const run of groupRuns)
  assert.deepEqual(inputsOf(run.id), [firstMessage.id], "每条 run 恰有一条输入");
pass("group.fanout-two-runs", {
  runs: groupRuns.length,
  profiles: groupRuns.map((run) => profileOfInstance(run.instanceId)),
});

// ---------------------------------------------------------------- 2. 同一 instance 的活跃 run 复用，不新建
const runOfA = groupRuns.find((run) => profileOfInstance(run.instanceId) === agentA.id);
const runOfB = groupRuns.find((run) => profileOfInstance(run.instanceId) === agentB.id);
assert.ok(runOfA && runOfB);
const secondMessage = sendMessage(
  group.id,
  { senderKind: "human", senderId: creatorId, body: "Alpha 再看一次现场" },
  ctx,
);
assert.equal(runsOf(group.id).length, 2, "已有活跃 run 时不得新建第二条 run");
assert.equal(runsOf(group.id).filter((run) => run.id === runOfA.id).length, 1);
assert.deepEqual(
  inputsOf(runOfA.id),
  [firstMessage.id, secondMessage.id].sort(),
  "新输入必须挂到同一条活跃 run",
);
pass("instance.serial-reuse", { runId: runOfA.id, inputs: inputsOf(runOfA.id).length });

// ---------------------------------------------------------------- 3. 两条 run 的输入互不可见
const thirdMessage = sendMessage(
  group.id,
  { senderKind: "human", senderId: creatorId, body: "Beta 对着回放看一遍" },
  ctx,
);
assert.deepEqual(inputsOf(runOfB.id), [firstMessage.id, thirdMessage.id].sort());
assert.equal(inputsOf(runOfA.id).includes(thirdMessage.id), false, "A 的 run 不能看到 B 的输入");
assert.equal(inputsOf(runOfB.id).includes(secondMessage.id), false, "B 的 run 不能看到 A 的输入");
assert.deepEqual(
  pendingRunInputs(runOfA.id, ctx)
    .map((input) => input.messageId)
    .sort(),
  inputsOf(runOfA.id),
  "待投递输入按 run_id 隔离，不看同 chat 的其它 run",
);
pass("run.input-isolation", { a: inputsOf(runOfA.id), b: inputsOf(runOfB.id) });

// ---------------------------------------------------------------- 4. 频道按频道 wake 语义唤醒（不广播）
const channelId = ensureProjectChannel(project.id);
assert.equal(getChat(channelId, ctx).kind, "public_channel");
assert.equal(getChat(channelId, ctx).title, undefined, "频道没有 title 字段，页面用固定文案");
assert.equal(PUBLIC_CHANNEL_DISPLAY_TITLE, "公共频道（Project 范围）");
const channelMessage = sendMessage(
  channelId,
  { senderKind: "human", senderId: creatorId, body: "Beta 看一下频道这条" },
  ctx,
);
const channelRuns = runsOf(channelId);
assert.equal(channelRuns.length, 1, "频道点名一个 Agent 只唤醒一个 run");
assert.equal(profileOfInstance(channelRuns[0].instanceId), agentB.id);
assert.deepEqual(inputsOf(channelRuns[0].id), [channelMessage.id]);
const silentMessage = sendMessage(
  channelId,
  { senderKind: "human", senderId: creatorId, body: "大家看一下，没有点名" },
  ctx,
);
assert.equal(runsOf(channelId).length, 1, "频道绝不按成员广播：无人被点名就不开 run");
assert.equal(
  scalar("SELECT count(*) AS n FROM agent_run_input WHERE message_id = ?", silentMessage.id),
  0,
);
pass("channel.named-only", {
  runs: channelRuns.length,
  displayTitle: PUBLIC_CHANNEL_DISPLAY_TITLE,
});

// ---------------------------------------------------------------- 5. DM 逐条不变：一条消息一条 run
const dm = createDirectChat(project.id, agentA.id, ctx);
const dmFirst = sendMessage(
  dm.chat.id,
  { senderKind: "human", senderId: creatorId, body: "DM 第一条" },
  ctx,
);
const dmRuns = runsOf(dm.chat.id);
assert.equal(dmRuns.length, 1, "DM 一条消息开一条 run");
assert.deepEqual(inputsOf(dmRuns[0].id), [dmFirst.id]);
const dmSecond = sendMessage(
  dm.chat.id,
  { senderKind: "human", senderId: creatorId, body: "DM 第二条" },
  ctx,
);
assert.equal(runsOf(dm.chat.id).length, 1, "DM 的活跃 run 复用同一条，不新建");
assert.deepEqual(inputsOf(dmRuns[0].id), [dmFirst.id, dmSecond.id].sort());
pass("dm.unchanged", { runs: runsOf(dm.chat.id).length, inputs: inputsOf(dmRuns[0].id).length });

// ---------------------------------------------------------------- 6. 跨 chat 的 assistant_message_id 被数据库拒绝
sqlite
  .prepare("UPDATE agent_run SET assistant_message_id = ? WHERE id = ?")
  .run(firstMessage.id, runOfA.id);
assert.throws(
  () =>
    sqlite
      .prepare("UPDATE agent_run SET assistant_message_id = ? WHERE id = ?")
      .run(dmFirst.id, runOfA.id),
  /FOREIGN KEY constraint failed/,
  "回复消息必须与 run 同属一个 chat（0024 复合外键）",
);
sqlite.prepare("UPDATE agent_run SET assistant_message_id = NULL WHERE id = ?").run(runOfA.id);
pass("fk.cross-chat-rejected", { runChat: group.id, messageChat: dm.chat.id });

// ---------------------------------------------------------------- 7. 一个会话里的多个活跃 run 都被 host 拾起
const queuedBefore = queuedRunWork()
  .map((work) => work.run.id)
  .sort();
assert.ok(queuedBefore.includes(runOfA.id) && queuedBefore.includes(runOfB.id));
const picked: string[] = [];
const hostFailures: string[] = [];
function contextOf(work: Work): ProjectContext {
  return {
    userId: work.ownerId,
    requestId: work.run.requestId,
    agent: {
      agentProfileId: work.agentProfileId,
      instanceId: work.run.instanceId,
      runId: work.run.id,
    },
  };
}
const runtime = ManagedRuntime.make(
  makePiHostLayer({
    loadWork: () => queuedRunWork().map((work) => ({ ...work, instanceId: work.run.instanceId })),
    prepareRun: (work) => ({
      runId: work.run.id,
      pid: undefined,
      abort: () => {},
      close: async () => {},
      body: Effect.sync(() => {
        picked.push(work.run.id);
        transitionAgentRun(
          work.run.id,
          "failed",
          { errorCode: "gate_pickup", errorMessage: "门禁只验证 host 拾起，不启动 LLM" },
          contextOf(work),
        );
      }),
    }),
    interruptActiveRuns: () => interruptActiveAgentRuns(),
    reportFailure: (failure) => {
      hostFailures.push(failure.event);
    },
  }),
);
try {
  await runtime.runPromise(
    Effect.gen(function* () {
      yield* startPiHost;
      const settled = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (queuedRunWork().length === 0) return true;
          yield* Effect.sleep("50 millis");
        }
        return false;
      });
      assert.equal(settled, true, "host 必须在 5 秒内拾起全部排队 run");
      yield* stopPiHost;
    }),
  );
} finally {
  await runtime.dispose();
}
assert.deepEqual(hostFailures, [], "host 调度不得报错");
assert.deepEqual(picked.slice().sort(), queuedBefore, "每条排队 run 恰被拾起一次");
assert.equal(new Set(picked).size, picked.length, "同一 run 不得被重复拾起");
assert.ok(picked.includes(runOfA.id) && picked.includes(runOfB.id), "同会话两条 run 都必须被拾起");
const settledRuns = db.select().from(agentRun).where(eq(agentRun.status, "failed")).all();
assert.equal(settledRuns.length, queuedBefore.length, "拾起的 run 都完成了状态转换");
pass("host.multi-run-pickup", { queued: queuedBefore.length, picked: picked.length });

// ---------------------------------------------------------------- 8. d19：DM 里的 Agent 发送者仍须是 Project 成员
const dmB = createDirectChat(project.id, agentB.id, ctx);
assert.equal(
  codeOf(() =>
    sendMessage(dmB.chat.id, { senderKind: "agent", senderId: agentB.id, body: "发言" }, ctx),
  ),
  "ok",
  "移除前 Agent 可以在自己的 DM 里发言",
);
removeProjectMember(project.id, agentB.id, ctx);
assert.equal(
  readChatEffectiveMembers(dmB.chat.id, project.id).some(
    (member) => member.memberKind === "agent" && member.memberId === agentB.id,
  ),
  true,
  "视图的 DM 分支不查 project_member，历史 DM 行仍在；d19 的判定必须自己补这一层",
);
assert.equal(
  db
    .select()
    .from(chatMember)
    .where(eq(chatMember.chatId, dmB.chat.id))
    .all()
    .some(
      (row: typeof chatMember.$inferSelect) =>
        row.memberKind === "agent" && row.memberId === agentB.id,
    ),
  true,
  "成员行保留（d14），参与权由判定收回",
);
assert.equal(
  db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.chatId, dmB.chat.id))
    .all()
    .some((row: typeof agentInstance.$inferSelect) => row.agentProfileId === agentB.id),
  true,
  "instance 行保留，历史消息与 run 还要引用它",
);
assert.equal(
  codeOf(() =>
    sendMessage(
      dmB.chat.id,
      { senderKind: "agent", senderId: agentB.id, body: "移除后还想发言" },
      ctx,
    ),
  ),
  "not_found",
  "Agent 移出 Project 后，旧 DM 里不再能发言",
);
assert.equal(
  listMessages(dmB.chat.id, ctx).filter((entry) => entry.senderKind === "agent").length,
  1,
  "被拒的发言不落消息行",
);
pass("d19.dm-agent-membership", { removed: agentB.id, code: "not_found" });
