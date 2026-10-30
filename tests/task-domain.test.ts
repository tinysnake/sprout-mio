import { afterAll, describe, expect, it } from "vite-plus/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { ProjectContext } from "../src/domain/access";
import type { TaskDetail } from "../src/contracts/task";

// Same real-row fixture pattern as tests/fixtures/group-chat.ts: seed Humans, use domain
// Project/Profile/Chat creation, and seed only the run identity which a host normally creates.
const directory = mkdtempSync(join(tmpdir(), "p5b-task-domain-"));
process.env.DATABASE_URL = join(directory, "domain.sqlite");
const { migrateDatabase } = await import("../src/db/migrate");
migrateDatabase();
const { db, sqlite } = await import("../src/db");
const { agentRun, agentRunInput, chat, task } = await import("../src/db/schema");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createProject } = await import("../src/domain/project");
const { createAgentProfile, addProjectMember, removeProjectMember } =
  await import("../src/domain/agent");
const {
  createGroupChat,
  createDirectChat,
  ensureInstance,
  sendMessage,
  setChatOwner,
  removeGroupMember,
  getChat,
} = await import("../src/domain/chat");
const { completeAgentRun, transitionAgentRun } = await import("../src/domain/agent-run");
const { ensureProjectChannel } = await import("../src/domain/channel");
const domain = await import("../src/domain/task");
const { taskResponsibilityFacts, taskCapabilityFacts } =
  await import("../src/domain/task-capabilities");
const { admitTaskStartInput, validateTaskStartInput, cancelInvalidTaskStartInputs } =
  await import("../src/domain/task-input");
const { taskDetailSchema, taskCommandResultSchema, projectTasksViewSchema } =
  await import("../src/contracts/task");
const { toDomainAppError } = await import("../src/server/functions/domain-errors");

