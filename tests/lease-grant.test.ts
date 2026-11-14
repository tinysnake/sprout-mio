import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.DATABASE_URL = join(mkdtempSync(join(tmpdir(), "lease-grant-")), "grant.sqlite");
const { eq } = await import("drizzle-orm");
const { ID_PREFIXES, newId } = await import("../src/contracts/ids");
const { db, sqlite } = await import("../src/db");
const { migrateDatabase } = await import("../src/db/migrate");
const { leaseGrant } = await import("../src/db/schema");
const { createMachine, saveProjectMachineBinding, hashCredential } =
  await import("../src/domain/machine");
const {
  acquireLease,
  assertExecutionWrite,
  authorityNow,
  escrowLease,
  getLease,
  grantLease,
  revokeLeaseGrant,
} = await import("../src/server/lease");
type AgentRemoteContext = import("../src/server/lease").AgentRemoteContext;

migrateDatabase();
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','owner@example.test',0,1,1)",
  )
  .run();
const projectId = newId(ID_PREFIXES.project);
sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Grant','owner')").run(projectId);
const crewId = newId(ID_PREFIXES.chat);
const now = new Date();
sqlite
  .prepare(
    "INSERT INTO chat(id,project_id,kind,owner_kind,owner_id,created_by,wake_policy) VALUES (?,?,'crew','human','owner','owner','owner_led')",
  )
  .run(crewId, projectId);
function actor(name: string, chatId: string): AgentRemoteContext {
  const profileId = newId(ID_PREFIXES.agentProfile);
  const instanceId = newId(ID_PREFIXES.instance);
  const runId = newId(ID_PREFIXES.run);
  sqlite
    .prepare("INSERT INTO agent_profile(id,name,created_by) VALUES (?,?,'owner')")
    .run(profileId, name);
  sqlite
    .prepare(
      "INSERT INTO project_member(project_id,agent_profile_id,added_by) VALUES (?,?,'owner')",
    )
    .run(projectId, profileId);
  sqlite
    .prepare("INSERT INTO chat_member(chat_id,member_kind,member_id) VALUES (?,'agent',?)")
    .run(chatId, profileId);
  sqlite
    .prepare("INSERT INTO agent_instance(id,agent_profile_id,chat_id,project_id) VALUES (?,?,?,?)")
    .run(instanceId, profileId, chatId, projectId);
  sqlite
    .prepare(
      "INSERT INTO agent_run(id,instance_id,chat_id,project_id,request_id,status,started_at,session_id) VALUES (?,?,?,?,?,'running',?,?)",
    )
    .run(
      runId,
      instanceId,
      chatId,
      projectId,
      newId(ID_PREFIXES.request),
      Math.floor(now.getTime() / 1000),
      randomBytes(16).toString("hex"),
    );
  const grantId = newId(ID_PREFIXES.remoteToolGrant);
  sqlite
    .prepare(
      "INSERT INTO remote_tool_grant(id,secret_hash,user_id,project_id,chat_id,instance_id,run_id,issued_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)",
    )
    .run(
      grantId,
      hashCredential(randomBytes(32).toString("base64url")),
      "owner",
      projectId,
      chatId,
      instanceId,
      runId,
      now.getTime(),
      now.getTime() + 3_600_000,
    );
  return {
    userId: "owner",
    projectId,
    chatId,
    instanceId,
    runId,
    grantId,
    bootId,
    now,
    requestId: newId(ID_PREFIXES.request),
  };
}
const lead = actor("Lead", crewId);
const leadProfileId = sqlite
  .prepare("SELECT agent_profile_id AS id FROM agent_instance WHERE id=?")
  .get(lead.instanceId) as { id: string };
sqlite.prepare("UPDATE chat SET lead_profile_id=? WHERE id=?").run(leadProfileId.id, crewId);
const delegationChatId = newId(ID_PREFIXES.chat);
sqlite
  .prepare(
    "INSERT INTO chat(id,project_id,kind,parent_crew_chat_id,owner_kind,owner_id,created_by) VALUES (?,?,'delegation',?,'human','owner','owner')",
  )
  .run(delegationChatId, projectId, crewId);
const worker = actor("Worker", delegationChatId);
const workerProfileId = sqlite
  .prepare("SELECT agent_profile_id AS id FROM agent_instance WHERE id=?")
  .get(worker.instanceId) as { id: string };
