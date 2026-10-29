import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { executionViewSchema } from "../../src/contracts/remote";
import type { RemoteCommand, RemoteReport } from "../../src/contracts/remote";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { workerExchangeFrame } from "../../src/db/schema";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import {
  acquireLease,
  assertExecutionWrite,
  authorityNow,
  forceReclaimLease,
  getLease,
  handoffLease,
  reclaimLease,
} from "../../src/server/lease";
import {
  cancelExecution,
  enqueueCancellation,
  getExecution,
  listHolderExecutions,
  listProjectExecutions,
  readExecutionLog,
  requestExecution,
} from "../../src/server/remote";
import { enrollWorker, exchangeWorker, openWorker } from "../../src/server/worker-gateway";
import { seedRemoteActor } from "./remote-actors";

migrateDatabase();
const req = () => newId(ID_PREFIXES.request);
const fail = (code: string) => (error: unknown) =>
  error instanceof Error && "code" in error && error.code === code;
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
for (const user of ["owner", "stranger"])
  sqlite
    .prepare(
      "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,0,1,1)",
    )
    .run(user, user, `${user}@example.test`);
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'Authority','owner')")
  .run(projectId);
const a = seedRemoteActor(sqlite, "owner", projectId, bootId);
const b = seedRemoteActor(sqlite, "owner", projectId, bootId);
a.now = b.now = new Date();
const human = { userId: "owner", bootId, now: a.now, requestId: req() };
const created = createMachine({ name: "Authority fixture" }, human);
const machineId = created.detail.machine.id;
const key = { projectId, machineId };
saveProjectMachineBinding({ ...key, description: "fixture", expectedRevision: null }, human);
// This fixture builds a relational authority snapshot; live binding creation is covered by w/z.
sqlite
  .prepare(
    "INSERT OR IGNORE INTO project_machine_membership(project_id,machine_id,epoch,state,joined_at) VALUES (?,?,1,'active',?)",
  )
  .run(projectId, machineId, a.now.getTime());
acquireLease({ ...key, action: "acquire", expectedGeneration: 0, requestId: req() }, a);
const secret = "w".repeat(43);
const wire = { machineId, secret, version: 3 as const, requestId: req() };
enrollWorker({ ...wire, ticket: created.ticket }, human);
const session = openWorker({ ...wire, attemptId: randomUUID() }, human).session;
let seq = 0;
function exchange(
  results: RemoteReport[] = [],
  fenceAcks: Parameters<typeof exchangeWorker>[0]["remote"]["fenceAcks"] = [],
) {
  return exchangeWorker(
    {
      ...wire,
      session,
      seq: ++seq,
      mode: "normal",
      capability: {
        platform: "darwin",
        arch: "arm64",
        workerVersion: "fixture",
        shells: [],
        remoteOperations: ["file_write"],
      },
      observations: [],
      remote: { results, fenceAcks, mcp: [], mcpCursors: [] },
    },
    human,
  );
}
exchange();
const input = {
  ...key,
  requestId: req(),
  authorizationGeneration: 1,
  operation: {
    kind: "file_write" as const,
    path: "/tmp/p4d-authority-never-run",
    content: "fact",
    mode: "overwrite" as const,
  },
};
// Authority holder comes exclusively from machine_lease, even if authorization history disagrees.
sqlite
  .prepare(
    "UPDATE lease_authorization SET holder_instance_id=? WHERE project_id=? AND machine_id=? AND generation=1",
  )
  .run(b.instanceId, projectId, machineId);
assert.equal(authorityNow(key)?.holderInstanceId, a.instanceId);
assert.equal(assertExecutionWrite(key, 1, a).holderInstanceId, a.instanceId);
assert.throws(() => assertExecutionWrite(key, 1, b), fail("lease_not_holder"));
sqlite
  .prepare(
    "UPDATE lease_authorization SET holder_instance_id=? WHERE project_id=? AND machine_id=? AND generation=1",
  )
  .run(a.instanceId, projectId, machineId);
sqlite
  .prepare(
    "UPDATE lease_authorization SET state='revoked',revoked_at=? WHERE project_id=? AND machine_id=? AND generation=1",
  )
  .run(human.now.getTime(), projectId, machineId);
