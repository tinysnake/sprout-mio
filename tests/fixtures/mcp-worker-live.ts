import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { and, asc, eq, isNull } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { ServerMcpItem } from "../../src/contracts/mcp";
import type { WorkerExchangeRemoteInput } from "../../src/contracts/worker";
import { workerExchangeOutputRemoteSchema } from "../../src/contracts/worker";
import { migrateDatabase } from "../../src/db/migrate";
import { db, sqlite } from "../../src/db";
import { mcpFrame, mcpSession, mcpServerProcess } from "../../src/db/schema";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { mcpSessionClose, mcpSessionOpen } from "../../src/server/mcp-relay";
import { acquireLease } from "../../src/server/lease";
import { requestExecution } from "../../src/server/remote";
import { enrollWorker, openWorker, exchangeWorker } from "../../src/server/worker-gateway";
import { McpRuntime } from "../../src/worker/mcp";
import { RemoteDispatcher } from "../../src/worker/remote";
import { probeNativePiVersion } from "./mcp-native-version";
import { seedRemoteActor } from "./remote-actors";
import { registration, sessionFor, waitFor } from "./mcp-runtime";
import { mcpBound, mcpHash, mcpPayloadHash } from "../../src/domain/mcp/protocol";

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
const useEverything = process.env.MCP_EVERYTHING === "1";
const configured = registration(
  useEverything
    ? {
        transport: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-everything@2.0.1"],
        workingDirectory: process.cwd(),
        launch: "configured_service",
        autostart: true,
        exposure: "wire",
        roots: [{ uri: "file:///tmp/sprout-mcp-fixture", name: "fixture" }],
        exposeSampling: true,
        elicitation: "cancel",
        requestTimeoutMs: 20000,
      }
    : undefined,
  machineId,
  projectId,
);
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
let timer: NodeJS.Timeout | undefined;
try {
  exchange();
  const fact = db
    .select()
    .from(mcpServerProcess)
    .where(eq(mcpServerProcess.machineId, machineId))
    .get()!;
  assert(fact.pid && fact.processStartedAt);
  process.kill(fact.pid, 0);
  const leaseInput = { projectId, machineId, authorizationGeneration: 1 };
  const rapidSession = mcpSessionOpen(
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
  mcpSessionClose(
    {
      ...leaseInput,
      sessionId: rapidSession.id,
      requestId: newId(ID_PREFIXES.request),
      reason: "client_closed",
    },
    ctx,
  );
  const rapidClose = exchange(undefined, false);
  assert.equal(
    rapidClose.remote.mcp.some(
      (item: ServerMcpItem) => item.type === "session_detach" && item.sessionId === rapidSession.id,
    ),
    true,
    "relay must reconcile a closed session even before its first Worker exchange",
  );
  dispatcher.accept(rapidClose, seq, []);
  const closedRow = db.select().from(mcpSession).where(eq(mcpSession.id, rapidSession.id)).get()!;
  assert.equal(closedRow.state, "closed");
  assert.equal(closedRow.attachedAt, null);
  exchange();
  assert.notEqual(
    db.select().from(mcpSession).where(eq(mcpSession.id, rapidSession.id)).get()!.workerDetachedAt,
    null,
  );
  process.kill(fact.pid, 0);
  const session = sessionFor(fact, worker, {
    projectId,
    holderInstanceId: ctx.instanceId,
    runId: ctx.runId,
    chatId: ctx.chatId,
    grantId: ctx.grantId,
  });
  db.insert(mcpSession).values(session).run();
  exchange();
  exchange();
  assert(
    db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!.attachedAt !== null,
  );
  let clientSeq = 0,
    serverAck = 0;
  const messages = new Set<(message: unknown) => void>();
  const closes = new Set<() => void>();
  let error: unknown;
  const transport = {
    async start() {},
    async send(message: unknown) {
      const payload = Buffer.from(JSON.stringify(message));
      sqlite.transaction(() => {
        db.insert(mcpFrame)
          .values({
            id: newId(ID_PREFIXES.mcpFrame),
            sessionId: session.id,
            projectId,
            machineId,
            authorizationGeneration: 1,
            holderInstanceId: ctx.instanceId,
            processId: fact.id,
            direction: "client_to_server",
            seq: ++clientSeq,
            payloadBase64: payload.toString("base64"),
            payloadBytes: payload.length,
            payloadHash: mcpPayloadHash(payload),
            state: "queued",
            createdAt: Date.now(),
            expiresAt: Date.now() + 120000,
          })
          .run();
        db.update(mcpSession)
          .set({ clientHighWater: clientSeq })
          .where(eq(mcpSession.id, session.id))
          .run();
      })();
    },
    async close() {
      mcpSessionClose(
        {
          ...leaseInput,
          sessionId: session.id,
          requestId: newId(ID_PREFIXES.request),
          reason: "client_closed",
        },
        ctx,
      );
      const closing = exchange();
      assert.ok(
        closing.remote.mcp.some(
          (item: ServerMcpItem) => item.type === "session_detach" && item.sessionId === session.id,
        ),
        "relay must still detach an attached session",
      );
      exchange();
      assert.notEqual(
        db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!.workerDetachedAt,
        null,
      );
      process.kill(fact.pid!, 0);
      for (const listener of closes) listener();
    },
    onMessage(listener: (message: unknown) => void) {
      messages.add(listener);
      return () => messages.delete(listener);
    },
    onError(_listener: (error: Error) => void) {
      return () => {};
    },
    onClose(listener: () => void) {
      closes.add(listener);
      return () => closes.delete(listener);
    },
  };
  const pump = () => {
    if (error) return;
    try {
      exchange();
      for (const frame of db
        .select()
        .from(mcpFrame)
        .where(
          and(
            eq(mcpFrame.sessionId, session.id),
            eq(mcpFrame.direction, "server_to_client"),
            isNull(mcpFrame.terminalAt),
          ),
        )
        .orderBy(asc(mcpFrame.seq))
        .all()) {
        const payload = JSON.parse(Buffer.from(frame.payloadBase64!, "base64").toString());
        for (const listener of messages) listener(payload);
        serverAck = frame.seq;
        db.update(mcpFrame)
          .set({ state: "acked", payloadBase64: null, sentAt: Date.now(), terminalAt: Date.now() })
          .where(eq(mcpFrame.id, frame.id))
          .run();
        db.update(mcpSession)
          .set({ hostAckServerSeq: serverAck })
          .where(eq(mcpSession.id, session.id))
          .run();
      }
    } catch (failure) {
      error = failure;
    }
  };
  if (useEverything) {
    const nativePath =
      process.env.PI_MCP_MODULE ??
      join(
        homedir(),
        ".pi/agent/install/releases/1.4.0/node_modules/@earendil-works/pi-mcp/dist/index.js",
      );
    const { McpClient } = await import(pathToFileURL(nativePath).href);
    const nativePiVersionEvidence = await probeNativePiVersion(nativePath);
    const client = new McpClient({
      name: "sprout-worker-acceptance",
      version: "1",
      requestTimeoutMs: 20000,
      capabilities: { sampling: {}, elicitation: {} },
      roots: configured.configJson.roots,
    });
    let sampling = 0,
      elicitation = 0;
    client.setRequestHandler("sampling/createMessage", () => {
      sampling++;
      return {
        role: "assistant",
        content: { type: "text", text: "fixture" },
        model: "fixture",
        stopReason: "endTurn",
      };
    });
    client.setRequestHandler("elicitation/create", () => {
      elicitation++;
      return { action: "cancel" };
    });
    timer = setInterval(pump, 10);
    await client.connect(transport);
    db.update(mcpSession)
      .set({ protocolVersion: client.protocolVersion })
      .where(eq(mcpSession.id, session.id))
      .run();
    await waitFor(() => {
      if (error) throw error;
      return (
        db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!.state ===
        "connected"
      );
    }, 10000);
    const tools = await client.listTools();
    assert(tools.length > 0);
    const names = tools.map((tool: { name: string }) => tool.name);
    if (names.includes("trigger-sampling-request")) {
      await client.callTool("trigger-sampling-request", { prompt: "fixture" });
      assert(sampling > 0);
    }
    if (names.includes("trigger-elicitation-request")) {
      await client.callTool("trigger-elicitation-request", {});
      assert(elicitation > 0);
    }
    await client.close();
    assert.equal(
      db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!.state,
      "closed",
    );
    const sessionClosedProcessAlive = process.kill(fact.pid, 0);
    assert(sessionClosedProcessAlive);
    const evidence = {
      pid: fact.pid,
      processStartedAt: fact.processStartedAt,
      registrationId: configured.id,
      processId: fact.id,
      sessionId: session.id,
      toolCount: names.length,
      tools: names,
      samplingFixtureRequests: sampling,
      elicitationCancelRequests: elicitation,
      ...nativePiVersionEvidence,
      sessionClosedProcessAlive,
    };
    await writeFile(
      process.env.MCP_EVIDENCE ?? "/tmp/sprout-mcp-evidence.json",
      JSON.stringify(evidence, null, 2),
    );
    console.log(
      `PASS real server-everything tools/list toolCount=${names.length}; session close preserves pid`,
    );
  } else {
    await transport.send({ jsonrpc: "2.0", id: 1, method: "fixture/echo", params: { value: 1 } });
    exchange();
    await waitFor(() => {
      exchange();
      return db
        .select()
        .from(mcpFrame)
        .where(and(eq(mcpFrame.sessionId, session.id), eq(mcpFrame.direction, "server_to_client")))
        .get();
    });
    const accepted = db
      .select()
      .from(mcpFrame)
      .where(and(eq(mcpFrame.sessionId, session.id), eq(mcpFrame.direction, "client_to_server")))
      .get()!;
    assert.equal(accepted.state, "acked");
    assert.equal(accepted.payloadBase64, null);
    assert.equal(
      sqlite
        .prepare("SELECT count(*) AS n FROM diagnostic_event WHERE event='mcp.frame.received'")
        .get()!.n,
      1,
    );
    await transport.send({ jsonrpc: "2.0", id: 2, method: "fixture/exit" });
    db.update(mcpFrame)
      .set({
        state: "dropped",
        payloadBase64: null,
        terminalAt: Date.now(),
        dispositionReason: "expired",
      })
      .where(
        and(
          eq(mcpFrame.sessionId, session.id),
          eq(mcpFrame.direction, "client_to_server"),
          eq(mcpFrame.seq, 2),
        ),
      )
      .run();
    await transport.send({ jsonrpc: "2.0", id: 3, method: "fixture/echo" });
    exchange();
    await waitFor(() => {
      exchange();
      return (
        db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!
          .workerAckClientSeq === 3
      );
    });
    assert.equal(
      db
        .select()
        .from(mcpFrame)
        .where(
          and(
            eq(mcpFrame.sessionId, session.id),
            eq(mcpFrame.direction, "client_to_server"),
            eq(mcpFrame.seq, 2),
          ),
        )
        .get()!.state,
      "dropped",
    );
    process.kill(fact.pid, 0);
    const incoming = db
      .select()
      .from(mcpFrame)
      .where(and(eq(mcpFrame.sessionId, session.id), eq(mcpFrame.direction, "server_to_client")))
      .get()!;
    const frame = {
      type: "frame" as const,
      direction: "server_to_client" as const,
      ...mcpBound(session),
      frameId: incoming.id,
      seq: incoming.seq,
      payloadBase64: incoming.payloadBase64!,
      payloadBytes: incoming.payloadBytes,
      payloadHash: incoming.payloadHash,
      expiresAt: incoming.expiresAt,
    };
    const stale = { ...frame, authorizationGeneration: 0 };
    assert.throws(() =>
      exchangeWorker(
        {
          version: 3,
          requestId,
          secret,
          session: worker,
          seq: seq + 1,
          mode: "normal",
          capability,
          observations: [],
          remote: { results: [], fenceAcks: [], mcp: [stale], mcpCursors: [] },
        },
        ctx,
      ),
    );
    const before = sqlite.prepare("SELECT count(*) AS n FROM diagnostic_event").get()!.n;
    const heartbeatValue = {
      ...fact,
      stateRevision: fact.stateRevision + 1,
      lastObservedAt: Date.now(),
    };
    const { stateHash: _oldStateHash, ...heartbeatState } = heartbeatValue;
    const heartbeat = { ...heartbeatValue, stateHash: mcpHash(heartbeatState) };
    assert.throws(() =>
      exchangeWorker(
        {
          version: 3,
          requestId,
          secret,
          session: worker,
          seq: seq + 1,
          mode: "normal",
          capability,
          observations: [],
          remote: {
            results: [],
            fenceAcks: [],
            mcp: [
              { type: "process_fact", process: heartbeat },
              { ...frame, projectId: newId(ID_PREFIXES.project) },
            ],
            mcpCursors: [],
          },
        },
        ctx,
      ),
    );
    assert.equal(sqlite.prepare("SELECT count(*) AS n FROM diagnostic_event").get()!.n, before);
    assert.equal(
      db.select().from(mcpServerProcess).where(eq(mcpServerProcess.id, fact.id)).get()!
        .stateRevision,
      fact.stateRevision,
    );
    if ((seq + 1) % 2 === 0) exchange();
    for (let index = 0; index < 6; index++)
      await transport.send({
        jsonrpc: "2.0",
        id: 10 + index,
        method: "fixture/echo",
        params: { text: "x".repeat(100000) },
      });
    for (let index = 0; index < 8; index++)
      requestExecution(
        {
          projectId,
          machineId,
          authorizationGeneration: 1,
          requestId: newId(ID_PREFIXES.request),
          operation: {
            kind: "file_write",
            path: "/tmp/sprout-mcp-budget-never-dispatched-to-worker",
            mode: "overwrite",
            content: "x".repeat(200000),
          },
        },
        ctx,
      );
    ctx.now = new Date();
    const budgetResponse = exchangeWorker(
      {
        version: 3,
        requestId,
        secret,
        session: worker,
        seq: ++seq,
        mode: "normal",
        capability,
        observations: [],
        remote: dispatcher.outgoing(),
      },
      ctx,
    );
    assert(Buffer.byteLength(JSON.stringify(budgetResponse)) <= 1048576);
    assert(budgetResponse.remote.commands.length > 0);
    assert(budgetResponse.remote.mcp.some((item: ServerMcpItem) => item.type === "frame"));
    assert(
      sqlite.prepare("SELECT count(*) AS n FROM remote_execution WHERE state='queued'").get()!.n >
        0,
    );
    assert(
      db
        .select()
        .from(mcpFrame)
        .where(
          and(
            eq(mcpFrame.sessionId, session.id),
            eq(mcpFrame.direction, "client_to_server"),
            eq(mcpFrame.state, "queued"),
          ),
        )
        .all().length > 0,
    );
    const replacementWorker = openWorker({ ...wire, attemptId: randomUUID() }, ctx).session;
    const replacementDispatcher = new RemoteDispatcher(
      replacementWorker,
      capability,
      Date.now,
      runtime,
    );
    const replacementResponse = exchangeWorker(
      {
        version: 3,
        requestId,
        secret,
        session: replacementWorker,
        seq: 1,
        mode: "normal",
        capability,
        observations: [],
        remote: replacementDispatcher.outgoing(),
      },
      ctx,
    );
    replacementDispatcher.accept(replacementResponse, 1, []);
    const disconnected = db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!;
    assert.equal(disconnected.state, "closed");
    assert.equal(disconnected.endReason, "worker_lost");
    assert.equal(
      db.select().from(mcpServerProcess).where(eq(mcpServerProcess.id, fact.id)).get()!.state,
      "running",
    );
    process.kill(fact.pid, 0);
    assert.equal(sqlite.prepare("PRAGMA foreign_key_check").all().length, 0);
    console.log(
      "PASS domain frame persistence, tombstone ack, atomic rejection, cross Project, stale generation and close lifetime",
    );
  }
  if (error) throw error;
} finally {
  if (timer) clearInterval(timer);
  dispatcher.disconnect();
  await runtime.stop();
  sqlite.close();
}
