import { z } from "zod";
import {
  mcpCatalogGetCall,
  mcpSessionOpenCall,
  mcpSessionExchangeCall,
  mcpSessionCloseCall,
} from "./mcp";
import { runIdSchema } from "./agent-run";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { leaseKeySchema, leaseMutationInputSchema, leaseReadInputSchema } from "./lease";
import {
  macosAbsolutePathSchema,
  positiveSafeIntegerSchema,
  REMOTE_OPERATION_KINDS,
} from "./machine";
import { APP_ERROR_CODES } from "./result";
import { workerSecretSchema, workerSessionSchema } from "./worker-session";

const id = (prefix: (typeof ID_PREFIXES)[keyof typeof ID_PREFIXES]) =>
  z.string().regex(appIdPattern(prefix));
const executionIdSchema = id(ID_PREFIXES.execution);
const instanceIdSchema = id(ID_PREFIXES.instance);
const mutationIdSchema = id(ID_PREFIXES.leaseMutation);
const requestIdSchema = id(ID_PREFIXES.request);
const nonnegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const timestampSchema = z.iso.datetime();
const fingerprintSchema = z.string().regex(/^[0-9a-f]{64}$/);
const runnerTokenSchema = z.string().regex(/^[0-9a-f]{32}$/);
const encoder = new TextEncoder();
const bytes = (max: number) =>
  z
    .string()
    .refine(
      (value) => !value.includes("\0") && encoder.encode(value).byteLength <= max,
      `字符串必须无 NUL 且 UTF-8 编码不超过 ${max} bytes`,
    );
const shellFields = {
  command: bytes(65536),
  cwd: macosAbsolutePathSchema.optional(),
  waitMs: nonnegativeSafeIntegerSchema.max(10000).default(1000),
};
const fileReadFields = {
  path: macosAbsolutePathSchema,
  maxBytes: positiveSafeIntegerSchema.max(262144).default(65536),
};
const fileWriteFields = {
  path: macosAbsolutePathSchema,
  content: bytes(262144),
  mode: z.enum(["overwrite", "append"]).default("overwrite"),
};
const processListFields = { limit: positiveSafeIntegerSchema.max(200).default(100) };
const processSignalFields = {
  pid: positiveSafeIntegerSchema,
  signal: z.enum(["TERM", "INT", "KILL"]),
};
const shellOperationSchema = z.strictObject({ kind: z.literal("shell"), ...shellFields });
const otherOperations = [
  z.strictObject({ kind: z.literal("file_read"), ...fileReadFields }),
  z.strictObject({ kind: z.literal("file_write"), ...fileWriteFields }),
  z.strictObject({ kind: z.literal("process_list"), ...processListFields }),
  z.strictObject({ kind: z.literal("process_signal"), ...processSignalFields }),
] as const;
export const remoteOperationSchema = z.discriminatedUnion("kind", [
  shellOperationSchema,
  ...otherOperations,
]);
const dispatchedOperationSchema = z.discriminatedUnion("kind", [
  shellOperationSchema.extend({ cwd: macosAbsolutePathSchema }),
  ...otherOperations,
]);
export const REMOTE_EXECUTION_STATES = [
  "queued",
  "dispatched",
  "running",
  "draining",
  "succeeded",
  "failed",
  "rejected",
  "timed_out",
  "unknown",
] as const;
/** 日志完整性与执行状态正交：`succeeded` 可以配 `truncated`，`unknown` 可以配 `partial`。 */
export const EXECUTION_LOG_STATES = ["none", "partial", "full", "gap", "truncated"] as const;
export const EXECUTION_LOG_STREAMS = ["stdout", "stderr"] as const;
/** 取消状态与执行状态、租约状态都是独立事实。 */
export const CANCELLATION_STATES = [
  "requested",
  "delivered",
  "exited_observed",
  "already_exited",
  "failed",
  "unknown",
] as const;
/** 取消策略是调用方声明的事实，服务端落库并原样下发给 Worker。 */
export const CANCELLATION_POLICIES = ["term_then_kill", "kill"] as const;
/** 只记录 OS 是否接受信号调用，不证明进程已退出。 */
export const CANCELLATION_SIGNAL_OUTCOMES = ["none", "term_delivered", "kill_delivered"] as const;
export const CANCELLATION_FAILURE_REASONS = ["signal_failed", "delivery_unconfirmed"] as const;
/** 单帧正文上限按原始 UTF-8 bytes 计，写进 `execution_log_frame` 的 CHECK。 */
export const EXECUTION_LOG_FRAME_MAX_BYTES = 16384;
/** 单 exchange 的日志帧数量上限，与命令数组同级。 */
export const EXECUTION_LOG_FRAMES_PER_EXCHANGE = 8;
/** 单条日志读取请求的正文预算上限。 */
export const EXECUTION_LOG_READ_LIMIT_MAX_BYTES = 65536;
export const CANCELLATION_INTENT_NAMESPACE = "cancel:";
export const REMOTE_OUTCOMES = ["succeeded", "failed", "rejected", "timed_out", "unknown"] as const;
export const REMOTE_FAILURE_REASONS = [
  "stale_generation",
  "not_holder",
  "authorization_revoked",
  "deadline",
  "worker_lost",
  "executor_error",
  "capability_unavailable",
  "directory_unavailable",
] as const;
const failureReasonSchema = z.enum(REMOTE_FAILURE_REASONS);
const shellSuccessSchema = z
  .strictObject({
    kind: z.literal("shell"),
    pid: positiveSafeIntegerSchema,
    exited: z.boolean(),
    exitCode: z.number().int().nullable(),
    stdout: bytes(65536),
    stderr: bytes(8192),
    truncated: z.boolean(),
  })
  .refine(
    (value) => value.exited === (value.exitCode !== null),
    "shell 退出状态与 exitCode 不一致",
  );
