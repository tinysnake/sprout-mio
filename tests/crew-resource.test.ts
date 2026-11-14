import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "crew-resource-")), "test.sqlite");
const { db, sqlite } = await import("../src/db");
const { migrateDatabase } = await import("../src/db/migrate");
const { newId, ID_PREFIXES } = await import("../src/contracts/ids");
const { createMachine, saveProjectMachineBinding } = await import("../src/domain/machine");
const {
  requestCrewResource,
  approveCrewResource,
  advanceCrewResources,
  reconcileCrewResources,
  releaseCrewResource,
  assertCrewExecutionScope,
  crewResourcesReady,
  deliverCrewResourceEvents,
} = await import("../src/domain/crew-resource");
const { cancelExecution } = await import("../src/server/remote");
const { recoverAgentRuns, queuedRunWork } = await import("../src/domain/agent-run");
const { dispatchDelegation } = await import("../src/domain/delegation");
const { authorityNow, acquireLease, assertExecutionWrite, forceReclaimLease } =
  await import("../src/server/lease");
const { setCrewLead, removeCrewMember } = await import("../src/domain/chat");
const { crewResourceRequest } = await import("../src/db/schema");
const { eq } = await import("drizzle-orm");
migrateDatabase();
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','crew-resource@example.test',0,1,1)",
  )
  .run();
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
function fixture() {
  const projectId = newId(ID_PREFIXES.project),
    crewChatId = newId(ID_PREFIXES.chat);
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Resources','owner')")
    .run(projectId);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?,?,'crew','human','owner','owner')",
    )
    .run(crewChatId, projectId);
  const human = { userId: "owner", bootId, now: new Date(), requestId: newId(ID_PREFIXES.request) };
  function actor(chatId: string, status = "queued") {
    const profileId = newId(ID_PREFIXES.agentProfile),
      instanceId = newId(ID_PREFIXES.instance),
      runId = newId(ID_PREFIXES.run);
    sqlite
      .prepare("INSERT INTO agent_profile(id,name,created_by) VALUES (?, ?,'owner')")
      .run(profileId, profileId);
    sqlite
      .prepare(
        "INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES (?,?,'owner')",
      )
      .run(projectId, profileId);
    sqlite
      .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
      .run(crewChatId, profileId);
    sqlite
      .prepare(
        "INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)",
      )
      .run(instanceId, profileId, chatId, projectId);
    sqlite
      .prepare(
        "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        runId,
        instanceId,
        chatId,
        projectId,
        newId(ID_PREFIXES.request),
        status,
        status === "running" ? 1 : null,
        crypto.randomUUID(),
      );
    return { projectId, instanceId, runId, profileId, chatId };
  }
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'human','owner')")
    .run(crewChatId);
  const lead = actor(crewChatId, "running");
  sqlite.prepare("UPDATE chat SET lead_profile_id=? WHERE id=?").run(lead.profileId, crewChatId);
  function worker() {
    const chatId = newId(ID_PREFIXES.chat),
      delegationId = newId(ID_PREFIXES.delegation);
    sqlite
      .prepare(
        "INSERT INTO chat(id,project_id,kind,parent_crew_chat_id,owner_kind,owner_id,created_by) VALUES (?,?,'delegation',?,'human','owner','owner')",
      )
      .run(chatId, projectId, crewChatId);
    const w = actor(chatId);
    sqlite
      .prepare(
        "INSERT INTO delegation(id,project_id,parent_crew_chat_id,child_chat_id,dispatch_lead_profile_id,crew_epoch,worker_profile_id,worker_instance_id,request_summary,status,client_request_id,started_at) VALUES (?,?,?,?,?,0,?,?,'work','running',?,1)",
      )
      .run(
        delegationId,
        projectId,
        crewChatId,
        chatId,
        lead.profileId,
        w.profileId,
        w.instanceId,
        newId(ID_PREFIXES.request),
      );
    return { ...w, delegationId };
  }
  const machineId = createMachine({ name: "Crew resource machine" }, human).detail.machine.id;
  saveProjectMachineBinding(
    { projectId, machineId, description: "", expectedRevision: null },
    human,
  );
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',1)",
    )
    .run(projectId, machineId);
  sqlite
    .prepare(
      "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at) VALUES (?,1,?,?,'open',1,1)",
    )
    .run(machineId, newId(ID_PREFIXES.request), bootId);
  sqlite
    .prepare(
      "INSERT INTO directory_observation(machine_id,generation,project_id,revision,seq,checked_at,kind,real_path) VALUES (?,1,?,1,1,1,'accessible','/workspace')",
    )
    .run(machineId, projectId);
  const key = { projectId, machineId };
  function input(w: ReturnType<typeof worker>) {
    return {
      crewChatId,
      crewEpoch: 0,
      subjectKind: "delegation" as const,
      delegationId: w.delegationId,
      attempt: 1,
      runId: w.runId,
      machineId,
      membershipEpoch: 1,
      directoryRealPath: "/workspace",
      directoryRevision: 1,
      operations: ["shell" as const],
      clientRequestId: crypto.randomUUID(),
    };
  }
  function approved(w: ReturnType<typeof worker>) {
    const r = requestCrewResource(input(w), w);
    return approveCrewResource(
      { resourceRequestId: r.id, crewEpoch: 0, expectedRevision: r.revision },
      lead,
    );
  }
  return { projectId, crewChatId, lead, human, key, worker, input, approved };
}
function row(id: string) {
  return db.select().from(crewResourceRequest).where(eq(crewResourceRequest.id, id)).get()!;
}
function dispatched(
  f: ReturnType<typeof fixture>,
  w: ReturnType<ReturnType<typeof fixture>["worker"]>,
  generation: number,
) {
  const now = Date.now(),
    id = newId(ID_PREFIXES.execution);
  sqlite
    .prepare(
      "INSERT INTO worker_exchange_frame(machine_id,connection_generation,seq,payload_hash,response_json,created_at) VALUES (?,1,1,?,'{}',?)",
    )
    .run(f.key.machineId, "a".repeat(64), now);
  sqlite
    .prepare(
      "INSERT INTO remote_execution(id,project_id,machine_id,authorization_generation,holder_instance_id,run_id,chat_id,request_id,payload_hash,operation_json,state,created_at,dispatch_deadline_at,dispatch_connection_generation,dispatch_seq,dispatched_at) VALUES (?,?,?,?,?,?,?,?,?,'{}','dispatched',?,?,1,1,?)",
    )
    .run(
      id,
      f.projectId,
      f.key.machineId,
      generation,
      w.instanceId,
      w.runId,
      w.chatId,
      newId(ID_PREFIXES.request),
      "b".repeat(64),
      now,
      now + 60000,
      now,
    );
  return id;
}
test("release keeps the slot until dispatched terminal execution has a drain receipt; reconciliation is idempotent", () => {
  const f = fixture(),
    w = f.worker(),
    next = f.worker(),
    r = f.approved(w),
    q = f.approved(next);
  advanceCrewResources();
  const id = dispatched(f, w, row(r.id).generation!);
  releaseCrewResource(r.id, w);
  const revision = row(r.id).revision;
  reconcileCrewResources();
  reconcileCrewResources();
  assert.equal(row(r.id).revision, revision);
  assert.equal(row(r.id).state, "releasing");
  assert.equal(advanceCrewResources(), 0);
  sqlite
    .prepare(
      "UPDATE remote_execution SET state='failed',failure_reason='executor_error',terminal_at=? WHERE id=?",
    )
    .run(Date.now(), id);
  reconcileCrewResources();
  assert.equal(row(r.id).state, "releasing");
  sqlite.prepare("UPDATE remote_execution SET drained_at=? WHERE id=?").run(Date.now(), id);
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
  advanceCrewResources();
  assert.equal(row(q.id).state, "active");
});
test("Human force reclaim records unconfirmed drain and blocks automatic worker reallocation", () => {
  const f = fixture(),
    w = f.worker(),
    next = f.worker(),
    r = f.approved(w),
    q = f.approved(next);
  advanceCrewResources();
  dispatched(f, w, row(r.id).generation!);
  releaseCrewResource(r.id, w);
  const pending = row(r.id);
  forceReclaimLease(
    {
      ...f.key,
      action: "force_reclaim",
      mutationId: pending.mutationId!,
      expectedGeneration: pending.generation!,
      confirm: true,
    },
    { ...f.human, now: new Date() },
  );
  reconcileCrewResources();
  assert.equal(row(r.id).state, "attention");
  assert.equal(row(r.id).reason, "drain_unconfirmed");
  advanceCrewResources();
  assert.equal(row(q.id).state, "queued");
  assert.ok(
    sqlite
      .prepare("SELECT id FROM crew_resource_event WHERE request_id=? AND audience='human'")
      .get(r.id),
  );
});
test("lead change and member removal cannot discard active resource responsibilities", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  const actor = {
    kind: "human" as const,
    userId: "owner",
    ctx: { userId: "owner", requestId: newId(ID_PREFIXES.request) },
  };
  assert.throws(() => setCrewLead(f.crewChatId, w.profileId, 0, actor));
  assert.throws(() => removeCrewMember(f.crewChatId, { kind: "agent", id: w.profileId }, 0, actor));
  sqlite
    .prepare("DELETE FROM project_member WHERE project_id=? AND agent_profile_id=?")
    .run(f.projectId, w.profileId);
  assert.throws(() => assertCrewExecutionScope(f.key, row(r.id).generation!, w));
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
});
test("an orphan Crew lease without a request creates a recovery mutation before freeing", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  sqlite
    .prepare("UPDATE lease_mutation SET resource_request_id=NULL WHERE resource_request_id=?")
    .run(r.id);
  sqlite.prepare("DELETE FROM crew_resource_event WHERE request_id=?").run(r.id);
  sqlite.prepare("DELETE FROM crew_resource_request WHERE id=?").run(r.id);
  reconcileCrewResources();
  assert.equal(authorityNow(f.key)?.state, "free");
  assert.ok(
    sqlite
      .prepare(
        "SELECT id FROM lease_mutation WHERE request_id LIKE 'crew-recovery:%' AND project_id=?",
      )
      .get(f.projectId),
  );
});
test("dispatch atomically preapproves resources and gates the original queued run", () => {
  const f = fixture(),
    w = f.worker(),
    scope = f.input(w);
  const resource = {
    machineId: scope.machineId,
    membershipEpoch: scope.membershipEpoch,
    directoryRealPath: scope.directoryRealPath,
    directoryRevision: scope.directoryRevision,
    operations: scope.operations,
  };
  const input = {
    chatId: f.crewChatId,
    workerProfileId: w.profileId,
    request: "run after allocation",
    clientRequestId: crypto.randomUUID(),
    resources: [resource],
  };
  const ctx = {
    userId: "owner",
    requestId: newId(ID_PREFIXES.request),
    agent: { agentProfileId: f.lead.profileId, instanceId: f.lead.instanceId, runId: f.lead.runId },
  };
  const result = dispatchDelegation(input, ctx);
  const request = db
    .select()
    .from(crewResourceRequest)
    .where(eq(crewResourceRequest.delegationId, result.delegationId))
    .get()!;
  assert.equal(request.approval, "approved");
  assert.equal(
    queuedRunWork().some((x) => x.run.id === request.runId),
    false,
  );
  assert.equal(dispatchDelegation(input, ctx).delegationId, result.delegationId);
  assert.throws(
    () =>
      dispatchDelegation(
        { ...input, resources: [{ ...resource, directoryRealPath: "/other" }] },
        ctx,
      ),
    /payload/,
  );
  advanceCrewResources();
  assert.equal(
    queuedRunWork().some((x) => x.run.id === request.runId),
    true,
  );
  const n = (
    sqlite
      .prepare("SELECT count(*) AS n FROM delegation WHERE parent_crew_chat_id=?")
      .get(f.crewChatId) as { n: number }
  ).n;
  assert.throws(() =>
    dispatchDelegation(
      {
        ...input,
        clientRequestId: crypto.randomUUID(),
        resources: [{ ...resource, directoryRevision: 999 }],
      },
      ctx,
    ),
  );
  assert.equal(
    (
      sqlite
        .prepare("SELECT count(*) AS n FROM delegation WHERE parent_crew_chat_id=?")
        .get(f.crewChatId) as { n: number }
    ).n,
    n,
  );
});
test("directory approval cannot reuse observations from an earlier connection or root revision", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  sqlite
    .prepare("UPDATE machine_connection SET status='closed',closed_at=? WHERE machine_id=?")
    .run(Date.now(), f.key.machineId);
  sqlite
    .prepare(
      "INSERT INTO machine_connection(machine_id,generation,attempt_id,boot_id,status,opened_at,last_seen_at) VALUES (?,2,?,?,'open',?,?)",
    )
    .run(f.key.machineId, crypto.randomUUID(), bootId, Date.now(), Date.now());
  assert.throws(() => assertCrewExecutionScope(f.key, row(r.id).generation!, w));
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
  const f2 = fixture(),
    w2 = f2.worker();
  sqlite
    .prepare("UPDATE machine SET root_revision=root_revision+1 WHERE id=?")
    .run(f2.key.machineId);
  assert.throws(() => requestCrewResource(f2.input(w2), w2), /directory/);
});
test("two workers share one Crew owner in FIFO order; grant binds run, attempt, operation and directory", () => {
  const f = fixture(),
    a = f.worker(),
    b = f.worker(),
    ra = f.approved(a),
    rb = f.approved(b);
  assert.equal(crewResourcesReady(a.runId), false);
  assert.equal(advanceCrewResources(), 1);
  assert.equal(row(ra.id).state, "active");
  assert.equal(row(rb.id).state, "queued");
  const auth = authorityNow(f.key)!;
  assert.equal(auth.ownerKind, "crew");
  assert.equal(auth.holderInstanceId, a.instanceId);
  assert.equal(auth.ownerCrewChatId, f.crewChatId);
  assertCrewExecutionScope(f.key, auth.generation, a, { kind: "shell", cwd: "/workspace/src" }, 1);
  assert.throws(() =>
    assertCrewExecutionScope(
      f.key,
      auth.generation,
      a,
      { kind: "shell", cwd: "/workspace-evil" },
      1,
    ),
  );
  assert.throws(() =>
    assertCrewExecutionScope(
      f.key,
      auth.generation,
      a,
      { kind: "file_write", path: "/workspace/a" },
      1,
    ),
  );
  assert.throws(() => assertCrewExecutionScope(f.key, auth.generation, { ...a, runId: b.runId }));
  releaseCrewResource(ra.id, a);
  reconcileCrewResources();
  assert.equal(row(ra.id).state, "released");
  advanceCrewResources();
  assert.equal(row(rb.id).state, "active");
});
test("idempotency compares payload and validates epoch, attempt, directory and membership", () => {
  const f = fixture(),
    w = f.worker(),
    input = f.input(w),
    r = requestCrewResource(input, w);
  assert.equal(requestCrewResource({ ...input, operations: ["shell"] }, w).id, r.id);
  assert.throws(() => requestCrewResource({ ...input, directoryRealPath: "/other" }, w), /payload/);
  for (const patch of [
    { crewEpoch: 1 },
    { attempt: 2 },
    { directoryRealPath: "/other" },
    { membershipEpoch: 2 },
  ])
    assert.throws(() =>
      requestCrewResource({ ...input, ...patch, clientRequestId: crypto.randomUUID() }, w),
    );
  assert.throws(() =>
    approveCrewResource({ resourceRequestId: r.id, crewEpoch: 1, expectedRevision: 0 }, f.lead),
  );
});
test("a grant committed before admission preserves only its original queued run on recovery", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  recoverAgentRuns();
  assert.equal(
    (sqlite.prepare("SELECT status FROM agent_run WHERE id=?").get(w.runId) as { status: string })
      .status,
    "queued",
  );
  assert.equal(crewResourcesReady(w.runId), true);
  sqlite.prepare("UPDATE agent_run SET status='interrupted',settled_at=2 WHERE id=?").run(w.runId);
  const nextRunId = newId(ID_PREFIXES.run);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',1,?)",
    )
    .run(
      nextRunId,
      w.instanceId,
      w.chatId,
      w.projectId,
      newId(ID_PREFIXES.request),
      crypto.randomUUID(),
    );
  assert.throws(() =>
    assertCrewExecutionScope(f.key, row(r.id).generation!, { ...w, runId: nextRunId }),
  );
});
test("held without pending mutation creates durable recovery receipt before releasing", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  db.update(crewResourceRequest)
    .set({ state: "held", mutationId: null })
    .where(eq(crewResourceRequest.id, r.id))
    .run();
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
  assert.ok(
    sqlite
      .prepare("SELECT id FROM lease_mutation WHERE resource_request_id=? AND action='release'")
      .get(r.id),
  );
});
test("stop and delegation terminal freeze writes; parent lead ending keeps worker resource", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  sqlite
    .prepare("UPDATE agent_run SET status='interrupted',settled_at=2 WHERE id=?")
    .run(f.lead.runId);
  reconcileCrewResources();
  assert.equal(row(r.id).state, "active");
  sqlite.prepare("INSERT INTO crew_control(chat_id,mode) VALUES (?,'stopped')").run(f.crewChatId);
  assert.throws(() => assertCrewExecutionScope(f.key, row(r.id).generation!, w));
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
  const g = fixture(),
    v = g.worker(),
    s = g.approved(v);
  advanceCrewResources();
  sqlite
    .prepare(
      "UPDATE delegation SET status='completed',settled_at=2,terminal_reason='done' WHERE id=?",
    )
    .run(v.delegationId);
  assert.throws(() => assertCrewExecutionScope(g.key, row(s.id).generation!, v));
  reconcileCrewResources();
  assert.equal(row(s.id).state, "released");
});
test("lead receives the full request scope and can allocate to its own exact run", () => {
  const f = fixture(),
    w = f.worker(),
    r = requestCrewResource(f.input(w), w);
  deliverCrewResourceEvents();
  const delivery = sqlite
    .prepare(
      "SELECT payload_json,bound_run_id FROM crew_resource_event WHERE request_id=? AND audience='lead'",
    )
    .get(r.id) as { payload_json: string; bound_run_id: string };
  assert.equal(delivery.bound_run_id, f.lead.runId);
  assert.deepEqual(JSON.parse(delivery.payload_json).operations, ["shell"]);
  assert.equal(JSON.parse(delivery.payload_json).machineId, f.key.machineId);
  assert.equal(JSON.parse(delivery.payload_json).runId, w.runId);
  assert.equal(crewResourcesReady(w.runId), false);
  releaseCrewResource(r.id, w);
  const input = {
    ...f.input(w),
    runId: f.lead.runId,
    subjectKind: "lead_run" as const,
    delegationId: undefined,
    attempt: undefined,
  };
  const own = requestCrewResource(input, f.lead);
  approveCrewResource({ resourceRequestId: own.id, crewEpoch: 0, expectedRevision: 0 }, f.lead);
  advanceCrewResources();
  assert.equal(row(own.id).state, "active");
  const afterExpiry = new Date(Date.now() + 86400001);
  assert.equal(crewResourcesReady(f.lead.runId, afterExpiry), false);
  assert.throws(() =>
    assertCrewExecutionScope(
      f.key,
      row(own.id).generation!,
      f.lead,
      undefined,
      undefined,
      afterExpiry,
    ),
  );
  assertCrewExecutionScope(f.key, row(own.id).generation!, f.lead, {
    kind: "shell",
    cwd: "/workspace",
  });
  assert.throws(
    () =>
      requestCrewResource({ ...input, clientRequestId: crypto.randomUUID(), attempt: 1 }, f.lead),
    /subject/,
  );
});
test("resource outbox binds once to original run and does not grant by delivery", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  deliverCrewResourceEvents();
  const before = sqlite
    .prepare("SELECT count(*) AS n FROM crew_resource_event WHERE request_id=? AND state='bound'")
    .get(r.id) as { n: number };
  assert.ok(before.n > 0);
  deliverCrewResourceEvents();
  const after = sqlite
    .prepare("SELECT count(*) AS n FROM crew_resource_event WHERE request_id=? AND state='bound'")
    .get(r.id) as { n: number };
  assert.equal(before.n, after.n);
  assert.equal(crewResourcesReady(w.runId), true);
});
test("0066 enforces owner, grant, active/released and composite identity CHECK/FK constraints", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  assert.throws(() =>
    sqlite
      .prepare("UPDATE machine_lease SET holder_instance_id=? WHERE project_id=? AND machine_id=?")
      .run(w.instanceId, f.projectId, f.key.machineId),
  );
  assert.throws(() =>
    sqlite
      .prepare("UPDATE machine_lease SET holder_crew_chat_id=? WHERE project_id=? AND machine_id=?")
      .run(newId(ID_PREFIXES.chat), f.projectId, f.key.machineId),
  );
  assert.throws(() =>
    sqlite.prepare("UPDATE crew_resource_request SET grant_id=NULL WHERE id=?").run(r.id),
  );
  assert.throws(() =>
    sqlite.prepare("UPDATE crew_resource_request SET state='released' WHERE id=?").run(r.id),
  );
  assert.throws(() =>
    sqlite
      .prepare("UPDATE crew_resource_request SET instance_id=? WHERE id=?")
      .run(f.lead.instanceId, r.id),
  );
  assert.throws(() =>
    sqlite
      .prepare("UPDATE lease_grant SET grantee_run_id=? WHERE id=?")
      .run(f.lead.runId, row(r.id).grantId),
  );
});
test("DM lease retains instance ownership and Human write semantics", () => {
  const f = fixture();
  const dmId = newId(ID_PREFIXES.chat);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by) VALUES (?, ?,'dm','human','owner','owner')",
    )
    .run(dmId, f.projectId);
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
    .run(dmId, f.lead.profileId);
  sqlite.prepare("UPDATE agent_instance SET chat_id=? WHERE id=?").run(dmId, f.lead.instanceId);
  sqlite.prepare("UPDATE agent_run SET chat_id=? WHERE id=?").run(dmId, f.lead.runId);
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare(
      "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,'owner',?,?,?,?,?,?)",
    )
    .run(
      grantId,
      "a".repeat(64),
      f.projectId,
      dmId,
      f.lead.instanceId,
      f.lead.runId,
      1,
      Date.now() + 86400000,
    );
  acquireLease(
    { ...f.key, action: "acquire", expectedGeneration: 0, requestId: newId(ID_PREFIXES.request) },
    {
      ...f.human,
      projectId: f.projectId,
      instanceId: f.lead.instanceId,
      chatId: dmId,
      runId: f.lead.runId,
      grantId,
    },
  );
  assert.equal(authorityNow(f.key)?.ownerKind, "instance");
  assertExecutionWrite(f.key, 1, f.human);
});

