import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { mcpWorkerItemSchema, type ServerMcpItem } from "../../src/contracts/mcp";
import type { WorkerExchangeRemoteInput } from "../../src/contracts/worker";
import { workerExchangeOutputRemoteSchema } from "../../src/contracts/worker";
import { migrateDatabase } from "../../src/db/migrate";
import { db, sqlite } from "../../src/db";
import { mcpSession, mcpServerProcess } from "../../src/db/schema";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { mcpSessionClose, mcpSessionOpen } from "../../src/server/mcp-relay";
import { acquireLease } from "../../src/server/lease";
import { enrollWorker, openWorker, exchangeWorker } from "../../src/server/worker-gateway";
import { McpRuntime } from "../../src/worker/mcp";
import { RemoteDispatcher } from "../../src/worker/remote";
import { seedRemoteActor } from "./remote-actors";
import { registration } from "./mcp-runtime";
import { mcpBound, mcpHash } from "../../src/domain/mcp/protocol";
migrateDatabase();
const bootId = newId(ID_PREFIXES.boot),
  requestId = newId(ID_PREFIXES.request);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','mcp@example.test',0,1,1)",
  )
  .run();
const projectId = newId(ID_PREFIXES.project);
sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'MCP','owner')").run(projectId);
const ctx = seedRemoteActor(sqlite, "owner", projectId, bootId);
const machine = createMachine({ name: "MCP fixture" }, ctx),
  machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "fixture", expectedRevision: null },
  ctx,
);
acquireLease(
  {
    projectId,
    machineId,
    action: "acquire",
    requestId: newId(ID_PREFIXES.request),
    expectedGeneration: 0,
  },
  ctx,
);
const secret = "w".repeat(43),
  wire = { machineId, secret, version: 3 as const, requestId };
enrollWorker({ ...wire, ticket: machine.ticket }, ctx);
const worker = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
const capability = {
  platform: "darwin" as const,
  arch: "arm64" as const,
  workerVersion: "test",
  shells: [],
  remoteOperations: ["file_write" as const],
  mcpRelay: {
    version: 1 as const,
    transports: ["stdio" as const],
    maxMessageBytes: 131072 as const,
  },
};
const configured = registration(undefined, machineId, projectId);
const runtime = new McpRuntime([configured]);
await runtime.start();
const dispatcher = new RemoteDispatcher(worker, capability, Date.now, runtime);
let seq = 0;
const exchange = (remote: WorkerExchangeRemoteInput = dispatcher.outgoing(), accept = true) => {
  ctx.now = new Date();
  const next = seq + 1;
  const response = exchangeWorker(
    {
      version: 3,
      requestId,
      secret,
      session: worker,
      seq: next,
      mode: "normal",
      capability,
      observations: [],
      remote,
    },
    ctx,
  );
  assert(workerExchangeOutputRemoteSchema.safeParse(response.remote).success);
  seq = next;
  if (accept) dispatcher.accept(response, seq, []);
  return response;
};