assert.equal(authorityNow(key), undefined);
assert.throws(() => assertExecutionWrite(key, 1, a), fail("lease_not_holder"));
sqlite
  .prepare(
    "UPDATE lease_authorization SET state='active',revoked_at=NULL WHERE project_id=? AND machine_id=? AND generation=1",
  )
  .run(projectId, machineId);
const first = requestExecution(input, a);
const command = exchange().remote.commands[0]!;
function terminal(command: RemoteCommand): RemoteReport {
  const {
    operation: _operation,
    requestId: _requestId,
    dispatchDeadlineAt: _deadline,
    directoryRevision: _directory,
    runtimeDeadlineAt: _runtime,
    maxRuntimeMs: _max,
    runnerToken: _token,
    ...identity
  } = command;
  return {
    ...identity,
    phase: "terminal",
    drained: true,
    outcome: "succeeded",
    payload: { kind: "file_write", bytesWritten: 4 },
  };
}
const get = (executionId: string, actor = a) => getExecution({ ...key, executionId }, actor);
const log = (executionId: string, actor = a) =>
  readExecutionLog({ ...key, executionId, cursor: null, limitBytes: 65536 }, actor);
const cancel = (executionId: string, generation: number, actor = a) =>
  enqueueCancellation(
    {
      ...key,
      executionId,
      requestId: req(),
      authorizationGeneration: generation,
      policy: "kill",
      termWaitMs: 1,
    },
    actor,
  );

assert.equal(get(first.executionId).authority, "holder");
assert.throws(() => get(first.executionId, b), fail("lease_not_holder"));

const handoff = handoffLease(
  {
    ...key,
    action: "handoff",
    expectedGeneration: 1,
    targetInstanceId: b.instanceId,
    requestId: req(),
  },
  a,
);
assert.equal(handoff.state, "pending");
assert.equal(get(first.executionId).state, "draining");
assert.equal(log(first.executionId).executionId, first.executionId);
assert.equal(listHolderExecutions({ machineId, limit: 20 }, a).executions.length, 1);
assert.throws(() => get(first.executionId, b), fail("lease_not_holder"));
assert.throws(() => log(first.executionId, b), fail("lease_not_holder"));
assert.throws(() => listHolderExecutions({ machineId, limit: 20 }, b), fail("lease_not_holder"));
for (const actor of [a, b]) {
  assert.throws(() => cancel(first.executionId, 1, actor), fail("lease_fencing"));
  assert.throws(
    () => requestExecution({ ...input, requestId: req() }, actor),
    fail("lease_fencing"),
  );
}
exchange([terminal(command)]);
assert.equal(getLease(key, human).lease.generation, 2);
const inherited = get(first.executionId, b);
assert.equal(inherited.state, "succeeded");
assert.equal(inherited.holderInstanceId, a.instanceId);
assert.equal(inherited.runId, a.runId);
assert.equal(inherited.authorizationGeneration, 1);
assert.equal(inherited.authority, "inherited");
assert.equal(inherited.currentAuthorizationGeneration, 2);
assert(executionViewSchema.safeParse(inherited).success);
assert.equal(log(first.executionId, b).executionId, first.executionId);
assert.equal(
  listHolderExecutions({ machineId, limit: 20 }, b).executions[0]?.executionId,
  first.executionId,
);
for (const action of [
  () => get(first.executionId),
  () => log(first.executionId),
  () => listHolderExecutions({ machineId, limit: 20 }, a),
])
  assert.throws(action, fail("lease_not_holder"));
for (const action of [
  () => requestExecution(input, a),
  () => requestExecution({ ...input, requestId: req() }, a),
  () => cancel(first.executionId, 1, a),
])
  assert.throws(action, fail("lease_stale_generation"));
