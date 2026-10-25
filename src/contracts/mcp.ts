import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { workerSessionSchema } from "./worker-session";

export const MCP_MAX_MESSAGE_BYTES = 131072;
export const MCP_MAX_ITEM_BYTES = 196608;
export const MCP_TRANSPORTS = ["stdio", "streamableHttp"] as const;
export const MCP_PROCESS_STATES = [
  "starting",
  "running",
  "stopping",
  "stopped",
  "failed",
  "lost",
] as const;
export const MCP_SESSION_STATES = ["connecting", "active", "draining", "closed", "failed"] as const;
export const MCP_FRAME_STATES = ["queued", "sent", "acked", "cancelled", "dropped"] as const;
export const MCP_FRAME_DIRECTIONS = ["client_to_server", "server_to_client"] as const;
const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));
const natural = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positive = natural.min(1);
const timestamp = natural;
const hash = z.string().regex(/^[0-9a-f]{64}$/);
const uuid = z.uuidv4();
const noNul = (max: number) =>
  z
    .string()
    .min(1)
    .max(max)
    .refine((value) => !value.includes("\0"));
const absolutePath = noNul(4096).refine((value) => value.startsWith("/"));
const transport = z.enum(MCP_TRANSPORTS);
export const mcpRegistrationIdSchema = id(ID_PREFIXES.mcpRegistration);
export const mcpProcessIdSchema = id(ID_PREFIXES.mcpProcess);
export const mcpSessionIdSchema = id(ID_PREFIXES.mcpSession);
export const mcpFrameIdSchema = id(ID_PREFIXES.mcpFrame);
const projectMachine = { projectId: id(ID_PREFIXES.project), machineId: id(ID_PREFIXES.machine) };
const root = z.strictObject({ uri: z.url().startsWith("file://"), name: noNul(256).optional() });
const commonConfig = {
  roots: z.array(root).max(16),
  toolAllowlist: z
    .array(noNul(128))
    .min(1)
    .max(64)
    .refine((values) => new Set(values).size === values.length),
  exposeResources: z.boolean(),
  exposeSampling: z.boolean(),
  exposeElicitation: z.boolean(),
  requestTimeoutMs: positive.max(300000),
};
export const mcpConfigSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...commonConfig,
    transport: z.literal("stdio"),
    command: absolutePath,
    args: z
      .array(
        z
          .string()
          .max(4096)
          .refine((value) => !value.includes("\0")),
      )
      .max(64),
    cwd: absolutePath,
    envRefs: z.record(noNul(128), noNul(128)).refine((value) => Object.keys(value).length <= 32),
  }),
  z.strictObject({
    ...commonConfig,
    transport: z.literal("streamableHttp"),
    url: z.url().refine((value) => {
      const url = new URL(value);
      return (
        ["http:", "https:"].includes(url.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
        !/^https?:\/\/[^/]*@/.test(url.href) &&
        !url.search &&
        !url.hash
      );
    }),
    headerRefs: z.record(noNul(128), noNul(128)).refine((value) => Object.keys(value).length <= 32),
  }),
]);
export const mcpServerRegistrationSchema = z
  .strictObject({
    id: mcpRegistrationIdSchema,
    revision: positive,
    ...projectMachine,
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
    transport,
    configRef: noNul(128),
    configHash: hash,
    configJson: mcpConfigSchema,
    createdAt: timestamp,
    retiredAt: timestamp.nullable(),
  })
  .refine(
    (value) =>
      value.configJson.transport === value.transport &&
      (value.retiredAt === null || value.retiredAt >= value.createdAt),
  );
export const mcpServerProcessSchema = z
  .strictObject({
    id: mcpProcessIdSchema,
    ...projectMachine,
    registrationId: mcpRegistrationIdSchema,
    registrationRevision: positive,
    transport,
    configHash: hash,
    workerIncarnationId: uuid,
    launchNonce: uuid,
    state: z.enum(MCP_PROCESS_STATES),
    pid: positive.max(2147483647).nullable(),
    endpoint: z.url().nullable(),
    startedAt: timestamp,
    lastObservedAt: timestamp,
    endedAt: timestamp.nullable(),
    stopReason: noNul(128).nullable(),
    stateRevision: positive,
    stateHash: hash,
  })
  .refine((value) => {
    if (value.lastObservedAt < value.startedAt) return false;
    if (["stopped", "failed", "lost"].includes(value.state))
      return (
        value.endedAt !== null && value.endedAt >= value.startedAt && value.stopReason !== null
      );
    if (value.endedAt !== null || value.stopReason !== null) return false;
    if (value.state === "starting") return true;
    if (value.state !== "running") return false;
    return value.transport === "stdio"
      ? value.pid !== null && value.endpoint === null
      : value.endpoint !== null;
  });
