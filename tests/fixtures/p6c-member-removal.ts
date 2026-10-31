import { createGroupChatInput } from "../../src/contracts/chat";
import { fork } from "node:child_process";
import { and, eq } from "drizzle-orm";
import {
  projectMemberRemovalBlockersSchema,
  projectMemberRemovalBlockedErrorSchema,
} from "../../src/contracts/project-member-removal";
import { toAppError } from "../../src/contracts/result";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db } from "../../src/db";
import {
  agentInstance,
  agentRun,
  chat,
  diagnosticEvent,
  leaseMutation,
  machineLease,
  task,
} from "../../src/db/schema";
import {
  addProjectMember,
  collectProjectMemberRemovalBlockers,
  removeProjectMember,
} from "../../src/domain/agent";
import {
  createDirectChat,
  createGroupChat,
  ensureInstance,
  getChat,
  setChatOwner,
} from "../../src/domain/chat";
import { chatGovernanceFacts } from "../../src/domain/chat-capabilities";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { createProject } from "../../src/domain/project";
import { mutateTask } from "../../src/domain/task";
import { completeLeaseMutation } from "../../src/server/lease";
import { toDomainAppError } from "../../src/server/functions/domain-errors";
import { seedRemoteActor } from "./remote-actors";
import { sqlite } from "../../src/db";
import {
  assert,
  assertionCount,
  setup,
  snapshot,
  seedRun,
  seedLease,
  seedTask,
  blocked,
} from "./p6c-member-fixture";

const f = setup();
const collect = () => collectProjectMemberRemovalBlockers(f.project.id, f.agent.id);
const remove = () => removeProjectMember(f.project.id, f.agent.id, f.ctx);
const pass = (name: string) => console.log(`PASS ${name}`);
function rejectsUnchanged(kind: string) {
  const before = snapshot();
  const error = blocked(remove);
  const mapped = toAppError(error, f.ctx.requestId);
  assert.equal(mapped.code, "project_member_removal_blocked");
  if (mapped.code !== "project_member_removal_blocked") throw new Error("Missing details");
  assert.deepEqual(
    mapped.details.blockers.map((group) => group.kind),
    [kind],
  );
  assert.deepEqual(snapshot(), before, "failure changes no persisted value in any table");
  return mapped;
}
assert.deepEqual(collect(), []);
const run1 = seedRun(f);
rejectsUnchanged("active_runs");
const channelInstance = ensureInstance(f.channel.id, f.agent.id, f.ctx);
const run2 = seedRun(f, "running", channelInstance.id, f.channel.id);
let active = collect()[0];
assert.equal(active.kind, "active_runs");
if (active.kind !== "active_runs") throw new Error("Expected runs");
assert.deepEqual(
  active.items.map((item) => item.runId),
  [run1, run2].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);
db.update(agentRun)
  .set({ status: "aborted", settledAt: new Date() })
  .where(eq(agentRun.id, run1))
  .run();
db.update(agentRun)
  .set({ status: "interrupted", settledAt: new Date() })
  .where(eq(agentRun.id, run2))
  .run();
assert.deepEqual(collect(), []);
pass("blockers.active-runs.all-and-stable");

const held = seedLease(f);
rejectsUnchanged("leases");
const fencing = seedLease(f, "fencing");
const leaseBlock = collect()[0];
assert.equal(leaseBlock.kind, "leases");
if (leaseBlock.kind !== "leases") throw new Error("Expected leases");
assert.deepEqual(
  leaseBlock.items.map((item) => item.key.machineId),
  [held.key.machineId, fencing.key.machineId].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);
assert.ok(leaseBlock.items.every((item) => item.relation === "holder"));
assert.equal(
  leaseBlock.items.find((item) => item.state === "fencing")?.pendingMutationId,
  fencing.pendingMutationId,
);
assert.match(blocked(remove).message, /等待确认或前往租约页处理/);
db.update(machineLease)
  .set({ state: "free", holderInstanceId: null })
  .where(eq(machineLease.machineId, held.key.machineId))
  .run();
completeLeaseMutation(fencing.key, new Date(), false);
assert.deepEqual(collect(), []);
pass("blockers.leases.held-and-fencing");

