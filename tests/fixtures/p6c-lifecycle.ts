// P6c 集成门禁：一个 Agent 从「四类责任在身」到「可移除」到「重新加入」的完整生命周期。
//
// 八条不变量各自有一段可读断言（失败信息写明哪一步、期望什么、实际什么）：
//   1 四类阻塞同时成立、互不吞并、固定顺序、按 ID 升序、不截断，且被拒请求零写入
//   2 逐项解除后逐项消失，每步只减少对应那一类
//   3 handoff_target 是真实责任：被列为待交接目标时被拒，撤掉交接后解除
//   4 移除成功后的事实（Group 退出、DM 归档、有效成员视图不含它）与重新加入后的事实
//   5 撤销 grant 与移除是两件事；真实 grant 只能读自己那次运行所在的 Chat
//   6 Public Channel 换 owner 只有本 Project 创建者那个 Human 能成为新 owner，DM 无入口
//   7 两个进程同时移除：只有一个产生移除副作用，且不留半移除状态
//   8 移除事务被 SIGKILL 打断后，新进程（重启）看到的阻塞事实与移除结果收敛到同一状态
//
// 边界：真实 SQLite 文件 + 真实生产函数。只有三处按 fixture 惯例直接写表，各自在代码里标注：
//   (a) 运行行与「机器侧已持有」的租约行（没有真实 Worker 进程可跑出这两行）；
//   (b) 公共频道的 Agent-owner 遗留行（产品入口不允许产生它，见第 6 条）；
//   (c) grant 的过期时刻（用真实 grant 证明「过期即拒」需要把时钟推到过期之后）。
// 模型边界不需要：本门禁不拉起 Agent 的推理，只用 PiSessionProcess 的空转 runner 换真实 grant。
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { and, eq } from "drizzle-orm";
import { createGroupChatInput } from "../../src/contracts/chat";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  projectMemberRemovalBlockedErrorSchema,
  projectMemberRemovalBlockersSchema,
} from "../../src/contracts/project-member-removal";
import { db, sqlite } from "../../src/db";
import {
  agentRun,
  chat,
  chatEffectiveMember,
  chatMember,
  diagnosticEvent,
  leaseAuthorization,
  leaseMutation,
  machineLease,
  projectMember,
  remoteToolGrant,
  task,
} from "../../src/db/schema";
import type { ProjectContext } from "../../src/domain/access";
import {
  addProjectMember,
  collectProjectMemberRemovalBlockers,
  createAgentProfile,
  ProjectMemberRemovalBlockedError,
  removeProjectMember,
} from "../../src/domain/agent";
import { abortAgentRun } from "../../src/domain/agent-run";
import {
  addGroupMember,
  chatGovernanceScope,
  createDirectChat,
  createGroupChat,
  ensureInstance,
  getChat,
  listMessages,
  sendMessage,
  setChatOwner,
} from "../../src/domain/chat";
import type { ChatActor } from "../../src/domain/chat-actor";
import { chatGovernanceFacts } from "../../src/domain/chat-capabilities";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { createProject } from "../../src/domain/project";
import { mutateTask } from "../../src/domain/task";
import { toDomainAppError } from "../../src/server/functions/domain-errors";
import { completeLeaseMutation, forceReclaimLease } from "../../src/server/lease";
import { openInitialMembership } from "../../src/server/membership";
import { PiSessionProcess } from "../../src/server/pi-host/process";
import {
  issueRemoteToolGrant,
  remoteAgentResponse,
  revokeRemoteToolGrant,
} from "../../src/server/remote-agent-gateway";
import * as runtime from "../../src/server/runtime";

const started = performance.now();
let assertions = 0;
let step = "启动";
const at = (name: string) => {
  step = name;
};
function fail(message: string): never {
  throw new Error(`失败于「${step}」：${message}`);
}
const check = (value: unknown, message: string) => {
  assertions++;
  if (!value) fail(message);
};
const equal = (actual: unknown, expected: unknown, message: string) => {
  assertions++;
  try {
    assert.deepEqual(actual, expected);
  } catch {
    fail(`${message}｜期望 ${JSON.stringify(expected)}｜实际 ${JSON.stringify(actual)}`);
  }
};
const pass = (id: string, detail: unknown = {}) =>
  console.log(`PASS ${id} :: ${JSON.stringify(detail)}`);

const databaseFile = process.env.DATABASE_URL ?? "";
if (!databaseFile || databaseFile === ":memory:")
  throw new Error("DATABASE_URL 必须由 bf-p6c-lifecycle.sh 指向一个真实 SQLite 文件");
const evidenceDirectory = dirname(databaseFile);
const request = () => newId(ID_PREFIXES.request);