const sessionIdentity = {
  ...projectMachine,
  authorizationGeneration: positive,
  holderInstanceId: id(ID_PREFIXES.instance),
  processId: mcpProcessIdSchema,
  workerSession: workerSessionSchema,
};
export const mcpSessionSchema = z
  .strictObject({
    id: mcpSessionIdSchema,
    ...projectMachine,
    registrationId: mcpRegistrationIdSchema,
    registrationRevision: positive,
    processId: mcpProcessIdSchema,
    authorizationGeneration: positive,
    holderInstanceId: id(ID_PREFIXES.instance),
    grantId: id(ID_PREFIXES.remoteToolGrant),
    runId: id(ID_PREFIXES.run),
    chatId: id(ID_PREFIXES.chat),
    openRequestId: id(ID_PREFIXES.request),
    openFingerprint: hash,
    workerBootId: id(ID_PREFIXES.boot),
    workerConnectionGeneration: positive,
    workerAttemptId: uuid,
    workerIncarnationId: uuid,
    protocolVersion: noNul(64).nullable(),
    state: z.enum(MCP_SESSION_STATES),
    reason: noNul(128).nullable(),
    createdAt: timestamp,
    initializedAt: timestamp.nullable(),
    closedAt: timestamp.nullable(),
    hostAckServerSeq: natural,
    clientAcceptedThrough: natural,
    serverAcceptedThrough: natural,
    clientHighWater: natural,
    serverHighWater: natural,
    workerStateRevision: natural,
    workerStateHash: hash.nullable(),
  })
  .refine(
    (value) =>
      value.hostAckServerSeq <= value.serverHighWater &&
      value.clientAcceptedThrough <= value.clientHighWater &&
      value.serverAcceptedThrough <= value.serverHighWater &&
      (value.workerStateRevision === 0) === (value.workerStateHash === null) &&
      (value.initializedAt === null || value.initializedAt >= value.createdAt) &&
      (["closed", "failed"].includes(value.state)
        ? value.closedAt !== null && value.closedAt >= value.createdAt && value.reason !== null
        : value.closedAt === null && value.reason === null) &&
      (value.state !== "active" ||
        (value.protocolVersion !== null && value.initializedAt !== null)),
  );
const base64 = z
  .string()
  .min(4)
  .max(174764)
  .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/);
const framePayload = {
  frameId: mcpFrameIdSchema,
  seq: positive,
  payloadBase64: base64,
  payloadBytes: positive.max(MCP_MAX_MESSAGE_BYTES),
  payloadHash: hash,
  expiresAt: timestamp,
};
const matchingPayload = (value: { payloadBase64: string; payloadBytes: number }) =>
  (value.payloadBase64.length / 4) * 3 -
    (value.payloadBase64.endsWith("==") ? 2 : value.payloadBase64.endsWith("=") ? 1 : 0) ===
  value.payloadBytes;
export const mcpHostOutboundFrameSchema = z.strictObject(framePayload).refine(matchingPayload);
export const mcpServerInboundFrameSchema = z.strictObject(framePayload).refine(matchingPayload);
export const mcpFrameSchema = z
  .strictObject({
    id: mcpFrameIdSchema,
    sessionId: mcpSessionIdSchema,
    direction: z.enum(MCP_FRAME_DIRECTIONS),
    seq: positive,
    payloadBase64: base64.nullable(),
    payloadBytes: positive.max(MCP_MAX_MESSAGE_BYTES),
    payloadHash: hash,
    state: z.enum(MCP_FRAME_STATES),
    createdAt: timestamp,
    expiresAt: timestamp,
    sentAt: timestamp.nullable(),
    terminalAt: timestamp.nullable(),
    terminalReason: noNul(128).nullable(),
  })
  .refine(
    (value) =>
      value.expiresAt > value.createdAt &&
      (value.sentAt === null || value.sentAt >= value.createdAt) &&
      (value.terminalAt === null || value.terminalAt >= value.createdAt) &&
      (value.payloadBase64 === null ||
        matchingPayload({ ...value, payloadBase64: value.payloadBase64 })) &&
      (value.state === "queued"
        ? value.payloadBase64 !== null &&
          value.sentAt === null &&
          value.terminalAt === null &&
          value.terminalReason === null
        : value.state === "sent"
          ? value.payloadBase64 !== null &&
            value.sentAt !== null &&
            value.terminalAt === null &&
            value.terminalReason === null
          : value.state === "acked"
            ? value.sentAt !== null && value.terminalAt !== null && value.terminalReason === null
            : value.terminalAt !== null && value.terminalReason !== null),
  );
