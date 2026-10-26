import assert from "node:assert/strict";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { openSync, closeSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import type { McpSession, WorkerMcpItem } from "../../src/contracts/mcp";
import { db, sqlite } from "../../src/db";
import { migrateDatabase } from "../../src/db/migrate";
import { mcpServerProcess, mcpSession } from "../../src/db/schema";
import { mcpPayloadHash } from "../../src/domain/mcp/protocol";
import { createMachine, saveProjectMachineBinding } from "../../src/domain/machine";
import { acquireLease } from "../../src/server/lease";
import {
  mcpCatalogGet,
  mcpSessionOpen,
  mcpSessionClose,
  mcpSessionExchange,
} from "../../src/server/mcp-relay";
import {
  enrollWorker,
  openWorker,
  exchangeWorker,
  closeWorker,
} from "../../src/server/worker-gateway";
import { initializeIdentity } from "../../src/worker/identity";
import { registration, waitFor } from "./mcp-runtime";
import { seedRemoteActor } from "./remote-actors";
import { startHttpMcpServer } from "./mcp-http-server";

const evidencePath = process.env.MCP_EVIDENCE;
const databaseUrl = process.env.DATABASE_URL;
assert(evidencePath && databaseUrl && databaseUrl !== ":memory:");
const directory = dirname(evidencePath);
const oldMigrations = join(directory, "before-0012");
await mkdir(join(oldMigrations, "meta"), { recursive: true });
const journal = JSON.parse(await readFile("drizzle/meta/_journal.json", "utf8"));
const targetTag = "0012_active_mcp_sessions";
const targetIndex = journal.entries.findIndex((entry: { tag: string }) => entry.tag === targetTag);
assert(targetIndex > 0, `journal 里必须有 ${targetTag}`);
const oldEntries = journal.entries.slice(0, targetIndex);
assert.equal(oldEntries.at(-1).idx, targetIndex - 1, `旧账本必须止于 ${targetTag} 的前一条`);
for (const entry of oldEntries)
  await copyFile(`drizzle/${entry.tag}.sql`, join(oldMigrations, `${entry.tag}.sql`));
await writeFile(
  join(oldMigrations, "meta/_journal.json"),
  JSON.stringify({ ...journal, entries: oldEntries }),
);
migrateDatabase(databaseUrl, oldMigrations);
const oldIndex = sqlite
  .prepare("SELECT sql FROM sqlite_master WHERE name='mcp_session_process_unique'")
  .get() as { sql: string };
assert(!oldIndex.sql.includes("WHERE"));
const beforeCount = (
  sqlite.prepare("SELECT count(*) n FROM __drizzle_migrations").get() as { n: number }
).n;
migrateDatabase();
const afterCount = (
  sqlite.prepare("SELECT count(*) n FROM __drizzle_migrations").get() as { n: number }
).n;
assert.equal(afterCount, journal.entries.length, "前向迁移后账本等于 journal 总条数");
assert(beforeCount < afterCount);
migrateDatabase();
assert.equal(
  (sqlite.prepare("SELECT count(*) n FROM __drizzle_migrations").get() as { n: number }).n,
  afterCount,
);
const newIndex = sqlite
  .prepare("SELECT sql FROM sqlite_master WHERE name='mcp_session_process_unique'")
  .get() as { sql: string };
assert(newIndex.sql.includes("WHERE"));
const bootId = newId(ID_PREFIXES.boot);
sqlite
  .prepare(
    "INSERT INTO runtime_boot(id,started_at,phase,pid,app_version) VALUES (?,1,'ready',1,'test')",
  )
  .run(bootId);
sqlite
  .prepare(
    "INSERT INTO user(id,name,email,email_verified,created_at,updated_at) VALUES ('owner','owner','http@example.test',0,1,1)",
  )
  .run();
const projectId = newId(ID_PREFIXES.project);
sqlite
  .prepare("INSERT INTO project(id,name,created_by) VALUES (?,'HTTP MCP','owner')")
  .run(projectId);
const ctx = seedRemoteActor(sqlite, "owner", projectId, bootId);
const machine = createMachine({ name: "HTTP Worker" }, ctx);
const machineId = machine.detail.machine.id;
saveProjectMachineBinding(
  { projectId, machineId, description: "HTTP", expectedRevision: null },
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

let lastCapability: unknown;
let gatewayFailure = false;
let closeWindowSession: string | undefined;
const gateway = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const input = JSON.parse(Buffer.concat(chunks).toString());
    ctx.now = new Date();
    let data;
    if (req.url === "/api/worker/open") data = { ...openWorker(input, ctx), pollIntervalMs: 30 };
    else if (req.url === "/api/worker/exchange") {
      lastCapability = input.capability ?? lastCapability;
      if (
        closeWindowSession &&
        input.remote?.mcp.some(
          (item: WorkerMcpItem) =>
            item.type === "session_fact" &&
            item.sessionId === closeWindowSession &&
            item.state === "attached",
        )
      ) {
        const row = db
          .select()
          .from(mcpSession)
          .where(eq(mcpSession.id, closeWindowSession))
          .get()!;
        assert.equal(row.attachedAt, null);
        mcpSessionClose(
          {
            ...leaseInput,
            sessionId: row.id,
            requestId: newId(ID_PREFIXES.request),
            reason: "client_closed",
          },
          ctx,
        );
        closeWindowSession = undefined;
      }
      data = exchangeWorker(input, ctx);
    } else if (req.url === "/api/worker/close") data = closeWorker(input, ctx);
    else throw new Error("Unexpected Worker route");
    res
      .writeHead(200, { "Content-Type": "application/json" })
      .end(JSON.stringify({ version: 3, requestId: input.requestId, ok: true, data }));
  } catch {
    gatewayFailure = true;
    res.writeHead(500, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        version: 3,
        requestId: newId(ID_PREFIXES.request),
        ok: false,
        error: {
          code: "internal",
          message: "fixture failure",
        },
      }),
    );
  }
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const gatewayAddress = gateway.address();
assert(gatewayAddress && typeof gatewayAddress !== "string");
const identity = await initializeIdentity(
  join(directory, "worker-state"),
  `http://127.0.0.1:${gatewayAddress.port}`,
  machineId,
  [],
);
enrollWorker(
  {
    machineId,
    secret: identity.secret,
    version: 3,
    requestId: newId(ID_PREFIXES.request),
    ticket: machine.ticket,
  },
  ctx,
);
const owner = await startHttpMcpServer();
const reservation = createServer();
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const reservedAddress = reservation.address();
assert(reservedAddress && typeof reservedAddress !== "string");
const servicePort = reservedAddress.port;
await new Promise<void>((resolve) => reservation.close(() => resolve()));
const common = {
  exposure: "wire" as const,
  roots: [],
  exposeSampling: false,
  elicitation: "absent" as const,
  requestTimeoutMs: 3000,
};
const ownerRegistration = {
  ...registration(
    {
      ...common,
      transport: "streamableHttp",
      url: owner.url,
      launch: "owner_managed",
      autostart: false,
    },
    machineId,
    projectId,
  ),
  name: "owner_http",
};
const managedRegistration = {
  ...registration(
    {
      ...common,
      transport: "streamableHttp",
      url: `http://127.0.0.1:${servicePort}/mcp`,
      launch: "configured_service",
      autostart: true,
      service: {
        command: process.execPath,
        args: [resolve("tests/fixtures/mcp-http-server.ts"), String(servicePort)],
        workingDirectory: process.cwd(),
      },
    },
    machineId,
    projectId,
  ),
  name: "managed_http",
};
const failedRegistration = {
  ...registration(
    {
      ...common,
      requestTimeoutMs: 100,
      transport: "streamableHttp",
      url: "http://127.0.0.1:1/mcp",
      launch: "owner_managed",
      autostart: false,
    },
    machineId,
    projectId,
  ),
  name: "unreachable_http",
};
const failedManagedRegistration = {
  ...registration(
    {
      ...common,
      transport: "streamableHttp",
      url: "http://127.0.0.1:1/mcp",
      launch: "configured_service",
      autostart: true,
      requestTimeoutMs: 100,
      service: {
        command: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        workingDirectory: process.cwd(),
      },
    },
    machineId,
    projectId,
  ),
  name: "unreachable_managed_http",
};
const configPath = join(directory, "registrations.json");
await writeFile(
  configPath,
  JSON.stringify([
    failedRegistration,
    failedManagedRegistration,
    ownerRegistration,
    managedRegistration,
  ]),
  { mode: 0o600 },
);
let worker: ChildProcess | undefined;
let managedPid: number | undefined;
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
const live = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const leaseInput = { projectId, machineId, authorizationGeneration: 1 };
const catalog = () => {
  ctx.now = new Date();
  return mcpCatalogGet(leaseInput, ctx);
};
try {
  const workerLog = openSync(join(directory, "worker.log"), "w", 0o600);
  worker = spawn(
    process.execPath,
    [
      "dist/worker/main.js",
      "run",
      "--state-dir",
      join(directory, "worker-state"),
      "--mcp-config",
      configPath,
    ],
    { stdio: ["ignore", workerLog, workerLog] },
  );
  closeSync(workerLog);
  exited = new Promise((resolve, reject) => {
    worker!.once("error", reject);
    worker!.once("exit", (code, signal) => resolve({ code, signal }));
  });
  await waitFor(
    () =>
      db.select().from(mcpServerProcess).where(eq(mcpServerProcess.machineId, machineId)).all()
        .length === 4,
    15000,
  );
  assert(!gatewayFailure);
  const facts: (typeof mcpServerProcess.$inferSelect)[] = db
    .select()
    .from(mcpServerProcess)
    .where(eq(mcpServerProcess.machineId, machineId))
    .all();
  const ownerFact = facts.find((fact) => fact.registrationId === ownerRegistration.id)!;
  const managedFact = facts.find((fact) => fact.registrationId === managedRegistration.id)!;
  const failedFact = facts.find((fact) => fact.registrationId === failedRegistration.id)!;
  const failedManagedFact = facts.find(
    (fact) => fact.registrationId === failedManagedRegistration.id,
  )!;
  assert.equal(failedManagedFact.state, "failed");
  assert.equal(failedManagedFact.endReason, "unreachable");
  assert(failedManagedFact.processStartedAt);
  assert.equal(ownerFact.state, "running");
  assert.equal(ownerFact.pid, null);
  assert.equal(ownerFact.endpoint, owner.url);
  assert.equal(ownerFact.processStartedAt, null);
  assert.equal(managedFact.state, "running");
  assert.equal(managedFact.pid, null);
  assert(managedFact.processStartedAt);
  const managedServer = (await (await fetch(`http://127.0.0.1:${servicePort}/stats`)).json()) as {
    pid: number;
  };
  managedPid = managedServer.pid;
  assert(live(managedPid));
  assert.equal(failedFact.state, "failed");
  assert.equal(failedFact.endReason, "unreachable");
  assert.deepEqual((lastCapability as { mcpRelay: { transports: string[] } }).mcpRelay.transports, [
    "stdio",
    "streamableHttp",
  ]);
  const workerChildren = execFileSync("ps", ["-axo", "pid=,ppid="], {
    encoding: "utf8",
  })
    .trim()
    .split("\n")
    .map((line) => line.trim().split(/\s+/).map(Number))
    .filter(([, parent]) => parent === worker!.pid)
    .map(([pid]) => pid);
  assert.deepEqual(workerChildren, [managedPid]);
  const ownerServerPid = (
    (await (await fetch(owner.url.replace("/mcp", "/stats"))).json()) as { pid: number }
  ).pid;
  assert.equal(ownerServerPid, process.pid);
  const view = catalog();
  assert.equal(
    view.registrations.find((row) => row.registrationId === ownerRegistration.id)?.processes[0]
      ?.processId,
    ownerFact.id,
  );
  assert.equal(
    view.registrations.find((row) => row.registrationId === failedRegistration.id)?.processes
      .length,
    0,
  );
  const open = (fact = ownerFact) => {
    ctx.now = new Date();
    return mcpSessionOpen(
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
  };
  const rapid = open();
  mcpSessionClose(
    {
      ...leaseInput,
      sessionId: rapid.id,
      requestId: newId(ID_PREFIXES.request),
      reason: "client_closed",
    },
    ctx,
  );
  await waitFor(
    () =>
      db.select().from(mcpSession).where(eq(mcpSession.id, rapid.id)).get()!.workerDetachedAt !==
      null,
  );
  const window = open();
  closeWindowSession = window.id;
  await waitFor(
    () =>
      db.select().from(mcpSession).where(eq(mcpSession.id, window.id)).get()!.workerDetachedAt !==
      null,
  );
  assert.equal(closeWindowSession, undefined);
  assert.equal(worker.exitCode, null);
  process.kill(worker.pid!, 0);
  console.log(
    "PASS real Worker CLI rapid close and close before attached fact commit; process slot released",
  );
  const first = open();
  // Bypass the gateway guard to prove SQLite itself rejects a second active row.
  assert.throws(
    () =>
      db
        .insert(mcpSession)
        .values({
          ...first,
          id: newId(ID_PREFIXES.mcpSession),
          openRequestId: newId(ID_PREFIXES.request),
        })
        .run(),
    /UNIQUE/,
  );
  assert.throws(
    () => open(),
    (error: unknown) =>
      !!error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "remote_request_conflict",
  );
  const tools = async (session: McpSession) => {
    let clientSeq = 0,
      ackServerSeq = 0;
    let protocolVersion: string | null = null;
    const exchange = async (messages: unknown[]) => {
      ctx.now = new Date();
      return mcpSessionExchange(
        {
          ...leaseInput,
          sessionId: session.id,
          frames: messages.map((value) => {
            const payload = Buffer.from(JSON.stringify(value));
            return {
              frameId: newId(ID_PREFIXES.mcpFrame),
              seq: ++clientSeq,
              payloadBase64: payload.toString("base64"),
              payloadBytes: payload.length,
              payloadHash: mcpPayloadHash(payload),
              expiresAt: Date.now() + 10000,
            };
          }),
          ackServerSeq,
          cancelClientSeqs: [],
          protocolVersion,
          confirmInitialized: protocolVersion !== null,
          holdMs: 0,
        },
        ctx,
      );
    };
    const rpc = async (id: number, method: string, params?: unknown) => {
      await exchange([{ jsonrpc: "2.0", id, method, params }]);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const response = await exchange([]);
        for (const frame of response.frames) {
          ackServerSeq = frame.seq;
          const value = JSON.parse(Buffer.from(frame.payloadBase64, "base64").toString());
          if (value.id === id) return value;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("HTTP gateway RPC timed out");
    };
    const initialized = await rpc(1, "initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "wire-acceptance", version: "1" },
    });
    assert.equal(initialized.result.protocolVersion, "2025-03-26");
    protocolVersion = initialized.result.protocolVersion;
    await exchange([{ jsonrpc: "2.0", method: "notifications/initialized" }]);
    const listed = await rpc(2, "tools/list");
    assert(listed.result.tools[0].name === "wire_echo", "HTTP tools/list target missing");
    const called = await rpc(3, "tools/call", {
      name: "wire_echo",
      arguments: { text: "acceptance fixture payload" },
    });
    assert(
      called.result.content[0].text === "acceptance fixture payload",
      "HTTP tools/call content mismatch",
    );
    assert.equal(called.result.structuredContent.delivered, true);
    assert.equal(
      db.select().from(mcpSession).where(eq(mcpSession.id, session.id)).get()!.state,
      "connected",
    );
    return { listedToolCount: listed.result.tools.length, callReturned: true, connected: true };
  };
  const firstResult = await tools(first);
  const deleteBefore = owner.stats.deletes;
  ctx.now = new Date();
  mcpSessionClose(
    {
      ...leaseInput,
      sessionId: first.id,
      requestId: newId(ID_PREFIXES.request),
      reason: "client_closed",
    },
    ctx,
  );
  await waitFor(() => owner.stats.deletes > deleteBefore);
  assert.equal(
    db.select().from(mcpSession).where(eq(mcpSession.id, first.id)).get()!.state,
    "closed",
  );
  assert.equal(
    db.select().from(mcpServerProcess).where(eq(mcpServerProcess.id, ownerFact.id)).get()!.state,
    "running",
  );
  const second = open();
  assert.notEqual(second.id, first.id);
  assert.equal(second.processId, first.processId);
  const secondResult = await tools(second);
  const managedSession = open(managedFact);
  const managedResult = await tools(managedSession);
  const managedStats = (await (await fetch(`http://127.0.0.1:${servicePort}/stats`)).json()) as {
    pid: number;
    deletes: number;
  };
  assert.equal(managedStats.pid, managedPid);
  assert(live(managedPid));
  worker.kill("SIGTERM");
  await waitFor(() => worker!.exitCode !== null || worker!.signalCode !== null, 8000);
  const exit = await exited;
  assert.deepEqual(exit, { code: 0, signal: null });
  await waitFor(() => !live(managedPid!));
  const ownerAfterExit = (await fetch(owner.url.replace("/mcp", "/stats"))).ok;
  assert(ownerAfterExit);
  assert(!gatewayFailure);
  const evidence = {
    pass: true,
    worker: {
      pid: worker.pid,
      exit,
      transports: ["stdio", "streamableHttp"],
      realCli: true,
      bundled: true,
    },
    ownerManaged: {
      autostart: false,
      pid: ownerFact.pid,
      processStartedAt: ownerFact.processStartedAt,
      endpoint: ownerFact.endpoint,
      catalogTarget: ownerFact.id,
      noSpawn: workerChildren.length === 1 && ownerServerPid === process.pid,
      workerChildren,
      runningAfterDelete: true,
      aliveAfterWorkerExit: ownerAfterExit,
      deleteCount: owner.stats.deletes,
      getCount: owner.stats.gets,
      firstResult,
      secondResult,
    },
    configuredService: {
      pid: managedPid,
      processFactPid: managedFact.pid,
      transport: "streamableHttp",
      spawnedServerPidMatched: managedStats.pid === managedPid,
      call: managedResult,
      aliveBeforeWorkerExit: true,
      aliveAfterWorkerExit: live(managedPid),
    },
    failures: {
      workerContinued: true,
      state: failedFact.state,
      endReason: failedFact.endReason,
      failedCatalogTargets: 0,
      configuredServiceFailed: {
        state: failedManagedFact.state,
        endReason: failedManagedFact.endReason,
        childTerminated: workerChildren.length === 1,
      },
    },
    sessions: {
      sameProcessId: second.processId === first.processId,
      closedState: "closed",
      newSessionId: second.id !== first.id,
      sqliteConcurrentActiveRejected: true,
      gatewayConflictCode: "remote_request_conflict",
    },
    migration: {
      beforeCount,
      afterCount,
      repeatCount: afterCount,
      oldIndex: oldIndex.sql,
      newIndex: newIndex.sql,
      oldWhen: oldEntries.at(-1).when,
      newWhen: journal.entries.at(-1).when,
    },
  };
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + "\n");
  console.log(
    "PASS real Worker CLI HTTP initialize, JSON tools/list, SSE tools/call, GET stream and DELETE attachment",
  );
  console.log(
    "PASS owner_managed autostart=false: no spawned pid, catalog target, service survives Worker exit",
  );
  console.log("PASS configured_service: actual spawned server pid, terminated after Worker exit");
  console.log(
    "PASS unreachable registration failed/unreachable; other registrations running; no failed catalog target",
  );
  console.log(
    "PASS same process closed then reopened; SQLite rejects two active sessions; gateway returns remote_request_conflict",
  );
  console.log(
    `PASS migration ${oldEntries.at(-1).tag}->${targetTag} then forward to ${journal.entries.at(-1).tag}: ${beforeCount}->${afterCount}; repeat migrate ledger unchanged`,
  );
} finally {
  if (worker && worker.exitCode === null && worker.signalCode === null) {
    worker.kill("SIGTERM");
    const timer = setTimeout(() => worker?.kill("SIGKILL"), 5000);
    await exited;
    clearTimeout(timer);
  }
  if (managedPid && live(managedPid)) {
    try {
      process.kill(-managedPid, "SIGKILL");
    } catch {}
  }
  await owner.close();
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  sqlite.close();
}
