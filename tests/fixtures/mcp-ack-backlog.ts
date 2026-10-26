import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq, and, isNull } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import { mcpWorkerItemSchema, type ServerMcpItem } from "../../src/contracts/mcp";
import type { WorkerExchangeRemoteInput } from "../../src/contracts/worker";
import {
  workerExchangeOutputRemoteSchema,
  workerExchangeResponseSchema,
} from "../../src/contracts/worker";
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
import { mcpBound } from "../../src/domain/mcp/protocol";
import { applyMcpExchange } from "../../src/domain/mcp/exchange";

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
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','mcp-e2b@example.test',0,1,1)",
  )
  .run();
const projectId = newId(ID_PREFIXES.project);
sqlite.prepare("INSERT INTO project(id,name,created_by) VALUES (?,'MCP','owner')").run(projectId);
const ctx = seedRemoteActor(sqlite, "owner", projectId, bootId);
const machine = createMachine({ name: "MCP E2b fixture" }, ctx),
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
const runtime = new McpRuntime([registration(undefined, machineId, projectId)]);
await runtime.start();
const dispatcher = new RemoteDispatcher(worker, capability, Date.now, runtime);
let seq = 0;
const exchange = (remote: WorkerExchangeRemoteInput = dispatcher.outgoing(), accept = true) => {
  ctx.now = new Date();
  const response = exchangeWorker(
    {
      version: 3,
      requestId,
      secret,
      session: worker,
      seq: seq + 1,
      mode: "normal",
      capability,
      observations: [],
      remote,
    },
    ctx,
  );
  assert(workerExchangeOutputRemoteSchema.safeParse(response.remote).success);
  const parsed = workerExchangeResponseSchema.safeParse({
    version: 3,
    requestId,
    ok: true,
    data: response,
  });
  assert(parsed.success, parsed.error?.message);
  seq++;
  if (accept) dispatcher.accept(response, seq, []);
  return response;
};
const entries = () =>
  (runtime as unknown as { sessions: Map<string, { active: boolean }> }).sessions;
const activeCount = () => [...entries().values()].filter((entry) => entry.active).length;
const pending = () =>
  db
    .select()
    .from(mcpSession)
    .where(and(eq(mcpSession.machineId, machineId), isNull(mcpSession.workerDetachedAt)))
    .all()
    .filter(
      (row: typeof mcpSession.$inferSelect) => !["connecting", "connected"].includes(row.state),
    ).length;