for (const id of ["usr_task_creator", "usr_task_other"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, id, `${id}@tasks.test`);
const ctx: ProjectContext = { userId: "usr_task_creator", requestId: newId(ID_PREFIXES.request) };
const other: ProjectContext = { userId: "usr_task_other", requestId: newId(ID_PREFIXES.request) };
const project = createProject({ name: "Task gate" }, ctx);
const foreignProject = createProject({ name: "Other project" }, ctx);
const alpha = createAgentProfile({ name: "Alpha", persona: "", harness: "pi" }, ctx);
const beta = createAgentProfile({ name: "Beta", persona: "", harness: "pi" }, ctx);
for (const profile of [alpha, beta]) addProjectMember(project.id, profile.id, ctx);
const human = { kind: "human" as const, userId: ctx.userId, ctx };
function group(owner: "human" | "agent" = "agent") {
  return createGroupChat(
    project.id,
    {
      projectId: project.id,
      title: "@Beta task group",
      wakePolicy: "owner_led",
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: alpha.id },
        { kind: "agent", id: beta.id },
      ],
      initialOwner:
        owner === "human" ? { kind: "human", id: ctx.userId } : { kind: "agent", id: alpha.id },
    },
    human,
  );
}
function agentContext(chatId: string, agentProfileId: string): ProjectContext {
  const instance = ensureInstance(chatId, agentProfileId, ctx);
  let run = db
    .select()
    .from(agentRun)
    .where(
      and(eq(agentRun.instanceId, instance.id), inArray(agentRun.status, ["queued", "running"])),
    )
    .get();
  run ??= db
    .insert(agentRun)
    .values({
      id: newId(ID_PREFIXES.run),
      instanceId: instance.id,
      chatId,
      projectId: project.id,
      requestId: ctx.requestId,
      sessionId: instance.id,
      status: "running",
      startedAt: new Date(),
    })
    .returning()
    .get();
  return { ...ctx, agent: { runId: run.id, instanceId: instance.id, agentProfileId } };
}
function create(title = "任务 @Beta") {
  return domain.createTask(
    {
      projectId: project.id,
      title,
      description: "说明",
      constraints: "约束",
      completionRequirements: "完成要求",
      checklist: ["验收"],
    },
    ctx,
  ).detail;
}
function input(detail: TaskDetail) {
  return { taskId: detail.task.id, expectedRevision: detail.task.revision };
}
function assigned(chatId: string) {
  return domain.assignTask({ ...input(create()), targetChatId: chatId }, ctx).detail;
}
function codeOf(run: () => unknown): string {
  try {
    run();
    return "ok";
  } catch (error) {
    return error instanceof Error && "code" in error ? String(error.code) : "unknown";
  }
}
function count(table: string): number {
  return (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("Task lifecycle, result boundaries and atomic writes", () => {
  it("keeps four states, CAS, checklist positions and immutable result history", () => {
    let detail = create();
    expect(detail.task.status).toBe("proposed");
    expect(detail.task.revision).toBe(1);
    expect(detail.task.assignmentRevision).toBe(0);
    expect(codeOf(() => domain.completeTask(input(detail), ctx))).toBe("task_invalid_transition");
    detail = domain.updateTask({ ...input(detail), title: "更新目标" }, ctx).detail;
    const stale = { taskId: detail.task.id, expectedRevision: 1 };
    expect(codeOf(() => domain.cancelTask(stale, ctx))).toBe("conflict");
    detail = domain.removeTaskChecklistItem(
      { ...input(detail), itemId: detail.checklist[0]!.id },
      ctx,
    ).detail;
    detail = domain.addTaskChecklistItem(
      { ...input(detail), body: "仍未勾选也允许完成" },
      ctx,
    ).detail;
    expect(detail.checklist.map((i) => i.position)).toEqual([2]);
    detail = domain.updateTaskChecklistItem(
      { ...input(detail), itemId: detail.checklist[0]!.id, checked: true },
      ctx,
    ).detail;
    const target = group();
    const before = [count("message"), count("agent_run"), count("agent_run_input")];
    const assignment = domain.assignTask({ ...input(detail), targetChatId: target.id }, ctx);
    expect(assignment.startDelivery).toBeUndefined();
    expect([count("message"), count("agent_run"), count("agent_run_input")]).toEqual(before);
    detail = assignment.detail;
    expect(codeOf(() => domain.completeTask(input(detail), ctx))).toBe("task_record_required");
    const normal = sendMessage(
      target.id,
      { senderKind: "human", senderId: ctx.userId, body: "引用原文" },
      ctx,
    );
    detail = domain.appendTaskRecord(
      { ...input(detail), body: "阶段进度", referenceMessageId: normal.id },
      ctx,
    ).detail;
    detail = domain.completeTask(input(detail), ctx).detail;
    expect(detail.completionRecord).toEqual(detail.lastRecord);
    expect(detail.completionRecord).toMatchObject({ body: "阶段进度", seq: 1 });
    expect(codeOf(() => domain.startTask(input(detail), ctx))).toBe("task_invalid_transition");
    expect(codeOf(() => domain.appendTaskRecord({ ...input(detail), body: "终态追加" }, ctx))).toBe(
      "task_invalid_transition",
    );
    detail = domain.correctTask({ ...input(detail), record: { body: "纠正结果" } }, ctx).detail;
    expect(detail.completionRecord).toMatchObject({ kind: "correction", body: "纠正结果", seq: 2 });
    expect(detail.completionHistory.map((h) => h.record.seq)).toEqual([1, 2]);
    detail = domain.reopenTask(input(detail), ctx).detail;
    expect(detail.task.status).toBe("assigned");
    expect(detail.completionRecord).toBeNull();
    expect(detail.previousCompletionRecord).toMatchObject({ body: "纠正结果" });
    detail = domain.appendTaskRecord({ ...input(detail), body: "重开后进度" }, ctx).detail;
    detail = domain.completeTask(input(detail), ctx).detail;
    expect(detail.completionHistory.map((h) => h.record.seq)).toEqual([1, 2, 3]);
    expect(detail.events.map((e) => e.seq)).toEqual(
      Array.from({ length: detail.task.revision }, (_, i) => i + 1),
    );
    expect(detail.events.at(-1)).toMatchObject({ action: "complete", recordSeqAtEvent: 3 });
    expect(taskDetailSchema.safeParse(detail).success).toBe(true);
    expect(projectTasksViewSchema.safeParse(domain.getProjectTasks(project.id, ctx)).success).toBe(
      true,
    );
  });

  it("rolls back record, revision, event and allocation when a bounded operation fails", () => {
    const target = group();
    let detail = assigned(target.id);
    const before = [count("message"), count("task_event"), detail.task.revision];
    expect(
      codeOf(() =>
        domain.correctTask(
          { ...input(detail), title: "不得残留", record: { body: "非 finished" } },
          ctx,
        ),
      ),
    ).toBe("task_invalid_transition");
    expect([
      count("message"),
      count("task_event"),
      domain.getTaskDetail(detail.task.id, ctx).task.revision,
    ]).toEqual(before);
    detail = domain.completeTask(
      { ...input(detail), appendRecord: { body: "一次完成" } },
      ctx,
    ).detail;
    const immutable = detail.lastRecord!;
    expect(immutable).toMatchObject({ body: "一次完成" });
    const finishedBefore = [count("message"), count("task_event"), detail.task.revision];
    expect(
      codeOf(() =>
        domain.correctTask(
          {
            ...input(detail),
            record: { body: "必须回滚" },
            checklist: {
              update: [{ itemId: newId(ID_PREFIXES.taskChecklistItem), checked: true }],
            },
          },
          ctx,
        ),
      ),
    ).toBe("not_found");
    expect([
      count("message"),
      count("task_event"),
      domain.getTaskDetail(detail.task.id, ctx).task.revision,
    ]).toEqual(finishedBefore);
    const large = domain.createTask(
      { projectId: project.id, title: "快照溢出", description: "a".repeat(8000) },
      ctx,
    ).detail;
    const snapshotBefore = [count("message"), count("agent_run_input"), count("task_event")];
    expect(
      codeOf(() =>
        domain.assignTask({ ...input(large), targetChatId: target.id, startNow: true }, ctx),
      ),
    ).toBe("validation_failed");
    expect(domain.getTaskDetail(large.task.id, ctx).task).toMatchObject({
      status: "proposed",
      revision: 1,
      assignmentRevision: 0,
    });
    expect([count("message"), count("agent_run_input"), count("task_event")]).toEqual(
      snapshotBefore,
    );
  });

  it("keeps Task status independent of run settlement and preserves a held Machine lease across complete/cancel/reassign", () => {
    const target = group();
    let detail = assigned(target.id);
    const first = agentContext(target.id, alpha.id);
    const machineId = newId(ID_PREFIXES.machine);
    sqlite
      .prepare(
        "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,'Task lease fixture',?,1,1)",
      )
      .run(machineId, ctx.userId);
    sqlite
      .prepare(
        "INSERT INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,?,1,1,1)",
      )
      .run(project.id, machineId, ctx.userId);
    sqlite
      .prepare(
        "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,1)",
      )
      .run(project.id, machineId, first.agent!.instanceId);
    const held = sqlite.prepare("SELECT * FROM machine_lease WHERE machine_id=?").get(machineId);
    for (const status of ["failed", "aborted", "interrupted", "completed"] as const) {
      const execution = agentContext(target.id, alpha.id);
      if (status === "completed") {
        db.update(agentRun)
          .set({
            configSnapshot: {
              model: "fixture-model",
              provider: "fixture",
              thinking: "off",
              tools: [],
              extensions: [],
              sessionId: execution.agent!.instanceId,
              sessionFile: "/tmp/task-domain-session",
              cwd: "/tmp",
              sdkVersion: "fixture",
              profile: {
                id: alpha.id,
                name: alpha.name,
                persona: alpha.persona,
                harness: "pi",
                updatedAt: alpha.updatedAt,
              },
            },
          })
          .where(eq(agentRun.id, execution.agent!.runId))
          .run();
        completeAgentRun(execution.agent!.runId, "普通 assistant 回复不会完成 Task", "stop", ctx);
      } else
        transitionAgentRun(
          execution.agent!.runId,
          status,
          status === "failed"
            ? { errorCode: "fixture_failure", errorMessage: "fixture failed" }
            : { stopReason: status },
          ctx,
        );
      const current = domain.getTaskDetail(detail.task.id, ctx);
      expect(current.task).toMatchObject({ status: "assigned", revision: detail.task.revision });
      expect(current.records).toEqual([]);
      expect(
        sqlite.prepare("SELECT * FROM machine_lease WHERE machine_id=?").get(machineId),
      ).toEqual(held);
    }
    detail = domain.completeTask(
      { ...input(detail), appendRecord: { body: "Human 明确完成" } },
      ctx,
    ).detail;
    expect(detail.task.status).toBe("finished");
    const otherTask = assigned(target.id);
    domain.cancelTask(input(otherTask), ctx);
    const reassigned = assigned(target.id);
    domain.reassignTask({ ...input(reassigned), targetChatId: group().id }, ctx);
    expect(sqlite.prepare("SELECT * FROM machine_lease WHERE machine_id=?").get(machineId)).toEqual(
      held,
    );
  });

  it("reopens cancellation only into a valid retained or explicit initial Chat", () => {
    const target = group();
    let detail = domain.cancelTask(input(create()), ctx).detail;
    expect(detail.task.chatId).toBeNull();
    expect(codeOf(() => domain.reopenTask(input(detail), ctx))).toBe("task_assignment_invalid");
    detail = domain.reopenTask({ ...input(detail), initialChatId: target.id }, ctx).detail;
    detail = domain.cancelTask(input(detail), ctx).detail;
    expect(
      codeOf(() => domain.reopenTask({ ...input(detail), initialChatId: target.id }, ctx)),
    ).toBe("task_assignment_invalid");
    db.update(chat).set({ archivedAt: new Date() }).where(eq(chat.id, target.id)).run();
    expect(codeOf(() => domain.reopenTask(input(detail), ctx))).toBe("task_assignment_invalid");
    db.update(chat).set({ archivedAt: null }).where(eq(chat.id, target.id)).run();
    detail = domain.reopenTask(input(detail), ctx).detail;
    detail = domain.unassignTask(input(detail), ctx).detail;
    expect(detail.task).toMatchObject({ status: "proposed", chatId: null });
  });
});

describe("responsibility, Agent scopes and explicit start delivery", () => {
  it("routes DM start to its sole Agent and Group start only to its owner, independent of @ and wake policy", () => {
    const dm = createDirectChat(project.id, alpha.id, ctx).chat;
    expect(taskResponsibilityFacts(dm.id, ctx)).toMatchObject({
      kind: "agent",
      agentProfileId: alpha.id,
    });
    const result = domain.assignTask(
      { ...input(create()), targetChatId: dm.id, startNow: true },
      ctx,
    );
    expect(taskCommandResultSchema.safeParse(result).success).toBe(true);
    expect(result.startDelivery).toMatchObject({ kind: "agent_input", recipientId: alpha.id });
    const target = group();
    db.update(chat).set({ wakePolicy: "mention_only" }).where(eq(chat.id, target.id)).run();
    let detail = assigned(target.id);
    const first = domain.startTask(input(detail), ctx);
    detail = first.detail;
    const second = domain.startTask(input(detail), ctx);
    expect(first.startDelivery?.runId).toBe(second.startDelivery?.runId);
    expect(second.detail.task.assignmentRevision).toBe(detail.task.assignmentRevision);
    const inputs = sqlite
      .prepare(
        "SELECT i.*, a.agent_profile_id FROM agent_run_input i JOIN agent_run r ON r.id=i.run_id JOIN agent_instance a ON a.id=r.instance_id JOIN message m ON m.id=i.message_id WHERE m.task_id=? ORDER BY m.task_record_seq",
      )
      .all(detail.task.id);
    expect(inputs).toHaveLength(2);
    expect(inputs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          agent_profile_id: alpha.id,
          admitted_at: null,
          disposition: "pending",
        }),
      ]),
    );
    expect(second.detail.lastRecord).toMatchObject({ seq: 2, kind: "start", senderKind: "human" });
    expect(
      second.detail.lastRecord?.visibility === "readable" && second.detail.lastRecord.body,
    ).toContain("完成要求");
    const snapshot = [count("message"), count("agent_run_input"), count("task_event")];
    expect(codeOf(() => domain.startTask(input(detail), ctx))).toBe("conflict");
    expect([count("message"), count("agent_run_input"), count("task_event")]).toEqual(snapshot);
  });

  it("Human Group and Public Channel start preserve a message and create zero run/input despite @ names", () => {
    const channel = ensureProjectChannel(project.id);
    for (const targetId of [group("human").id, channel]) {
      expect(taskResponsibilityFacts(targetId, ctx)).toEqual({ kind: "human", userId: ctx.userId });
      const before = [
        count("agent_instance"),
        count("agent_run"),
        count("agent_run_input"),
        count("run_resource_notice"),
      ];
      const result = domain.assignTask(
        { ...input(create("@Alpha @Beta")), targetChatId: targetId, startNow: true },
        ctx,
      );
      expect(result.startDelivery).toMatchObject({
        kind: "human_message",
        recipientId: ctx.userId,
      });
      expect(result.detail.lastRecord).toMatchObject({ kind: "start", senderKind: "human" });
      expect([
        count("agent_instance"),
        count("agent_run"),
        count("agent_run_input"),
        count("run_resource_notice"),
      ]).toEqual(before);
    }
    db.update(chat)
      .set({ ownerKind: "agent", ownerId: alpha.id })
      .where(eq(chat.id, channel))
      .run();
    expect(codeOf(() => taskResponsibilityFacts(channel, ctx))).toBe("task_assignment_invalid");
    db.update(chat)
      .set({ ownerKind: "human", ownerId: ctx.userId })
      .where(eq(chat.id, channel))
      .run();
  });

  it("restricts Agent actions by current responsibility/run and redacts old Chat record bodies", () => {
    const oldChat = group();
    const newChat = group();
    const owner = agentContext(oldChat.id, alpha.id);
    const member = agentContext(oldChat.id, beta.id);
    let detail = assigned(oldChat.id);
    expect(
      taskCapabilityFacts(db.select().from(task).where(eq(task.id, detail.task.id)).get()!, member)
        .allowedActions,
    ).toContain("record_append");
    expect(codeOf(() => domain.updateTask({ ...input(detail), title: "成员越权" }, member))).toBe(
      "forbidden",
    );
    expect(codeOf(() => domain.completeTask(input(detail), member))).toBe("forbidden");
    expect(codeOf(() => domain.startTask(input(detail), owner))).toBe("forbidden");
    expect(
      codeOf(() => domain.createTask({ projectId: project.id, title: "Agent create" }, owner)),
    ).toBe("forbidden");
    expect(
      codeOf(() => domain.assignTask({ ...input(detail), targetChatId: newChat.id }, owner)),
    ).toBe("forbidden");
    detail = domain.updateTask({ ...input(detail), title: "负责人更新" }, owner).detail;
    detail = domain.appendTaskRecord(
      { ...input(detail), body: "旧 Chat 的敏感正文" },
      member,
    ).detail;
    const oldMessage = detail.lastRecord!;
    detail = domain.reassignTask({ ...input(detail), targetChatId: newChat.id }, ctx).detail;
    expect(codeOf(() => domain.getTaskDetail(detail.task.id, owner))).toBe("not_found");
    const nextOwner = agentContext(newChat.id, alpha.id);
    const agentDetail = domain.getTaskDetail(detail.task.id, nextOwner);
    expect(agentDetail.records[0]).toEqual({
      taskId: detail.task.id,
      seq: 1,
      chatId: oldChat.id,
      visibility: "restricted",
    });
    expect(JSON.stringify(agentDetail)).not.toContain("旧 Chat 的敏感正文");
    if (oldMessage.visibility !== "readable") throw new Error("fixture record must be readable");
    expect(
      codeOf(() =>
        domain.appendTaskRecord(
          { ...input(detail), body: "越范围引用", referenceMessageId: oldMessage.messageId },
          nextOwner,
        ),
      ),
    ).toBe("task_reference_forbidden");
    detail = domain.completeTask(
      { ...input(detail), appendRecord: { body: "新负责人完成" } },
      nextOwner,
    ).detail;
    expect(detail.completionRecord).toMatchObject({ body: "新负责人完成", senderId: alpha.id });
    expect(codeOf(() => domain.reopenTask(input(detail), nextOwner))).toBe("forbidden");
    expect(
      codeOf(() => domain.correctTask({ ...input(detail), title: "越权纠正" }, nextOwner)),
    ).toBe("forbidden");
    const ended = agentContext(group().id, alpha.id);
    db.update(agentRun)
      .set({ status: "aborted", settledAt: new Date() })
      .where(eq(agentRun.id, ended.agent!.runId))
      .run();
    expect(codeOf(() => domain.getTaskDetail(detail.task.id, ended))).toBe("not_found");
    expect(codeOf(() => domain.getTaskDetail(detail.task.id, other))).toBe("not_found");
    expect(
      domain
        .getProjectTasks(project.id, nextOwner)
        .items.every((item) => item.chatId === newChat.id),
    ).toBe(true);
    const foreign = domain.createTask(
      { projectId: foreignProject.id, title: "另一 Project" },
      ctx,
    ).detail;
    expect(codeOf(() => domain.getTaskDetail(foreign.task.id, nextOwner))).toBe("not_found");
  });

  it("rejects nonmembers, invalid assignment targets, revoked DM participation and stale identities before revision disclosure", () => {
    const target = group();
    const detail = assigned(target.id);
    const wrongChat = agentContext(group().id, alpha.id);
    expect(
      codeOf(() =>
        domain.updateTask({ ...input(detail), expectedRevision: 999, title: "越范围" }, wrongChat),
      ),
    ).toBe("not_found");
    const revoked = agentContext(target.id, beta.id);
    sqlite
      .prepare("DELETE FROM chat_member WHERE chat_id=? AND member_kind='agent' AND member_id=?")
      .run(target.id, beta.id);
    expect(
      codeOf(() =>
        domain.appendTaskRecord(
          { ...input(detail), expectedRevision: 999, body: "已撤权" },
          revoked,
        ),
      ),
    ).toBe("not_found");
    removeGroupMember(
      target.id,
      { kind: "human", id: ctx.userId },
      getChat(target.id, ctx).governanceRevision,
      human,
    );
    expect(codeOf(() => domain.cancelTask({ ...input(detail), expectedRevision: 999 }, ctx))).toBe(
      "forbidden",
    );
    const unassigned = create();
    const foreignChat = ensureProjectChannel(foreignProject.id);
    expect(
      codeOf(() => domain.assignTask({ ...input(unassigned), targetChatId: foreignChat }, ctx)),
    ).toBe("task_assignment_invalid");
    const disposable = createAgentProfile({ name: "Disposable", persona: "", harness: "pi" }, ctx);
    addProjectMember(project.id, disposable.id, ctx);
    const dm = createDirectChat(project.id, disposable.id, ctx).chat;
    const dmTask = assigned(dm.id);
    const canceled = domain.cancelTask(input(dmTask), ctx).detail;
    const revokedDm = agentContext(dm.id, disposable.id);
    sqlite
      .prepare("DELETE FROM project_member WHERE project_id=? AND agent_profile_id=?")
      .run(project.id, disposable.id);
    expect(codeOf(() => domain.getTaskDetail(canceled.task.id, revokedDm))).toBe("not_found");
    expect(codeOf(() => domain.getProjectTasks(project.id, revokedDm))).toBe("not_found");
    expect(
      codeOf(() =>
        domain.appendTaskRecord({ ...input(canceled), body: "DM 项目参与权已撤销" }, revokedDm),
      ),
    ).toBe("not_found");
    addProjectMember(project.id, disposable.id, ctx);
    transitionAgentRun(revokedDm.agent!.runId, "aborted", { stopReason: "aborted" }, ctx);
    removeProjectMember(project.id, disposable.id, ctx);
    expect(codeOf(() => domain.reopenTask(input(canceled), ctx))).toBe("task_assignment_invalid");
    expect(
      codeOf(() => domain.assignTask({ ...input(unassigned), targetChatId: dm.id }, ctx)),
    ).toBe("task_assignment_invalid");
  });

  it("withdraws every old lifecycle generation and persists a synchronous transport attempt even when send throws", () => {
    const target = group();
    for (const action of ["reassign", "unassign", "cancel", "complete"] as const) {
      const started = domain.assignTask(
        { ...input(create()), targetChatId: target.id, startNow: true },
        ctx,
      );
      const delivery = started.startDelivery!;
      const changed =
        action === "reassign"
          ? domain.reassignTask(
              { ...input(started.detail), targetChatId: target.id, startNow: true },
              ctx,
            )
          : action === "complete"
            ? domain.completeTask(
                { ...input(started.detail), appendRecord: { body: "完成旧代次" } },
                ctx,
              )
            : domain.mutateTask(action, input(started.detail), ctx);
      expect(
        db
          .select()
          .from(agentRunInput)
          .where(eq(agentRunInput.messageId, delivery.messageId))
          .get(),
      ).toMatchObject({
        disposition: "cancelled",
        admittedAt: null,
        cancelReason: "task_context_changed",
      });
      expect(changed.detail.task.assignmentRevision).toBe(
        started.detail.task.assignmentRevision + 1,
      );
      if (action === "reassign")
        expect(
          db
            .select()
            .from(agentRunInput)
            .where(eq(agentRunInput.messageId, changed.startDelivery!.messageId))
            .get(),
        ).toMatchObject({ disposition: "pending", admittedAt: null });
      if (action === "cancel" || action === "complete") {
        const before = [count("message"), count("agent_run_input")];
        const reopened = domain.reopenTask(input(changed.detail), ctx);
        expect(reopened.detail.task.assignmentRevision).toBe(
          changed.detail.task.assignmentRevision + 1,
        );
        expect(reopened.startDelivery).toBeUndefined();
        expect([count("message"), count("agent_run_input")]).toEqual(before);
      }
    }
    const started = domain.assignTask(
      { ...input(create()), targetChatId: target.id, startNow: true },
      ctx,
    );
    const delivery = started.startDelivery!;
    let attempts = 0;
    expect(() =>
      admitTaskStartInput(delivery.runId!, delivery.messageId, () => {
        attempts++;
        throw new Error("transport uncertain");
      }),
    ).toThrow("transport uncertain");
    admitTaskStartInput(delivery.runId!, delivery.messageId, () => {
      attempts++;
    });
    expect(attempts).toBe(1);
    expect(
      db.select().from(agentRunInput).where(eq(agentRunInput.messageId, delivery.messageId)).get(),
    ).toMatchObject({ admittedAt: expect.any(Date), disposition: "pending" });
  });

  it("cancels obsolete unadmitted starts but preserves an attempted input and never admits it twice", () => {
    const target = group();
    let result = domain.assignTask(
      { ...input(create()), targetChatId: target.id, startNow: true },
      ctx,
    );
    const delivery = result.startDelivery!;
    const run = db.select().from(agentRun).where(eq(agentRun.id, delivery.runId!)).get()!;
    const pending = db
      .select()
      .from(agentRunInput)
      .where(eq(agentRunInput.messageId, delivery.messageId))
      .get()!;
    expect(validateTaskStartInput(pending, run)).toBe(true);
    let sent = 0;
    admitTaskStartInput(run.id, delivery.messageId, () => {
      sent++;
    });
    admitTaskStartInput(run.id, delivery.messageId, () => {
      sent++;
    });
    expect(sent).toBe(1);
    result = domain.startTask(input(result.detail), ctx);
    const unattempted = result.startDelivery!;
    const finished = domain.completeTask(
      { ...input(result.detail), appendRecord: { body: "完成" } },
      ctx,
    ).detail;
    expect(finished.task.status).toBe("finished");
    expect(
      db.select().from(agentRunInput).where(eq(agentRunInput.messageId, delivery.messageId)).get(),
    ).toMatchObject({ disposition: "pending", admittedAt: expect.any(Date) });
    expect(
      db
        .select()
        .from(agentRunInput)
        .where(eq(agentRunInput.messageId, unattempted.messageId))
        .get(),
    ).toMatchObject({
      disposition: "cancelled",
      cancelReason: "task_context_changed",
      admittedAt: null,
    });
    let next = domain.assignTask(
      { ...input(create()), targetChatId: target.id, startNow: true },
      ctx,
    );
    const stale = next.startDelivery!;
    setChatOwner(
      target.id,
      { kind: "agent", id: beta.id },
      getChat(target.id, ctx).governanceRevision,
      human,
    );
    expect(cancelInvalidTaskStartInputs(stale.runId!)).toBe(1);
    admitTaskStartInput(stale.runId!, stale.messageId, () => {
      sent++;
    });
    expect(sent).toBe(1);
    next = domain.reassignTask(
      { ...input(next.detail), targetChatId: target.id, startNow: true },
      ctx,
    );
    const fresh = next.startDelivery!;
    expect(fresh.recipientId).toBe(beta.id);
    expect(fresh.runId).not.toBe(stale.runId);
    domain.unassignTask(input(next.detail), ctx);
    expect(
      db.select().from(agentRunInput).where(eq(agentRunInput.messageId, fresh.messageId)).get(),
    ).toMatchObject({ disposition: "cancelled", cancelReason: "task_context_changed" });
  });
});