const evidence: Record<string, unknown> = {};
try {
  exchange();
  const fact = db
    .select()
    .from(mcpServerProcess)
    .where(eq(mcpServerProcess.machineId, machineId))
    .get()!;
  const leaseInput = { projectId, machineId, authorizationGeneration: 1 };
  const open = () =>
    mcpSessionOpen(
      {
        ...leaseInput,
        requestId: newId(ID_PREFIXES.request),
        registrationId: fact.registrationId,
        registrationRevision: fact.registrationRevision,
        processId: fact.id,
        expectedWorkerIncarnationId: fact.workerIncarnationId,
      },
      ctx,
    ).session;
  const close = (id: string) =>
    mcpSessionClose(
      {
        ...leaseInput,
        sessionId: id,
        requestId: newId(ID_PREFIXES.request),
        reason: "client_closed",
      },
      ctx,
    );
  const row = (id: string) => db.select().from(mcpSession).where(eq(mcpSession.id, id)).get()!;
  const settle = (id: string) => {
    const pending: number[] = [];
    const snapshots: number[] = [];
    const detaches: number[] = [];
    for (let round = 0; round < 4; round++) {
      const response = exchange();
      pending.push(row(id).workerDetachedAt === null ? 1 : 0);
      snapshots.push(
        response.remote.mcp.filter((item: ServerMcpItem) => item.type === "session_reconcile")
          .length,
      );
      detaches.push(
        response.remote.mcp.filter((item: ServerMcpItem) => item.type === "session_detach").length,
      );
    }
    assert.deepEqual(snapshots, [1, 1, 1, 1]);
    assert.deepEqual(detaches, [0, 0, 0, 0]);
    return pending;
  };
  const rapid = open();
  close(rapid.id);
  const rapidPending = settle(rapid.id);
  evidence.rapid = {
    pendingConfirmation: rapidPending,
    workerDetached: row(rapid.id).workerDetachedAt !== null,
  };
  assert.deepEqual(rapidPending, [1, 0, 0, 0]);
  assert.notEqual(row(rapid.id).workerDetachedAt, null);
  const acknowledgement = {
    type: "session_reconcile_ack" as const,
    machineId,
    workerSession: worker,
    closedHash: mcpHash([rapid.id]),
    sessions: [] as ReturnType<typeof mcpBound>[],
  };
  const bound = mcpBound(rapid);
  const mismatches: Partial<typeof bound>[] = [
    { projectId: newId(ID_PREFIXES.project) },
    { machineId: newId(ID_PREFIXES.machine) },
    { authorizationGeneration: rapid.authorizationGeneration + 1 },
    { holderInstanceId: newId(ID_PREFIXES.instance) },
    { processId: newId(ID_PREFIXES.mcpProcess) },
    { workerSession: { ...worker, machineId: newId(ID_PREFIXES.machine) } },
    { workerSession: { ...worker, generation: worker.generation + 1 } },
    { workerSession: { ...worker, bootId: newId(ID_PREFIXES.boot) } },
    { workerSession: { ...worker, attemptId: randomUUID() } },
  ];
  for (const mismatch of mismatches) {
    assert.throws(
      () =>
        exchange({
          ...dispatcher.outgoing(),
          mcp: [{ ...acknowledgement, sessions: [{ ...bound, ...mismatch }] }],
        }),
      "mismatched detach acknowledgement must be rejected",
    );
  }
  evidence.ackBoundRejected = mismatches.length;
  const detachedAt = row(rapid.id).workerDetachedAt;
  for (let replay = 0; replay < 2; replay++) {
    exchange({ ...dispatcher.outgoing(), mcp: [acknowledgement] });
    assert.equal(row(rapid.id).workerDetachedAt, detachedAt);
    assert.equal(row(rapid.id).workerStateRevision, 0);
  }
  process.kill(fact.pid!, 0);
  const window = open();
  assert.equal(
    mcpWorkerItemSchema.safeParse({ type: "session_detach_ack", ...mcpBound(window) }).success,
    false,
    "active session must reject the removed detach acknowledgement",
  );
  exchange(
    {
      ...dispatcher.outgoing(),
      mcp: [
        {
          ...acknowledgement,
          closedHash: mcpHash([rapid.id, window.id].sort((a, b) => a.localeCompare(b))),
        },
      ],
    },
    false,
  );
  assert.equal(row(window.id).workerDetachedAt, null);
  evidence.activeAck = { legacyRejected: true, reconcileCannotConfirmActive: true };
  exchange();
  assert.equal(
    row(window.id).attachedAt,
    null,
    "probe must close inside the unconfirmed attach window",
  );
  close(window.id);
  const windowPending = settle(window.id);
  evidence.window = {
    pendingConfirmation: windowPending,
    workerDetached: row(window.id).workerDetachedAt !== null,
  };
  const next = open();
  exchange();
  exchange();
  assert.notEqual(row(next.id).attachedAt, null);
  close(next.id);
  settle(next.id);
  assert.notEqual(row(next.id).workerDetachedAt, null);
  evidence.reopened = true;
  assert.notEqual(row(window.id).workerDetachedAt, null);
  assert.deepEqual(windowPending, [1, 0, 0, 0]);
  for (const loss of ["undelivered_attach", "rebind", "pruned"] as const) {
    const session = open();
    exchange(undefined, loss !== "undelivered_attach");
    if (loss === "pruned") exchange();
    close(session.id);
    if (loss === "rebind") runtime.bind(worker);
    if (loss === "pruned") {
      const detach = exchange(undefined, false);
      dispatcher.accept(detach, seq, []);
      runtime.outgoing();
      runtime.accept([], [], []);
    }
    const pendingConfirmation = settle(session.id);
    const result = {
      pendingConfirmation,
      workerDetached: row(session.id).workerDetachedAt !== null,
      workerStateRevision: row(session.id).workerStateRevision,
    };
    evidence[loss] = result;
    assert.deepEqual(pendingConfirmation, [1, 0, 0, 0], loss);
    assert.equal(result.workerDetached, true, loss);
  }
  process.kill(fact.pid!, 0);
  console.log("E2 " + JSON.stringify(evidence));
} finally {
  await runtime.stop();
  sqlite.close();
}
