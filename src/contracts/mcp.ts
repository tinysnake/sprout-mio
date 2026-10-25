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
  "exited",
  "failed",
  "lost",
] as const;
export const MCP_SESSION_STATES = [
  "connecting",
  "connected",
  "disconnected",
  "failed",
  "closed",
] as const;
export const MCP_FRAME_STATES = ["queued", "sent", "acked", "dropped", "unknown"] as const;
export const MCP_FRAME_DIRECTIONS = ["client_to_server", "server_to_client"] as const;
export const MCP_PROCESS_END_REASONS = [
  "owner_stopped",
  "spawn_failed",
  "exited",
  "crashed",
  "unreachable",
  "worker_lost",
  "config_retired",
] as const;
export const MCP_SESSION_END_REASONS = [
  "client_closed",
  "grant_expired",
  "run_ended",
  "authorization_revoked",
  "target_lost",
  "worker_lost",
  "transport_error",
  "overflow",
  "timeout",
] as const;
export const MCP_FRAME_DISPOSITION_REASONS = [
  "authorization_revoked",
  "expired",
  "client_closed",
  "worker_lost",
  "overflow",
  "transport_error",
] as const;
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
const commonConfig = {
  exposure: z.enum(["wire", "resources"]),
  toolAllowlist: z
    .array(noNul(128))
    .max(64)
    .refine((values) => new Set(values).size === values.length)
    .optional(),
  requestTimeoutMs: positive.default(120000),
  roots: z.array(z.strictObject({ uri: noNul(4096), name: noNul(128).optional() })).max(16),
  exposeSampling: z.boolean(),
  elicitation: z.enum(["absent", "cancel"]),
};
const args = z
  .array(
    z
      .string()
      .max(4096)
      .refine((value) => !value.includes("\0")),
  )
  .max(64);
const service = z.strictObject({
  command: noNul(4096),
  args,
  envRef: noNul(128).optional(),
  workingDirectory: absolutePath,
});
export const mcpConfigSchema = z.discriminatedUnion("transport", [
  z.strictObject({
    ...commonConfig,
    transport: z.literal("stdio"),
    ...service.shape,
    launch: z.literal("configured_service"),
    autostart: z.boolean(),
  }),
  z.strictObject({
    ...commonConfig,
    transport: z.literal("streamableHttp"),
    url: z
      .url()
      .max(4096)
      .refine((value) => {
        const url = new URL(value);
        return (
          ["http:", "https:"].includes(url.protocol) &&
          !/^https?:\/\/[^/]*@/.test(url.href) &&
          !/[?#]/.test(url.href)
        );
      }),
    headerRef: noNul(128).optional(),
    launch: z.enum(["owner_managed", "configured_service"]),
    autostart: z.boolean(),
    service: service.optional(),
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
    pid: positive.nullable(),
    processStartedAt: timestamp.nullable(),
    endpoint: noNul(4096).nullable(),
    state: z.enum(MCP_PROCESS_STATES),
    stateRevision: positive,
    stateHash: hash,
    createdAt: timestamp,
    lastObservedAt: timestamp,
    endedAt: timestamp.nullable(),
    exitCode: z
      .number()
      .int()
      .min(-Number.MAX_SAFE_INTEGER)
      .max(Number.MAX_SAFE_INTEGER)
      .nullable(),
    endReason: z.enum(MCP_PROCESS_END_REASONS).nullable(),
  })
  .refine(
    (value) =>
      (value.transport === "streamableHttp" || value.endpoint === null) &&
      (value.state !== "running" ||
        value.pid !== null ||
        (value.transport === "streamableHttp" && value.endpoint !== null)) &&
      (["starting", "running", "stopping"].includes(value.state)
        ? value.endedAt === null && value.endReason === null && value.exitCode === null
        : ["exited", "failed", "lost"].includes(value.state) &&
          value.endedAt !== null &&
          value.endReason !== null),
  );
const sessionIdentity = {
  ...projectMachine,
  authorizationGeneration: natural,
  holderInstanceId: id(ID_PREFIXES.instance),
  processId: mcpProcessIdSchema,
  workerSession: workerSessionSchema,
};
export const mcpSessionSchema = z
  .strictObject({
    id: mcpSessionIdSchema,
    ...projectMachine,
    processId: mcpProcessIdSchema,
    registrationId: mcpRegistrationIdSchema,
    registrationRevision: positive,
    transport,
    configHash: hash,
    workerIncarnationId: uuid,
    runId: id(ID_PREFIXES.run),
    holderInstanceId: id(ID_PREFIXES.instance),
    authorizationGeneration: natural,
    grantId: id(ID_PREFIXES.remoteToolGrant),
    chatId: id(ID_PREFIXES.chat),
    openRequestId: id(ID_PREFIXES.request),
    openHash: hash,
    state: z.enum(MCP_SESSION_STATES),
    createdAt: timestamp,
    attachedAt: timestamp.nullable(),
    connectedAt: timestamp.nullable(),
    endedAt: timestamp.nullable(),
    endReason: z.enum(MCP_SESSION_END_REASONS).nullable(),
    protocolVersion: noNul(64).nullable(),
    clientHighWater: natural,
    workerAckClientSeq: natural,
    serverHighWater: natural,
    hostAckServerSeq: natural,
    workerStateRevision: natural,
    workerStateHash: hash.nullable(),
    workerDetachedAt: timestamp.nullable(),
    fenceMutationId: id(ID_PREFIXES.leaseMutation).nullable(),
    workerConnectionGeneration: positive,
    serverBootId: id(ID_PREFIXES.boot),
    workerAttemptId: uuid,
  })
  .refine(
    (value) =>
      value.workerAckClientSeq <= value.clientHighWater &&
      value.hostAckServerSeq <= value.serverHighWater &&
      (value.attachedAt === null || value.attachedAt >= value.createdAt) &&
      (value.connectedAt === null ||
        (value.attachedAt !== null &&
          value.connectedAt >= value.attachedAt &&
          value.protocolVersion !== null)) &&
      (value.state !== "connecting" || value.connectedAt === null) &&
      (value.state !== "connected" || value.connectedAt !== null) &&
      (["connecting", "connected"].includes(value.state)
        ? value.endedAt === null && value.endReason === null
        : value.endedAt !== null &&
          (value.connectedAt === null || value.endedAt >= value.connectedAt) &&
          value.endReason !== null) &&
      (value.workerStateRevision === 0) === (value.workerStateHash === null),
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
    ...projectMachine,
    authorizationGeneration: natural,
    holderInstanceId: id(ID_PREFIXES.instance),
    processId: mcpProcessIdSchema,
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
    dispositionReason: z.enum(MCP_FRAME_DISPOSITION_REASONS).nullable(),
  })
  .refine(
    (value) =>
      value.expiresAt > value.createdAt &&
      (value.sentAt === null || value.sentAt >= value.createdAt) &&
      (value.payloadBase64 === null ||
        matchingPayload({ ...value, payloadBase64: value.payloadBase64 })) &&
      (["queued", "sent"].includes(value.state)
        ? value.payloadBase64 !== null &&
          value.terminalAt === null &&
          value.dispositionReason === null
        : value.state === "acked"
          ? value.terminalAt !== null && value.dispositionReason === null
          : value.terminalAt !== null && value.dispositionReason !== null) &&
      (value.state !== "queued" || value.sentAt === null) &&
      (!["sent", "acked"].includes(value.state) || value.sentAt !== null),
  );
const leaseInput = { ...projectMachine, authorizationGeneration: natural };
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
        value.session.serverBootId === value.workerSession.bootId &&
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
