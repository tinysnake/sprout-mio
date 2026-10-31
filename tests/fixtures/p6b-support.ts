import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import assert from "node:assert/strict";

export async function p6bFixture(label: string) {
  const started = performance.now();
  const directory = mkdtempSync(join(tmpdir(), `p6b-${label}-`));
  process.env.DATABASE_URL = join(directory, "facts.sqlite");
  process.env.NODE_ENV = "test";
  process.env.BETTER_AUTH_SECRET = randomBytes(32).toString("base64url");
  process.env.SPROUT_PI_ENABLED = "false";
  const { migrateDatabase } = await import("../../src/db/migrate");
  migrateDatabase();
  const { db, sqlite, openDatabase } = await import("../../src/db");
  const schema = await import("../../src/db/schema");
  const { ID_PREFIXES, newId } = await import("../../src/contracts/ids");
  const project = await import("../../src/domain/project");
  const agents = await import("../../src/domain/agent");
  const chats = await import("../../src/domain/chat");
  const info = await import("../../src/domain/info-hub");
  const turns = await import("../../src/domain/turn-context");
  const tasks = await import("../../src/domain/task");
  const { projectInfoHubSchema, chatInfoViewSchema, INFO_HUB_LIMITS } =
    await import("../../src/contracts/info-hub");
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('usr_p6b','P6b','p6b@test.local',0,1,1)",
    )
    .run();
  const runtime = label === "agent-tool" ? await import("../../src/server/runtime") : undefined;
  if (runtime) await runtime.startRuntime();
  const runtimeCtx = runtime
    ? await runtime.machineRuntimeContext()
    : { bootId: "p6b-test", now: new Date() };
  const ctx = { userId: "usr_p6b", requestId: newId(ID_PREFIXES.request), ...runtimeCtx };
  const p = project.createProject({ name: "P6b project" }, ctx);
  const a = agents.createAgentProfile(
    { name: "Alpha", persona: "private persona", harness: "pi" },
    ctx,
  );
  const b = agents.createAgentProfile(
    { name: "Beta", persona: "private persona", harness: "pi" },
    ctx,
  );
  agents.addProjectMember(p.id, a.id, ctx);
  agents.addProjectMember(p.id, b.id, ctx);
  const chat = chats.createGroupChat(
    p.id,
    {
      projectId: p.id,
      title: "Group",
      wakePolicy: "owner_led",
      members: [
        { kind: "human", id: ctx.userId },
        { kind: "agent", id: a.id },
        { kind: "agent", id: b.id },
      ],
      initialOwner: { kind: "agent", id: a.id },
    },
    { kind: "human", userId: ctx.userId, ctx },
  );
  const instanceA = chats.ensureInstance(chat.id, a.id, ctx);
  const instanceB = chats.ensureInstance(chat.id, b.id, ctx);
  const neighbor = chats.createDirectChat(p.id, a.id, ctx).chat;
  const neighborInstance = chats.ensureInstance(neighbor.id, a.id, ctx);
  const addRun = (
    instance = instanceA,
    status: "queued" | "running" | "failed" | "completed" = "running",
  ) => {
    const id = newId(ID_PREFIXES.run);
    db.insert(schema.agentRun)
      .values({
        id,
        instanceId: instance.id,
        projectId: p.id,
        chatId: instance.chatId,
        requestId: ctx.requestId,
        sessionId: instance.id,
        status,
        ...(status === "running" ? { startedAt: new Date() } : {}),
        ...(status === "failed" || status === "completed"
          ? {
              settledAt: new Date(),
              ...(status === "failed"
                ? { errorCode: "fixture_failure", errorMessage: "safe failure" }
                : {}),
            }
          : {}),
      })
      .run();
    return id;
  };
  const runA = addRun(instanceA),
    runB = addRun(instanceB),
    runNeighbor = addRun(neighborInstance);
  const agentCtx = {
    ...ctx,
    agent: { runId: runA, instanceId: instanceA.id, agentProfileId: a.id },
  };
  const hold = (instance = instanceA) => {
    const id = newId(ID_PREFIXES.machine);
    sqlite
      .prepare(
        "INSERT INTO machine(id,name,created_by,created_at,updated_at) VALUES (?,'P6b machine',?,1,1)",
      )
      .run(id, ctx.userId);
    sqlite
      .prepare(
        "INSERT INTO project_machine(project_id,machine_id,created_by,revision,created_at,updated_at) VALUES (?,?,?,1,1,1)",
      )
      .run(p.id, id, ctx.userId);
    sqlite
      .prepare(
        "INSERT INTO machine_lease(project_id,machine_id,generation,state,holder_instance_id,changed_at) VALUES (?,?,1,'held',?,1)",
      )
      .run(p.id, id, instance.id);
    return id;
  };
  const machineA = hold(instanceA),
    machineB = hold(instanceB);
  const task = tasks.createTask(
    {
      projectId: p.id,
      title: "Task summary",
      description: "SECRET_TASK_BODY",
      constraints: "SECRET_CONSTRAINT",
      completionRequirements: "SECRET_REQUIREMENT",
      checklist: ["SECRET_CHECKLIST"],
    },
    ctx,
  ).detail;
  tasks.assignTask(
    { taskId: task.task.id, expectedRevision: task.task.revision, targetChatId: chat.id },
    ctx,
  );
  chats.sendMessage(
    chat.id,
    { senderKind: "human", senderId: ctx.userId, body: "SECRET_CHAT_BODY" },
    ctx,
  );
  let assertions = 0;
  const check = (value: unknown, message: string) => {
    assert.ok(value, message);
    assertions++;
  };
  const equal = (actual: unknown, expected: unknown, message?: string) => {
    assert.deepEqual(actual, expected, message);
    assertions++;
  };
  const throws = (fn: () => unknown, code?: string) => {
    assert.throws(
      fn,
      (error) => !code || (error instanceof Error && "code" in error && error.code === code),
    );
    assertions++;
  };
  const finish = () => {
    console.log(
      JSON.stringify({
        gate: label,
        assertions,
        elapsedMs: Math.round((performance.now() - started) * 10) / 10,
      }),
    );
    sqlite.close();
    rmSync(directory, { recursive: true, force: true });
  };
  return {
    runtime,
    directory,
    started,
    db,
    sqlite,
    openDatabase,
    schema,
    ID_PREFIXES,
    newId,
    project,
    agents,
    chats,
    info,
    turns,
    tasks,
    projectInfoHubSchema,
    chatInfoViewSchema,
    INFO_HUB_LIMITS,
    ctx,
    p,
    a,
    b,
    chat,
    neighbor,
    instanceA,
    instanceB,
    neighborInstance,
    runA,
    runB,
    runNeighbor,
    agentCtx,
    machineA,
    machineB,
    hold,
    addRun,
    check,
    equal,
    throws,
    finish,
  };
}
