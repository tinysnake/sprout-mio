import nodeAssert from "node:assert/strict";
export let assertionCount = 0;
export const assert: typeof nodeAssert = new Proxy(nodeAssert, {
  apply(target, thisArg, args) {
    assertionCount++;
    return Reflect.apply(target, thisArg, args);
  },
  get(target, key) {
    const value = Reflect.get(target, key);
    return typeof value === "function"
      ? (...args: unknown[]) => {
          assertionCount++;
          return Reflect.apply(value, target, args);
        }
      : value;
  },
});
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import {
  agentRun,
  chat,
  leaseAuthorization,
  leaseMutation,
  machineLease,
  task,
} from "../../src/db/schema";
import { addProjectMember, createAgentProfile } from "../../src/domain/agent";
import { createDirectChat, createGroupChat, ensureInstance } from "../../src/domain/chat";
import { createGroupChatInput } from "../../src/contracts/chat";
import { mutateTask } from "../../src/domain/task";
import { createProject } from "../../src/domain/project";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { openInitialMembership } from "../../src/server/membership";

export function setup() {
  migrateDatabase();
  const userId = "p6c-human";
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(userId, userId, "p6c@example.test");
  const ctx = { userId, requestId: newId(ID_PREFIXES.request) };
  const project = createProject({ name: "P6c" }, ctx);
  const agent = createAgentProfile({ name: "Leaving", persona: "", harness: "pi" }, ctx);
  addProjectMember(project.id, agent.id, ctx);
  const dm = createDirectChat(project.id, agent.id, ctx);
  const group = createGroupChat(
    project.id,
    createGroupChatInput.parse({
      projectId: project.id,
      title: "Group",
      initialOwner: { kind: "human", id: userId },
      members: [
        { kind: "human", id: userId },
        { kind: "agent", id: agent.id },
      ],
    }),
    { kind: "human", userId, ctx },
  );
  const instance = ensureInstance(group.id, agent.id, ctx);
  const channel = db
    .select()
    .from(chat)
    .where(and(eq(chat.projectId, project.id), eq(chat.kind, "public_channel")))
    .get()!;
  const bootId = newId(ID_PREFIXES.boot);
  sqlite
    .prepare(
      "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
    )
    .run(bootId);
  const machineCtx = { ...ctx, bootId, now: new Date() };
  const makeMachine = () => {
    const result = createMachine({ name: "P6c Machine" }, machineCtx);
    const key = { projectId: project.id, machineId: result.detail.machine.id };
    saveProjectMachineBinding({ ...key, description: "", expectedRevision: null }, machineCtx);
    openInitialMembership(db, { ...key, now: machineCtx.now });
    return key;
  };
  return { ctx, project, agent, dm, group, instance, channel, bootId, machineCtx, makeMachine };
}
export type Fixture = ReturnType<typeof setup>;
export function seedRun(
  f: Fixture,
  status: typeof agentRun.$inferSelect.status = "queued",
  instanceId = f.instance.id,
  chatId = f.group.id,
) {
  const id = newId(ID_PREFIXES.run);
  db.insert(agentRun)
    .values({
      id,
      instanceId,
      chatId,
      projectId: f.project.id,
      requestId: f.ctx.requestId,
      status,
      sessionId: instanceId,
      startedAt: status === "running" ? new Date() : null,
      settledAt: status !== "queued" && status !== "running" ? new Date() : null,
    })
    .run();
  return id;
}
export function seedTask(
  f: Fixture,
  status: typeof task.$inferSelect.status = "assigned",
  chatId = f.dm.chat.id,
) {
  const created = mutateTask("create", { projectId: f.project.id, title: "Task" }, f.ctx).detail
    .task;
  if (status === "proposed") return created.id;
  const assigned = mutateTask(
    "assign",
    {
      taskId: created.id,
      expectedRevision: created.revision,
      targetChatId: chatId,
      startNow: false,
    },
    f.ctx,
  ).detail.task;
  if (status === "finished")
    mutateTask(
      "complete",
      { taskId: created.id, expectedRevision: assigned.revision, appendRecord: { body: "Done" } },
      f.ctx,
    );
  if (status === "canceled")
    mutateTask("cancel", { taskId: created.id, expectedRevision: assigned.revision }, f.ctx);
  return created.id;
}
export function seedLease(
  f: Fixture,
  state: "held" | "fencing" = "held",
  holderInstanceId = f.instance.id,
  targetInstanceId?: string,
) {
  const key = f.makeMachine();
  db.insert(machineLease)
    .values({ ...key, generation: 1, state, holderInstanceId, changedAt: new Date() })
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation: 1,
      state: state === "held" ? "active" : "draining",
      holderInstanceId,
      reason: "acquire",
      issuedAt: new Date(),
    })
    .run();
  let pendingMutationId: string | null = null;
  if (state === "fencing") {
    pendingMutationId = newId(ID_PREFIXES.leaseMutation);
    db.insert(leaseMutation)
      .values({
        id: pendingMutationId,
        ...key,
        actorKind: "agent",
        actorId: holderInstanceId,
        requestId: newId(ID_PREFIXES.request),
        payloadHash: "a".repeat(64),
        action: targetInstanceId ? "handoff" : "release",
        targetInstanceId,
        expectedGeneration: 1,
        state: "pending",
        createdAt: new Date(),
      })
      .run();
  }
  return { key, pendingMutationId };
}
/** All persisted columns of all tables, including diagnostics and migration journal. */
export function snapshot() {
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
export function blocked(operation: () => unknown) {
  try {
    operation();
  } catch (error) {
    assert.ok(
      error instanceof Error && "code" in error && error.code === "project_member_removal_blocked",
    );
    return error;
  }
  assert.fail("Expected removal to be blocked");
}
