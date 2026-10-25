import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { executionViewSchema } from "../../src/contracts/remote";
import { workerExchangeOutputRemoteSchema } from "../../src/contracts/worker";
import { leaseMutationViewSchema, leaseViewSchema } from "../../src/contracts/lease";
import { migrateDatabase } from "../../src/db/migrate";
import { sqlite } from "../../src/db";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import {
  acquireLease,
  getLease,
  handoffLease,
  reclaimLease,
  releaseLease,
  listProjectLeases,
} from "../../src/server/lease";
import { getExecution, requestExecution } from "../../src/server/remote";
import { enrollWorker, openWorker, exchangeWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";
import { LeaseError } from "../../src/server/lease";
import { RemoteError } from "../../src/server/remote";
import { toDomainAppError } from "../../src/server/functions/domain-errors";

migrateDatabase();
const bootId = newId(ID_PREFIXES.boot),
  requestId = newId(ID_PREFIXES.request);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
for (const user of ["owner", "other"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project),
  otherProjectId = newId(ID_PREFIXES.project);
for (const id of [projectId, otherProjectId])
  sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Remote','owner')").run(id);
const ctx = seedRemoteActor(sqlite, "owner", projectId, bootId);
const target = seedRemoteActor(sqlite, "owner", projectId, bootId);
const another = seedRemoteActor(sqlite, "owner", otherProjectId, bootId);
const machine = createMachine({ name: "Remote Mac" }, ctx);
const machineId = machine.detail.machine.id;
for (const projectId of [ctx.projectId, another.projectId])
  saveProjectMachineBinding(
    { projectId, machineId, description: "fixture", expectedRevision: null },
    ctx,
  );
const key = { projectId, machineId };
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const acquire = acquireLease(
  { ...key, action: "acquire", requestId: req(), expectedGeneration: 0 },
  ctx,
);
assert.equal(acquire.completedGeneration, 1);
assert(leaseMutationViewSchema.safeParse(acquire).success);
assert.throws(
  () =>
    acquireLease({ ...key, action: "acquire", requestId: req(), expectedGeneration: 1 }, target),
  fail("lease_conflict"),
);
assert.throws(() => getLease(key, { ...ctx, userId: "other" }), fail("not_found"));
assert.throws(() => getLease(key, { ...ctx, userId: "" }), fail("unauthorized"));
assert.throws(() => getLease(key, another), fail("not_found"));
const otherLease = acquireLease(
  {
    projectId: otherProjectId,
    machineId,
    action: "acquire",
    requestId: req(),
    expectedGeneration: 0,
  },
  another,
);
assert.equal(otherLease.completedGeneration, 1);
assert.equal(listProjectLeases({ projectId }, ctx).length, 1);
const secret = "w".repeat(43),
  wire = { machineId, secret, version: 3 as const, requestId };
enrollWorker({ ...wire, ticket: machine.ticket }, ctx);
const session = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
let seq = 0;
const exchange = (
  remote = { results: [], fenceAcks: [], mcp: [], mcpCursors: [] } as Parameters<
    typeof exchangeWorker
  >[0]["remote"],
) =>
  exchangeWorker(
    {
      version: 3,
      requestId,
      secret,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "test",
        shells: [
          {
            path: "/bin/sh",
            kind: "sh",
            version: null,
            checkedAt: ctx.now.toISOString(),
            probe: { kind: "success" },
          },
        ],
        remoteOperations: ["shell", "file_read", "file_write", "process_list", "process_signal"],
      },
      observations: [],
      remote,
    },
    ctx,
  );
exchange();
const input = {
  ...key,
  requestId: req(),
  authorizationGeneration: 1,
  operation: {
    kind: "file_write" as const,
    path: "/tmp/p4b-domain-never-executed",
    content: "fixture",
    mode: "overwrite" as const,
  },
};
assert.throws(() => requestExecution(input, target), fail("lease_not_holder"));
assert.throws(() => requestExecution({ ...input, machineId: undefined } as never, ctx));
assert.throws(
  () => requestExecution({ ...input, projectId: otherProjectId }, ctx),
  fail("not_found"),
);
const execution = requestExecution(input, ctx);
assert(executionViewSchema.safeParse(execution).success);
assert.equal(requestExecution(input, ctx).executionId, execution.executionId);
assert.throws(
  () => requestExecution({ ...input, operation: { ...input.operation, content: "changed" } }, ctx),
  fail("remote_request_conflict"),
);
const dispatched = exchange();
assert(workerExchangeOutputRemoteSchema.safeParse(dispatched.remote).success);
assert.equal(dispatched.remote.commands.length, 1);
const command = dispatched.remote.commands[0]!;
const release = releaseLease(
  { ...key, action: "release", expectedGeneration: 1, requestId: req() },
  ctx,
);
assert.equal(release.state, "pending");
assert.equal(getLease(key, ctx).lease.generation, 1);
assert.throws(() => requestExecution({ ...input, requestId: req() }, ctx), fail("lease_fencing"));
const fenceFrame = exchange();
const fence = fenceFrame.remote.fences[0]!;
assert(fence);
const {
  operation: _operation,
  requestId: _requestId,
  deadlineAt: _deadlineAt,
  directoryRevision: _directoryRevision,
  ...identity
} = command;
const report = {
  ...identity,
  phase: "terminal" as const,
  drained: true as const,
  outcome: "succeeded" as const,
  payload: { kind: "file_write" as const, bytesWritten: 7 },
};
assert.throws(
  () =>
    exchange({
      results: [{ ...report, projectId: otherProjectId }],
      fenceAcks: [],
      mcp: [],
      mcpCursors: [],
    }),
  fail("not_found"),
);
seq--; // rolled-back frame
const completed = exchange({
  results: [report],
  fenceAcks: [{ ...fence, dispatchSession: session }],
  mcp: [],
  mcpCursors: [],
});
assert(workerExchangeOutputRemoteSchema.safeParse(completed.remote).success);
assert.equal(getExecution({ ...key, executionId: execution.executionId }, ctx).state, "rejected");
assert.equal(
  getLease({ ...key, mutationId: release.mutationId }, ctx).mutation?.completedGeneration,
  2,
);
assert(leaseViewSchema.safeParse(getLease(key, ctx).lease).success);
assert.throws(
  () => requestExecution({ ...input, requestId: req() }, ctx),
  fail("lease_stale_generation"),
);
assert.equal(requestExecution(input, ctx).executionId, execution.executionId);
acquireLease({ ...key, action: "acquire", expectedGeneration: 2, requestId: req() }, ctx);
const handed = handoffLease(
  {
    ...key,
    action: "handoff",
    expectedGeneration: 3,
    targetInstanceId: target.instanceId,
    requestId: req(),
  },
  ctx,
);
assert.equal(handed.completedGeneration, 4);
assert.throws(
  () =>
    reclaimLease(
      { ...key, action: "reclaim", expectedGeneration: 4, confirm: true, requestId: req() },
      { ...ctx, userId: "other" } as never,
    ),
  fail("forbidden"),
);
const human = { userId: ctx.userId, bootId, now: ctx.now, requestId };
assert.equal(
  reclaimLease(
    { ...key, action: "reclaim", expectedGeneration: 4, confirm: true, requestId: req() },
    human,
  ).completedGeneration,
  5,
);
assert.equal(getLease({ projectId: otherProjectId, machineId }, another).lease.generation, 1);
// Drain carries genuine terminal facts without issuing any new command or heartbeat.
acquireLease({ ...key, action: "acquire", expectedGeneration: 5, requestId: req() }, ctx);
const drainedExecution = requestExecution(
  { ...input, requestId: req(), authorizationGeneration: 6 },
  ctx,
);
const drainCommand = exchange().remote.commands[0]!;
const {
  operation: _drainOperation,
  requestId: _drainRequest,
  deadlineAt: _drainDeadline,
  directoryRevision: _drainDirectory,
  ...drainIdentity
} = drainCommand;
const drainResponse = exchangeWorker(
  {
    version: 3,
    requestId,
    secret,
    session,
    seq: ++seq,
    mode: "drain",
    remote: {
      results: [
        {
          ...drainIdentity,
          phase: "terminal",
          drained: true,
          outcome: "succeeded",
          payload: { kind: "file_write", bytesWritten: 7 },
        },
      ],
      fenceAcks: [],
      mcp: [],
      mcpCursors: [],
    },
  },
  ctx,
);
assert.equal(drainResponse.remote.commands.length, 0);
assert.equal(
  getExecution({ ...key, executionId: drainedExecution.executionId }, ctx).state,
  "succeeded",
);
for (const code of [
  "lease_conflict",
  "lease_not_holder",
  "lease_stale_generation",
  "lease_fencing",
  "machine_unavailable",
  "directory_unavailable",
  "remote_request_conflict",
  "remote_grant_invalid",
  "remote_run_inactive",
] as const)
  for (const ErrorClass of [LeaseError, RemoteError])
    assert.equal((await toDomainAppError(new ErrorClass(code), requestId))?.code, code);
console.log(
  "worker-remote-domain: PASS authorization, fencing, cross-Project, receipt replay, error mapping",
);
sqlite.close();
