import { afterAll, describe, expect, it } from "vite-plus/test";
import { mkdtempSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";

const directory = mkdtempSync(join(tmpdir(), "crew-blockers-"));
process.env.DATABASE_URL = join(directory, "test.sqlite");
process.env.SPROUT_PI_ENABLED = "false";
process.env.BETTER_AUTH_SECRET = randomUUID();
const { migrateDatabase } = await import("../../src/db/migrate");
migrateDatabase();
const { db, sqlite } = await import("../../src/db");
const { newId, ID_PREFIXES } = await import("../../src/contracts/ids");
const s = await import("../../src/db/schema");
const chats = await import("../../src/domain/chat");
const agents = await import("../../src/domain/agent");
const { createProject } = await import("../../src/domain/project");
const { resolveAutomationTarget } = await import("../../src/domain/automation-target");
const { taskResponsibilityFacts } = await import("../../src/domain/task-capabilities");
const { setChatOwnerCompat } = await import("./crew-chat");
const ctx = { userId: "crew-human", requestId: randomUUID() };
const actor = { kind: "human" as const, userId: ctx.userId, ctx };
for (const id of [ctx.userId, "crew-other"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, id, `${id}@test.example`);
function fixture() {
  const project = createProject({ name: "Crew" }, ctx);
  const lead = agents.createAgentProfile(
    { name: `Lead ${project.id}`, persona: "", harness: "pi" },
    ctx,
  );
  const worker = agents.createAgentProfile(
    { name: `Worker ${project.id}`, persona: "", harness: "pi" },
    ctx,
  );
  agents.addProjectMember(project.id, lead.id, ctx);
  agents.addProjectMember(project.id, worker.id, ctx);
  const row = db
    .select()
    .from(s.chat)
    .where(and(eq(s.chat.projectId, project.id), eq(s.chat.kind, "crew")))
    .get()!;
  for (const agent of [lead, worker])
    db.insert(s.chatMember)
      .values({ chatId: row.id, memberKind: "agent", memberId: agent.id })
      .onConflictDoNothing()
      .run();
  chats.initializeCrewLead(row.id, lead.id);
  const current = () => chats.getChat(row.id, ctx);
  const instance = (profileId: string, chatId = row.id) => {
    const id = newId(ID_PREFIXES.instance);
    db.insert(s.agentInstance)
      .values({ id, projectId: project.id, chatId, agentProfileId: profileId })
      .run();
    return id;
  };
  return { project, lead, worker, chatId: row.id, current, instance };
}
function lease(
  f: ReturnType<typeof fixture>,
  holderInstanceId: string,
  state: "held" | "fencing",
  targetInstanceId?: string,
) {
  const now = new Date();
  const machineId = newId(ID_PREFIXES.machine);
  db.insert(s.machine)
    .values({
      id: machineId,
      name: "Machine",
      createdBy: ctx.userId,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(s.projectMachine)
    .values({
      projectId: f.project.id,
      machineId,
      createdBy: ctx.userId,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(s.machineLease)
    .values({
      ownerKind: "instance",
      projectId: f.project.id,
      machineId,
      generation: 1,
      state,
      holderInstanceId,
      changedAt: now,
    })
    .run();
  if (targetInstanceId) {
    db.insert(s.leaseAuthorization)
      .values({
        ownerKind: "instance",
        projectId: f.project.id,
        machineId,
        generation: 1,
        holderInstanceId,
        state: "draining",
        issuedAt: now,
        reason: "acquire",
      })
      .run();
    db.insert(s.leaseMutation)
      .values({
        id: newId(ID_PREFIXES.leaseMutation),
        projectId: f.project.id,
        machineId,
        actorKind: "agent",
        actorId: holderInstanceId,
        requestId: randomUUID(),
        payloadHash: "a".repeat(64),
        action: "handoff",
        expectedGeneration: 1,
        targetInstanceId,
        state: "pending",
        createdAt: now,
      })
      .run();
  }
  return () => {
    db.delete(s.leaseMutation).where(eq(s.leaseMutation.machineId, machineId)).run();
    db.update(s.machineLease)
      .set({ state: "free", holderInstanceId: null, ownerKind: null })
      .where(eq(s.machineLease.machineId, machineId))
      .run();
  };
}
function blocked(action: () => unknown, kind: string, relation?: string) {
  expect(action).toThrowError(
    expect.objectContaining({
      code: "project_member_removal_blocked",
      details: expect.objectContaining({
        blockers: expect.arrayContaining([
          expect.objectContaining({
            kind,
            ...(relation
              ? { items: expect.arrayContaining([expect.objectContaining({ relation })]) }
              : {}),
          }),
        ]),
      }),
    }),
  );
}
afterAll(() => {
  sqlite.close();
  rmSync(directory, { recursive: true, force: true });
});

describe("CR1 Crew governance regressions", () => {
  it("enrolls only the first Project Agent into its initial Crew atomically", () => {
    const project = createProject({ name: "Manual project" }, ctx);
    const first = agents.createAgentProfile({ name: "First", persona: "", harness: "pi" }, ctx);
    const second = agents.createAgentProfile({ name: "Second", persona: "", harness: "pi" }, ctx);
    expect(() =>
      agents.addProjectMember(project.id, first.id, ctx, {
        afterWrite: () => {
          throw new Error("rollback-first-enrollment");
        },
      }),
    ).toThrow("rollback-first-enrollment");
    const initial = db.select().from(s.chat).where(eq(s.chat.projectId, project.id)).get()!;
    expect(agents.listProjectMembers(project.id, ctx)).toEqual([]);
    expect(chats.getChat(initial.id, ctx)).toMatchObject({ crewEpoch: 0 });
    expect(chats.listChatMembers(initial.id, ctx).filter((m) => m.memberKind === "agent")).toEqual(
      [],
    );
    agents.addProjectMember(project.id, first.id, ctx);
    const crew = db.select().from(s.chat).where(eq(s.chat.projectId, project.id)).get()!;
    expect(chats.getChat(crew.id, ctx)).toMatchObject({ leadProfileId: first.id, crewEpoch: 1 });
    agents.addProjectMember(project.id, second.id, ctx);
    expect(
      chats
        .listChatMembers(crew.id, ctx)
        .filter((m) => m.memberKind === "agent")
        .map((m) => m.memberId),
    ).toEqual([first.id]);
  });

  it.each(["vacant", "assigned"] as const)(
    "does not auto-enroll the first Project Agent into a previously initialized %s Crew",
    (kind) => {
      const project = createProject({ name: "Previously initialized" }, ctx);
      const profile = agents.createAgentProfile({ name: `Later first ${project.id}` }, ctx);
      const row = db.select().from(s.chat).where(eq(s.chat.projectId, project.id)).get()!;
      db.update(s.chat)
        .set({
          crewEpoch: kind === "assigned" ? 0 : 5,
          leadProfileId: kind === "assigned" ? profile.id : null,
        })
        .where(eq(s.chat.id, row.id))
        .run();
      agents.addProjectMember(project.id, profile.id, ctx);
      expect(chats.listChatMembers(row.id, ctx).filter((m) => m.memberKind === "agent")).toEqual(
        [],
      );
      expect(chats.getChat(row.id, ctx).crewEpoch).toBe(kind === "assigned" ? 0 : 5);
    },
  );

  it("ignores responsibility held by the same Agent in a different chat", () => {
    const f = fixture();
    const dm = chats.createDirectChat(f.project.id, f.worker.id, ctx);
    lease(f, dm.instance.id, "held");
    const removed = chats.removeCrewMember(
      f.chatId,
      { kind: "agent", id: f.worker.id },
      f.current().governanceRevision,
      actor,
    );
    const enrolled = chats.addCrewMember(
      f.chatId,
      { kind: "agent", id: f.worker.id },
      removed.governanceRevision,
      actor,
    );
    const leadDm = chats.createDirectChat(f.project.id, f.lead.id, ctx);
    db.insert(s.agentRun)
      .values({
        id: newId(ID_PREFIXES.run),
        projectId: f.project.id,
        chatId: leadDm.chat.id,
        instanceId: leadDm.instance.id,
        requestId: randomUUID(),
        sessionId: randomUUID(),
        status: "running",
        startedAt: new Date(),
      })
      .run();
    expect(
      chats.setCrewLead(f.chatId, f.worker.id, enrolled.governanceRevision, actor).leadProfileId,
    ).toBe(f.worker.id);
  });

  it("resolves configured Crew workers to the lead and rejects an empty lead", () => {
    const f = fixture();
    const action = { kind: "group_agent" as const, chatId: f.chatId, agentProfileId: f.worker.id };
    expect(resolveAutomationTarget(f.project.id, action, ctx)).toEqual({
      chatId: f.chatId,
      agentProfileId: f.lead.id,
    });
    db.update(s.chat).set({ leadProfileId: null }).where(eq(s.chat.id, f.chatId)).run();
    expect(resolveAutomationTarget(f.project.id, action, ctx)).toEqual({
      reason: "crew_lead_missing",
    });
  });

  it("blocks lead changes while the old lead has a run, then advances epoch and revision", () => {
    const f = fixture();
    const instanceId = f.instance(f.lead.id);
    const runId = newId(ID_PREFIXES.run);
    db.insert(s.agentRun)
      .values({
        id: runId,
        projectId: f.project.id,
        chatId: f.chatId,
        instanceId,
        requestId: randomUUID(),
        status: "running",
        sessionId: randomUUID(),
        startedAt: new Date(),
      })
      .run();
    const before = f.current();
    blocked(
      () => chats.setCrewLead(f.chatId, f.worker.id, before.governanceRevision, actor),
      "active_runs",
    );
    expect(f.current()).toEqual(before);
    db.update(s.agentRun)
      .set({ status: "interrupted", settledAt: new Date() })
      .where(eq(s.agentRun.id, runId))
      .run();
    const next = setChatOwnerCompat(
      f.chatId,
      { kind: "agent", id: f.worker.id },
      before.governanceRevision,
      actor,
    );
    expect(next).toMatchObject({
      leadProfileId: f.worker.id,
      crewEpoch: before.crewEpoch + 1,
      governanceRevision: before.governanceRevision + 1,
    });
    expect(() =>
      chats.setCrewLead(f.chatId, f.lead.id, before.governanceRevision, actor),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
  });

  it.each(
    (["lead", "worker"] as const).flatMap((role) =>
      (["held", "fencing", "handoff_target"] as const).map((kind) => ({ role, kind })),
    ),
  )("blocks $role governance for $kind responsibility", ({ role, kind }) => {
    const f = fixture();
    const target = f.instance(f[role].id);
    const other = f.instance(f[role === "lead" ? "worker" : "lead"].id);
    const release = lease(
      f,
      kind === "handoff_target" ? other : target,
      kind === "held" ? "held" : "fencing",
      kind === "handoff_target" ? target : undefined,
    );
    const before = f.current();
    const action = () =>
      role === "lead"
        ? chats.setCrewLead(f.chatId, f.worker.id, before.governanceRevision, actor)
        : chats.removeCrewMember(
            f.chatId,
            { kind: "agent", id: f.worker.id },
            before.governanceRevision,
            actor,
          );
    blocked(action, "leases", kind === "handoff_target" ? "handoff_target" : "holder");
    expect(f.current()).toEqual(before);
    release();
    expect(action().governanceRevision).toBe(before.governanceRevision + 1);
  });

  it("never reinitializes a vacant lead after epoch zero", () => {
    const f = fixture();
    db.update(s.chat)
      .set({ leadProfileId: null, crewEpoch: 7 })
      .where(eq(s.chat.id, f.chatId))
      .run();
    chats.initializeCrewLead(f.chatId, f.worker.id);
    expect(f.current()).toMatchObject({ crewEpoch: 7 });
    expect(f.current().leadProfileId).toBeUndefined();
    const added = chats.addCrewMember(
      f.chatId,
      { kind: "agent", id: f.worker.id },
      f.current().governanceRevision,
      actor,
    );
    expect(added.leadProfileId).toBeUndefined();
    const assigned = chats.setCrewLead(f.chatId, f.worker.id, added.governanceRevision, actor);
    expect(assigned.crewEpoch).toBe(8);
  });

  it("routes compatibility governance through owner authorization", () => {
    const f = fixture();
    const otherCtx = { ...ctx, userId: "crew-other" };
    expect(() =>
      setChatOwnerCompat(
        f.chatId,
        { kind: "agent", id: f.worker.id },
        f.current().governanceRevision,
        { kind: "human", userId: otherCtx.userId, ctx: otherCtx },
      ),
    ).toThrow();
    expect(f.current().leadProfileId).toBe(f.lead.id);
  });

  it("exposes Crew stop through an authenticated and validated server boundary", async () => {
    const { auth } = await import("../../src/lib/auth");
    const { setCrewModeBoundary } = await import("../../src/server/functions/chat");
    const signed = await auth.api.signUpEmail({
      body: {
        email: `${randomUUID()}@crew.test`,
        password: "crew-test-password-123",
        name: "Crew owner",
      },
      returnHeaders: true,
    });
    const ownerCtx = { userId: signed.response.user.id, requestId: randomUUID() };
    const headers = new Headers({ cookie: signed.headers.get("set-cookie")!.split(";")[0] });
    const project = createProject({ name: "Boundary Crew" }, ownerCtx);
    const row = db.select().from(s.chat).where(eq(s.chat.projectId, project.id)).get()!;
    const input = { chatId: row.id, mode: "stopped", expectedRevision: row.governanceRevision };
    expect(await setCrewModeBoundary(input, new Headers(), ownerCtx.requestId)).toMatchObject({
      ok: false,
      error: { code: "unauthorized" },
    });
    expect(
      await setCrewModeBoundary({ ...input, mode: "off" }, headers, ownerCtx.requestId),
    ).toMatchObject({ ok: false, error: { code: "validation_failed" } });
    expect(await setCrewModeBoundary(input, headers, ownerCtx.requestId)).toMatchObject({
      ok: true,
      data: { control: "stopped", governanceRevision: row.governanceRevision + 1 },
    });
    expect(
      await setCrewModeBoundary({ ...input, mode: "active" }, headers, ownerCtx.requestId),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("stops Crew intake by owner CAS without terminating runs, and resumes explicitly", () => {
    const f = fixture();
    const runId = newId(ID_PREFIXES.run);
    db.insert(s.agentRun)
      .values({
        id: runId,
        projectId: f.project.id,
        chatId: f.chatId,
        instanceId: f.instance(f.lead.id),
        requestId: randomUUID(),
        status: "running",
        sessionId: randomUUID(),
        startedAt: new Date(),
      })
      .run();
    const before = f.current();
    const otherCtx = { ...ctx, userId: "crew-other" };
    expect(() =>
      chats.setCrewMode(f.chatId, "stopped", before.governanceRevision, {
        kind: "human",
        userId: otherCtx.userId,
        ctx: otherCtx,
      }),
    ).toThrow();
    const stopped = chats.setCrewMode(f.chatId, "stopped", before.governanceRevision, actor);
    expect(stopped).toMatchObject({
      control: "stopped",
      governanceRevision: before.governanceRevision + 1,
    });
    expect(() =>
      chats.sendMessage(
        f.chatId,
        { senderKind: "human", senderId: ctx.userId, body: "new input" },
        ctx,
      ),
    ).toThrow();
    expect(() => taskResponsibilityFacts(f.chatId, ctx)).toThrowError(
      expect.objectContaining({ code: "task_assignment_invalid" }),
    );
    expect(
      resolveAutomationTarget(f.project.id, { kind: "group_owner", chatId: f.chatId }, ctx),
    ).toEqual({ reason: "chat_stopped" });
    expect(db.select().from(s.agentRun).where(eq(s.agentRun.id, runId)).get()?.status).toBe(
      "running",
    );
    expect(() =>
      chats.setCrewMode(f.chatId, "active", before.governanceRevision, actor),
    ).toThrowError(expect.objectContaining({ code: "conflict" }));
    const active = chats.setCrewMode(f.chatId, "active", stopped.governanceRevision, actor);
    expect(active.control).toBe("active");
    expect(taskResponsibilityFacts(f.chatId, ctx)).toMatchObject({ agentProfileId: f.lead.id });
    expect(
      chats.sendMessage(
        f.chatId,
        { senderKind: "human", senderId: ctx.userId, body: "resumed" },
        ctx,
      ).body,
    ).toBe("resumed");
  });
});
