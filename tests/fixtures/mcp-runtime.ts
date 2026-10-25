import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ID_PREFIXES, newId } from "../../src/contracts/ids";
import {
  mcpSessionSchema,
  type McpConfig,
  type McpServerProcess,
  type McpServerRegistration,
  type McpSession,
  type ServerMcpItem,
  type WorkerMcpItem,
} from "../../src/contracts/mcp";
import type { WorkerSession } from "../../src/contracts/worker-session";
import { mcpBound, mcpHash, mcpPayloadHash } from "../../src/domain/mcp/protocol";
import { McpRuntime } from "../../src/worker/mcp";

export const workerSession: WorkerSession = {
  machineId: newId(ID_PREFIXES.machine),
  generation: 1,
  bootId: newId(ID_PREFIXES.boot),
  attemptId: randomUUID(),
};
export const projectId = newId(ID_PREFIXES.project);
export const holderInstanceId = newId(ID_PREFIXES.instance);
export function registration(
  config?: McpConfig,
  machineId = workerSession.machineId,
  project = projectId,
): McpServerRegistration {
  const configJson: McpConfig = config ?? {
    transport: "stdio",
    command: process.execPath,
    args: [resolve("tests/fixtures/mcp-server.ts")],
    workingDirectory: process.cwd(),
    launch: "configured_service",
    autostart: true,
    exposure: "wire",
    roots: [],
    exposeSampling: true,
    elicitation: "cancel",
    requestTimeoutMs: 10000,
  };
  return {
    id: newId(ID_PREFIXES.mcpRegistration),
    revision: 1,
    projectId: project,
    machineId,
    name: "fixture",
    transport: configJson.transport,
    configRef: "fixture",
    configHash: mcpHash(configJson),
    configJson,
    createdAt: Date.now(),
    retiredAt: null,
  };
}
export function sessionFor(
  process: McpServerProcess,
  worker = workerSession,
  extra: Partial<McpSession> = {},
): McpSession {
  return mcpSessionSchema.parse({
    id: newId(ID_PREFIXES.mcpSession),
    projectId: process.projectId,
    machineId: process.machineId,
    processId: process.id,
    registrationId: process.registrationId,
    registrationRevision: process.registrationRevision,
    transport: process.transport,
    configHash: process.configHash,
    workerIncarnationId: process.workerIncarnationId,
    runId: newId(ID_PREFIXES.run),
    holderInstanceId,
    authorizationGeneration: 1,
    grantId: newId(ID_PREFIXES.remoteToolGrant),
    chatId: newId(ID_PREFIXES.chat),
    openRequestId: newId(ID_PREFIXES.request),
    openHash: "1".repeat(64),
    state: "connecting",
    createdAt: Date.now(),
    attachedAt: null,
    connectedAt: null,
    endedAt: null,
    endReason: null,
    protocolVersion: null,
    clientHighWater: 0,
    workerAckClientSeq: 0,
    serverHighWater: 0,
    hostAckServerSeq: 0,
    workerStateRevision: 0,
    workerStateHash: null,
    workerDetachedAt: null,
    fenceMutationId: null,
    workerConnectionGeneration: worker.generation,
    serverBootId: worker.bootId,
    workerAttemptId: worker.attemptId,
    ...extra,
  });
}
export const attach = (session: McpSession): ServerMcpItem => ({
  type: "session_attach",
  ...mcpBound(session),
  session,
  configHash: session.configHash,
});
export function clientFrame(
  session: McpSession,
  seq: number,
  value: unknown,
): Extract<ServerMcpItem, { type: "frame" }> {
  const payload = Buffer.from(JSON.stringify(value));
  return {
    type: "frame",
    direction: "client_to_server",
    ...mcpBound(session),
    frameId: newId(ID_PREFIXES.mcpFrame),
    seq,
    payloadBase64: payload.toString("base64"),
    payloadBytes: payload.length,
    payloadHash: mcpPayloadHash(payload),
    expiresAt: Date.now() + 120000,
  };
}
export const authorization = (session: McpSession) => ({
  projectId: session.projectId,
  machineId: session.machineId,
  generation: session.authorizationGeneration,
  state: "active" as const,
  holderInstanceId: session.holderInstanceId,
});
export async function waitFor<T>(read: () => T | undefined | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(5);
  }
  throw new Error("MCP fixture condition timed out");
}
export function serverFrames(runtime: McpRuntime): Extract<WorkerMcpItem, { type: "frame" }>[] {
  return runtime
    .outgoing()
    .mcp.filter((item): item is Extract<WorkerMcpItem, { type: "frame" }> => item.type === "frame");
}
export async function setup() {
  const runtime = new McpRuntime([registration()]);
  await runtime.start();
  runtime.bind(workerSession);
  const process = runtime.outgoing().mcp.find((item) => item.type === "process_fact");
  if (process?.type !== "process_fact") throw new Error("Process fact missing");
  const session = sessionFor(process.process);
  runtime.accept([attach(session)], [], [authorization(session)]);
  return { runtime, session, process: process.process };
}