const execute = promisify(execFile);
async function concurrent(action: "record_append" | "complete", detail: TaskDetail, body: string) {
  const script = `const {mutateTask}=await import('./src/domain/task.ts'); const [action,input,ctx]=JSON.parse(process.argv[1]); try {const result=mutateTask(action,input,ctx); console.log(JSON.stringify({ok:true,revision:result.detail.task.revision}));} catch(e) {console.log(JSON.stringify({ok:false,code:e.code}));}`;
  const payload =
    action === "record_append"
      ? { ...input(detail), body }
      : { ...input(detail), appendRecord: { body } };
  const result = await execute(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      script,
      JSON.stringify([action, payload, ctx]),
    ],
    { cwd: process.cwd(), env: { ...process.env }, timeout: 20000 },
  );
  return JSON.parse(result.stdout.trim().split("\n").at(-1)!) as { ok: boolean; code?: string };
}
describe("cross-process SQLite CAS", () => {
  it("serializes competing appends and append/complete without orphan messages or event gaps", async () => {
    let detail = assigned(group().id);
    const appends = await Promise.all([
      concurrent("record_append", detail, "并发 A"),
      concurrent("record_append", detail, "并发 B"),
    ]);
    expect(appends.filter((result) => result.ok)).toHaveLength(1);
    expect(appends.filter((result) => !result.ok)).toEqual([{ ok: false, code: "conflict" }]);
    detail = domain.getTaskDetail(detail.task.id, ctx);
    expect(detail.records.map((record) => record.seq)).toEqual([1]);
    const race = await Promise.all([
      concurrent("record_append", detail, "追加竞态"),
      concurrent("complete", detail, "完成竞态"),
    ]);
    expect(race.filter((result) => result.ok)).toHaveLength(1);
    expect(race.filter((result) => !result.ok)).toEqual([{ ok: false, code: "conflict" }]);
    detail = domain.getTaskDetail(detail.task.id, ctx);
    if (detail.task.status !== "finished") detail = domain.completeTask(input(detail), ctx).detail;
    expect(detail.completionRecord).toEqual(detail.lastRecord);
    expect(detail.records.map((record) => record.seq)).toEqual([1, 2]);
    expect(detail.events.map((event) => event.seq)).toEqual(
      Array.from({ length: detail.task.revision }, (_, i) => i + 1),
    );
    expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  }, 30000);
});

describe("safe Task error boundary", () => {
  it("maps only registered Task errors and keeps unknown SQL failures internal", async () => {
    for (const code of [
      "task_invalid_transition",
      "task_assignment_invalid",
      "task_record_required",
      "task_reference_forbidden",
      "task_record_immutable",
    ] as const) {
      const mapped = await toDomainAppError(
        new domain.TaskError(code, "SELECT private_token FROM secret"),
        ctx.requestId,
      );
      expect(mapped).toMatchObject({ code, requestId: ctx.requestId });
      expect(mapped?.message).not.toContain("SELECT");
    }
    expect(
      await toDomainAppError(new Error("SQLITE_ERROR: SELECT private_token"), ctx.requestId),
    ).toBeUndefined();
  });
});