const leaseInput = { ...projectMachine, authorizationGeneration: positive };
export const mcpCatalogGetInputSchema = z.strictObject(leaseInput);
export const mcpSessionOpenInputSchema = z.strictObject({
  ...leaseInput,
  requestId: id(ID_PREFIXES.request),
  registrationId: mcpRegistrationIdSchema,
  registrationRevision: positive,
  processId: mcpProcessIdSchema,
  expectedWorkerIncarnationId: uuid,
});
export const mcpSessionExchangeInputSchema = z
  .strictObject({
    ...leaseInput,
    sessionId: mcpSessionIdSchema,
    frames: z.array(mcpHostOutboundFrameSchema).max(2),
    ackServerSeq: natural,
    cancelClientSeqs: z
      .array(positive)
      .max(32)
      .refine((values) => new Set(values).size === values.length),
    protocolVersion: noNul(64).nullable(),
    confirmInitialized: z.boolean(),
    holdMs: natural.max(2000),
  })
  .refine((value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= 393216);
export const mcpSessionCloseInputSchema = z.strictObject({
  ...leaseInput,
  sessionId: mcpSessionIdSchema,
  requestId: id(ID_PREFIXES.request),
  reason: z.literal("client_closed"),
});
export const mcpCatalogGetCall = z.strictObject({
  type: z.literal("mcp_catalog_get"),
  input: mcpCatalogGetInputSchema,
});
export const mcpSessionOpenCall = z.strictObject({
  type: z.literal("mcp_session_open"),
  input: mcpSessionOpenInputSchema,
});
export const mcpSessionExchangeCall = z.strictObject({
  type: z.literal("mcp_session_exchange"),
  input: mcpSessionExchangeInputSchema,
});
export const mcpSessionCloseCall = z.strictObject({
  type: z.literal("mcp_session_close"),
  input: mcpSessionCloseInputSchema,
});
export const mcpCatalogViewSchema = z.strictObject({
  registrations: z
    .array(
      z.strictObject({
        registrationId: mcpRegistrationIdSchema,
        registrationRevision: positive,
        ...projectMachine,
        name: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
        transport,
        configHash: hash,
        ...commonConfig,
        processes: z
          .array(
            z.strictObject({
              processId: mcpProcessIdSchema,
              workerIncarnationId: uuid,
              lastObservedAt: timestamp,
            }),
          )
          .max(8),
      }),
    )
    .max(64),
});
export const mcpSessionOpenOutputSchema = z.strictObject({ session: mcpSessionSchema });
export const mcpSessionCloseOutputSchema = z.strictObject({ session: mcpSessionSchema });
export const mcpSessionExchangeOutputSchema = z.strictObject({
  session: mcpSessionSchema,
  acceptedClientSeq: natural,
  frames: z.array(mcpServerInboundFrameSchema).max(2),
  hasMore: z.boolean(),
});
export const mcpSessionCursorSchema = z
  .strictObject({
    sessionId: mcpSessionIdSchema,
    ...sessionIdentity,
    clientAcceptedThrough: natural,
    serverAcceptedThrough: natural,
  })
  .refine((value) => value.workerSession.machineId === value.machineId);
const bound = { sessionId: mcpSessionIdSchema, ...sessionIdentity };
const targets = z
  .array(z.strictObject({ sessionId: mcpSessionIdSchema, processId: mcpProcessIdSchema }))
  .max(8)
  .refine((values) => new Set(values.map((value) => value.sessionId)).size === values.length);
const fence = {
  ...projectMachine,
  authorizationGeneration: positive,
  holderInstanceId: id(ID_PREFIXES.instance),
  workerSession: workerSessionSchema,
  mutationId: id(ID_PREFIXES.leaseMutation),
  sessions: targets,
};
const wireFrame = { type: z.literal("frame"), ...bound, ...framePayload };
const matchingWorker = (value: { machineId: string; workerSession: { machineId: string } }) =>
  value.machineId === value.workerSession.machineId;
export const mcpWorkerItemSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("registration_fact"),
      registration: mcpServerRegistrationSchema,
    }),
    z.strictObject({
      type: z.literal("registration_retire"),
      registrationId: mcpRegistrationIdSchema,
      revision: positive,
      configHash: hash,
    }),
    z.strictObject({ type: z.literal("process_fact"), process: mcpServerProcessSchema }),
    z.strictObject({
      type: z.literal("session_fact"),
      ...bound,
      state: z.enum(["attached", "failed", "detached"]),
      reason: noNul(128).nullable(),
      stateRevision: positive,
      stateHash: hash,
    }),
    z.strictObject({ type: z.literal("session_fence_ack"), ...fence, detached: z.literal(true) }),
    z
      .strictObject({ ...wireFrame, direction: z.literal("server_to_client") })
      .refine(matchingPayload),
  ])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MCP_MAX_ITEM_BYTES,
  )
  .refine((value) => !("workerSession" in value) || matchingWorker(value));