assert.throws(() => cancel(first.executionId, 2, a), fail("lease_not_holder"));
assert.throws(
  () => requestExecution({ ...input, requestId: req(), authorizationGeneration: 2 }, a),
  fail("lease_not_holder"),
);
assert.throws(() => cancel(first.executionId, 1, b), fail("lease_stale_generation"));
assert.throws(() => cancel(first.executionId, 2, b), fail("cancellation_already_terminal"));
assert.equal(getExecution({ ...key, executionId: first.executionId }, human).authority, "history");
assert.equal(
  getExecution({ ...key, executionId: first.executionId }, human).currentAuthorizationGeneration,
  null,
);
assert.throws(
  () => getExecution({ ...key, executionId: first.executionId }, { ...human, userId: "stranger" }),
  fail("not_found"),
);
assert.throws(
  () => getExecution({ ...key, executionId: first.executionId }, { ...human, userId: "" }),
  fail("unauthorized"),
);
const { authority: _authority, ...missingAuthority } = inherited;
assert.equal(executionViewSchema.safeParse(missingAuthority).success, false);
assert.equal(
  executionViewSchema.safeParse({ ...inherited, currentAuthorizationGeneration: undefined })
    .success,
  false,
);

// Stable pagination uses the id tie-breaker and rejects cursors from another binding.
const second = requestExecution({ ...input, requestId: req(), authorizationGeneration: 2 }, b);
const third = requestExecution({ ...input, requestId: req(), authorizationGeneration: 2 }, b);
const page1 = listHolderExecutions({ machineId, limit: 1 }, b);
const page2 = listHolderExecutions({ machineId, limit: 1, before: page1.nextCursor! }, b);
const page3 = listHolderExecutions({ machineId, limit: 1, before: page2.nextCursor! }, b);
assert.equal(
  new Set([...page1.executions, ...page2.executions, ...page3.executions].map((x) => x.executionId))
    .size,
  3,
);
assert.equal(page3.nextCursor, null);
assert.throws(
  () => listHolderExecutions({ machineId, limit: 1, before: "invalid" }, b),
  fail("validation_failed"),
);
// Undispatched work cannot claim to have received a cancellation.
assert.throws(() => cancel(second.executionId, 2, b), fail("cancellation_delivery_unconfirmed"));
const dispatched: RemoteCommand[] = exchange().remote.commands;
assert.equal(dispatched.length, 2);

// Model a cutover snapshot with live physical work to verify inherited cancellation custody.
// This does not claim that a Worker fence acknowledgement proves process termination.
sqlite
  .prepare(
    "UPDATE lease_authorization SET state='revoked',revoked_at=? WHERE project_id=? AND machine_id=? AND generation=2",
  )
  .run(human.now.getTime(), projectId, machineId);
sqlite
  .prepare(
    "INSERT INTO lease_authorization(project_id,machine_id,generation,holder_instance_id,state,reason,issued_at) VALUES (?,?,3,?,'active','handoff',?)",
  )
  .run(projectId, machineId, a.instanceId, human.now.getTime());
sqlite
  .prepare(
    "UPDATE machine_lease SET generation=3,holder_instance_id=? WHERE project_id=? AND machine_id=?",
  )
  .run(a.instanceId, projectId, machineId);
const sameOriginHolder = get(first.executionId, a);
assert.equal(sameOriginHolder.authority, "inherited");
assert.equal(sameOriginHolder.currentAuthorizationGeneration, 3);
const intent = cancel(second.executionId, 3, a);
const custody = sqlite
  .prepare(
    "SELECT authorization_generation,holder_instance_id FROM execution_cancellation WHERE id=?",
  )
  .get(intent.cancelId) as { authorization_generation: number; holder_instance_id: string };
assert.equal(custody.authorization_generation, 3);
assert.equal(custody.holder_instance_id, a.instanceId);
assert.equal(get(second.executionId).authorizationGeneration, 2);
// Cross-generation scans must fence both origin g=2 executions under current g=3.
const pending = reclaimLease(
  { ...key, action: "reclaim", expectedGeneration: 3, requestId: req(), confirm: true },
  human,
);
assert.equal(pending.state, "pending");
const fence = exchange().remote.fences[0]!;
assert.equal(fence.authorizationGeneration, 3);
assert.deepEqual(new Set(fence.executionIds), new Set([second.executionId, third.executionId]));
forceReclaimLease(
  {
    ...key,
    action: "force_reclaim",
    mutationId: pending.mutationId,
    expectedGeneration: 3,
    confirm: true,
  },
  human,
);
assert.equal(getExecution({ ...key, executionId: second.executionId }, human).state, "unknown");
for (const actor of [a, b]) {
  assert.throws(() => get(first.executionId, actor), fail("lease_not_holder"));
  assert.throws(
    () => listHolderExecutions({ machineId, limit: 20 }, actor),
    fail("lease_not_holder"),
  );
}
acquireLease({ ...key, action: "acquire", expectedGeneration: 4, requestId: req() }, b);
// A dead process's result retains its physical outcome despite intervening holder changes.
exchange([terminal(dispatched.find((x) => x.executionId === second.executionId)!)]);
assert.equal(get(second.executionId, b).state, "succeeded");
assert.equal(get(second.executionId, b).holderInstanceId, b.instanceId);
assert.equal(get(second.executionId, b).authority, "inherited");

