import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { migrateDatabase } from "../../src/db/migrate";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { machineDetailSchema } from "../../src/contracts/machine";
import type { CapabilitySnapshot } from "../../src/contracts/machine";
import {
  createMachine,
  getMachine,
  listMachines,
  listProjectMachines,
  renewMachineEnrollment,
  saveMachineRootDirectory,
  saveProjectMachineBinding,
} from "../../src/domain/machine";
import {
  closeWorker,
  enrollWorker,
  exchangeWorker,
  openWorker,
} from "../../src/server/worker-gateway";
import { sqlite } from "../../src/db";

migrateDatabase();
const now = new Date("2026-01-01T00:00:00Z");
const bootId = newId(ID_PREFIXES.boot);
const requestId = newId(ID_PREFIXES.request);
for (const id of ["owner", "other"])
  sqlite
    .prepare(
      "INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(id, id, `${id}@example.test`);
sqlite
  .prepare(
    "INSERT INTO runtime_boot (id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
const ctx = { now, bootId, requestId, userId: "owner" };
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project (id,name,created_by) VALUES (?,'Project','owner')")
  .run(projectId);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const enrollment = createMachine({ name: "Mac" }, ctx);
const machineId = enrollment.detail.machine.id;
const secret = "s".repeat(43);
const wire = { version: 1 as const, requestId, machineId, secret };
assert.equal(listMachines(ctx).length, 1);
assert.throws(() => getMachine({ machineId }, { ...ctx, userId: "other" }), fail("not_found"));
assert.throws(() =>
  createMachine({ name: "Rollback" }, ctx, {
    beforeDiagnostic: () => {
      throw new Error("diagnostic failed");
    },
  }),
);
assert.equal(listMachines(ctx).length, 1);
const renewed = renewMachineEnrollment(machineId, ctx);
assert.throws(
  () => enrollWorker({ ...wire, ticket: enrollment.ticket }, ctx),
  fail("unauthorized"),
);
enrollWorker({ ...wire, ticket: renewed.ticket }, ctx);
enrollWorker({ ...wire, ticket: renewed.ticket }, ctx);
assert.throws(
  () => enrollWorker({ ...wire, secret: "x".repeat(43), ticket: renewed.ticket }, ctx),
  fail("unauthorized"),
);
assert.throws(
  () =>
    enrollWorker(
      { ...wire, ticket: renewed.ticket },
      { ...ctx, now: new Date(now.getTime() + 600000) },
    ),
  fail("unauthorized"),
);
assert.equal(getMachine({ machineId }, ctx).enrollmentStatus, "active");
assert.throws(() => renewMachineEnrollment(machineId, ctx), fail("conflict"));
const attemptId = randomUUID();
const first = openWorker({ ...wire, attemptId }, ctx).session;
assert.deepEqual(openWorker({ ...wire, attemptId }, ctx).session, first);
assert.equal(getMachine({ machineId }, ctx).connection.kind, "connecting");
const binding = {
  machineId,
  projectId,
  description: "local",
  expectedRevision: null,
};
saveProjectMachineBinding(binding, ctx);
assert.equal(getMachine({ machineId }, ctx).bindings[0]?.observation, null);
assert.equal(getMachine({ machineId }, ctx).machine.rootDirectory, null);
const rootInput = { machineId, directory: "/tmp", expectedRevision: 1 };
assert.throws(
  () => saveMachineRootDirectory(rootInput, { ...ctx, userId: "other" }),
  fail("not_found"),
);
assert.throws(
  () => saveMachineRootDirectory({ ...rootInput, expectedRevision: null }, ctx),
  fail("conflict"),
);
assert.throws(() =>
  saveMachineRootDirectory(rootInput, ctx, {
    beforeDiagnostic: () => {
      throw new Error("diagnostic failed");
    },
  }),
);
assert.equal(getMachine({ machineId }, ctx).machine.rootRevision, 1);
const root = saveMachineRootDirectory(rootInput, ctx);
assert.deepEqual(root, { machineId, directory: "/tmp", revision: 2 });
assert.equal(saveMachineRootDirectory({ ...rootInput, expectedRevision: 2 }, ctx).revision, 2);
assert.throws(() => saveMachineRootDirectory(rootInput, ctx), fail("conflict"));
assert.equal(saveProjectMachineBinding(binding, ctx).revision, 1);
assert.throws(
  () => saveProjectMachineBinding({ ...binding, description: "wrong" }, ctx),
  fail("conflict"),
);
assert.throws(() =>
  saveProjectMachineBinding({ ...binding, description: "bad", expectedRevision: 1 }, ctx, {
    beforeDiagnostic: () => {
      throw new Error("diagnostic failed");
    },
  }),
);
assert.equal(listProjectMachines(projectId, ctx)[0]?.bindings[0]?.intent.description, "local");
const capability: CapabilitySnapshot = {
  platform: "darwin",
  arch: "arm64",
  workerVersion: "test",
  shells: [],
  remoteOperations: "not_implemented",
};
const exchange = {
  version: 1 as const,
  requestId,
  secret,
  session: first,
  seq: 1,
  capability,
  observations: [
    {
      machineId,
      projectId,
      generation: first.generation,
      revision: root.revision,
      seq: 1,
      checkedAt: now.toISOString(),
      result: { kind: "accessible" as const, realPath: "/private/tmp" },
    },
  ],
};
const configuration = exchangeWorker(exchange, ctx);
assert.equal(configuration.root, "/tmp");
assert.equal(configuration.rootRevision, root.revision);
assert.deepEqual(configuration.bindings, [{ projectId, description: "local" }]);
exchangeWorker(
  { ...exchange, requestId: newId(ID_PREFIXES.request) },
  { ...ctx, now: new Date(now.getTime() + 1000) },
);
assert.equal(getMachine({ machineId }, ctx).connection.lastSeenAt, now.toISOString());
assert.throws(
  () =>
    exchangeWorker({ ...exchange, capability: { ...capability, workerVersion: "changed" } }, ctx),
  fail("conflict"),
);
assert.throws(
  () => exchangeWorker({ ...exchange, secret: "x".repeat(43), seq: 2 }, ctx),
  fail("unauthorized"),
);
saveProjectMachineBinding({ ...binding, description: "new", expectedRevision: 1 }, ctx);
assert.equal(getMachine({ machineId }, ctx).bindings[0]?.observation?.current, true);
exchangeWorker(
  { ...exchange, seq: 2, observations: exchange.observations.map((o) => ({ ...o, seq: 2 })) },
  ctx,
);
saveMachineRootDirectory({ machineId, directory: null, expectedRevision: root.revision }, ctx);
assert.equal(getMachine({ machineId }, ctx).bindings[0]?.observation?.current, false);
assert.throws(
  () =>
    exchangeWorker(
      {
        ...exchange,
        seq: 3,
        observations: exchange.observations.map((o) => ({
          ...o,
          seq: 3,
          revision: root.revision + 1,
        })),
      },
      ctx,
    ),
  fail("conflict"),
);
const refreshed = saveMachineRootDirectory(
  { machineId, directory: "/changed", expectedRevision: root.revision + 1 },
  ctx,
);
assert.throws(
  () =>
    exchangeWorker(
      { ...exchange, seq: 3, observations: exchange.observations.map((o) => ({ ...o, seq: 3 })) },
      ctx,
    ),
  fail("conflict"),
);
assert.equal(refreshed.revision, root.revision + 2);
const second = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
assert.equal(second.generation, first.generation + 1);
for (const action of [
  () => openWorker({ ...wire, attemptId }, ctx),
  () => exchangeWorker(exchange, ctx),
  () => closeWorker({ version: 1, requestId, secret, session: first }, ctx),
])
  assert.throws(action, fail("superseded"));
closeWorker({ version: 1, requestId, secret, session: second }, ctx);
closeWorker({ version: 1, requestId, secret, session: second }, ctx);
assert.equal(getMachine({ machineId }, ctx).connection.kind, "offline");
const third = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
assert.throws(
  () =>
    exchangeWorker(
      { ...exchange, session: third, observations: [] },
      { ...ctx, now: new Date(now.getTime() + 15000) },
    ),
  fail("stale"),
);
const reboot = { ...ctx, bootId: newId(ID_PREFIXES.boot) };
assert.equal(getMachine({ machineId }, reboot).connection.kind, "offline");
assert.equal(getMachine({ machineId }, reboot).capability?.current, false);
sqlite
  .prepare(
    "INSERT INTO runtime_boot (id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(reboot.bootId);
assert.throws(
  () => openWorker({ ...wire, attemptId: third.attemptId }, reboot),
  fail("superseded"),
);
const fourth = openWorker({ ...wire, attemptId: randomUUID() }, reboot).session;
assert.equal(fourth.generation, third.generation + 1);
sqlite
  .prepare("UPDATE machine_connection_counter SET high_water=? WHERE machine_id=?")
  .run(Number.MAX_SAFE_INTEGER, machineId);
assert.throws(() => openWorker({ ...wire, attemptId: randomUUID() }, reboot), fail("conflict"));
sqlite
  .prepare("UPDATE project_machine SET revision=? WHERE machine_id=? AND project_id=?")
  .run(Number.MAX_SAFE_INTEGER, machineId, projectId);
assert.throws(
  () =>
    saveProjectMachineBinding(
      { ...binding, description: "overflow", expectedRevision: Number.MAX_SAFE_INTEGER },
      ctx,
    ),
  fail("conflict"),
);
sqlite
  .prepare("UPDATE machine SET root_revision=? WHERE id=?")
  .run(Number.MAX_SAFE_INTEGER, machineId);
assert.throws(
  () =>
    saveMachineRootDirectory(
      { machineId, directory: "/overflow", expectedRevision: Number.MAX_SAFE_INTEGER },
      ctx,
    ),
  fail("conflict"),
);
machineDetailSchema.parse(getMachine({ machineId }, reboot));
assert(!JSON.stringify(getMachine({ machineId }, ctx)).includes(secret));
console.log(
  "PASS ownership rollback enrollment CAS retry generation boot expiry high-water and safe projection",
);
sqlite.close();