const human = { kind: "human" as const, userId: f.ctx.userId, ctx: f.ctx };
const unprovisionedGroup = createGroupChat(
  f.project.id,
  createGroupChatInput.parse({
    projectId: f.project.id,
    title: "Owner without instance",
    initialOwner: { kind: "agent", id: f.agent.id },
    members: [
      { kind: "human", id: f.ctx.userId },
      { kind: "agent", id: f.agent.id },
    ],
  }),
  human,
);
assert.equal(
  db.select().from(agentInstance).where(eq(agentInstance.chatId, unprovisionedGroup.id)).all()
    .length,
  0,
);
setChatOwner(
  f.group.id,
  { kind: "agent", id: f.agent.id },
  getChat(f.group.id, f.ctx).governanceRevision,
  human,
);
rejectsUnchanged("owner_duties");
// Legacy channel owner and archived group remain real responsibilities, including without active runs.
db.update(chat)
  .set({ ownerKind: "agent", ownerId: f.agent.id })
  .where(eq(chat.id, f.channel.id))
  .run();
db.update(chat).set({ archivedAt: new Date() }).where(eq(chat.id, f.group.id)).run();
const ownerBlock = collect()[0];
assert.equal(ownerBlock.kind, "owner_duties");
if (ownerBlock.kind !== "owner_duties") throw new Error("Expected owner duties");
assert.deepEqual(
  ownerBlock.items.map((item) => item.chat.chatId),
  [f.group.id, f.channel.id, unprovisionedGroup.id].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);
const facts = chatGovernanceFacts(
  {
    kind: "public_channel",
    ownerKind: "agent",
    ownerId: f.agent.id,
    projectCreatedBy: f.ctx.userId,
  },
  human,
);
assert.equal(facts.canChangeOwner, true);
assert.equal(facts.canChangeMembers, false);
const beforeForeign = snapshot();
assert.throws(
  () =>
    setChatOwner(
      f.channel.id,
      { kind: "human", id: "foreign-human" },
      getChat(f.channel.id, f.ctx).governanceRevision,
      human,
    ),
  { code: "forbidden" },
);
assert.deepEqual(snapshot(), beforeForeign);
setChatOwner(
  f.channel.id,
  { kind: "human", id: f.ctx.userId },
  getChat(f.channel.id, f.ctx).governanceRevision,
  human,
);
// Owner transfer on archived Group follows existing policy; unarchive to resolve explicitly.
db.update(chat).set({ archivedAt: null }).where(eq(chat.id, f.group.id)).run();
setChatOwner(
  f.group.id,
  { kind: "human", id: f.ctx.userId },
  getChat(f.group.id, f.ctx).governanceRevision,
  human,
);
setChatOwner(
  unprovisionedGroup.id,
  { kind: "human", id: f.ctx.userId },
  getChat(unprovisionedGroup.id, f.ctx).governanceRevision,
  human,
);
assert.deepEqual(collect(), []);
pass("blockers.owner-duties.channel-recoverable");

const task1 = seedTask(f);
rejectsUnchanged("dm_assigned_tasks");
const task2 = seedTask(f);
seedTask(f, "finished");
seedTask(f, "canceled");
seedTask(f, "proposed");
seedTask(f, "assigned", f.group.id);
const taskBlock = collect()[0];
assert.equal(taskBlock.kind, "dm_assigned_tasks");
if (taskBlock.kind !== "dm_assigned_tasks") throw new Error("Expected DM tasks");
assert.deepEqual(
  taskBlock.items.map((item) => item.taskId),
  [task1, task2].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
);
pass("blockers.dm-assigned-tasks.excludes-other-states-and-group");

// ── 跨 Project 对照组（设计 §2.1 最后一行、core-scope「移除不影响其他 Projects」）：
// 同一个 Agent profile 在 B 里同时拥有 run、held 租约、Group owner 职责、DM assigned Task。
// A 的阻塞与移除都不得碰到 B 的任何一行。
const projectB = createProject({ name: "P6c Other" }, f.ctx);
addProjectMember(projectB.id, f.agent.id, f.ctx);
const dmB = createDirectChat(projectB.id, f.agent.id, f.ctx);
const groupB = createGroupChat(
  projectB.id,
  createGroupChatInput.parse({
    projectId: projectB.id,
    title: "Other Project Group",
    initialOwner: { kind: "agent", id: f.agent.id },
    members: [
      { kind: "human", id: f.ctx.userId },
      { kind: "agent", id: f.agent.id },
    ],
  }),
  human,
);
const instanceB = ensureInstance(groupB.id, f.agent.id, f.ctx);
const runB = newId(ID_PREFIXES.run);
db.insert(agentRun)
  .values({
    id: runB,
    instanceId: instanceB.id,
    chatId: groupB.id,
    projectId: projectB.id,
    requestId: newId(ID_PREFIXES.request),
    status: "queued",
    sessionId: instanceB.id,
    startedAt: null,
    settledAt: null,
  })
  .run();