export const mcpServerItemSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      type: z.literal("session_attach"),
      ...bound,
      session: mcpSessionSchema,
      configHash: hash,
    }),
    z.strictObject({ type: z.literal("session_protocol"), ...bound, protocolVersion: noNul(64) }),
    z.strictObject({
      type: z.literal("session_detach"),
      ...bound,
      reason: noNul(128),
      mutationId: id(ID_PREFIXES.leaseMutation).optional(),
    }),
    z.strictObject({ type: z.literal("session_fence"), ...fence }),
    z.strictObject({
      type: z.literal("cancel_frames"),
      ...bound,
      tombstones: z
        .array(
          z.strictObject({ clientSeq: positive, frameId: mcpFrameIdSchema, payloadHash: hash }),
        )
        .max(32)
        .refine((values) => new Set(values.map((value) => value.clientSeq)).size === values.length),
    }),
    z
      .strictObject({ ...wireFrame, direction: z.literal("client_to_server") })
      .refine(matchingPayload),
  ])
  .refine(
    (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= MCP_MAX_ITEM_BYTES,
  )
  .refine(matchingWorker)
  .refine(
    (value) =>
      value.type !== "session_attach" ||
      (value.session.id === value.sessionId &&
        value.session.projectId === value.projectId &&
        value.session.machineId === value.machineId &&
        value.session.processId === value.processId &&
        value.session.authorizationGeneration === value.authorizationGeneration &&
        value.session.holderInstanceId === value.holderInstanceId &&
        value.session.workerBootId === value.workerSession.bootId &&
        value.session.workerConnectionGeneration === value.workerSession.generation &&
        value.session.workerAttemptId === value.workerSession.attemptId),
  );
const batchBudget = (items: { type: string }[]) => {
  let controlBytes = 0;
  let frameBytes = 0;
  for (const item of items) {
    const bytes = new TextEncoder().encode(JSON.stringify(item)).byteLength;
    if (item.type === "frame") frameBytes += bytes;
    else controlBytes += bytes;
  }
  return controlBytes <= 65536 && frameBytes <= 524288;
};
export const mcpWorkerExchangeShape = {
  mcp: z.array(mcpWorkerItemSchema).max(64).refine(batchBudget),
  mcpCursors: z.array(mcpSessionCursorSchema).max(8),
};
export const mcpServerExchangeShape = {
  mcp: z.array(mcpServerItemSchema).max(64).refine(batchBudget),
  mcpCursors: z.array(mcpSessionCursorSchema).max(8),
};
export type McpLeaseInput = z.infer<typeof mcpCatalogGetInputSchema>;
export type McpBoundInput = McpLeaseInput & { sessionId: string };
export type McpSessionOpenInput = z.infer<typeof mcpSessionOpenInputSchema>;
export type McpSessionExchangeInput = z.infer<typeof mcpSessionExchangeInputSchema>;
export type McpSessionCloseInput = z.infer<typeof mcpSessionCloseInputSchema>;
export type HostOutboundFrame = z.infer<typeof mcpHostOutboundFrameSchema>;
export type ServerInboundFrame = z.infer<typeof mcpServerInboundFrameSchema>;
export type McpCatalogView = z.infer<typeof mcpCatalogViewSchema>;
export type McpConfig = z.infer<typeof mcpConfigSchema>;
export type McpServerRegistration = z.infer<typeof mcpServerRegistrationSchema>;
export type McpServerProcess = z.infer<typeof mcpServerProcessSchema>;
export type McpSession = z.infer<typeof mcpSessionSchema>;
export type McpFrame = z.infer<typeof mcpFrameSchema>;
export type WorkerMcpItem = z.infer<typeof mcpWorkerItemSchema>;
export type ServerMcpItem = z.infer<typeof mcpServerItemSchema>;
export type SessionCursor = z.infer<typeof mcpSessionCursorSchema>;