/** 全表快照：被拒请求不许改任何一行（含诊断与迁移日志）。 */
function snapshot() {
  const tables = sqlite
    .prepare("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name")
    .all() as { name: string }[];
  return tables.map(({ name }) => {
    const rows = sqlite
      .prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`)
      .all()
      .map((row: unknown) => JSON.stringify(row))
      .sort();
    return { name, count: rows.length, rows };
  });
}
const tableSnapshot = (name: string) => snapshot().find((table) => table.name === name);

await runtime.startRuntime();
const runtimeCtx = await runtime.machineRuntimeContext();

// ─────────────────────────────────────────── 夹具（真实创建路径，除标注处外不写表）
const creator = "usr_p6c_int_creator";
const otherHuman = "usr_p6c_int_other_human";
for (const [id, name, email] of [
  [creator, "creator", "creator@p6c-int.test"],
  [otherHuman, "other", "other@p6c-int.test"],
] as const)
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, name, email);

const ctx: ProjectContext = { userId: creator, requestId: request() };
const machineCtx = { ...ctx, bootId: runtimeCtx.bootId, now: new Date() };
const project = createProject({ name: "P6c 集成" }, ctx);
const agentA = createAgentProfile({ name: "Leaving", persona: "", harness: "pi" }, ctx);
const agentB = createAgentProfile({ name: "Holder", persona: "", harness: "pi" }, ctx);
addProjectMember(project.id, agentA.id, ctx);
addProjectMember(project.id, agentB.id, ctx);
const human: ChatActor = { kind: "human", userId: creator, ctx };
const dm = createDirectChat(project.id, agentA.id, ctx).chat;
const group = createGroupChat(
  project.id,
  createGroupChatInput.parse({
    projectId: project.id,
    title: "P6c 组",
    initialOwner: { kind: "human", id: creator },
    members: [
      { kind: "human", id: creator },
      { kind: "agent", id: agentA.id },
      { kind: "agent", id: agentB.id },
    ],
  }),
  human,
);
const channelRow = db
  .select()
  .from(chat)
  .where(and(eq(chat.projectId, project.id), eq(chat.kind, "public_channel")))
  .get();
if (!channelRow) throw new Error("createProject 必须派生出一个 public_channel");
const channelId = channelRow.id;
const instanceAGroup = ensureInstance(group.id, agentA.id, ctx);
const instanceADm = ensureInstance(dm.id, agentA.id, ctx);
const instanceBGroup = ensureInstance(group.id, agentB.id, ctx);
const dmHistory = sendMessage(
  dm.id,
  { senderKind: "human", senderId: creator, body: "DM 历史消息" },
  ctx,
);
sendMessage(group.id, { senderKind: "human", senderId: creator, body: "群历史消息" }, ctx);
// 发历史消息会按生产的唤醒语义自动开出 run（DM 消息必然给分身排一次运行）。
// 这些 run 不是本门禁的被测对象，先按真实路径停掉，后面要用的运行行再逐条种。
for (const row of db.select().from(agentRun).all())
  if (row.status === "queued" || row.status === "running") abortAgentRun(row.id, ctx);
const activeRunsAfterHistory = (db.select().from(agentRun).all() as { status: string }[]).filter(
  (row) => row.status === "queued" || row.status === "running",
);
check(activeRunsAfterHistory.length === 0, "发历史消息产生的自动 run 必须已按真实路径停掉");

const removalError = (): ProjectMemberRemovalBlockedError => {
  try {
    removeProjectMember(project.id, agentA.id, ctx);
  } catch (error) {
    if (!(error instanceof ProjectMemberRemovalBlockedError))
      fail(`期望移除被 project_member_removal_blocked 拒绝，实际抛的是 ${String(error)}`);
    return error;
  }
  return fail("期望移除被拒绝，实际移除成功了");
};
const kinds = (blockers: { kind: string }[]) => blockers.map((blocker) => blocker.kind);
/** 断言里预期的升序 ID 列表：与契约的 compareIds 同一口径。 */
const ascend = (...ids: string[]) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const collect = () => collectProjectMemberRemovalBlockers(project.id, agentA.id);
const projectEvents = (event: string) =>
  db
    .select()
    .from(diagnosticEvent)
    .where(and(eq(diagnosticEvent.projectId, project.id), eq(diagnosticEvent.event, event)))
    .all().length;
type EffectiveMember = { chatId: string; memberKind: string; memberId: string };
const effective = (chatId: string) =>
  db
    .select()
    .from(chatEffectiveMember)
    .where(eq(chatEffectiveMember.chatId, chatId))
    .all() as unknown as EffectiveMember[];
const membership = (chatId: string) =>
  db
    .select()
    .from(chatMember)
    .where(
      and(
        eq(chatMember.chatId, chatId),
        eq(chatMember.memberKind, "agent"),
        eq(chatMember.memberId, agentA.id),
      ),
    )
    .get();
const isMember = () =>
  db
    .select()
    .from(projectMember)
    .where(
      and(eq(projectMember.projectId, project.id), eq(projectMember.agentProfileId, agentA.id)),
    )
    .get();
const taskRevision = (taskId: string) =>
  db.select().from(task).where(eq(task.id, taskId)).get()!.revision;
const messageIds = (chatId: string) => listMessages(chatId, ctx).map((row) => row.id);

function createTask(chatId: string, title: string) {
  const created = mutateTask("create", { projectId: project.id, title }, ctx).detail.task;
  return mutateTask(
    "assign",
    {
      taskId: created.id,
      expectedRevision: created.revision,
      targetChatId: chatId,
      startNow: false,
    },
    ctx,
  ).detail.task;
}
/** 运行行按 fixtures 惯例直接写：真实 run 由 pi-host 拉起，本门禁不跑推理。 */
function seedRun(instanceId: string, chatId: string, status: "running" | "queued" = "running") {
  const id = newId(ID_PREFIXES.run);
  db.insert(agentRun)
    .values({
      id,
      instanceId,
      chatId,
      projectId: project.id,
      requestId: request(),
      status,
      sessionId: instanceId,
      startedAt: status === "running" ? new Date() : null,
      settledAt: null,
    })
    .run();
  return id;
}
function makeMachine(name: string) {
  const created = createMachine({ name }, machineCtx);
  const key = { projectId: project.id, machineId: created.detail.machine.id };
  saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
  openInitialMembership(db, { ...key, now: machineCtx.now });
  return key;
}

const dmTaskA = createTask(dm.id, "DM 任务 A");
const dmTaskB = createTask(dm.id, "DM 任务 B");
const groupTask = createTask(group.id, "群任务");
const runAGroup = seedRun(instanceAGroup.id, group.id);
const runADm = seedRun(instanceADm.id, dm.id);
const runnerPath = resolve("tests/fixtures/p6a-continuation-runner.mjs");
/** 拉起过的空转 runner 与子进程：任何失败路径都必须关掉，否则它们会拖住事件循环。 */
const processes: PiSessionProcess[] = [];
const children: ChildProcess[] = [];
const killChildren = () => {
  for (const child of children) child.kill("SIGKILL");
};
const spawnWorker = () => {
  const child = fork(new URL("./p6c-lifecycle-worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  children.push(child);
  return child;
};

/** 机器侧已持有的租约（fixture 直写，见文件头边界 a）：没有真实 Worker 进程可跑出这一行。 */
function seedHeldLease(
  machine: { projectId: string; machineId: string },
  holderInstanceId: string,
) {
  db.insert(machineLease)
    .values({ ...machine, generation: 1, state: "held", holderInstanceId, changedAt: new Date() })
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...machine,
      generation: 1,
      state: "active",
      holderInstanceId,
      reason: "acquire",
      issuedAt: new Date(),
    })
    .run();
}
/**
 * 待交接的 fencing 租约（fixture 直写，见文件头边界 a）：生产中它出现在交接目标排空执行期间
 * （`handoffLease` 在没有待排空执行时会当场完成，落成 holder 责任）。本门禁没有真实执行可排空，
 * 所以要直接种出这个真实存在的中间状态。
 */
function seedFencingHandoff(
  machine: { projectId: string; machineId: string },
  holderInstanceId: string,
  targetInstanceId: string,
) {
  db.insert(machineLease)
    .values({
      ...machine,
      generation: 1,
      state: "fencing",
      holderInstanceId,
      changedAt: new Date(),
    })
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...machine,
      generation: 1,
      state: "draining",
      holderInstanceId,
      reason: "handoff",
      issuedAt: new Date(),
    })
    .run();
  const id = newId(ID_PREFIXES.leaseMutation);
  db.insert(leaseMutation)
    .values({
      id,
      ...machine,
      actorKind: "agent",
      actorId: holderInstanceId,
      requestId: request(),
      payloadHash: "b".repeat(64),
      action: "handoff",
      targetInstanceId,
      expectedGeneration: 1,
      state: "pending",
      createdAt: new Date(),
    })
    .run();
  return id;
}
const machineHeld = makeMachine("P6c 已持有");
seedHeldLease(machineHeld, instanceAGroup.id);
// 第二台机器由 B 持有并正在交接给 A 的群实例 → A 是 pending handoff 的目标。
const machineHandoff = makeMachine("P6c 交接中");
const handoffId = seedFencingHandoff(machineHandoff, instanceBGroup.id, instanceAGroup.id);
const handoff = { mutationId: handoffId };
// owner 职责：群 owner 走真实路径，频道 owner 是没有产品入口的遗留行（见文件头边界 b）。
setChatOwner(
  group.id,
  { kind: "agent", id: agentA.id },
  getChat(group.id, ctx).governanceRevision,
  human,
);
db.update(chat).set({ ownerKind: "agent", ownerId: agentA.id }).where(eq(chat.id, channelId)).run();

try {
  // ─────────────────────────────────────────────────────────── 不变量 1
  at("不变量 1：四类阻塞同时成立");
  const beforeAll = snapshot();
  const combined = removalError();
  equal(snapshot(), beforeAll, "被拒的移除请求必须零写入（含诊断、租约与成员表）");
  equal(
    kinds(combined.details.blockers),
    ["active_runs", "leases", "owner_duties", "dm_assigned_tasks"],
    "四类阻塞必须一次全部返回，且顺序固定为 active_runs→leases→owner_duties→dm_assigned_tasks",
  );
  const [runFacts, leaseFacts, ownerFacts, taskFacts] = combined.details.blockers;
  if (runFacts.kind !== "active_runs" || leaseFacts.kind !== "leases")
    fail("前两组必须是 active_runs 与 leases");
  if (ownerFacts.kind !== "owner_duties" || taskFacts.kind !== "dm_assigned_tasks")
    fail("后两组必须是 owner_duties 与 dm_assigned_tasks");
  equal(
    runFacts.items.map((item) => item.runId),
    ascend(runAGroup, runADm),
    "active_runs 必须包含 A 的全部活跃 run，并按 runId 升序",
  );
  equal(
    leaseFacts.items.map((item) => item.key.machineId),
    ascend(machineHeld.machineId, machineHandoff.machineId),
    "leases 必须包含 A 持有的租约（holder）与指向它的待交接目标（handoff_target），按 machineId 升序",
  );
  const heldFirst =
    ascend(machineHeld.machineId, machineHandoff.machineId)[0] === machineHeld.machineId;
  equal(
    leaseFacts.items.map((item) => item.relation),
    heldFirst ? ["holder", "handoff_target"] : ["handoff_target", "holder"],
    "同一个 Agent 的两种租约责任都要出现：holder 与 handoff_target，不能互相吞并",
  );
  equal(
    leaseFacts.items.map((item) => item.pendingMutationId),
    heldFirst ? [null, handoff.mutationId] : [handoff.mutationId, null],
    "只有 fencing 的待交接项带 pendingMutationId，已持有项必须是 null",
  );
  equal(
    ownerFacts.items.map((item) => item.chat.chatId),
    ascend(group.id, channelId),
    "owner_duties 必须同时包含 Group owner 与 Public Channel owner，按 chatId 升序",
  );
  equal(
    ownerFacts.items.map((item) => item.chat.chatKind),
    ascend(group.id, channelId)[0] === group.id
      ? ["group", "public_channel"]
      : ["public_channel", "group"],
    "owner_duties 的 chatKind 必须如实反映 Group / Public Channel",
  );
  equal(
    taskFacts.items.map((item) => item.taskId),
    ascend(dmTaskA.id, dmTaskB.id),
    "dm_assigned_tasks 必须包含 DM 里全部 assigned Task，按 taskId 升序",
  );
  equal(
    taskFacts.items.map((item) => item.chat.chatId),
    [dm.id, dm.id],
    "dm_assigned_tasks 的每一项都必须指向那个 DM",
  );
  equal(
    [
      runFacts.items.length,
      leaseFacts.items.length,
      ownerFacts.items.length,
      taskFacts.items.length,
    ],
    [2, 2, 2, 2],
    "每类都必须完整返回 2 项（不截断）",
  );
  equal(
    projectMemberRemovalBlockersSchema.safeParse({
      ...combined.details,
      blockers: [...combined.details.blockers].reverse(),
    }).success,
    false,
    "契约层面必须拒绝逆序的阻塞分组，顺序不是展示习惯而是契约",
  );
  const mapped = await toDomainAppError(combined, ctx.requestId);
  check(
    mapped?.code === "project_member_removal_blocked",
    `服务端边界必须把领域错误映射成 project_member_removal_blocked｜实际 ${JSON.stringify(mapped)}`,
  );
  if (mapped?.code !== "project_member_removal_blocked") fail("映射失败");
  equal(
    projectMemberRemovalBlockedErrorSchema.parse(mapped).details,
    combined.details,
    "映射后的 details 必须与领域错误逐字段一致（页面据此分组渲染）",
  );
  pass("invariant.1.four-blockers-together", {
    kinds: kinds(combined.details.blockers),
    counts: combined.details.blockers.map((blocker) => blocker.items.length),
  });

  // ─────────────────────────────────────────────────────────── 不变量 2
  at("不变量 2：逐项解除后逐项消失");
  abortAgentRun(runAGroup, ctx);
  abortAgentRun(runADm, ctx);
  const afterRuns = collect();
  equal(
    kinds(afterRuns),
    ["leases", "owner_duties", "dm_assigned_tasks"],
    "停掉全部活跃 run 之后必须只剩三类",
  );
  equal(afterRuns[0], leaseFacts, "停 run 不许连带改变 leases 的内容");
  equal(afterRuns[1], ownerFacts, "停 run 不许连带改变 owner_duties 的内容");
  equal(afterRuns[2], taskFacts, "停 run 不许连带改变 dm_assigned_tasks 的内容");
  pass("invariant.2.runs-cleared", { kinds: kinds(afterRuns) });

  completeLeaseMutation(machineHandoff, new Date(), false);
  const afterHandoff = collect();
  equal(
    kinds(afterHandoff),
    ["leases", "owner_duties", "dm_assigned_tasks"],
    "交接完成不是解除责任：租约换到 A 名下后仍然阻塞",
  );
  const transferred = afterHandoff[0];
  if (transferred.kind !== "leases") fail("期望 leases 仍在");
  equal(
    transferred.items.map((item) => item.relation),
    ["holder", "holder"],
    "交接完成后两台机器都是 A 持有的 holder 责任，handoff_target 不得凭空消失",
  );
  equal(transferred.items.length, 2, "交接完成后租约项数不变（责任转移，不是清空）");
  // 机器侧释放这两台机器（没有真实 Worker 去跑 release，按文件头边界 a 直写）。
  for (const key of [machineHeld, machineHandoff])
    db.update(machineLease)
      .set({ state: "free", holderInstanceId: null, changedAt: new Date() })
      .where(
        and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId)),
      )
      .run();
  const afterLeases = collect();
  equal(kinds(afterLeases), ["owner_duties", "dm_assigned_tasks"], "租约全部结束后必须只剩两类");
  equal(afterLeases[0], ownerFacts, "结束租约不许连带改变 owner_duties 的内容");
  equal(afterLeases[1], taskFacts, "结束租约不许连带改变 dm_assigned_tasks 的内容");
  pass("invariant.2.leases-cleared", { kinds: kinds(afterLeases) });

  setChatOwner(
    group.id,
    { kind: "human", id: creator },
    getChat(group.id, ctx).governanceRevision,
    human,
  );
  db.update(chat).set({ ownerKind: "human", ownerId: creator }).where(eq(chat.id, channelId)).run();
  const afterOwners = collect();
  equal(
    kinds(afterOwners),
    ["dm_assigned_tasks"],
    "owner 全部换掉之后必须只剩 dm_assigned_tasks 一类",
  );
  equal(afterOwners[0], taskFacts, "换 owner 不许连带改变 dm_assigned_tasks 的内容");
  pass("invariant.2.owners-cleared", { kinds: kinds(afterOwners) });

  mutateTask("cancel", { taskId: dmTaskA.id, expectedRevision: taskRevision(dmTaskA.id) }, ctx);
  const afterOneTask = collect();
  equal(kinds(afterOneTask), ["dm_assigned_tasks"], "取消一个 DM Task 之后仍然阻塞（另一个还在）");
  const remaining = afterOneTask[0];
  if (remaining.kind !== "dm_assigned_tasks") fail("期望 dm_assigned_tasks 仍在");
  equal(
    remaining.items.map((item) => item.taskId),
    [dmTaskB.id],
    "取消后只剩未取消的那一个 Task，不许整类清空",
  );
  mutateTask(
    "complete",
    {
      taskId: dmTaskB.id,
      expectedRevision: taskRevision(dmTaskB.id),
      appendRecord: { body: "Done" },
    },
    ctx,
  );
  equal(collect(), [], "取消与完成 DM 里全部 assigned Task 之后必须可移除");
  at("不变量 2：最后一步真的可以移除");
  removeProjectMember(project.id, agentA.id, ctx);
  pass("invariant.2.all-cleared", { kinds: [] });

  // ─────────────────────────────────────────────────────────── 不变量 4
  at("不变量 4：移除成功后的事实");
  equal(isMember(), undefined, "移除后 project_member 行必须不存在");
  equal(membership(group.id), undefined, "移除后该 Agent 必须退出普通 Group 的成员表");
  equal(
    effective(group.id).filter((row) => row.memberId === agentA.id),
    [],
    "移除后 chat_effective_member 不再把该 Agent 算作 Group 成员",
  );
  equal(
    effective(channelId).filter((row) => row.memberId === agentA.id),
    [],
    "移除后 chat_effective_member 不再把该 Agent 算作 Public Channel 成员",
  );
  const archivedDm = db.select().from(chat).where(eq(chat.id, dm.id)).get()!;
  check(
    archivedDm.archivedAt !== null,
    `移除后 DM 必须归档｜实际 archivedAt=${String(archivedDm.archivedAt)}`,
  );
  check(
    membership(dm.id) !== undefined,
    "DM 的成员行按 d14 保留（归档不是删行）；参与权由 project_member 判定，见下一条",
  );
  equal(
    db
      .select()
      .from(projectMember)
      .where(
        and(eq(projectMember.projectId, project.id), eq(projectMember.agentProfileId, agentA.id)),
      )
      .all(),
    [],
    "DM 发言守卫（d19：DM 里的 Agent 发送者必须仍是 Project 成员）的输入必须已不存在",
  );
  const dmMessagesAfterRemoval = messageIds(dm.id);
  const groupMessagesAfterRemoval = messageIds(group.id);
  check(dmMessagesAfterRemoval.includes(dmHistory.id), "移除后 DM 的历史消息必须仍然可读");
  check(groupMessagesAfterRemoval.length > 0, "移除后 Group 的历史消息必须仍然可读");
  pass("invariant.4.removal-facts", {
    dmArchived: true,
    groupMembership: false,
    channelMembership: false,
  });

  at("不变量 4：重新加入后的事实");
  addProjectMember(project.id, agentA.id, ctx);
  equal(isMember() !== undefined, true, "重新加入后 project_member 行必须回来");
  equal(
    db.select().from(chat).where(eq(chat.id, dm.id)).get()!.archivedAt,
    null,
    "重新加入后既有 DM 必须取消归档",
  );
  equal(
    membership(group.id),
    undefined,
    "重新加入只恢复 Public Channel 与 DM：普通 Group 成员身份不自动恢复（设计 §2 冻结语义）",
  );
  check(
    effective(channelId).some((row) => row.memberId === agentA.id),
    "重新加入后该 Agent 必须重新成为 Public Channel 的有效成员",
  );
  equal(messageIds(dm.id), dmMessagesAfterRemoval, "重新加入不许复制或丢失 DM 历史消息");
  equal(messageIds(group.id), groupMessagesAfterRemoval, "重新加入不许复制或丢失 Group 历史消息");
  pass("invariant.4.rejoin-facts", { dmRestored: true, groupRestored: false, history: "intact" });

  // ─────────────────────────────────────────────────────────── 不变量 5
  at("不变量 5：grant 的范围与撤销");
  const runAGrant = seedRun(instanceADm.id, dm.id);
  const processA = new PiSessionProcess(runAGrant, runnerPath);
  processes.push(processA);
  const grantA = issueRemoteToolGrant(runAGrant, processA, { ...runtimeCtx, requestId: request() });
  const grantARow = db
    .select()
    .from(remoteToolGrant)
    .where(eq(remoteToolGrant.runId, runAGrant))
    .get();
  if (!grantARow) throw new Error("真实 grant 行必须已写入");
  type RemoteBody = {
    ok?: boolean;
    data?: { task?: { id: string }; chatId?: string; messages?: { id: string; chatId: string }[] };
    error?: { code?: string };
  };
  const call = async (
    raw: unknown,
    secret = grantA.secret,
  ): Promise<{ status: number; body: RemoteBody }> => {
    const response = await remoteAgentResponse(
      new Request(grantA.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
          "x-sprout-request-id": request(),
        },
        body: JSON.stringify(raw),
      }),
    );
    return { status: response.status, body: (await response.json()) as RemoteBody };
  };
  const taskCall = (taskId: string) => ({
    version: 2,
    call: { type: "task_get", input: { projectId: project.id, taskId } },
  });
  const ownChatRead = await call(taskCall(dmTaskB.id));
  equal(ownChatRead.status, 200, "真实 grant 读自己那次运行所在 DM 的 Task 必须成功");
  equal(ownChatRead.body.data?.task?.id, dmTaskB.id, "读到的必须就是那个 DM Task");
  const crossChatRead = await call(taskCall(groupTask.id));
  equal(
    crossChatRead.body.error?.code,
    "not_found",
    "真实 grant 不能读本人 Chat 之外的对象（同 Project 的群 Task 也必须 not_found）",
  );
  const ownChat = await call({
    version: 2,
    call: { type: "chat_get", input: { projectId: project.id } },
  });
  const ownChatData = ownChat.body.data;
  equal(ownChatData?.chatId, dm.id, "chat_get 只能返回本次运行所在的对话");
  check(
    (ownChatData?.messages ?? []).every((row) => row.chatId === dm.id),
    `chat_get 返回的每条消息都必须属于本次运行的对话｜实际 ${JSON.stringify(ownChatData?.messages?.map((row) => row.chatId))}`,
  );
  equal(
    (ownChatData?.messages ?? []).filter((row) => groupMessagesAfterRemoval.includes(row.id)),
    [],
    "chat_get 不得泄漏群里的消息",
  );
  // 过期：把这条真实 grant 的有效期推到过去（文件头边界 c），证明「过期即拒」。
  // 约束要求 expires_at > issued_at，所以两个时刻一起前移：这条 grant 现在「已过期一小时」。
  db.update(remoteToolGrant)
    .set({
      issuedAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    })
    .where(eq(remoteToolGrant.id, grantARow.id))
    .run();
  const expired = await call(taskCall(dmTaskB.id));
  equal(expired.status, 401, "过期 grant 必须以 401 被拒");
  equal(
    expired.body.error?.code,
    "remote_grant_invalid",
    "过期 grant 的错误码必须是 remote_grant_invalid",
  );
  db.update(remoteToolGrant)
    .set({ issuedAt: grantARow.issuedAt, expiresAt: grantARow.expiresAt })
    .where(eq(remoteToolGrant.id, grantARow.id))
    .run();
  equal(
    (await call(taskCall(dmTaskB.id))).status,
    200,
    "恢复有效期后同一条 grant 必须重新可用（证明刚才被拒的原因是过期）",
  );
  const blockersBeforeRevoke = collect();
  revokeRemoteToolGrant(runAGrant, { ...runtimeCtx, requestId: request() });
  const revoked = await call(taskCall(dmTaskB.id));
  equal(revoked.status, 401, "撤销后的 grant 必须以 401 被拒");
  equal(
    revoked.body.error?.code,
    "remote_grant_invalid",
    "撤销后的 grant 错误码必须是 remote_grant_invalid",
  );
  check(isMember() !== undefined, "撤销 grant 不得删除成员关系（撤销与移除是两件事）");
  equal(collect(), blockersBeforeRevoke, "撤销 grant 不得解除阻塞（A 的 run 仍然活跃）");
  equal(kinds(collect()), ["active_runs"], "撤销 grant 之后仍然只有 active_runs 一条阻塞");
  equal(
    db.select().from(chat).where(eq(chat.id, dm.id)).get()!.archivedAt,
    null,
    "撤销 grant 不得归档 DM",
  );
  pass("invariant.5.grant-scope-and-revocation", {
    ownChat: "ok",
    crossChat: "not_found",
    expired: 401,
    revoked: 401,
    blockers: kinds(collect()),
  });
  abortAgentRun(runAGrant, ctx);
  await processA.close();
  processes.pop();

  // ─────────────────────────────────────────────────────────── 不变量 3
  at("不变量 3：handoff_target 是真实责任");
  equal(collect(), [], "第 3 条起点：该 Agent 此时没有任何阻塞");
  const machineTarget = makeMachine("P6c 待交接目标");
  const pendingHandoff = {
    mutationId: seedFencingHandoff(machineTarget, instanceBGroup.id, instanceAGroup.id),
  };
  const beforeHandoff = snapshot();
  const handoffError = removalError();
  equal(
    kinds(handoffError.details.blockers),
    ["leases"],
    "只有待交接目标这一条责任时，报的必须是 leases 类",
  );
  const handoffBlock = handoffError.details.blockers[0];
  if (handoffBlock.kind !== "leases") fail("期望 leases");
  equal(handoffBlock.items.length, 1, "待交接目标必须单独列出一项");
  equal(
    handoffBlock.items[0].relation,
    "handoff_target",
    "被列为 pending handoff 目标时报的必须是 relation=handoff_target",
  );
  equal(
    handoffBlock.items[0].pendingMutationId,
    pendingHandoff.mutationId,
    "阻塞项必须指向那条待完成的交接",
  );
  equal(handoffBlock.items[0].state, "fencing", "待交接的租约状态必须是 fencing");
  equal(handoffBlock.items[0].holderInstanceId, instanceBGroup.id, "阻塞项要如实报告当前持有者");
  equal(snapshot(), beforeHandoff, "被拒的待交接目标移除必须零写入");
  forceReclaimLease(
    {
      ...machineTarget,
      action: "force_reclaim",
      mutationId: pendingHandoff.mutationId,
      expectedGeneration: 1,
      confirm: true,
    },
    { ...machineCtx, now: new Date(), requestId: request() },
  );
  equal(collect(), [], "把交接撤掉（Human 强制收回）之后必须解除");
  const settledLease = db
    .select()
    .from(machineLease)
    .where(
      and(
        eq(machineLease.projectId, project.id),
        eq(machineLease.machineId, machineTarget.machineId),
      ),
    )
    .get()!;
  equal(settledLease.state, "free", "强制收回后租约必须回到 free");
  equal(
    db.select().from(leaseMutation).where(eq(leaseMutation.id, pendingHandoff.mutationId)).get()!
      .state,
    "completed",
    "被撤掉的交接必须作为已完成动作留档，不能凭空消失",
  );
  pass("invariant.3.handoff-target", { relation: "handoff_target", clearedBy: "force_reclaim" });

  // ─────────────────────────────────────────────────────────── 不变量 6
  at("不变量 6：Public Channel 换 owner");
  const channel = getChat(channelId, ctx);
  equal(channel.owner, { kind: "human", id: creator }, "频道 owner 必须已经回到 Project 创建者");
  check(
    chatGovernanceFacts(chatGovernanceScope(channel), human).canChangeOwner === true,
    "Project 创建者必须看到频道换 owner 的入口（canChangeOwner=true）",
  );
  const agentActor: ChatActor = {
    kind: "agent",
    agentProfileId: agentA.id,
    instanceId: instanceAGroup.id,
    runId: runAGroup,
    ctx,
  };
  check(
    chatGovernanceFacts(chatGovernanceScope(channel), agentActor).canChangeOwner === false,
    "Agent 不得看到频道换 owner 的入口（canChangeOwner=false）",
  );
  const beforeAgentOwner = snapshot();
  let agentOwnerError: unknown;
  try {
    setChatOwner(
      channelId,
      { kind: "agent", id: agentA.id },
      getChat(channelId, ctx).governanceRevision,
      human,
    );
  } catch (error) {
    agentOwnerError = error;
  }
  check(
    agentOwnerError !== undefined,
    "把 Public Channel 的 owner 换成 Agent 必须被拒（实际产品契约是 forbidden，而 brief 举例的 task_assignment_invalid 并未出现）",
  );
  equal(
    {
      code: (agentOwnerError as { code?: string }).code,
      message: (agentOwnerError as Error).message,
    },
    { code: "forbidden", message: "Public Channel 的新所有者必须是本 Project 的 Human" },
    "换成 Agent 的拒绝必须是既有治理错误 forbidden，文案说明新所有者必须是 Human",
  );
  equal(snapshot(), beforeAgentOwner, "被拒的换 owner 请求必须零写入");
  let otherHumanError: unknown;
  try {
    setChatOwner(
      channelId,
      { kind: "human", id: otherHuman },
      getChat(channelId, ctx).governanceRevision,
      human,
    );
  } catch (error) {
    otherHumanError = error;
  }
  equal(
    (otherHumanError as { code?: string } | undefined)?.code,
    "forbidden",
    "换成非创建者 Human 必须被拒（只有本 Project 创建者那个 Human 能成为新 owner）",
  );
  equal(snapshot(), beforeAgentOwner, "被拒的非创建者换 owner 也必须零写入");
  const revisionBeforeCreator = getChat(channelId, ctx).governanceRevision;
  setChatOwner(channelId, { kind: "human", id: creator }, revisionBeforeCreator, human);
  equal(
    getChat(channelId, ctx).owner,
    { kind: "human", id: creator },
    "创建者作为新 owner 必须成功",
  );
  equal(
    getChat(channelId, ctx).governanceRevision,
    revisionBeforeCreator + 1,
    "成功的换 owner 必须推进一版治理版本",
  );
  const dmChat = getChat(dm.id, ctx);
  check(
    chatGovernanceFacts(chatGovernanceScope(dmChat), human).canChangeOwner === false,
    "DM 没有换 owner 入口：Human 创建者的 canChangeOwner 必须恒为 false",
  );
  let dmOwnerError: unknown;
  try {
    setChatOwner(dm.id, { kind: "human", id: creator }, dmChat.governanceRevision, human);
  } catch (error) {
    dmOwnerError = error;
  }
  equal(
    (dmOwnerError as { code?: string } | undefined)?.code,
    "forbidden",
    "DM 的换 owner 命令必须被拒",
  );
  // 对比：普通 Group 允许 Agent 当 owner（频道才是特例）。
  // 重新加入不恢复 Group 成员身份，所以先把 A 加回群里（真实路径），再换 owner。
  addGroupMember(
    group.id,
    { kind: "agent", id: agentA.id },
    getChat(group.id, ctx).governanceRevision,
    human,
  );
  setChatOwner(
    group.id,
    { kind: "agent", id: agentA.id },
    getChat(group.id, ctx).governanceRevision,
    human,
  );
  equal(
    getChat(group.id, ctx).owner,
    { kind: "agent", id: agentA.id },
    "普通 Group 允许把 owner 换成 Agent",
  );
  setChatOwner(
    group.id,
    { kind: "human", id: creator },
    getChat(group.id, ctx).governanceRevision,
    human,
  );
  pass("invariant.6.channel-owner", {
    agentOwner: "forbidden",
    otherHuman: "forbidden",
    creator: "ok",
    dmCanChangeOwner: false,
  });

  // ─────────────────────────────────────────────────────────── 不变量 8
  at("不变量 8：事务被中断后重启一致");
  const marker = resolve(evidenceDirectory, "p6c-interrupt.marker");
  rmSync(marker, { force: true });
  equal(collect(), [], "中断实验的起点必须可移除（否则事务到不了写阶段）");
  const eventsBeforeCrash = projectEvents("project_member.removed");
  const crashWorker = spawnWorker();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((done) =>
    crashWorker.once("exit", (code, signal) => done({ code, signal })),
  );
  crashWorker.send({
    mode: "interrupt",
    projectId: project.id,
    agentProfileId: agentA.id,
    userId: creator,
    marker,
  });
  const deadline = Date.now() + 30_000;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) {
      crashWorker.kill("SIGKILL");
      fail("中断进程 30 秒内没有走到事务写阶段（未出现 marker）");
    }
    await new Promise((done) => setTimeout(done, 50));
  }
  crashWorker.kill("SIGKILL");
  const crashExit = await exited;
  equal(crashExit.signal, "SIGKILL", "中断必须由 SIGKILL 造成（模拟进程在事务中死掉）");
  equal(isMember() !== undefined, true, "被中断的移除不得删掉成员行（未提交事务必须回滚）");
  equal(
    db.select().from(chat).where(eq(chat.id, dm.id)).get()!.archivedAt,
    null,
    "被中断的移除不得归档 DM",
  );
  check(membership(group.id) !== undefined, "被中断的移除不得删掉 Group 成员行");
  equal(
    projectEvents("project_member.removed"),
    eventsBeforeCrash,
    "被中断的移除不得留下移除诊断（孤儿行）",
  );
  equal(collect(), [], "重启前阻塞事实必须与中断前一致");
  const restartWorker = spawnWorker();
  type RestartReport = {
    ok: boolean;
    error: string | null;
    before: {
      memberPresent: boolean;
      dmArchived: boolean;
      groupMemberPresent: boolean;
      blockerKinds: string[];
      removedEvents: number;
    };
    after: {
      memberPresent: boolean;
      dmArchived: boolean;
      groupMemberPresent: boolean;
      effectiveGroupAndChannel: number;
      removedEvents: number;
      activeRuns: number;
    };
  };
  const restartReport = await new Promise<RestartReport>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("重启进程 30 秒内没有汇报")), 30_000);
    restartWorker.once("message", (message: unknown) => {
      clearTimeout(timer);
      done(message as RestartReport);
    });
    restartWorker.once("error", reject);
    restartWorker.send({
      mode: "restart",
      projectId: project.id,
      agentProfileId: agentA.id,
      userId: creator,
      dmChatId: dm.id,
      groupChatId: group.id,
    });
  });
  restartWorker.kill("SIGKILL");
  await new Promise((done) => setTimeout(done, 10));
  equal(
    restartReport.before,
    {
      memberPresent: true,
      dmArchived: false,
      groupMemberPresent: true,
      blockerKinds: [],
      removedEvents: eventsBeforeCrash,
    },
    "重启后的新进程必须看到与中断前完全一致的事实（成员在、DM 未归档、群成员在、无阻塞、无多余诊断）",
  );
  equal(restartReport.ok, true, `重启后的重试移除必须成功｜实际 ${String(restartReport.error)}`);
  equal(
    restartReport.after,
    {
      memberPresent: false,
      dmArchived: true,
      groupMemberPresent: false,
      effectiveGroupAndChannel: 0,
      removedEvents: eventsBeforeCrash + 1,
      activeRuns: 0,
    },
    "重启后的移除结果必须收敛：成员消失、DM 归档、群成员消失、频道有效成员 0、恰好一条移除诊断",
  );
  equal(isMember(), undefined, "重启后的移除必须真的删掉成员行");
  pass("invariant.8.restart-convergence", restartReport.after);

  // ─────────────────────────────────────────────────────────── 不变量 7
  at("不变量 7：两进程并发移除");
  addProjectMember(project.id, agentA.id, ctx);
  equal(isMember() !== undefined, true, "并发实验前必须重新加入该 Agent");
  const concurrencyRun = seedRun(instanceADm.id, dm.id);
  const race = async (expectRemoval: boolean) => {
    const racers = [spawnWorker(), spawnWorker()];
    const reports = await Promise.all(
      racers.map(
        (child) =>
          new Promise<{ ok: boolean; code?: string | null; name?: string; message?: string }>(
            (done, reject) => {
              const timer = setTimeout(() => reject(new Error("并发移除 30 秒内没有汇报")), 30_000);
              child.once("message", (message: unknown) => {
                clearTimeout(timer);
                done(
                  message as {
                    ok: boolean;
                    code?: string | null;
                    name?: string;
                    message?: string;
                  },
                );
              });
              child.once("error", reject);
              child.send({
                mode: "remove",
                projectId: project.id,
                agentProfileId: agentA.id,
                userId: creator,
              });
            },
          ),
      ),
    ).finally(killChildren);
    if (expectRemoval)
      check(
        reports.every((report) => report.ok),
        `两个请求都必须给出确定结论｜实际 ${JSON.stringify(reports)}`,
      );
    return reports;
  };
  const blockedReports = await race(false);
  check(
    blockedReports.every(
      (report) => !report.ok && report.code === "project_member_removal_blocked",
    ),
    `有活动 run 时两个并发请求都必须得到 project_member_removal_blocked｜实际 ${JSON.stringify(blockedReports)}`,
  );
  equal(isMember() !== undefined, true, "并发被拒之后成员行必须还在");
  pass("invariant.7.concurrent-blocked", { codes: blockedReports.map((report) => report.code) });

  abortAgentRun(concurrencyRun, ctx);
  equal(collect(), [], "并发移除前必须没有阻塞");
  const beforeRace = snapshot();
  const raceReports = await race(true);
  const removalEvents = projectEvents("project_member.removed") - 0;
  const afterRace = snapshot();
  equal(isMember(), undefined, "并发移除之后成员行必须消失");
  check(
    db.select().from(chat).where(eq(chat.id, dm.id)).get()!.archivedAt !== null,
    "并发移除之后 DM 必须归档（成员表与 DM 归档必须一致，不许半移除）",
  );
  equal(membership(group.id), undefined, "并发移除之后 Group 成员行必须消失");
  equal(
    tableSnapshot("machine_lease"),
    beforeRace.find((table) => table.name === "machine_lease"),
    "移除不得改动任何租约行（三处一致的另一半：租约保持原样）",
  );
  equal(
    tableSnapshot("lease_mutation"),
    beforeRace.find((table) => table.name === "lease_mutation"),
    "移除不得改动任何租约动作行",
  );
  equal(
    afterRace.find((table) => table.name === "diagnostic_event")!.count -
      beforeRace.find((table) => table.name === "diagnostic_event")!.count,
    1,
    "两个并发请求只能产生一次移除副作用（恰好一条 project_member.removed 诊断）",
  );
  check(removalEvents > 0, "移除诊断必须存在");
  const afterRemovalSnapshot = snapshot();
  removeProjectMember(project.id, agentA.id, ctx);
  equal(snapshot(), afterRemovalSnapshot, "第二次并发请求是幂等空转：再来一次移除不改变任何一行");
  pass("invariant.7.concurrent-single-effect", {
    reports: raceReports.map((report) => report.ok),
    removalEvents,
  });
} catch (error) {
  console.error(`FAIL p6c-lifecycle :: ${step} :: ${(error as Error).message}`);
  killChildren();
  await Promise.all(processes.map((handle) => handle.close().catch(() => {})));
  await runtime.shutdownRuntime("p6c-lifecycle-failure").catch(() => {});
  process.exitCode = 1;
}
if (!process.exitCode) {
  await runtime.shutdownRuntime("p6c-lifecycle-gate");
  const elapsedMs = Math.round(performance.now() - started);
  console.log(
    `p6c-lifecycle: ${assertions} assertions passed, ${elapsedMs}ms, database=${databaseFile}`,
  );
}