const machineB = createMachine({ name: "Other Project Machine" }, f.machineCtx);
const machineKeyB = { projectId: projectB.id, machineId: machineB.detail.machine.id };
saveProjectMachineBinding(
  { ...machineKeyB, description: "", expectedRevision: null },
  f.machineCtx,
);
db.insert(machineLease)
  .values({
    ...machineKeyB,
    generation: 1,
    state: "held",
    holderInstanceId: instanceB.id,
    changedAt: new Date(),
  })
  .run();
const taskB = mutateTask("create", { projectId: projectB.id, title: "Other Project Task" }, f.ctx)
  .detail.task;
mutateTask(
  "assign",
  {
    taskId: taskB.id,
    expectedRevision: taskB.revision,
    targetChatId: dmB.chat.id,
    startNow: false,
  },
  f.ctx,
);

const blockersB = collectProjectMemberRemovalBlockers(projectB.id, f.agent.id);
assert.deepEqual(
  blockersB.map((group) => group.kind),
  ["active_runs", "leases", "owner_duties", "dm_assigned_tasks"],
  "the control Project must own all four responsibility classes",
);
const serializedB = JSON.stringify(blockersB);
const crossProjectIds: [string, string][] = [
  ["run", runB],
  ["lease", machineKeyB.machineId],
  ["owner duty", groupB.id],
  ["DM task", taskB.id],
];
for (const [label, id] of crossProjectIds)
  assert.ok(
    serializedB.includes(id),
    `the control Project blocker set must contain its own ${label}`,
  );
for (const [label, id] of crossProjectIds)
  assert.ok(!JSON.stringify(collect()).includes(id), `A blockers must not mention B's ${label}`);
/** B 的四类责任行，逐字段（不接受只比 id）在 A 移除前后比对。 */
const crossProjectRows = () =>
  JSON.stringify(
    [
      {
        table: "agent_run",
        rows: db.select().from(agentRun).where(eq(agentRun.projectId, projectB.id)).all(),
      },
      {
        table: "machine_lease",
        rows: db.select().from(machineLease).where(eq(machineLease.projectId, projectB.id)).all(),
      },
      { table: "chat", rows: db.select().from(chat).where(eq(chat.projectId, projectB.id)).all() },
      { table: "task", rows: db.select().from(task).where(eq(task.projectId, projectB.id)).all() },
    ].map(({ table, rows }) => ({
      table,
      rows: rows.map((row: unknown) => JSON.stringify(row)).sort(),
    })),
  );
pass("blockers.cross-project.same-profile-control-group");

const busyRun = seedRun(f);
const busyLease = seedLease(f);
db.update(chat)
  .set({ ownerKind: "agent", ownerId: f.agent.id })
  .where(eq(chat.id, f.channel.id))
  .run();
const beforeCombined = snapshot();
const combinedError = blocked(remove);
const structured = await toDomainAppError(combinedError, f.ctx.requestId);
assert.ok(structured?.code === "project_member_removal_blocked");
if (structured?.code !== "project_member_removal_blocked")
  throw new Error("Structured mapping lost");
assert.deepEqual(
  structured.details.blockers.map((group) => group.kind),
  ["active_runs", "leases", "owner_duties", "dm_assigned_tasks"],
);
for (const [label, id] of crossProjectIds)
  assert.ok(
    !JSON.stringify(structured.details.blockers).includes(id),
    `combined A blockers must not mention B's ${label}`,
  );
assert.deepEqual(
  JSON.parse(JSON.stringify(structured)),
  projectMemberRemovalBlockedErrorSchema.parse(structured),
);
assert.equal(
  projectMemberRemovalBlockedErrorSchema.safeParse({ ...structured, details: undefined }).success,
  false,
);
assert.equal(
  toAppError({ code: "project_member_removal_blocked", message: "bad" }, f.ctx.requestId).code,
  "internal",
);
for (const group of structured.details.blockers)
  assert.equal(
    projectMemberRemovalBlockersSchema.safeParse({
      ...structured.details,
      blockers: [{ kind: group.kind, items: [] }],
    }).success,
    false,
  );
assert.equal(
  projectMemberRemovalBlockersSchema.safeParse({ ...structured.details, blockers: [] }).success,
  false,
);
assert.equal(
  projectMemberRemovalBlockersSchema.safeParse({
    ...structured.details,
    blockers: [...structured.details.blockers].reverse(),
  }).success,
  false,
);
assert.deepEqual(snapshot(), beforeCombined);
pass("blockers.combined.schema-and-zero-writes");
db.update(agentRun)
  .set({ status: "aborted", settledAt: new Date() })
  .where(eq(agentRun.id, busyRun))
  .run();
db.update(machineLease)
  .set({ state: "free", holderInstanceId: null })
  .where(eq(machineLease.machineId, busyLease.key.machineId))
  .run();