const successPayloads = [
  shellSuccessSchema,
  z.strictObject({ kind: z.literal("file_read"), content: bytes(262144), truncated: z.boolean() }),
  z.strictObject({
    kind: z.literal("file_write"),
    bytesWritten: nonnegativeSafeIntegerSchema.max(262144),
  }),
  z.strictObject({
    kind: z.literal("process_list"),
    items: z
      .array(z.strictObject({ pid: positiveSafeIntegerSchema, command: bytes(1024) }))
      .max(200),
    truncated: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("process_signal"),
    ...processSignalFields,
    delivered: z.literal(true),
  }),
] as const;
const successPayloadSchema = z.discriminatedUnion("kind", successPayloads);
const failurePayloadSchema = z
  .strictObject({
    kind: z.enum(REMOTE_OPERATION_KINDS),
    failureReason: failureReasonSchema,
    partial: successPayloadSchema.optional(),
  })
  .refine(
    (value) => !value.partial || value.partial.kind === value.kind,
    "partial 必须与操作 kind 相同",
  );
export const remoteResultPayloadSchema = z.union([successPayloadSchema, failurePayloadSchema]);
function validOutcome(
  outcome: (typeof REMOTE_OUTCOMES)[number],
  payload: z.infer<typeof remoteResultPayloadSchema>,
): boolean {
  if (outcome === "succeeded")
    return (
      !("failureReason" in payload) &&
      (payload.kind !== "shell" || !payload.exited || payload.exitCode === 0)
    );
  return (
    "failureReason" in payload && (outcome !== "timed_out" || payload.failureReason === "deadline")
  );
}
export const executionSubmitInputSchema = leaseKeySchema.extend({
  requestId: requestIdSchema,
  authorizationGeneration: positiveSafeIntegerSchema,
  operation: remoteOperationSchema,
});
export const executionReadInputSchema = leaseKeySchema.extend({ executionId: executionIdSchema });
/** 日志列与执行状态正交，恢复事实只改运行位点，不改已确定的终态。 */
export const executionViewSchema = leaseKeySchema
  .extend({
    executionId: executionIdSchema,
    authorizationGeneration: positiveSafeIntegerSchema,
    holderInstanceId: instanceIdSchema,
    runId: runIdSchema,
    chatId: id(ID_PREFIXES.chat),
    requestId: requestIdSchema,
    operation: remoteOperationSchema,
    state: z.enum(REMOTE_EXECUTION_STATES),
    createdAt: timestampSchema,
    dispatchDeadlineAt: timestampSchema,
    runtimeDeadlineAt: timestampSchema.nullable(),
    maxRuntimeMs: positiveSafeIntegerSchema.nullable(),
    dispatchConnectionGeneration: positiveSafeIntegerSchema.nullable(),
    dispatchSeq: positiveSafeIntegerSchema.nullable(),
    dispatchedAt: timestampSchema.nullable(),
    drainedAt: timestampSchema.nullable(),
    payloadHash: fingerprintSchema,
    terminalAt: timestampSchema.nullable(),
    failureReason: failureReasonSchema.nullable(),
    result: remoteResultPayloadSchema.nullable(),
    logState: z.enum(EXECUTION_LOG_STATES),
    producedThroughSequence: nonnegativeSafeIntegerSchema.nullable(),
    acknowledgedThroughSequence: nonnegativeSafeIntegerSchema.nullable(),
    availableFromSequence: nonnegativeSafeIntegerSchema.nullable(),
  })
  .superRefine((value, ctx) => {
    const terminal = REMOTE_OUTCOMES.some((state) => state === value.state);
    if (
      Date.parse(value.dispatchDeadlineAt) <= Date.parse(value.createdAt) ||
      terminal !== (value.terminalAt !== null) ||
      (value.terminalAt !== null && Date.parse(value.terminalAt) < Date.parse(value.createdAt)) ||
      (!terminal && (value.failureReason !== null || value.result !== null)) ||
      (value.state === "succeeded" && value.failureReason !== null) ||
      (terminal && value.state !== "succeeded" && value.failureReason === null) ||
      (value.result !== null &&
        (value.result.kind !== value.operation.kind ||
          !terminal ||
          !validOutcome(value.state as (typeof REMOTE_OUTCOMES)[number], value.result) ||
          ("failureReason" in value.result &&
            value.result.failureReason !== value.failureReason))) ||
      // 下发窗口与运行上限是两个独立事实；未下发时不能有运行上限。
      (value.runtimeDeadlineAt !== null &&
        (value.maxRuntimeMs === null ||
          value.dispatchedAt === null ||
          Date.parse(value.runtimeDeadlineAt) < Date.parse(value.dispatchedAt))) ||
      (value.runtimeDeadlineAt === null) !== (value.maxRuntimeMs === null) ||
      // 产出、已确认、可读起点只能是单调不清的事实：ack 不能超过产出，可读起点不能超过已产出。
      (value.acknowledgedThroughSequence !== null &&
        (value.producedThroughSequence === null ||
          value.acknowledgedThroughSequence > value.producedThroughSequence)) ||
      (value.availableFromSequence !== null &&
        value.producedThroughSequence !== null &&
        value.availableFromSequence > value.producedThroughSequence + 1) ||
      (value.logState === "none" && value.producedThroughSequence !== null) ||
      (value.logState === "full" && value.acknowledgedThroughSequence === null) ||
      (value.logState !== "none" && value.producedThroughSequence === null)
    ) {
      ctx.addIssue({ code: "custom", message: "执行状态、时间、日志位点与结果不一致" });
    }
  });
