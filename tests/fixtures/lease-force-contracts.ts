import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { forceReclaimLeaseInputSchema, leaseMutationViewSchema } from "../../src/contracts/lease";
import { remoteAgentRequestSchema } from "../../src/contracts/remote";
import { migrateDatabase } from "../../src/db/migrate";
import { sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import {
  acquireLease,
  forceReclaimLease,
  getLease,
  handoffLease,
  releaseLease,
} from "../../src/server/lease";
import { requestExecution } from "../../src/server/remote";
import { enrollWorker, openWorker, exchangeWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
const bootId = newId(ID_PREFIXES.boot),
  requestId = newId(ID_PREFIXES.request);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
for (const user of ["force-owner", "force-other"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project),
  projectB = newId(ID_PREFIXES.project);
for (const id of [projectId, projectB])
  sqlite
    .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Force contract','force-owner')")
    .run(id);
const actor = seedRemoteActor(sqlite, "force-owner", projectId, bootId);
const next = seedRemoteActor(sqlite, "force-owner", projectId, bootId);
const otherProject = seedRemoteActor(sqlite, "force-owner", projectB, bootId);
const human = { userId: actor.userId, bootId, now: actor.now, requestId };
const machine = createMachine({ name: "Force contract Mac" }, human);
const machineId = machine.detail.machine.id,
  key = { projectId, machineId };
for (const projectId of [key.projectId, projectB])
  saveProjectMachineBinding(
    { projectId, machineId, description: "force", expectedRevision: null },
    human,
  );
const req = () => newId(ID_PREFIXES.request);
const fails = (code: string) => (e: unknown) =>
  e instanceof Error && "code" in e && e.code === code;
const secret = "f".repeat(43),
  wire = { machineId, secret, version: 2 as const, requestId };
enrollWorker({ ...wire, ticket: machine.ticket }, actor);
const session = openWorker({ ...wire, attemptId: randomUUID() }, actor).session;
let seq = 0;
const exchange = () =>
  exchangeWorker(
    {
      version: 2,
      requestId,
      secret,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "force-test",
        shells: [
          {
            path: "/bin/sh",
            kind: "sh",
            version: null,
            checkedAt: actor.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["file_write"],
      },
      observations: [],
      remote: { results: [], fenceAcks: [] },
    },
    actor,
  );
exchange();
acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 0 }, actor);
acquireLease(
  { projectId: projectB, machineId, action: "acquire", requestId: req(), expectedGeneration: 0 },
  otherProject,
);
const execution = requestExecution(
  {
    ...key,
    requestId: req(),
    authorizationGeneration: 1,
    operation: {
      kind: "file_write",
      path: "/tmp/force-contract-never-dispatched-to-worker",
      content: "test",
      mode: "overwrite",
    },
  },
  actor,
);
exchange();
const pending = handoffLease(
  {
    ...key,
    action: "handoff",
    requestId: req(),
    expectedGeneration: 1,
    targetInstanceId: next.instanceId,
  },
  actor,
);
assert.equal(pending.state, "pending");
const force = {
  ...key,
  action: "force_reclaim" as const,
  mutationId: pending.mutationId,
  expectedGeneration: 1,
  confirm: true as const,
};
assert(forceReclaimLeaseInputSchema.safeParse(force).success);
assert(!forceReclaimLeaseInputSchema.safeParse({ ...force, confirm: false }).success);
assert(
  !remoteAgentRequestSchema.safeParse({ version: 1, call: { type: "lease_mutate", input: force } })
    .success,
);
const before = sqlite
  .prepare("SELECT state,terminal_at,drained_at FROM remote_execution WHERE id=?")
  .get(execution.executionId);
for (const ctx of [actor, next, otherProject])
  assert.throws(() => forceReclaimLease(force, ctx), fails("forbidden"));
assert.throws(() => forceReclaimLease(force, { ...human, userId: "" }), fails("unauthorized"));
assert.throws(
  () => forceReclaimLease(force, { ...human, userId: "force-other" }),
  fails("not_found"),
);
assert.throws(() => forceReclaimLease({ ...force, projectId: projectB }, human), fails("conflict"));
assert.deepEqual(
  sqlite
    .prepare("SELECT state,terminal_at,drained_at FROM remote_execution WHERE id=?")
    .get(execution.executionId),
  before,
);
for (const fn of [
  () => releaseLease({ ...key, action: "release", expectedGeneration: 1, requestId: req() }, actor),
  () =>
    handoffLease(
      {
        ...key,
        action: "handoff",
        expectedGeneration: 1,
        requestId: req(),
        targetInstanceId: next.instanceId,
      },
      actor,
    ),
])
  assert.throws(fn, fails("lease_fencing"));
const receipt = forceReclaimLease(force, human);
assert(leaseMutationViewSchema.safeParse(receipt).success);
assert.equal(receipt.action, "reclaim");
assert.equal(receipt.completedGeneration, 2);
assert.equal(receipt.forcedReclaim?.supersededMutationId, pending.mutationId);
assert.equal(receipt.forcedReclaim?.forcedByUserId, human.userId);
assert.deepEqual(forceReclaimLease(force, human), receipt);
assert.equal(
  getLease({ ...key, mutationId: pending.mutationId }, human).mutation?.forcedReclaim?.mutationId,
  receipt.mutationId,
);
assert.deepEqual(
  sqlite
    .prepare("SELECT state,failure_reason,drained_at FROM remote_execution WHERE id=?")
    .get(execution.executionId),
  { state: "unknown", failure_reason: "worker_lost", drained_at: null },
);
assert.equal(getLease(key, human).lease.state, "free");
assert.equal(getLease({ projectId: projectB, machineId }, human).lease.generation, 1);
assert.equal(
  acquireLease({ ...key, action: "acquire", expectedGeneration: 2, requestId: req() }, next)
    .completedGeneration,
  3,
);
assert.throws(
  () =>
    requestExecution(
      {
        ...key,
        requestId: req(),
        authorizationGeneration: 1,
        operation: { kind: "process_list", limit: 10 },
      },
      actor,
    ),
  fails("lease_stale_generation"),
);
assert.deepEqual(forceReclaimLease(force, human), receipt);
assert.equal(getLease(key, human).lease.generation, 3);
assert.throws(
  () => forceReclaimLease({ ...force, expectedGeneration: 3 }, human),
  fails("remote_request_conflict"),
);
console.log(
  "PASS force contracts: Human-only, unchanged normal fencing, unknown undrained, auditable supersession, immediate acquire and idempotent receipt",
);
sqlite.close();