setChatOwner(
  f.channel.id,
  { kind: "human", id: f.ctx.userId },
  getChat(f.channel.id, f.ctx).governanceRevision,
  human,
);
for (const row of db
  .select()
  .from(task)
  .where(and(eq(task.chatId, f.dm.chat.id), eq(task.status, "assigned")))
  .all())
  mutateTask("cancel", { taskId: row.id, expectedRevision: row.revision }, f.ctx);

const holder = seedRemoteActor(sqlite, f.ctx.userId, f.project.id, f.bootId);
const handoff = seedLease(f, "fencing", holder.instanceId, f.instance.id);
const handoffBefore = snapshot();
sqlite.exec("SAVEPOINT p6c_generation_probe");
try {
  db.update(machineLease)
    .set({ generation: 2 })
    .where(eq(machineLease.machineId, handoff.key.machineId))
    .run();
  assert.deepEqual(
    collect(),
    [],
    "handoff expectedGeneration must match the current fencing lease",
  );
} finally {
  sqlite.exec("ROLLBACK TO p6c_generation_probe; RELEASE p6c_generation_probe");
}
assert.deepEqual(snapshot(), handoffBefore);
const targetError = blocked(remove);
const targetDetails = toAppError(targetError, f.ctx.requestId);
assert.ok(targetDetails.code === "project_member_removal_blocked");
if (targetDetails.code !== "project_member_removal_blocked")
  throw new Error("Expected structured handoff");
const targetBlock = targetDetails.details.blockers[0];
assert.equal(targetBlock.kind, "leases");
if (targetBlock.kind !== "leases") throw new Error("Expected lease");
assert.equal(targetBlock.items[0].relation, "handoff_target");
assert.equal(targetBlock.items[0].pendingMutationId, handoff.pendingMutationId);
assert.deepEqual(snapshot(), handoffBefore);
completeLeaseMutation(handoff.key, new Date(), false);
assert.equal(
  db.select().from(machineLease).where(eq(machineLease.machineId, handoff.key.machineId)).get()
    ?.holderInstanceId,
  f.instance.id,
);
// Human handles the now-held responsibility before removal.
db.update(machineLease)
  .set({ state: "free", holderInstanceId: null })
  .where(eq(machineLease.machineId, handoff.key.machineId))
  .run();
assert.deepEqual(collect(), [], "completed historical handoff must not block");
assert.equal(
  db.select().from(leaseMutation).where(eq(leaseMutation.id, handoff.pendingMutationId!)).get()
    ?.state,
  "completed",
);
pass("blockers.handoff-target.current-fencing-only");

const events = () =>
  db
    .select()
    .from(diagnosticEvent)
    .where(
      and(
        eq(diagnosticEvent.projectId, f.project.id),
        eq(diagnosticEvent.event, "project_member.removed"),
      ),
    )
    .all().length;
const beforeEvents = events();
const beforeCrossProject = crossProjectRows();
const workers = [0, 1].map(() =>
  fork(new URL("./p6c-remove-worker.ts", import.meta.url), [], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  }),
);
try {
  const ready = workers.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once("message", (message) =>
          message === "ready" ? resolve() : reject(new Error("No readiness")),
        );
        child.once("error", reject);
        child.once("exit", (code) => {
          if (code !== null) reject(new Error(`Early child exit ${code}`));
        });
      }),
  );
  await Promise.race([
    Promise.all(ready),
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("Concurrent removal timeout")), 15000);
      timeout.unref();
    }),
  ]);
  const results = workers.map(
    (child) =>
      new Promise<void>((resolve, reject) => {
        child.once("message", (message: { ok: boolean }) =>
          message.ok ? resolve() : reject(new Error(JSON.stringify(message))),
        );
        child.once("error", reject);
        child.send({ projectId: f.project.id, agentProfileId: f.agent.id, userId: f.ctx.userId });
      }),
  );
  await Promise.race([
    Promise.all(results),
    new Promise((_, reject) => {
      const timeout = setTimeout(() => reject(new Error("Concurrent removal timeout")), 15000);
      timeout.unref();
    }),
  ]);
} finally {
  for (const child of workers) child.kill();
}
assert.equal(
  events() - beforeEvents,
  1,
  "two idempotent successful requests perform one actual removal",
);
const after = snapshot();
remove();
assert.deepEqual(snapshot(), after);
assert.equal(
  crossProjectRows(),
  beforeCrossProject,
  "removing from A must leave every B-owned run/lease/group/task row unchanged",
);
pass("removal.resolved.concurrent-exactly-once-effects");
console.log(`p6c-member-removal: ${assertionCount} assertions passed`);