const evidence: Record<string, unknown> = {};
try {
  exchange();
  const processFact = db
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
        registrationId: processFact.registrationId,
        registrationRevision: processFact.registrationRevision,
        processId: processFact.id,
        expectedWorkerIncarnationId: processFact.workerIncarnationId,
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
  const session = open();
  exchange();
  assert.equal(activeCount(), 1);
  close(session.id);
  const legacyAck = { type: "session_detach_ack", ...mcpBound(session) };
  const legacyAckAccepted = mcpWorkerItemSchema.safeParse(legacyAck).success;
  assert.equal(legacyAckAccepted, false);
  const cleanup = exchange({ ...dispatcher.outgoing(), mcp: [], mcpCursors: [] }, false);
  const snapshot = cleanup.remote.mcp.find(
    (item: ServerMcpItem) => item.type === "session_reconcile",
  )!;
  assert(snapshot);
  const forged = exchange(
    {
      ...dispatcher.outgoing(),
      mcp: [mcpWorkerItemSchema.parse({ ...snapshot, type: "session_reconcile_ack" })],
      mcpCursors: [],
    },
    false,
  );
  evidence.forged = {
    legacyAckAccepted,
    active: activeCount(),
    confirmed: row(session.id).workerDetachedAt !== null,
    cleanupSnapshots: forged.remote.mcp.filter(
      (item: ServerMcpItem) => item.type === "session_reconcile",
    ).length,
  };
  assert.equal(activeCount(), 1);
  assert.notEqual(row(session.id).workerDetachedAt, null);
  assert.equal(
    forged.remote.mcp.filter((item: ServerMcpItem) => item.type === "session_reconcile").length,
    1,
  );
  const next = open();
  const reattach = exchange({ ...dispatcher.outgoing(), mcp: [], mcpCursors: [] }, false);
  const order = reattach.remote.mcp.map((item: ServerMcpItem) => item.type);
  assert(order.indexOf("session_reconcile") < order.indexOf("session_attach"));
  dispatcher.accept(reattach, seq, []);
  exchange();
  evidence.reopened = { active: activeCount(), attached: row(next.id).attachedAt !== null, order };
  assert.equal(activeCount(), 1);
  assert.notEqual(row(next.id).attachedAt, null);
  close(next.id);
  exchange();
  exchange();
  for (let index = 0; index < 220; index++) {
    const old = open();
    close(old.id);
  }
  const backlogBefore = pending();
  const backlogDetaches: number[] = [],
    attachForFresh: number[] = [],
    reconciliation: number[] = [],
    wireBytes: number[] = [];
  for (let round = 0; round < 3; round++) {
    const fresh = open();
    const response = exchange({ ...dispatcher.outgoing(), mcp: [], mcpCursors: [] }, false);
    backlogDetaches.push(
      response.remote.mcp.filter((item: ServerMcpItem) => item.type === "session_detach").length,
    );
    attachForFresh.push(
      response.remote.mcp.filter(
        (item: ServerMcpItem) => item.type === "session_attach" && item.sessionId === fresh.id,
      ).length,
    );
    reconciliation.push(
      response.remote.mcp.filter((item: ServerMcpItem) => item.type === "session_reconcile").length,
    );
    wireBytes.push(Buffer.byteLength(JSON.stringify(response.remote.mcp)));
    close(fresh.id);
  }
  const backlogAfterDroppedResponses = pending();
  exchange();
  const afterCleanup = activeCount();
  exchange();
  const backlogAfterRecovery = pending();
  evidence.backlog = {
    backlogBefore,
    backlogAfterDroppedResponses,
    backlogDetaches,
    attachForFresh,
    reconciliation,
    wireBytes,
    afterCleanup,
    backlogAfterRecovery,
  };
  const pressure = open();
  const constrained = applyMcpExchange(
    { mcp: [], mcpCursors: [] },
    { session: worker, mode: "normal", seq: seq + 1, now: ctx.now, bootId },
    8192,
  );
  assert.equal(constrained.mcp.length, 0);
  assert.equal(constrained.mcpCursors.length, 8);
  assert.equal(row(pressure.id).attachedAt, null);
  const resumed = exchange();
  const resumedAttach = resumed.remote.mcp.filter(
    (item: ServerMcpItem) => item.type === "session_attach" && item.sessionId === pressure.id,
  ).length;
  assert.equal(resumedAttach, 1);
  exchange();
  evidence.smallBudget = {
    bytes: 8192,
    controls: constrained.mcp.length,
    cursors: constrained.mcpCursors.length,
    resumedAttach,
  };
  dispatcher.disconnect();
  const drain = applyMcpExchange(dispatcher.outgoing(), {
    session: worker,
    mode: "drain",
    seq: seq + 1,
    now: ctx.now,
    bootId,
  });
  runtime.accept(drain.mcp, drain.mcpCursors, []);
  const drainSnapshot = drain.mcp.find((item: ServerMcpItem) => item.type === "session_reconcile");
  assert(drainSnapshot && drainSnapshot.type === "session_reconcile");
  assert.equal(drainSnapshot.sessions.length, 0);
  const drainData = {
    mode: "drain",
    session: worker,
    seq: seq + 1,
    configuration: null,
    remote: {
      authorizations: [],
      commands: [],
      fences: [],
      resultAcks: [],
      fenceAcks: [],
      mcp: drain.mcp,
      mcpCursors: drain.mcpCursors,
    },
  };
  assert(
    workerExchangeResponseSchema.safeParse({ version: 3, requestId, ok: true, data: drainData })
      .success,
  );
  assert.equal(
    workerExchangeResponseSchema.safeParse({
      version: 3,
      requestId,
      ok: true,
      data: {
        ...drainData,
        remote: {
          ...drainData.remote,
          mcp: [{ ...drainSnapshot, sessions: [mcpBound(pressure)] }],
        },
      },
    }).success,
    false,
  );
  evidence.drain = {
    retainedSessions: drainSnapshot.sessions.length,
    populatedSnapshotRejected: true,
  };
  process.kill(processFact.pid!, 0);
  console.log("E2b " + JSON.stringify(evidence));
  assert.deepEqual(attachForFresh, [1, 1, 1]);
  assert.deepEqual(backlogDetaches, [0, 0, 0]);
  assert.deepEqual(reconciliation, [1, 1, 1]);
  assert.equal(afterCleanup, 0);
  assert.equal(backlogAfterRecovery, 0);
} finally {
  await runtime.stop();
  sqlite.close();
}