sqlite
  .prepare(
    "INSERT INTO delegation(id,project_id,parent_crew_chat_id,child_chat_id,dispatch_lead_profile_id,crew_epoch,worker_profile_id,worker_instance_id,request_summary,status,client_request_id,started_at) VALUES (?,?,?,?,?,0,?,?,?,'running',?,?)",
  )
  .run(
    newId(ID_PREFIXES.delegation),
    projectId,
    crewId,
    delegationChatId,
    leadProfileId.id,
    workerProfileId.id,
    worker.instanceId,
    "grant test",
    newId(ID_PREFIXES.request),
    Math.floor(now.getTime() / 1000),
  );
const human = { userId: "owner", bootId, now, requestId: newId(ID_PREFIXES.request) };
const machine = createMachine({ name: "Grant machine" }, human);
const machineId = machine.detail.machine.id;
const key = { projectId, machineId };
saveProjectMachineBinding({ ...key, description: "grant", expectedRevision: null }, human);
sqlite
  .prepare(
    "INSERT OR IGNORE INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',?)",
  )
  .run(projectId, machineId, now.getTime());
acquireLease(
  { ...key, action: "acquire", expectedGeneration: 0, requestId: newId(ID_PREFIXES.request) },
  lead,
);
test("grant and revoke", () => {
  assert.equal(getLease(key, human).lease.generation, 1);

  const grant = {
    ...key,
    action: "grant" as const,
    expectedGeneration: 1,
    targetInstanceId: worker.instanceId,
    requestId: newId(ID_PREFIXES.request),
  };
  const first = grantLease(grant, lead);
  assert.equal(first.state, "completed");
  assert.equal(getLease(key, human).lease.generation, 2);
  assert.equal(authorityNow(key)?.holderInstanceId, worker.instanceId);
  const active = db
    .select()
    .from(leaseGrant)
    .where(eq(leaseGrant.projectId, projectId))
    .all()
    .filter((row: { state: string }) => row.state === "active");
  assert.equal(active.length, 1);
  assert.equal(active[0]!.granteeInstanceId, worker.instanceId);
  assert.equal(active[0]!.crewChatId, crewId);
  assert.equal(active[0]!.granteeRunId, worker.runId);
  assertExecutionWrite(key, 2, worker);
  assert.throws(
    () => assertExecutionWrite(key, 2, lead),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "lease_not_holder",
  );

  assert.throws(
    () => assertExecutionWrite(key, 1, lead),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "lease_stale_generation",
  );

  const replay = grantLease(grant, lead);
  assert.equal(replay.mutationId, first.mutationId);
  assert.equal(getLease(key, human).lease.generation, 2);

  const revoked = revokeLeaseGrant(
    {
      ...key,
      action: "revoke_grant",
      expectedGeneration: 2,
      requestId: newId(ID_PREFIXES.request),
    },
    lead,
  );
  assert.equal(revoked.state, "completed");
  assert.equal(getLease(key, human).lease.generation, 3);
  assert.equal(authorityNow(key)?.holderInstanceId, lead.instanceId);
  assert.equal(db.select().from(leaseGrant).where(eq(leaseGrant.state, "active")).all().length, 0);
  assertExecutionWrite(key, 3, lead);
  assert.throws(
    () => assertExecutionWrite(key, 2, worker),
    (error: unknown) =>
      error instanceof Error && "code" in error && error.code === "lease_stale_generation",
  );

  const otherDelegationId = newId(ID_PREFIXES.chat);
  sqlite
    .prepare(
      "INSERT INTO chat(id,project_id,kind,parent_crew_chat_id,owner_kind,owner_id,created_by) VALUES (?,?,'delegation',?,'human','owner','owner')",
    )
    .run(otherDelegationId, projectId, crewId);
  const delegated = actor("Delegated worker", otherDelegationId);
  assert.throws(
    () =>
      acquireLease(
        { ...key, action: "acquire", expectedGeneration: 3, requestId: newId(ID_PREFIXES.request) },
        delegated,
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "forbidden",
  );
  assert.throws(
    () =>
      escrowLease(
        {
          ...key,
          action: "escrow",
          chatId: crewId,
          expectedGeneration: 3,
          requestId: newId(ID_PREFIXES.request),
        },
        delegated,
      ),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "forbidden",
  );
});
