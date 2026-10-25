import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
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

const candidate = process.env.E2_CANDIDATE ?? "B";
const evidence: Record<string, unknown> = { candidate };
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
  const settle = (id: string) =>
    Array.from(
      { length: 4 },
      () =>
        exchange().remote.mcp.filter(
          (item) => item.type === "session_detach" && item.sessionId === id,
        ).length,
    );
  const rapid = open();
  close(rapid.id);
  const rapidDetaches = settle(rapid.id);
  evidence.rapid = {
    detaches: rapidDetaches,
    workerDetached: row(rapid.id).workerDetachedAt !== null,
  };
  process.kill(fact.pid!, 0);
  const window = open();
  exchange();
  assert.equal(
    row(window.id).attachedAt,
    null,
    "probe must close inside the unconfirmed attach window",
  );
  close(window.id);
  const windowDetaches = settle(window.id);
  evidence.window = {
    detaches: windowDetaches,
    workerDetached: row(window.id).workerDetachedAt !== null,
  };
  let reopened = false;
  try {
    const next = open();
    exchange();
    reopened = true;
    exchange();
    assert.notEqual(row(next.id).attachedAt, null);
    close(next.id);
    settle(next.id);
    assert.notEqual(row(next.id).workerDetachedAt, null);
  } catch (error) {
    evidence.reopenError = error instanceof Error ? error.message : "unknown";
  }
  evidence.reopened = reopened;
  if (candidate === "baseline") {
    console.log("E2 " + JSON.stringify(evidence));
    assert.equal(reopened, true, "closed window must release the exact process slot");
  }
  assert.equal(reopened, true);
  assert.notEqual(row(window.id).workerDetachedAt, null);
  assert.deepEqual(windowDetaches, [1, 0, 0, 0]);
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
    const detaches = settle(session.id);
    const result = {
      detaches,
      workerDetached: row(session.id).workerDetachedAt !== null,
      workerStateRevision: row(session.id).workerStateRevision,
    };
    evidence[loss] = result;
    if (candidate === "B") {
      assert.deepEqual(detaches, [1, 0, 0, 0], loss);
      assert.equal(result.workerDetached, true, loss);
    } else {
      assert.deepEqual(detaches, [1, 1, 1, 1], loss);
      assert.equal(result.workerDetached, false, loss);
    }
  }
  process.kill(fact.pid!, 0);
  console.log("E2 " + JSON.stringify(evidence));
} finally {
  await runtime.stop();
  sqlite.close();
}