// Removed membership blocks all Agent paths, while proven late facts remain Human history.
const fourthInput = { ...input, requestId: req(), authorizationGeneration: 5 };
const fourth = requestExecution(fourthInput, b);
const fourthCommand = exchange().remote.commands[0]!;
const lastPending = reclaimLease(
  { ...key, action: "reclaim", expectedGeneration: 5, requestId: req(), confirm: true },
  human,
);
forceReclaimLease(
  {
    ...key,
    action: "force_reclaim",
    mutationId: lastPending.mutationId,
    expectedGeneration: 5,
    confirm: true,
  },
  human,
);
sqlite
  .prepare(
    "UPDATE project_machine_membership SET state='removed',requested_by='owner',request_id=?,payload_hash=?,requested_at=?,removed_at=?,revoked_generation=6 WHERE project_id=? AND machine_id=? AND epoch=1",
  )
  .run(req(), "a".repeat(64), human.now.getTime(), human.now.getTime(), projectId, machineId);
for (const actor of [a, b]) {
  // 冻结决定 10：执行读在任何非 active 关系下都是 lease_not_holder；
  // membership_removed 只留给 request/cancel 等非读操作路径。
  for (const read of [
    () => get(first.executionId, actor),
    () => log(first.executionId, actor),
    () => listHolderExecutions({ machineId, limit: 20 }, actor),
  ])
    assert.throws(read, fail("lease_not_holder"));
  for (const operation of [
    () => cancel(first.executionId, 6, actor),
    () => requestExecution(actor === a ? input : fourthInput, actor),
  ])
    assert.throws(operation, fail("membership_removed"));
}
assert.throws(
  () => cancelExecution({ executionId: first.executionId, requestId: req() }, human),
  fail("membership_removed"),
);
exchange([terminal(fourthCommand)]);
assert.equal(getExecution({ ...key, executionId: fourth.executionId }, human).state, "succeeded");
assert.equal(getExecution({ ...key, executionId: first.executionId }, human).state, "succeeded");
assert.equal(
  readExecutionLog(
    { ...key, executionId: fourth.executionId, cursor: null, limitBytes: 65536 },
    human,
  ).executionId,
  fourth.executionId,
);
assert.equal(listProjectExecutions({ projectId }, human).length, 4);
// Remove only third's historical command proof, retaining matching row/session/origin identity.
for (const frame of db.select().from(workerExchangeFrame).all()) {
  if (
    frame.responseJson.remote.commands.some(
      (x: RemoteCommand) => x.executionId === third.executionId,
    )
  )
    db.update(workerExchangeFrame)
      .set({
        responseJson: {
          ...frame.responseJson,
          remote: {
            ...frame.responseJson.remote,
            commands: frame.responseJson.remote.commands.filter(
              (x: RemoteCommand) => x.executionId !== third.executionId,
            ),
          },
        },
      })
      .where(
        and(
          eq(workerExchangeFrame.machineId, frame.machineId),
          eq(workerExchangeFrame.connectionGeneration, frame.connectionGeneration),
          eq(workerExchangeFrame.seq, frame.seq),
        ),
      )
      .run();
}
exchange([terminal(dispatched.find((x) => x.executionId === third.executionId)!)]);
const unproven = getExecution({ ...key, executionId: third.executionId }, human);
assert.equal(unproven.state, "rejected");
assert.equal(unproven.failureReason, "authorization_revoked");
assert.equal(sqlite.pragma("foreign_key_check").length, 0);
console.log(
  "p4d-authority: PASS continuity, current cancellation, history, delivery proof, cross-generation fencing",
);
sqlite.close();