test("released history does not block a replacement request for the same queued run", () => {
  const f = fixture(),
    w = f.worker(),
    first = f.approved(w);
  advanceCrewResources();
  releaseCrewResource(first.id, w);
  reconcileCrewResources();
  assert.equal(row(first.id).state, "released");
  const replacement = f.approved(w);
  advanceCrewResources();
  assert.equal(crewResourcesReady(w.runId), true);
  recoverAgentRuns();
  const run = sqlite.prepare("SELECT status FROM agent_run WHERE id=?").get(w.runId) as {
    status: string;
  };
  assert.equal(run.status, "queued");
  assert.equal(row(replacement.id).state, "active");
});

test("legacy lease mutations cannot bypass Crew resource approval", () => {
  const f = fixture(),
    w = f.worker();
  sqlite.prepare("INSERT INTO crew_control(chat_id,mode) VALUES (?,'stopped')").run(f.crewChatId);
  assert.throws(
    () =>
      acquireLease(
        { ...f.key, action: "acquire", expectedGeneration: 0, requestId: newId(ID_PREFIXES.request) },
        f.lead as never,
      ),
    (error: unknown) => error instanceof Error && "code" in error,
  );
  sqlite.prepare("UPDATE crew_control SET mode='active' WHERE chat_id=?").run(f.crewChatId);
  assert.throws(
    () =>
      acquireLease(
        { ...f.key, action: "acquire", expectedGeneration: 0, requestId: newId(ID_PREFIXES.request) },
        f.lead as never,
      ),
    (error: unknown) => error instanceof Error && "code" in error,
  );
  assert.equal(authorityNow(f.key), undefined);
  void w;
});

test("human cancel is not blocked by a Crew grant", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  const executionId = dispatched(f, w, row(r.id).generation!);
  assert.throws(
    () =>
      cancelExecution(
        { executionId, requestId: newId(ID_PREFIXES.request) },
        { ...f.human, now: new Date() },
      ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "cancellation_delivery_unconfirmed",
  );
});

test("external lease release releases the active request and admits the next worker", () => {
  const f = fixture(),
    w = f.worker(),
    r = f.approved(w);
  advanceCrewResources();
  const generation = row(r.id).generation!;
  sqlite
    .prepare("UPDATE machine_lease SET state='free', owner_kind=NULL, holder_crew_chat_id=NULL, generation=generation+1 WHERE project_id=? AND machine_id=?")
    .run(f.projectId, f.key.machineId);
  sqlite
    .prepare("UPDATE lease_authorization SET state='revoked', revoked_at=issued_at+1 WHERE project_id=? AND machine_id=? AND generation=?")
    .run(f.projectId, f.key.machineId, generation);
  reconcileCrewResources();
  assert.equal(row(r.id).state, "released");
});