const deliveryIdentity = {
  executionId: executionIdSchema,
  ...leaseKeySchema.shape,
  authorizationGeneration: positiveSafeIntegerSchema,
  holderInstanceId: instanceIdSchema,
  dispatchSession: workerSessionSchema,
  dispatchSeq: positiveSafeIntegerSchema,
  fingerprint: fingerprintSchema,
};
export const remoteCommandSchema = z
  .strictObject({
    ...deliveryIdentity,
    requestId: requestIdSchema,
    operation: dispatchedOperationSchema,
    directoryRevision: positiveSafeIntegerSchema.nullable(),
    dispatchDeadlineAt: timestampSchema,
    runtimeDeadlineAt: timestampSchema.nullable().default(null),
    maxRuntimeMs: positiveSafeIntegerSchema.nullable().default(null),
    runnerToken: runnerTokenSchema.nullable().default(null),
  })
  .refine(
    (value) =>
      value.machineId === value.dispatchSession.machineId &&
      (value.directoryRevision === null || value.operation.kind === "shell"),
    "命令必须属于投递会话和目录修订",
  );
export const remoteReportSchema = z
  .discriminatedUnion("phase", [
    z.strictObject({ ...deliveryIdentity, phase: z.literal("running"), drained: z.literal(false) }),
    z.strictObject({
      ...deliveryIdentity,
      phase: z.literal("terminal"),
      drained: z.literal(true),
      outcome: z.enum(REMOTE_OUTCOMES),
      payload: remoteResultPayloadSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      value.machineId !== value.dispatchSession.machineId ||
      (value.phase === "terminal" && !validOutcome(value.outcome, value.payload))
    ) {
      ctx.addIssue({ code: "custom", message: "报告必须匹配投递身份与结果状态" });
    }
  });
const executionIdsSchema = z
  .array(executionIdSchema)
  .max(64)
  .refine((ids) => new Set(ids).size === ids.length, "executionIds 不能重复");
const fenceFields = {
  mutationId: mutationIdSchema,
  ...leaseKeySchema.shape,
  authorizationGeneration: positiveSafeIntegerSchema,
  executionIds: executionIdsSchema,
};
export const remoteFenceSchema = z.strictObject(fenceFields);
export const remoteFenceAckSchema = z
  .strictObject({ ...fenceFields, dispatchSession: workerSessionSchema })
  .refine((value) => value.machineId === value.dispatchSession.machineId, "fence 必须属于投递会话");
/** 上行日志帧。`bytes` 与 `gapTo` 二选一：一行要么有正文，要么只声明缺口。 */
export const executionLogFrameSchema = z
  .strictObject({
    executionId: executionIdSchema,
    ...leaseKeySchema.shape,
    authorizationGeneration: positiveSafeIntegerSchema,
    holderInstanceId: instanceIdSchema,
    dispatchSession: workerSessionSchema,
    dispatchSeq: positiveSafeIntegerSchema,
    sequence: positiveSafeIntegerSchema,
    stream: z.enum(EXECUTION_LOG_STREAMS),
    byteStart: nonnegativeSafeIntegerSchema,
    byteEnd: nonnegativeSafeIntegerSchema,
    checksum: fingerprintSchema,
    bytes: bytes(EXECUTION_LOG_FRAME_MAX_BYTES).optional(),
    gapTo: positiveSafeIntegerSchema.optional(),
  })
  .refine(
    (value) =>
      (value.bytes === undefined) !== (value.gapTo === undefined) &&
      value.byteEnd >= value.byteStart &&
      (value.gapTo === undefined || value.gapTo >= value.sequence),
    "日志帧要么带正文要么声明 gap，且字节位点单调",
  );
/** 上行恢复事实。必须带 runner token；token 只能来自宿主曾向这台 Machine 下发过的命令。 */
export const executionRecoverySchema = z.strictObject({
  executionId: executionIdSchema,
  ...leaseKeySchema.shape,
  authorizationGeneration: positiveSafeIntegerSchema,
  holderInstanceId: instanceIdSchema,
  runnerToken: runnerTokenSchema,
  observedState: z.enum(["running", "exited", "unknown"]),
  exitCode: z.number().int().min(-1).max(255).nullable(),
  signal: z.string().max(16).nullable(),
  observedExitedAt: timestampSchema.nullable(),
  producedThroughSequence: nonnegativeSafeIntegerSchema.nullable(),
  claimEvidenceAt: timestampSchema,
});
export const remoteExchangeInputSchema = z.strictObject({
  results: z.array(remoteReportSchema).max(64),
  fenceAcks: z.array(remoteFenceAckSchema).max(64),
  logFrames: z.array(executionLogFrameSchema).max(EXECUTION_LOG_FRAMES_PER_EXCHANGE).optional(),
  recoveries: z.array(executionRecoverySchema).max(8).optional(),
});
const authorizationSchema = leaseKeySchema
  .extend({
    generation: nonnegativeSafeIntegerSchema,
    state: z.enum(["free", "active", "draining"]),
    holderInstanceId: instanceIdSchema.nullable(),
  })
  .refine(
    (value) =>
      (value.state === "free") === (value.holderInstanceId === null) &&
      (value.state === "free" || value.generation > 0),
    "授权状态与持有者/代次不一致",
  );
/** 下行取消意图：送达只说明收到，不说明进程已停。 */
export const executionCancelSchema = z.strictObject({
  cancelId: id(ID_PREFIXES.cancellation),
  executionId: executionIdSchema,
  ...leaseKeySchema.shape,
  authorizationGeneration: positiveSafeIntegerSchema,
  runnerToken: runnerTokenSchema,
  policy: z.enum(CANCELLATION_POLICIES),
  termWaitMs: positiveSafeIntegerSchema.max(10000),
});
export const remoteExchangeOutputSchema = z.strictObject({
  authorizations: z.array(authorizationSchema).max(1000),
  commands: z.array(remoteCommandSchema).max(8),
  fences: z.array(remoteFenceSchema).max(64),
  resultAcks: z
    .array(
      z.strictObject({
        executionId: executionIdSchema,
        disposition: z.enum(["accepted", "ignored_terminal"]),
      }),
    )
    .max(64),
  fenceAcks: z
    .array(z.strictObject({ mutationId: mutationIdSchema, executionIds: executionIdsSchema }))
    .max(64),
  /** 下行 ACK：确认已落盘的前缀，不表示执行结束。 */
  logAcks: z
    .array(
      z.strictObject({
        executionId: executionIdSchema,
        stream: z.enum([...EXECUTION_LOG_STREAMS, "both"]),
        acknowledgedThroughSequence: nonnegativeSafeIntegerSchema,
        availableFromSequence: nonnegativeSafeIntegerSchema.nullable(),
      }),
    )
    .max(8)
    .optional(),
  /** 下行取消意图：送达只说明收到，不说明进程已停。 */
  cancellations: z.array(executionCancelSchema).max(4).optional(),
});
const agentMutationInputSchema = z.discriminatedUnion("action", [
  leaseMutationInputSchema.options[0],
  leaseMutationInputSchema.options[1],
  leaseMutationInputSchema.options[2],
]);
export const executionLogReadInputSchema = leaseKeySchema.extend({
  executionId: executionIdSchema,
  cursor: z.strictObject({ nextSequence: nonnegativeSafeIntegerSchema }).nullable(),
  limitBytes: positiveSafeIntegerSchema.max(EXECUTION_LOG_READ_LIMIT_MAX_BYTES).default(65536),
});
export const executionCancelInputSchema = leaseKeySchema.extend({
  executionId: executionIdSchema,
  requestId: requestIdSchema,
  authorizationGeneration: positiveSafeIntegerSchema,
  policy: z.enum(CANCELLATION_POLICIES).default("term_then_kill"),
  termWaitMs: positiveSafeIntegerSchema.max(10000).default(2000),
});
/** 游标读取结果：`frames` 为空只说明该范围无帧，不证明「没有输出」；`logState` 才区分。 */
export const executionLogReadViewSchema = leaseKeySchema.extend({
  executionId: executionIdSchema,
  frames: z.array(
    z.strictObject({
      sequence: positiveSafeIntegerSchema,
      stream: z.enum(EXECUTION_LOG_STREAMS),
      byteStart: nonnegativeSafeIntegerSchema,
      byteEnd: nonnegativeSafeIntegerSchema,
      text: z.string().nullable(),
      checksum: fingerprintSchema,
    }),
  ),
  nextCursor: z.strictObject({ nextSequence: nonnegativeSafeIntegerSchema }),
  availableFromSequence: nonnegativeSafeIntegerSchema.nullable(),
  acknowledgedThroughSequence: nonnegativeSafeIntegerSchema.nullable(),
  producedThroughSequence: nonnegativeSafeIntegerSchema.nullable(),
  gapRanges: z.array(
    z.strictObject({
      fromSequence: positiveSafeIntegerSchema,
      toSequence: positiveSafeIntegerSchema,
    }),
  ),
  logState: z.enum(EXECUTION_LOG_STATES),
  workerOnline: z.boolean(),
});
/** 取消尝试的可见状态。`delivered` 不显示为已停止。 */
export const executionCancellationViewSchema = leaseKeySchema.extend({
  cancelId: id(ID_PREFIXES.cancellation),
  executionId: executionIdSchema,
  state: z.enum(CANCELLATION_STATES),
  policy: z.enum(CANCELLATION_POLICIES),
  termWaitMs: positiveSafeIntegerSchema,
  requestedAt: timestampSchema,
  deliveredAt: timestampSchema.nullable(),
  exitedAt: timestampSchema.nullable(),
  signalOutcome: z.enum(CANCELLATION_SIGNAL_OUTCOMES),
  failureReason: z.enum(CANCELLATION_FAILURE_REASONS).nullable(),
});
export const remoteAgentRequestSchema = z.strictObject({
  version: z.literal(2),
  call: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("lease_mutate"), input: agentMutationInputSchema }),
    z.strictObject({ type: z.literal("lease_get"), input: leaseReadInputSchema }),
    z.strictObject({ type: z.literal("execution_submit"), input: executionSubmitInputSchema }),
    z.strictObject({ type: z.literal("execution_get"), input: executionReadInputSchema }),
    z.strictObject({ type: z.literal("execution_cancel"), input: executionCancelInputSchema }),
    z.strictObject({ type: z.literal("execution_log_read"), input: executionLogReadInputSchema }),
    mcpCatalogGetCall,
    mcpSessionOpenCall,
    mcpSessionExchangeCall,
    mcpSessionCloseCall,
  ]),
});
export const remoteToolGrantSchema = z.strictObject({
  endpoint: z.url().refine((value) => {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/api/remote/agent"
    );
  }, "grant endpoint 必须是 HTTP origin 下的 /api/remote/agent"),
  secret: workerSecretSchema,
  expiresAt: timestampSchema,
  projectId: id(ID_PREFIXES.project),
});
export const REMOTE_ERROR_CODES = APP_ERROR_CODES;
const toolMutationBase = { machineId: leaseKeySchema.shape.machineId, requestId: requestIdSchema };
const toolExecutionBase = {
  ...toolMutationBase,
  authorizationGeneration: positiveSafeIntegerSchema,
};
export const remoteToolInputSchemas = {
  sprout_lease_acquire: z.strictObject({
    ...toolMutationBase,
    expectedGeneration: nonnegativeSafeIntegerSchema,
  }),
  sprout_lease_release: z.strictObject({
    ...toolMutationBase,
    expectedGeneration: positiveSafeIntegerSchema,
  }),
  sprout_lease_handoff: z.strictObject({
    ...toolMutationBase,
    expectedGeneration: positiveSafeIntegerSchema,
    targetInstanceId: instanceIdSchema,
  }),
  sprout_lease_get: z.strictObject({
    machineId: leaseKeySchema.shape.machineId,
    mutationId: mutationIdSchema.optional(),
  }),
  sprout_remote_shell: z.strictObject({ ...toolExecutionBase, ...shellFields }),
  sprout_remote_file_read: z.strictObject({ ...toolExecutionBase, ...fileReadFields }),
  sprout_remote_file_write: z.strictObject({ ...toolExecutionBase, ...fileWriteFields }),
  sprout_remote_process_list: z.strictObject({ ...toolExecutionBase, ...processListFields }),
  sprout_remote_process_signal: z.strictObject({ ...toolExecutionBase, ...processSignalFields }),
  sprout_remote_execution_get: z.strictObject({
    machineId: leaseKeySchema.shape.machineId,
    executionId: executionIdSchema,
  }),
} as const;
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;
export type RemoteResultPayload = z.infer<typeof remoteResultPayloadSchema>;
export type RemoteCommand = z.infer<typeof remoteCommandSchema>;
export type RemoteReport = z.infer<typeof remoteReportSchema>;
export type RemoteFence = z.infer<typeof remoteFenceSchema>;
export type RemoteFenceAck = z.infer<typeof remoteFenceAckSchema>;
export type RemoteExchangeInput = z.infer<typeof remoteExchangeInputSchema>;
export type RemoteExchangeOutput = z.infer<typeof remoteExchangeOutputSchema>;
export type RemoteAgentRequest = z.infer<typeof remoteAgentRequestSchema>;
export type ExecutionSubmitInput = z.infer<typeof executionSubmitInputSchema>;
export type ExecutionReadInput = z.infer<typeof executionReadInputSchema>;
export type ExecutionView = z.infer<typeof executionViewSchema>;
export type ExecutionLogFrame = z.infer<typeof executionLogFrameSchema>;
export type ExecutionRecovery = z.infer<typeof executionRecoverySchema>;
export type ExecutionCancel = z.infer<typeof executionCancelSchema>;
export type ExecutionCancelInput = z.infer<typeof executionCancelInputSchema>;
export type ExecutionLogReadInput = z.infer<typeof executionLogReadInputSchema>;
export type ExecutionLogReadView = z.infer<typeof executionLogReadViewSchema>;
export type ExecutionCancellationView = z.infer<typeof executionCancellationViewSchema>;
export type ExecutionLogState = (typeof EXECUTION_LOG_STATES)[number];
export type CancellationState = (typeof CANCELLATION_STATES)[number];
export type CancellationPolicy = (typeof CANCELLATION_POLICIES)[number];
export type RemoteToolGrant = z.infer<typeof remoteToolGrantSchema>;
