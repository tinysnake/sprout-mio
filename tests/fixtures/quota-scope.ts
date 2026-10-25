import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { acquireLease, getLease } from "../../src/server/lease";
import { getExecution, listProjectExecutions, requestExecution } from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
const req = () => newId(ID_PREFIXES.request);
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','Owner','quota@example.test',0,1,1)",
  )
  .run();
const projects = [newId(ID_PREFIXES.project), newId(ID_PREFIXES.project)];
for (const id of projects)
  sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Quota','owner')").run(id);
const [a, b] = projects.map((id) => seedRemoteActor(sqlite, "owner", id, bootId));
const machine = createMachine({ name: "Shared quota Mac" }, a!);
const machineId = machine.detail.machine.id;
for (const actor of [a!, b!]) {
  saveProjectMachineBinding(
    { projectId: actor.projectId, machineId, description: "quota", expectedRevision: null },
    actor,
  );
  acquireLease(
    {
      projectId: actor.projectId,
      machineId,
      action: "acquire",
      requestId: req(),
      expectedGeneration: 0,
    },
    actor,
  );
}
const secret = "q".repeat(43);
const wire = { version: 3 as const, requestId: req(), machineId, secret };
enrollWorker({ ...wire, ticket: machine.ticket }, a!);
const session = openWorker({ ...wire, attemptId: randomUUID() }, a!).session;
exchangeWorker(
  {
    version: 3,
    requestId: req(),
    secret,
    session,
    seq: 1,
    mode: "normal",
    capability: {
      platform: "darwin",
      arch: "arm64",
      workerVersion: "quota-test",
      shells: [],
      remoteOperations: ["file_read"],
    },
    observations: [],
    remote: { results: [], fenceAcks: [], mcp: [], mcpCursors: [] },
  },
  a!,
);
const keyA = { projectId: a!.projectId, machineId };
const keyB = { projectId: b!.projectId, machineId };
const submit = (actor: typeof a, now = actor!.now) =>
  requestExecution(
    {
      projectId: actor!.projectId,
      machineId,
      requestId: req(),
      authorizationGeneration: 1,
      operation: { kind: "file_read", path: "/tmp/quota-fixture-never-read", maxBytes: 64 },
    },
    { ...actor!, now },
  );
const firstA = submit(a);
for (let i = 1; i < 64; i++) submit(a);
const quotaError = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "too_many_requests";
assert.throws(() => submit(a), quotaError, "Project A must retain its 64-operation limit");

if (process.argv[2] === "independence") {
  assert.equal(getLease(keyB, b!).lease.state, "held");
  const firstB = submit(b); // F-3: this fails on the machine-wide counter.
  for (let i = 1; i < 64; i++) submit(b);
  assert.throws(() => submit(b), quotaError, "Project B must retain its own 64-operation limit");
  for (const [actor, key] of [
    [a!, keyA],
    [b!, keyB],
  ] as const) {
    const visible = listProjectExecutions({ projectId: key.projectId, limit: 100 }, actor);
    assert.equal(visible.length, 64);
    assert(visible.every((execution) => execution.projectId === key.projectId));
  }
  assert.throws(
    () => getExecution({ ...keyB, executionId: firstA.executionId }, b!),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "not_found",
  );
  assert.equal(getExecution({ ...keyB, executionId: firstB.executionId }, b!).state, "queued");
} else {
  const firstB = submit(b);
  // Real SQLite deadlines and an explicit clock avoid waiting 30 seconds.
  const deadline = Math.max(a!.now.getTime(), b!.now.getTime()) + 1000;
  const afterDeadline = new Date(deadline + 1);
  sqlite
    .prepare("UPDATE remote_execution SET deadline_at=? WHERE id IN (?,?)")
    .run(deadline, firstA.executionId, firstB.executionId);
  submit(a, afterDeadline); // Reclaims only A's expired slot; B must remain untouched.
  const row = (id: string) =>
    sqlite
      .prepare(
        "SELECT state,terminal_at,drained_at,failure_reason FROM remote_execution WHERE id=?",
      )
      .get(id) as {
      state: string;
      terminal_at: number | null;
      drained_at: number | null;
      failure_reason: string | null;
    };
  assert.equal(row(firstA.executionId).state, "timed_out");
  assert.equal(row(firstA.executionId).failure_reason, "deadline");
  assert.equal(row(firstA.executionId).drained_at, null);
  assert.equal(row(firstB.executionId).state, "queued");
  assert.equal(row(firstB.executionId).terminal_at, null);
  assert.throws(() => submit(a), quotaError);
  submit(b, afterDeadline);
  assert.equal(row(firstB.executionId).state, "timed_out");
  assert.equal(row(firstB.executionId).drained_at, null);
}
sqlite.close();
