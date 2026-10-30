import { afterAll, describe, expect, it, vi } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskDetail } from "../src/contracts/task";
import type { ProjectContext } from "../src/domain/access";

const directory = mkdtempSync(join(tmpdir(), "p5b-task-info-"));
process.env.DATABASE_URL = join(directory, "info.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { sqlite, db } = await import("../src/db");
const { agentRun } = await import("../src/db/schema");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember } = await import("../src/domain/agent");
const { createDirectChat, createGroupChat, ensureInstance } = await import("../src/domain/chat");
const { transitionAgentRun, completeAgentRun } = await import("../src/domain/agent-run");
const tasks = await import("../src/domain/task");
const { getProjectInfoHub, getChatInfo, getTurnStartContext } =
  await import("../src/domain/info-hub");
const { projectInfoHubSchema, chatInfoViewSchema } = await import("../src/contracts/info-hub");

sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_info','Info','info@tasks.test',0,1,1)",
  )
  .run();
const ctx = {
  userId: "usr_info",
  requestId: newId(ID_PREFIXES.request),
  bootId: "info-gate",
  now: new Date(),
};
function fixture() {
  const project = createProject({ name: "Task Info" }, ctx);
  const profile = createAgentProfile({ name: "Info Agent", persona: "", harness: "pi" }, ctx);
  addProjectMember(project.id, profile.id, ctx);
  const chat = createDirectChat(project.id, profile.id, ctx).chat;
  const instance = ensureInstance(chat.id, profile.id, ctx);
  const run = db
    .insert(agentRun)
    .values({
      id: newId(ID_PREFIXES.run),
      instanceId: instance.id,
      chatId: chat.id,
      projectId: project.id,
      requestId: ctx.requestId,
      sessionId: instance.id,
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();
  const agent: ProjectContext = {
    ...ctx,
    agent: { runId: run.id, instanceId: instance.id, agentProfileId: profile.id },
  };
  const create = (title = "Summary task") =>
    tasks.createTask(
      {
        projectId: project.id,
        title,
        description: "secret description",
        constraints: "secret constraints",
        completionRequirements: "secret requirements",
        checklist: ["check"],
      },
      ctx,
    ).detail;
  const assign = (detail: TaskDetail, targetChatId = chat.id) =>
    tasks.assignTask(
      {
        taskId: detail.task.id,
        expectedRevision: detail.task.revision,
        targetChatId,
      },
      ctx,
    ).detail;
  const hub = () => getProjectInfoHub(project.id, ctx);
  const assigned = assign(create());
  return { project, profile, chat, instance, run, agent, create, assign, assigned, hub };
}
const input = (detail: TaskDetail) => ({
  taskId: detail.task.id,
  expectedRevision: detail.task.revision,
});
function facts() {
  return {
    runs: sqlite.prepare("SELECT * FROM agent_run ORDER BY id").all(),
    leases: sqlite.prepare("SELECT * FROM machine_lease ORDER BY machine_id").all(),
  };
}
function heldLease(f: ReturnType<typeof fixture>) {
  const machineId = newId(ID_PREFIXES.machine);
  sqlite
    .prepare(
      "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,'Info lease',?,1,1)",
    )
    .run(machineId, ctx.userId);
  sqlite
    .prepare(
      "INSERT INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,?,1,1,1)",
    )
    .run(f.project.id, machineId, ctx.userId);
  sqlite
    .prepare(
      "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,1)",
    )
    .run(f.project.id, machineId, f.instance.id);
  return machineId;
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Task Info Hub real SQLite aggregates", () => {
  it("projects all four states and metadata in stable order without exposing bodies or inferring bindings", () => {
    const f = fixture();
    const proposed = f.create();
    const canceled = tasks.cancelTask(input(f.create()), ctx).detail;
    const finished = tasks.completeTask(
      { ...input(f.assign(f.create())), appendRecord: { body: "secret result" } },
      ctx,
    ).detail;
    const reopened = tasks.reopenTask(input(finished), ctx).detail;
    const checked = tasks.updateTaskChecklistItem(
      {
        ...input(reopened),
        itemId: reopened.checklist[0]!.id,
        checked: true,
      },
      ctx,
    ).detail;
    const extra = tasks.addTaskChecklistItem({ ...input(checked), body: "removed" }, ctx).detail;
    tasks.removeTaskChecklistItem({ ...input(extra), itemId: extra.checklist[1]!.id }, ctx);
    const humanChat = createGroupChat(
      f.project.id,
      {
        projectId: f.project.id,
        title: "Human responsibility",
        wakePolicy: "owner_led",
        members: [{ kind: "human", id: ctx.userId }],
        initialOwner: { kind: "human", id: ctx.userId },
      },
      { kind: "human", userId: ctx.userId, ctx },
    );
    const humanTask = f.assign(f.create(), humanChat.id);
    const done = tasks.completeTask(
      { ...input(f.assign(f.create())), appendRecord: { body: "finished body" } },
      ctx,
    ).detail;
    // Equal timestamps exercise the documented id tie-break independently of insertion order.
    sqlite
      .prepare(
        "UPDATE task SET updated_at=created_at+1000, revision=revision+1 WHERE project_id=?",
      )
      .run(f.project.id);
    const hub = projectInfoHubSchema.parse(f.hub());
    expect(hub.tasks.counts).toEqual({ proposed: 1, assigned: 3, finished: 1, canceled: 1 });
    expect(hub.tasks.items.map((item) => item.taskId)).toEqual(
      [...hub.tasks.items]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.taskId.localeCompare(b.taskId))
        .map((item) => item.taskId),
    );
    const summary = hub.tasks.items.find((item) => item.taskId === reopened.task.id)!;
    expect(summary).toMatchObject({
      checklistTotal: 1,
      checklistChecked: 1,
      recordCount: 1,
      previousCompletionRef: { seq: 1, chatId: f.chat.id },
      responsibility: { kind: "agent", agentProfileId: f.profile.id, instanceId: f.instance.id },
      context: { activeRunIds: [f.run.id], relation: "same_chat", taskRunBinding: false },
    });
    expect(
      hub.tasks.items.find((item) => item.taskId === humanTask.task.id)?.responsibility,
    ).toEqual({ kind: "human", userId: ctx.userId });
    expect(
      hub.tasks.items.find((item) => item.taskId === proposed.task.id)?.context.activeRunIds,
    ).toEqual([]);
    expect(JSON.stringify(hub.tasks)).not.toMatch(
      /secret|description|constraints|requirements|body|leaseId|leaseHolder|runStatus/,
    );
    const aggregate = hub.chats.find((item) => item.chatId === f.chat.id)!;
    expect(aggregate.taskCounts).toEqual({ proposed: 0, assigned: 2, finished: 1, canceled: 0 });
    expect([...aggregate.assignedTaskIds].sort()).toEqual(
      [f.assigned.task.id, reopened.task.id].sort(),
    );
    const chat = chatInfoViewSchema.parse(getChatInfo(f.chat.id, ctx));
    expect(chat.tasks.items.map((item) => item.taskId).sort()).toEqual(
      [f.assigned.task.id, reopened.task.id, done.task.id].sort(),
    );
    expect(chat.tasks.items).toEqual(hub.tasks.items.filter((item) => item.chatId === f.chat.id));
    expect(hub.tasks.items.some((item) => item.taskId === canceled.task.id)).toBe(true);
    expect(getTurnStartContext(f.chat.id, ctx).injectedIntoPrompt).toBe(false);
  });

  it("keeps every run and lease field unchanged when only Task state and records change", () => {
    const f = fixture();
    heldLease(f);
    const neighborProfile = createAgentProfile(
      { name: "Neighbor", persona: "", harness: "pi" },
      ctx,
    );
    addProjectMember(f.project.id, neighborProfile.id, ctx);
    const neighbor = createDirectChat(f.project.id, neighborProfile.id, ctx).chat;
    const neighborInstance = ensureInstance(neighbor.id, neighborProfile.id, ctx);
    const neighborRunId = newId(ID_PREFIXES.run);
    db.insert(agentRun)
      .values({
        id: neighborRunId,
        instanceId: neighborInstance.id,
        chatId: neighbor.id,
        projectId: f.project.id,
        requestId: ctx.requestId,
        sessionId: neighborInstance.id,
        status: "running",
        startedAt: new Date(),
      })
      .run();
    const before = facts();
    const beforeHub = f.hub();
    const recorded = tasks.appendTaskRecord({ ...input(f.assigned), body: "progress" }, ctx).detail;
    tasks.completeTask({ ...input(recorded), appendRecord: { body: "done" } }, ctx);
    expect(facts()).toEqual(before);
    const after = f.hub();
    expect(after.agents.runs).toEqual(beforeHub.agents.runs);
    expect(after.leases).toEqual(beforeHub.leases);
    expect(after.tasks.items[0]).toMatchObject({
      status: "finished",
      recordCount: 2,
      lastRecordRef: { seq: 2 },
      context: { activeRunIds: [f.run.id] },
    });
    expect(after.chats.find((chat) => chat.chatId === f.chat.id)?.activeRunIds).toEqual([f.run.id]);
    expect(after.chats.find((chat) => chat.chatId === neighbor.id)?.activeRunIds).toEqual([
      neighborRunId,
    ]);
  });

  it.each(["completed", "failed"] as const)(
    "keeps Task status and record references unchanged when only a run becomes %s",
    (status) => {
      const f = fixture();
      tasks.appendTaskRecord({ ...input(f.assigned), body: "progress" }, ctx);
      const before = f.hub().tasks.items[0]!;
      const raw = sqlite.prepare("SELECT * FROM task WHERE id=?").get(f.assigned.task.id);
      if (status === "completed") {
        sqlite.prepare("UPDATE agent_run SET config_snapshot=? WHERE id=?").run(
          JSON.stringify({
            model: "fixture-model",
            provider: "fixture",
            thinking: "off",
            tools: [],
            extensions: [],
            sessionId: f.instance.id,
            sessionFile: "/tmp/task-info-session",
            cwd: "/tmp",
            sdkVersion: "fixture",
            profile: {
              id: f.profile.id,
              name: f.profile.name,
              persona: f.profile.persona,
              harness: "pi",
              updatedAt: f.profile.updatedAt,
            },
          }),
          f.run.id,
        );
        completeAgentRun(f.run.id, "Ordinary assistant result", "stop", ctx);
      } else {
        transitionAgentRun(
          f.run.id,
          status,
          { errorCode: "fixture_failure", errorMessage: "fixture" },
          ctx,
        );
      }
      const after = f.hub().tasks.items[0]!;
      expect(sqlite.prepare("SELECT * FROM task WHERE id=?").get(f.assigned.task.id)).toEqual(raw);
      expect({ ...after, context: before.context }).toEqual(before);
      expect(after.context.activeRunIds).toEqual([]);
    },
  );

  it("keeps Task and run summaries unchanged when only a real held lease changes", () => {
    const f = fixture();
    const machineId = heldLease(f);
    const before = f.hub();
    const runRows = facts().runs;
    const taskRows = sqlite
      .prepare("SELECT * FROM task WHERE project_id=? ORDER BY id")
      .all(f.project.id);
    sqlite
      .prepare(
        "UPDATE machine_lease SET generation=2,state='free',holder_instance_id=NULL,changed_at=2 WHERE machine_id=?",
      )
      .run(machineId);
    const after = f.hub();
    expect(after.tasks).toEqual(before.tasks);
    expect(after.agents.runs).toEqual(before.agents.runs);
    expect(after.chats).toEqual(before.chats);
    expect(facts().runs).toEqual(runRows);
    expect(
      sqlite.prepare("SELECT * FROM task WHERE project_id=? ORDER BY id").all(f.project.id),
    ).toEqual(taskRows);
    expect(after.leases).not.toEqual(before.leases);
  });

  it("allows a real Project member basic summaries but rejects other Chat bodies, other Projects and revoked membership", () => {
    const f = fixture();
    const otherProfile = createAgentProfile({ name: "Other", persona: "", harness: "pi" }, ctx);
    addProjectMember(f.project.id, otherProfile.id, ctx);
    const other = createDirectChat(f.project.id, otherProfile.id, ctx).chat;
    const elsewhere = f.assign(f.create(), other.id);
    const summary = getProjectInfoHub(f.project.id, { ...ctx, ...f.agent }).tasks;
    expect(summary.items.map((item) => item.taskId)).toContain(elsewhere.task.id);
    expect(JSON.stringify(summary)).not.toContain("secret");
    expect(() => tasks.getTaskDetail(elsewhere.task.id, f.agent)).toThrow();
    expect(() => getChatInfo(other.id, f.agent)).toThrow();
    const foreign = createProject({ name: "Foreign" }, ctx);
    expect(() => getProjectInfoHub(foreign.id, { ...ctx, ...f.agent })).toThrow();
    // Simulate stale enrollment independently of run liveness, as in task-domain's revoked-DM fixture.
    sqlite
      .prepare("DELETE FROM project_member WHERE project_id=? AND agent_profile_id=?")
      .run(f.project.id, f.profile.id);
    expect(() => getProjectInfoHub(f.project.id, { ...ctx, ...f.agent })).toThrow();
    expect(() => tasks.getTaskDetail(f.assigned.task.id, f.agent)).toThrow();
  });

  it("does not increase SQLite statement count as one Chat gains many Tasks", () => {
    const f = fixture();
    const statementCount = (read: () => unknown) => {
      const listener = vi.spyOn(sqlite, "prepare");
      try {
        read();
        return listener.mock.calls.length;
      } finally {
        listener.mockRestore();
      }
    };
    const projectBefore = statementCount(f.hub);
    const chatBefore = statementCount(() => getChatInfo(f.chat.id, ctx));
    expect(projectBefore).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) f.assign(f.create(`Batch ${i}`));
    expect(f.hub().tasks.items).toHaveLength(41);
    const projectAfter = statementCount(f.hub);
    const chatAfter = statementCount(() => getChatInfo(f.chat.id, ctx));
    expect(projectAfter).toBe(projectBefore);
    expect(chatAfter).toBe(chatBefore);
    console.info("Task aggregate SQLite statement counts", {
      tasksBefore: 1,
      tasksAfter: 41,
      projectBefore,
      projectAfter,
      chatBefore,
      chatAfter,
    });
  });
});
