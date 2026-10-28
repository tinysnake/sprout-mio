import { createHash, randomBytes } from "node:crypto";
import { machineBindings } from "../domain/machine";
import { applyMcpExchange, McpExchangeError } from "../domain/mcp/exchange";
import type { WorkerExchangeRemoteInput } from "../contracts/worker";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";
import type { ShellFact } from "../contracts/machine";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  CANCELLATION_INTENT_NAMESPACE,
  EXECUTION_LOG_FRAME_MAX_BYTES,
  EXECUTION_LOG_RETAIN_BYTES,
  EXECUTION_LOG_RETAIN_FRAMES,
  executionCancelInputSchema,
  executionCancelRequestSchema,
  executionLogReadInputSchema,
  executionReadInputSchema,
  executionSubmitInputSchema,
} from "../contracts/remote";
import type {
  ExecutionCancel,
  ExecutionCancelInput,
  ExecutionCancelRequest,
  ExecutionCancellationView,
  ExecutionLogFrame,
  ExecutionLogReadInput,
  ExecutionLogReadView,
  ExecutionLogState,
  ExecutionReadInput,
  ExecutionRecovery,
  ExecutionSubmitInput,
  ExecutionView,
  RemoteCommand,
  RemoteReport,
} from "../contracts/remote";
import type { AppErrorCode } from "../contracts/result";
import type { WorkerSession } from "../contracts/worker-session";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import type { WorkerExchangeResponse } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  diagnosticEvent,
  directoryObservation,
  executionCancellation,
  executionLogFrame,
  executionResult,
  leaseMutation,
  machine,
  machineConnection,
  machineConnectionCounter,
  machineLease,
  mcpFrame,
  project,
  remoteExecution,
  workerExchangeFrame,
} from "../db/schema";
import type { MachineContext } from "../domain/machine";
import {
  assertAgentContext,
  assertExecutionHolder,
  assertRemoteAccess,
  completeLeaseMutation,
  ensureLease,
  expireExecutions,
  leaseWhere,
  payloadHash,
} from "./lease";
import type { AgentRemoteContext } from "./lease";
import { wakeMcpSession } from "./mcp-relay";

export class RemoteError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "RemoteError";
  }
}
type Execution = typeof remoteExecution.$inferSelect;
type Cancellation = typeof executionCancellation.$inferSelect;
/** 已由 runner 证据确定的终态：后续报告与恢复事实都不能改写。 */
const SETTLED_STATES = new Set(["succeeded", "failed", "rejected"]);
/** 只能被带 runner token 的恢复事实单向归约的状态。 */
const RECOVERABLE_STATES: ReadonlyArray<Execution["state"]> = [
  "unknown",
  "timed_out",
  "dispatched",
  "running",
  "draining",
];
export type AuthenticatedWorkerContext = {
  session: WorkerSession;
  mode: "normal" | "drain";
  seq: number;
  now: Date;
  bootId: string;
};
/** Worker v3 出站 wire 形状：基座 remote 加上 relay 空批字段。 */
type RemoteWireOutput = Extract<WorkerExchangeResponse, { ok: true }>["data"]["remote"];
type NormalRemoteOutput = RemoteWireOutput;
export type DrainProjection = Pick<
  RemoteWireOutput,
  "fences" | "resultAcks" | "fenceAcks" | "logAcks" | "mcp" | "mcpCursors"
>;
function connection(machineId: string, ctx: Pick<MachineContext, "now" | "bootId">) {
  const counter = db
    .select()
    .from(machineConnectionCounter)
    .where(eq(machineConnectionCounter.machineId, machineId))
    .get();
  const row =
    counter &&
    db
      .select()
      .from(machineConnection)
      .where(
        and(
          eq(machineConnection.machineId, machineId),
          eq(machineConnection.generation, counter.highWater),
        ),
      )
      .get();
  if (
    !row ||
    row.status !== "open" ||
    row.bootId !== ctx.bootId ||
    ctx.now.getTime() - row.lastSeenAt.getTime() >= WORKER_STALE_AFTER_MS ||
    !row.capability
  )
    throw new RemoteError("machine_unavailable");
  return row;
}
function executionView(row: Execution, provisionalResult = false): ExecutionView {
  const result = db
    .select()
    .from(executionResult)
    .where(eq(executionResult.executionId, row.id))
    .get();
  const cancellation = db
    .select()
    .from(executionCancellation)
    .where(eq(executionCancellation.executionId, row.id))
    .orderBy(desc(executionCancellation.requestedAt), desc(executionCancellation.id))
    .get();
  return {
    executionId: row.id,
    projectId: row.projectId,
    machineId: row.machineId,
    authorizationGeneration: row.authorizationGeneration,
    holderInstanceId: row.holderInstanceId,
    runId: row.runId,
    chatId: row.chatId,
    requestId: row.requestId,
    operation: row.operationJson,
    state: row.state,
    createdAt: row.createdAt.toISOString(),
    dispatchDeadlineAt: row.dispatchDeadlineAt.toISOString(),
    runtimeDeadlineAt: row.runtimeDeadlineAt?.toISOString() ?? null,
    maxRuntimeMs: row.maxRuntimeMs,
    dispatchConnectionGeneration: row.dispatchConnectionGeneration,
    dispatchSeq: row.dispatchSeq,
    dispatchedAt: row.dispatchedAt?.toISOString() ?? null,
    drainedAt: row.drainedAt?.toISOString() ?? null,
    payloadHash: row.payloadHash,
    terminalAt: row.terminalAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    recoveryReason: row.recoveryReason ?? null,
    // Agent 读视图的契约是：未落终态就没有结果。Web 列表额外允许 waitMs 快照
    // （exited:false）用于显示 pid，但执行本身仍是 running；一旦落成 unknown/failed，
    // 快照不再是这次执行的结果，不能拿它冒充终态正文。
    result: (() => {
      const payload = result?.payloadJson;
      // waitMs 快照没有 `exited`；恢复事实带 `recovered`，它不是快照，不能当成空结果。
      const provisional =
        payload !== null &&
        payload !== undefined &&
        payload.kind === "shell" &&
        !("failureReason" in payload) &&
        !("recovered" in payload) &&
        !payload.exited;
      if (provisional && row.terminalAt !== null) return null;
      return provisionalResult || row.terminalAt !== null ? (payload ?? null) : null;
    })(),
    logState: row.logState,
    producedThroughSequence: row.producedThroughSeq,
    acknowledgedThroughSequence: row.acknowledgedThroughSeq,
    availableFromSequence: row.availableFromSeq,
    cancellation: cancellation ? cancellationView(cancellation) : null,
  };
}
type LeaseClaim = { projectId: string; machineId: string; authorizationGeneration: number };
/** 租约是否仍授权这次执行：状态、代次与 holder 三项都属于通道事实，与调用者是谁无关。 */
function leaseHeldBy(
  lease: typeof machineLease.$inferSelect,
  authorizationGeneration: number,
  holderInstanceId: string,
) {
  return (
    lease.state === "held" &&
    lease.generation === authorizationGeneration &&
    lease.holderInstanceId === holderInstanceId
  );
}
function liveLease(input: LeaseClaim, ctx: AgentRemoteContext) {
  const lease = ensureLease(input, ctx.now);
  if (lease.generation !== input.authorizationGeneration)
    throw new RemoteError("lease_stale_generation");
  if (lease.state === "fencing") throw new RemoteError("lease_fencing");
  if (!leaseHeldBy(lease, input.authorizationGeneration, ctx.instanceId))
    throw new RemoteError("lease_not_holder");
}
function runnerOnline(machineId: string, now: Date) {
  const counter = db
    .select()
    .from(machineConnectionCounter)
    .where(eq(machineConnectionCounter.machineId, machineId))
    .get();
  if (!counter) return false;
  const row = db
    .select()
    .from(machineConnection)
    .where(
      and(
        eq(machineConnection.machineId, machineId),
        eq(machineConnection.generation, counter.highWater),
      ),
    )
    .get();
  return Boolean(
    row &&
    row.status === "open" &&
    now.getTime() - row.lastSeenAt.getTime() < WORKER_STALE_AFTER_MS,
  );
}
function executionByKey(executionId: string, key: Pick<LeaseClaim, "projectId" | "machineId">) {
  return db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.id, executionId),
        eq(remoteExecution.projectId, key.projectId),
        eq(remoteExecution.machineId, key.machineId),
      ),
    )
    .get();
}
function logStateAfterProduce(row: Execution, producedThrough: number): ExecutionLogState {
  if (row.logState !== "none") return row.logState;
  return producedThrough >= 1 ? "partial" : row.logState;
}
/** 单执行保留上限。私有验收库可用 env 缩小阈值；产品默认值固定，不随请求变化。 */
function retentionLimit(name: string, fallback: number) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}
/**
 * 前缀裁剪：只删除最早的帧，把可读起点推进到最早保留帧。
 * 裁剪是服务端职责，Worker 不因此停采；ACK 不得落后于可读起点，否则 CHECK 先拒。
 */
function trimLogPrefix(executionId: string): void {
  const row = db.select().from(remoteExecution).where(eq(remoteExecution.id, executionId)).get();
  if (!row) return;
  const frames = db
    .select({ sequence: executionLogFrame.sequence, payload: executionLogFrame.payloadBytes })
    .from(executionLogFrame)
    .where(eq(executionLogFrame.executionId, executionId))
    .orderBy(executionLogFrame.sequence)
    .all() as Array<{ sequence: number; payload: Buffer | null }>;
  const frameLimit = retentionLimit(
    "SPROUT_EXECUTION_LOG_RETAIN_FRAMES",
    EXECUTION_LOG_RETAIN_FRAMES,
  );
  const byteLimit = retentionLimit("SPROUT_EXECUTION_LOG_RETAIN_BYTES", EXECUTION_LOG_RETAIN_BYTES);
  let bytes = frames.reduce((sum, frame) => sum + (frame.payload?.byteLength ?? 0), 0);
  let drop = 0;
  while (drop < frames.length && (frames.length - drop > frameLimit || bytes > byteLimit)) {
    bytes -= frames[drop]!.payload?.byteLength ?? 0;
    drop += 1;
  }
  if (drop === 0) return;
  const from = frames[drop]!.sequence;
  db.delete(executionLogFrame)
    .where(
      and(eq(executionLogFrame.executionId, executionId), lt(executionLogFrame.sequence, from)),
    )
    .run();
  db.update(remoteExecution)
    .set({
      availableFromSeq: from,
      acknowledgedThroughSeq: Math.max(row.acknowledgedThroughSeq ?? 0, from - 1),
      logState: "truncated",
    })
    .where(eq(remoteExecution.id, executionId))
    .run();
}
const checksumOf = (payload: Buffer | null) =>
  createHash("sha256")
    .update(payload ?? Buffer.alloc(0))
    .digest("hex");
function textOf(payload: Buffer | null) {
  if (!payload) return null;
  const text = payload.toString("utf8");
  // 损坏的不完整 UTF-8 不得静默显示为正文。
  return text.includes("\ufffd") ? null : text;
}
/**
 * 上行日志帧。会话归属由 `dispatchSession` + `dispatchSeq` 核对，只接受本行下发过的那一次投递。
 * 重复帧幂等，且返回本 exchange 已确认的前缀，用于下行 `logAcks`。
 */
function applyLogFrames(
  frames: ReadonlyArray<ExecutionLogFrame>,
  ctx: AuthenticatedWorkerContext,
): Map<string, Execution> {
  const touched = new Set<string>();
  for (const frame of frames) {
    if (frame.machineId !== ctx.session.machineId) throw new RemoteError("not_found");
    const row = executionByKey(frame.executionId, frame);
    if (!row) throw new RemoteError("not_found");
    // 帧有两类合法发送方：真正承载那次下发的会话，以及同一台 Machine 之后的连接。
    // 后者是 Worker 重启后的补送：终态结果早已 ACK，但日志 outbox 里还有没送到宿主的前缀。
    // 它仍必须带着那次下发的序号，并且代次与 holder 与执行行一致，不能借新连接冒充别的执行。
    const dispatchedHere =
      sameSession(frame.dispatchSession, ctx.session) &&
      row.dispatchConnectionGeneration === ctx.session.generation;
    const superseding =
      row.dispatchConnectionGeneration !== null &&
      row.dispatchConnectionGeneration < ctx.session.generation;
    if (
      row.machineId !== frame.machineId ||
      row.projectId !== frame.projectId ||
      row.authorizationGeneration !== frame.authorizationGeneration ||
      row.holderInstanceId !== frame.holderInstanceId ||
      row.dispatchSeq !== frame.dispatchSeq ||
      !(dispatchedHere || superseding)
    )
      throw new RemoteError("not_found");
    const payload = frame.bytes === undefined ? null : Buffer.from(frame.bytes, "utf8");
    if (payload && payload.byteLength > EXECUTION_LOG_FRAME_MAX_BYTES)
      throw new RemoteError("remote_request_conflict");
    const gapRow = frame.gapTo !== undefined;
    if (payload && checksumOf(payload) !== frame.checksum) {
      // 帧损坏不得冒充 missing 之外的另一种事实：只认 gap，不落正文。
      db.insert(executionLogFrame)
        .values({
          executionId: row.id,
          sequence: frame.sequence,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          stream: frame.stream,
          byteStart: frame.byteStart,
          byteEnd: frame.byteStart,
          payloadBytes: null,
          checksum: checksumOf(null),
          gapFromSeq: frame.sequence,
          gapToSeq: frame.gapTo ?? frame.sequence,
          durableAt: ctx.now,
        })
        .onConflictDoNothing()
        .run();
    } else
      db.insert(executionLogFrame)
        .values({
          executionId: row.id,
          sequence: frame.sequence,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          stream: frame.stream,
          byteStart: frame.byteStart,
          byteEnd: frame.byteEnd,
          payloadBytes: payload,
          checksum: frame.checksum,
          gapFromSeq: gapRow ? frame.sequence : null,
          gapToSeq: gapRow ? frame.gapTo! : null,
          durableAt: ctx.now,
        })
        .onConflictDoNothing()
        .run();
    const produced = Math.max(
      row.producedThroughSeq ?? 0,
      frame.sequence,
      frame.gapTo ?? frame.sequence,
    );
    db.update(remoteExecution)
      .set({
        producedThroughSeq: produced,
        logState: logStateAfterProduce(row, produced),
      })
      .where(eq(remoteExecution.id, row.id))
      .run();
    touched.add(row.id);
  }
  const rows = new Map<string, Execution>();
  for (const executionId of touched) {
    // 一批帧写完后只裁一次前缀，避免逐帧重算保留量。
    trimLogPrefix(executionId);
    rows.set(
      executionId,
      db.select().from(remoteExecution).where(eq(remoteExecution.id, executionId)).get()!,
    );
  }
  return rows;
}
/** 只推进到连续前缀：仍缺失的 sequence 会阻止 ACK 越过它。 */
function acknowledgeLogPrefix(row: Execution) {
  const produced = row.producedThroughSeq;
  if (produced === null) return row;
  const sequences = new Set(
    db
      .select({ sequence: executionLogFrame.sequence })
      .from(executionLogFrame)
      .where(eq(executionLogFrame.executionId, row.id))
      .all()
      .map((frame: { sequence: number }) => frame.sequence),
  );
  let contiguous = row.acknowledgedThroughSeq ?? 0;
  while (sequences.has(contiguous + 1)) contiguous += 1;
  const acknowledged = contiguous === 0 ? null : contiguous;
  const availableFrom = row.availableFromSeq;
  const full =
    acknowledged !== null &&
    acknowledged === produced &&
    (availableFrom === null || availableFrom === 1);
  db.update(remoteExecution)
    .set({
      acknowledgedThroughSeq: acknowledged,
      logState: full ? "full" : logStateAfterProduce(row, produced),
    })
    .where(eq(remoteExecution.id, row.id))
    .run();
  return db.select().from(remoteExecution).where(eq(remoteExecution.id, row.id)).get()!;
}
function logAckOf(row: Execution) {
  if (row.producedThroughSeq === null) return null;
  const frames = db
    .select({ stream: executionLogFrame.stream })
    .from(executionLogFrame)
    .where(eq(executionLogFrame.executionId, row.id))
    .all();
  return {
    executionId: row.id,
    stream: (frames.every((frame: { stream: string }) => frame.stream === "stdout")
      ? "stdout"
      : frames.every((frame: { stream: string }) => frame.stream === "stderr")
        ? "stderr"
        : "both") as "stdout" | "stderr" | "both",
    acknowledgedThroughSequence: row.acknowledgedThroughSeq ?? 0,
    availableFromSequence: row.availableFromSeq,
  };
}
const recoveryMessage = "已根据 runner 恢复事实把执行归约为终态";
/**
 * B1 阻塞项的解法：新会话上报旧执行的终态。`delivery()` 要求同一 dispatchSession，
 * 所以恢复必须自己核对归属、token 与单向性，且必须带证据。
 */
export function applyExecutionRecovery(
  recovery: ExecutionRecovery,
  ctx: { session: WorkerSession; now: Date; requestId: string },
): void {
  const row = executionByKey(recovery.executionId, recovery);
  // runner token 由宿主下发，且只随那一次 command 交出。token 不符意味着这条事实不是
  // 我们交给这台 Machine 的那次下发产生的，因此没有可信终态：拒绝改写，保留原行。
  if (
    !row ||
    row.machineId !== ctx.session.machineId ||
    row.authorizationGeneration !== recovery.authorizationGeneration ||
    row.holderInstanceId !== recovery.holderInstanceId ||
    !row.runnerToken ||
    row.runnerToken !== recovery.runnerToken
  )
    throw new RemoteError("execution_log_unavailable");
  if (SETTLED_STATES.has(row.state)) return;
  if (!RECOVERABLE_STATES.includes(row.state)) return;
  const produced = recovery.producedThroughSequence;
  if (produced !== null && produced > (row.producedThroughSeq ?? 0))
    db.update(remoteExecution)
      .set({ producedThroughSeq: produced, logState: logStateAfterProduce(row, produced) })
      .where(eq(remoteExecution.id, row.id))
      .run();
  // 任何被接受的归约报告都算「这一代 Worker 交代过这条执行」：宿主侧的丢失宽限据此
  // 判断自己该不该替它收尾，不能把 Worker 正在看的执行也写成 unknown。
  db.update(remoteExecution)
    .set({ recoveryReportedAt: ctx.now })
    .where(eq(remoteExecution.id, row.id))
    .run();
  if (recovery.observedState === "running") return;
  if (recovery.observedState === "unknown") {
    // Worker 归约出的 unknown 也是终态，但它是「带原因的未知」，不是宿主猜的 worker_lost；
    // 它仍可被后来带 runner result 的恢复事实提升，见下方单向归约。
    db.update(remoteExecution)
      .set({
        state: "unknown",
        failureReason: "worker_lost",
        recoveryReason: recovery.observedReason ?? "child-exited-without-result",
        terminalAt: row.terminalAt ?? ctx.now,
      })
      .where(eq(remoteExecution.id, row.id))
      .run();
    // 子进程已经不在但没有 result：取消不能停在 delivered 等满确认窗口才说投递未确认，
    // 它现在就能诚实地说「进程已不再运行，退出没有被记录」。
    if (recovery.observedReason === "child-exited-without-result")
      settleCancellations(row.id, ctx.now, false);
    return;
  }
  // 证据不足时不归约：unknown 保留，不当作成功或失败。
  if (recovery.claimEvidenceAt === null || recovery.observedExitedAt === null) return;
  if (recovery.observedExitedAt < recovery.claimEvidenceAt) return;
  const succeeded = recovery.exitCode === 0 && recovery.signal === null;
  const failureReason = succeeded ? null : "executor_error";
  if (recovery.exitCode === null && recovery.signal === null) {
    // runner 只报了退出时间，没有退出事实：保留可恢复标记，不猜终态。
    db.update(remoteExecution)
      .set({
        state: "unknown",
        failureReason: "worker_lost",
        recoveryReason: "child-exited-without-result",
        terminalAt: ctx.now,
      })
      .where(eq(remoteExecution.id, row.id))
      .run();
    return;
  }
  const existing = db
    .select()
    .from(executionResult)
    .where(eq(executionResult.executionId, row.id))
    .get();
  // waitMs 快照只是「已启动」的观察，不是结果：恢复事实到了就用真实退出覆盖它，
  // 否则终态执行会带着一份 exited:false 的正文，页面只能把它当空结果。
  const provisionalExisting =
    existing !== undefined &&
    existing.payloadJson.kind === "shell" &&
    !("failureReason" in existing.payloadJson) &&
    !existing.payloadJson.exited;
  if (!existing || provisionalExisting) {
    const outcome = succeeded ? ("succeeded" as const) : ("failed" as const);
    // 恢复事实只带退出码与信号，不重写原本就未知的输出正文；`recovered: true` 让视图与 UI
    // 知道这份结果来自恢复而不是 runner 的原生报告，不把空正文当成「没有输出」。
    // 只有 shell 有 runner result；其余操作没有第三层，不能凭空造退出正文。
    const recoveredPid = typeof recovery.pid === "number" ? recovery.pid : null;
    const shell = row.operationJson.kind === "shell" && recoveredPid !== null;
    const recoveredSuccess = shell
      ? {
          kind: "shell" as const,
          recovered: true as const,
          pid: recoveredPid!,
          // 正文已随上一个 Worker 丢失：`truncated` 是诚实说法，不是「没有输出」。
          exited: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: true,
        }
      : null;
    const payload = succeeded
      ? (recoveredSuccess ?? {
          kind: row.operationJson.kind,
          recovered: true,
          failureReason: failureReason!,
        })
      : shell
        ? {
            kind: "shell" as const,
            recovered: true as const,
            failureReason: failureReason!,
            partial: {
              ...recoveredSuccess!,
              exitCode: recovery.exitCode ?? 1,
            },
          }
        : {
            kind: row.operationJson.kind,
            recovered: true,
            failureReason: failureReason!,
          };
    if (provisionalExisting)
      db.update(executionResult)
        .set({
          payloadHash: payloadHash(payload),
          outcome,
          payloadJson: payload as never,
          recordedAt: ctx.now,
        })
        .where(eq(executionResult.executionId, row.id))
        .run();
    else
      db.insert(executionResult)
        .values({
          executionId: row.id,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          payloadHash: payloadHash(payload),
          outcome,
          payloadJson: payload as never,
          recordedAt: ctx.now,
        })
        .onConflictDoNothing()
        .run();
  }
  db.update(remoteExecution)
    .set({
      state: succeeded ? "succeeded" : "failed",
      failureReason,
      // runner result 到达即推翻「未知」：这是唯一允许改写 unknown/worker_lost 的路径。
      recoveryReason: null,
      drainedAt: row.drainedAt ?? ctx.now,
      terminalAt: ctx.now,
    })
    // 单向性：只允许从可恢复状态进入已知终态，已确定的终态不回头。
    .where(and(eq(remoteExecution.id, row.id), inArray(remoteExecution.state, RECOVERABLE_STATES)))
    .run();
  // durable result 到达，退出证据同时成立：取消不必等满确认窗口才能说已观测到退出。
  settleCancellations(row.id, ctx.now);
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event: "remote.recovered",
      requestId: ctx.requestId,
      projectId: row.projectId,
      runId: row.runId,
      chatId: row.chatId,
      executionId: row.id,
      message: recoveryMessage,
    })
    .run();
}
export function requestExecution(
  raw: ExecutionSubmitInput,
  ctx: AgentRemoteContext,
): ExecutionView {
  const input = executionSubmitInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertAgentContext(input, ctx);
      const hash = payloadHash(input);
      const old = db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.holderInstanceId, ctx.instanceId),
            eq(remoteExecution.requestId, input.requestId),
          ),
        )
        .get();
      if (old) {
        if (old.payloadHash !== hash) throw new RemoteError("remote_request_conflict");
        expireExecutions(input, ctx.now, ctx.bootId);
        return executionView(
          db.select().from(remoteExecution).where(eq(remoteExecution.id, old.id)).get()!,
        );
      }
      liveLease(input, ctx);
      const conn = connection(input.machineId, ctx);
      if (!conn.capability!.remoteOperations.includes(input.operation.kind))
        throw new RemoteError("machine_unavailable");
      let operation = input.operation;
      let directoryRevision: number | null = null;
      if (operation.kind === "shell") {
        if (!conn.capability!.shells.some((shell: ShellFact) => shell.probe.kind === "success"))
          throw new RemoteError("machine_unavailable");
        if (operation.cwd === undefined) {
          const root = db.select().from(machine).where(eq(machine.id, input.machineId)).get()!;
          const observation = db
            .select()
            .from(directoryObservation)
            .where(
              and(
                eq(directoryObservation.machineId, input.machineId),
                eq(directoryObservation.projectId, input.projectId),
                eq(directoryObservation.generation, conn.generation),
                eq(directoryObservation.revision, root.rootRevision),
              ),
            )
            .get();
          if (
            !root.rootDirectory ||
            !observation ||
            observation.kind !== "accessible" ||
            !observation.realPath
          )
            throw new RemoteError("directory_unavailable");
          operation = { ...operation, cwd: observation.realPath };
          directoryRevision = root.rootRevision;
        }
      }
      expireExecutions(input, ctx.now, ctx.bootId);
      if (
        db
          .select()
          .from(remoteExecution)
          .where(
            and(
              eq(remoteExecution.projectId, input.projectId),
              eq(remoteExecution.machineId, input.machineId),
              // `unknown` 已不再收窄终态：可恢复行仍占一个活跃名额，避免失联行堆积。
              or(isNull(remoteExecution.terminalAt), eq(remoteExecution.state, "unknown")),
            ),
          )
          .all().length >= 64
      )
        throw new RemoteError("too_many_requests");
      const id = newId(ID_PREFIXES.execution);
      db.insert(remoteExecution)
        .values({
          id,
          projectId: input.projectId,
          machineId: input.machineId,
          authorizationGeneration: input.authorizationGeneration,
          holderInstanceId: ctx.instanceId,
          runId: ctx.runId,
          chatId: ctx.chatId,
          requestId: input.requestId,
          payloadHash: hash,
          operationJson: operation,
          directoryRevision,
          state: "queued",
          createdAt: ctx.now,
          dispatchDeadlineAt: new Date(ctx.now.getTime() + 30000),
        })
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "info",
          event: "remote.requested",
          requestId: ctx.requestId,
          projectId: input.projectId,
          chatId: ctx.chatId,
          instanceId: ctx.instanceId,
          runId: ctx.runId,
          executionId: id,
          message: "远端操作已入队",
        })
        .run();
      return executionView(
        db.select().from(remoteExecution).where(eq(remoteExecution.id, id)).get()!,
      );
    })
    .immediate();
}
export function getExecution(
  raw: ExecutionReadInput,
  ctx: MachineContext | AgentRemoteContext,
): ExecutionView {
  const input = executionReadInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      expireExecutions(input, ctx.now, ctx.bootId);
      const row = db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.id, input.executionId),
            eq(remoteExecution.projectId, input.projectId),
            eq(remoteExecution.machineId, input.machineId),
          ),
        )
        .get();
      if (!row) throw new RemoteError("not_found");
      assertExecutionHolder(row, ctx);
      return executionView(row);
    })
    .immediate();
}
export function listProjectExecutions(
  input: { projectId: string; machineId?: string; limit?: number },
  ctx: MachineContext,
): ExecutionView[] {
  return sqlite
    .transaction(() => {
      if (!ctx.userId) throw new RemoteError("unauthorized");
      if (
        !db
          .select()
          .from(project)
          .where(and(eq(project.id, input.projectId), eq(project.createdBy, ctx.userId)))
          .get()
      )
        throw new RemoteError("not_found");
      if (input.machineId)
        assertRemoteAccess({ projectId: input.projectId, machineId: input.machineId }, ctx);
      const rows = db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.projectId, input.projectId),
            input.machineId ? eq(remoteExecution.machineId, input.machineId) : undefined,
          ),
        )
        .orderBy(desc(remoteExecution.createdAt))
        .limit(Math.min(100, Math.max(1, input.limit ?? 20)))
        .all();
      for (const row of rows) {
        assertRemoteAccess(row, ctx);
        expireExecutions(row, ctx.now, ctx.bootId);
      }
      return rows.map((row: Execution) =>
        executionView(
          db.select().from(remoteExecution).where(eq(remoteExecution.id, row.id)).get()!,
          true,
        ),
      );
    })
    .immediate();
}
/**
 * 游标读取日志。游标早于可读起点时返回 gap，不静默从新起点称完整。
 * `frames` 为空只说明该范围内无帧，完整性以 `logState` 为准。
 */
export function readExecutionLog(
  raw: ExecutionLogReadInput,
  ctx: MachineContext | AgentRemoteContext,
): ExecutionLogReadView {
  const input = executionLogReadInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      expireExecutions(input, ctx.now, ctx.bootId);
      const row = executionByKey(input.executionId, input);
      if (!row) throw new RemoteError("not_found");
      assertExecutionHolder(row, ctx);
      const cursor = input.cursor?.nextSequence ?? 0;
      // 游标属于它的执行：跨执行的序号不构成续读起点，必须重读，不冒充完整。
      if (input.cursor && input.cursor.executionId !== input.executionId)
        throw new RemoteError("execution_log_cursor_stale");
      const from = row.availableFromSeq;
      if (from !== null && cursor + 1 < from) throw new RemoteError("execution_log_gap");
      if (row.producedThroughSeq === null && row.logState !== "none")
        throw new RemoteError("execution_log_unavailable");
      const rows = db
        .select()
        .from(executionLogFrame)
        .where(
          and(
            eq(executionLogFrame.executionId, row.id),
            gte(executionLogFrame.sequence, cursor + 1),
          ),
        )
        .orderBy(executionLogFrame.sequence)
        .all();
      const frames: ExecutionLogReadView["frames"] = [];
      const gapRanges: ExecutionLogReadView["gapRanges"] = [];
      let used = 0;
      let nextSequence = cursor;
      for (const frame of rows) {
        if (frame.payloadBytes === null) {
          gapRanges.push({ fromSequence: frame.gapFromSeq!, toSequence: frame.gapToSeq! });
          if (nextSequence <= frame.gapToSeq!) nextSequence = frame.gapToSeq!;
          continue;
        }
        const size = frame.payloadBytes.byteLength;
        // `limitBytes` 是软预算：只要还有可读帧就至少给一帧，分页游标才不会停在原地。
        if (frames.length > 0 && used + size > input.limitBytes) break;
        used += size;
        frames.push({
          sequence: frame.sequence,
          stream: frame.stream,
          byteStart: frame.byteStart,
          byteEnd: frame.byteEnd,
          text: textOf(frame.payloadBytes),
          checksum: frame.checksum,
        });
        if (nextSequence <= frame.sequence) nextSequence = frame.sequence;
      }
      if (gapRanges.length) {
        const current = db
          .select()
          .from(remoteExecution)
          .where(eq(remoteExecution.id, row.id))
          .get()!;
        if (current.logState !== "truncated")
          db.update(remoteExecution)
            .set({ logState: "gap" })
            .where(eq(remoteExecution.id, row.id))
            .run();
      }
      const current = db
        .select()
        .from(remoteExecution)
        .where(eq(remoteExecution.id, row.id))
        .get()!;
      return {
        projectId: row.projectId,
        machineId: row.machineId,
        executionId: row.id,
        frames,
        nextCursor: { executionId: row.id, nextSequence },
        availableFromSequence: current.availableFromSeq,
        acknowledgedThroughSequence: current.acknowledgedThroughSeq,
        producedThroughSequence: current.producedThroughSeq,
        gapRanges,
        logState: current.logState,
        workerOnline: runnerOnline(row.machineId, ctx.now),
      };
    })
    .immediate();
}
function cancellationView(row: Cancellation): ExecutionCancellationView {
  return {
    projectId: row.projectId,
    machineId: row.machineId,
    cancelId: row.id,
    executionId: row.executionId,
    state: row.state,
    requestedAt: row.requestedAt.toISOString(),
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    exitedAt: row.exitedAt?.toISOString() ?? null,
    signalOutcome: row.signalOutcome,
    failureReason: row.failureReason,
  };
}
/** 取消幂等键带 actor 身份：人取消与分身取消共用一张表，但不互相冒充。 */
type CancellationActor = { kind: "agent" | "human"; id: string };
const cancellationRequestKey = (actor: CancellationActor, requestId: string) =>
  `${CANCELLATION_INTENT_NAMESPACE}${actor.kind}:${actor.id}:${requestId}`;
/**
 * 取消只入队一个意图。`delivered` 说明 Worker 收到了意图，不说明进程已停；
 * 进程只有 runner 落盘的 durable result 才能归约为 `exited_observed`。
 */
export function enqueueCancellation(
  raw: ExecutionCancelInput,
  ctx: AgentRemoteContext,
): ExecutionCancellationView {
  const input = executionCancelInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertAgentContext(input, ctx);
      const row = executionByKey(input.executionId, input);
      if (!row) throw new RemoteError("cancellation_not_found");
      // 通道核对先于幂等返回：幂等键只保证「同一请求不重复投递」，不保证调用方还有权碰这台
      // Machine。旧代次、已换 holder 或已释放的租约在命中旧行时同样要拒，且不读写任何行。
      if (input.authorizationGeneration !== row.authorizationGeneration)
        throw new RemoteError("lease_stale_generation");
      liveLease(row, ctx);
      const key = cancellationRequestKey({ kind: "agent", id: ctx.instanceId }, input.requestId);
      const old = db
        .select()
        .from(executionCancellation)
        .where(
          and(
            eq(executionCancellation.holderInstanceId, row.holderInstanceId),
            eq(executionCancellation.requestId, key),
          ),
        )
        .get();
      if (old) {
        if (old.executionId !== row.id) throw new RemoteError("remote_request_conflict");
        return cancellationView(old);
      }
      if (SETTLED_STATES.has(row.state) || row.terminalAt)
        throw new RemoteError("cancellation_already_terminal");
      const open = db
        .select()
        .from(executionCancellation)
        .where(
          and(
            eq(executionCancellation.executionId, row.id),
            inArray(executionCancellation.state, ["requested", "delivered"]),
          ),
        )
        .get();
      // 已有未完成意图时只返回同样的事实，不重复投递。
      if (open) throw new RemoteError("cancellation_delivery_unconfirmed");
      const id = newId(ID_PREFIXES.cancellation);
      db.insert(executionCancellation)
        .values({
          id,
          executionId: row.id,
          requestId: key,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          actorKind: "agent",
          actorId: ctx.instanceId,
          state: "requested",
          signalOutcome: "none",
          // 调用方声明的策略是事实：落库后原样下发给 Worker，不再用常量顶替。
          policy: input.policy,
          termWaitMs: input.termWaitMs,
          requestedAt: ctx.now,
        })
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "info",
          event: "remote.cancel_requested",
          requestId: ctx.requestId,
          projectId: row.projectId,
          runId: row.runId,
          chatId: row.chatId,
          executionId: row.id,
          instanceId: ctx.instanceId,
          message: "已入队取消意图，尚未确认进程退出",
        })
        .run();
      return cancellationView(
        db.select().from(executionCancellation).where(eq(executionCancellation.id, id)).get()!,
      );
    })
    .immediate();
}
/**
 * 人类在 Web 侧发起的显式取消。授权、归属与投递通道都在服务端边界核对；
 * 幂等键按人类身份归属，所以人类取消不会冒充分身。通道不成立时只报「未确认」，
 * 既不写新行，也不假装已入队。
 */
export function cancelExecution(
  raw: ExecutionCancelRequest,
  ctx: MachineContext,
): ExecutionCancellationView {
  const input = executionCancelRequestSchema.parse(raw);
  return sqlite
    .transaction(() => {
      if (!ctx.userId) throw new RemoteError("unauthorized");
      const found = db
        .select()
        .from(remoteExecution)
        .where(eq(remoteExecution.id, input.executionId))
        .get();
      // 不区分「不存在」与「别人的」：两者都是 not_found。
      if (!found) throw new RemoteError("not_found");
      assertRemoteAccess({ projectId: found.projectId, machineId: found.machineId }, ctx);
      expireExecutions(
        { projectId: found.projectId, machineId: found.machineId },
        ctx.now,
        ctx.bootId,
      );
      const row = db.select().from(remoteExecution).where(eq(remoteExecution.id, found.id)).get()!;
      // 幂等命中同样要核对投递通道：旧代次或已换 holder 时，这条意图没有任何人能被投递到，
      // 不能因为「同一个 requestId」就把它当成仍然成立。
      const lease = ensureLease({ projectId: row.projectId, machineId: row.machineId }, ctx.now);
      if (!leaseHeldBy(lease, row.authorizationGeneration, row.holderInstanceId))
        throw new RemoteError("cancellation_delivery_unconfirmed");
      const key = cancellationRequestKey({ kind: "human", id: ctx.userId }, input.requestId);
      const old = db
        .select()
        .from(executionCancellation)
        .where(
          and(
            eq(executionCancellation.actorKind, "human"),
            eq(executionCancellation.actorId, ctx.userId),
            eq(executionCancellation.requestId, key),
          ),
        )
        .get();
      if (old) {
        if (old.executionId !== row.id) throw new RemoteError("remote_request_conflict");
        return cancellationView(old);
      }
      if (row.terminalAt !== null) throw new RemoteError("cancellation_already_terminal");
      const open = db
        .select()
        .from(executionCancellation)
        .where(
          and(
            eq(executionCancellation.executionId, row.id),
            inArray(executionCancellation.state, ["requested", "delivered"]),
          ),
        )
        .get();
      if (open) throw new RemoteError("cancellation_delivery_unconfirmed");
      const id = newId(ID_PREFIXES.cancellation);
      db.insert(executionCancellation)
        .values({
          id,
          executionId: row.id,
          requestId: key,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          actorKind: "human",
          actorId: ctx.userId,
          state: "requested",
          signalOutcome: "none",
          policy: "term_then_kill",
          termWaitMs: 2000,
          requestedAt: ctx.now,
        })
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "info",
          event: "remote.cancel_requested",
          requestId: ctx.requestId,
          projectId: row.projectId,
          executionId: row.id,
          message: "人类已入队取消意图，尚未确认进程退出",
          data: JSON.stringify({ executionId: row.id, actorKind: "human" }),
        })
        .run();
      return cancellationView(
        db.select().from(executionCancellation).where(eq(executionCancellation.id, id)).get()!,
      );
    })
    .immediate();
}
/**
 * 取消送达后等多久才敢写「投递未确认」的窗口基准。窗口从这次取消的 `termWaitMs` 派生：
 * 必须覆盖「TERM→KILL 宽限 + 退出观测 + 报告往返」，否则合法的宽限取消会被抢先判成失败。
 */
const CANCELLATION_CONFIRM_WINDOW_FLOOR_MS = 15000;
/** Worker 在信号之后观测退出的固定窗口，与 `src/worker/remote.ts` 的 `EXIT_OBSERVATION_MS` 同值。 */
const CANCELLATION_EXIT_OBSERVATION_MS = 5000;
/** 余量：runner 落盘 durable result 后由下一次 exchange 上行报告的往返。 */
const CANCELLATION_CONFIRM_MARGIN_MS = 5000;
/** 派生窗口。只影响 `delivery_unconfirmed` 的写入时机，不抢先于 durable result 判失败。 */
export function cancellationConfirmWindowMs(termWaitMs: number) {
  return Math.max(
    CANCELLATION_CONFIRM_WINDOW_FLOOR_MS,
    termWaitMs + CANCELLATION_EXIT_OBSERVATION_MS + CANCELLATION_CONFIRM_MARGIN_MS,
  );
}
/**
 * 构建尚未下发的取消意图供 Worker 拉取。发送前只标 `delivered`（送达），
 * 旧授权代次的意图直接作废，不能借租约操作别人的 Machine。
 */
function drainCancellationIntents(machineId: string, now: Date): ExecutionCancel[] {
  const shared = globalThis as typeof globalThis & {
    sproutCancellationSends?: Map<string, number>;
  };
  const sends = (shared.sproutCancellationSends ??= new Map());
  const output: ExecutionCancel[] = [];
  for (const row of db
    .select()
    .from(executionCancellation)
    .where(
      and(
        eq(executionCancellation.machineId, machineId),
        eq(executionCancellation.state, "requested"),
      ),
    )
    .all()) {
    if (output.length >= 4) break;
    const execution = db
      .select()
      .from(remoteExecution)
      .where(eq(remoteExecution.id, row.executionId))
      .get();
    if (!execution?.runnerToken || execution.terminalAt) continue;
    const lease = db
      .select()
      .from(machineLease)
      .where(
        and(eq(machineLease.projectId, row.projectId), eq(machineLease.machineId, row.machineId)),
      )
      .get();
    if (
      !lease ||
      lease.state !== "held" ||
      lease.generation !== row.authorizationGeneration ||
      lease.holderInstanceId !== row.holderInstanceId
    )
      continue;
    db.update(executionCancellation)
      .set({ state: "delivered", deliveredAt: now, signalOutcome: "term_delivered" })
      .where(
        and(eq(executionCancellation.id, row.id), eq(executionCancellation.state, "requested")),
      )
      .run();
    const delivered = db
      .select()
      .from(executionCancellation)
      .where(eq(executionCancellation.id, row.id))
      .get()!;
    if (delivered.state !== "delivered") continue;
    sends.set(delivered.id, now.getTime());
    output.push({
      cancelId: delivered.id,
      executionId: delivered.executionId,
      projectId: delivered.projectId,
      machineId: delivered.machineId,
      authorizationGeneration: delivered.authorizationGeneration,
      runnerToken: execution.runnerToken,
      policy: delivered.policy,
      termWaitMs: delivered.termWaitMs,
    });
  }
  // 送达后没有 durable result 的意图不得停成「已停止」，只能写投递未确认。
  for (const row of db
    .select()
    .from(executionCancellation)
    .where(
      and(
        eq(executionCancellation.machineId, machineId),
        eq(executionCancellation.state, "delivered"),
      ),
    )
    .all()) {
    const sentAt = sends.get(row.id);
    if (sentAt === undefined) {
      sends.set(row.id, now.getTime());
      continue;
    }
    if (now.getTime() - sentAt < cancellationConfirmWindowMs(row.termWaitMs)) continue;
    db.update(executionCancellation)
      .set({ state: "failed", failureReason: "delivery_unconfirmed" })
      .where(
        and(eq(executionCancellation.id, row.id), eq(executionCancellation.state, "delivered")),
      )
      .run();
    sends.delete(row.id);
  }
  return output;
}
/**
 * runner 落盘的 durable result 是取消的唯一退出证据：意图已送达而命令随后退出写 `exited_observed`，
 * 意图尚未送达而命令自然退出写 `already_exited`。不重写执行结果本身。
 *
 * `exitObserved === false` 表示 Worker 只看到进程不见了、没有 result 落盘。此时既不能写
 * `exited_observed`（没有退出码可确认），也不能沿用 `already_exited`（不知道是不是自然退出）：
 * 诚实的终态是未确认，原因 `exit_not_observed`。送达过的记 `failed`，没送达的记 `unknown`
 * （check_7 要求 `failed` 有送达时间）。
 */
function settleCancellations(executionId: string, now: Date, exitObserved = true) {
  for (const row of db
    .select()
    .from(executionCancellation)
    .where(
      and(
        eq(executionCancellation.executionId, executionId),
        inArray(executionCancellation.state, ["requested", "delivered"]),
      ),
    )
    .all())
    if (!exitObserved)
      db.update(executionCancellation)
        .set({
          state: row.deliveredAt === null ? "unknown" : "failed",
          failureReason: "exit_not_observed",
        })
        .where(eq(executionCancellation.id, row.id))
        .run();
    else
      db.update(executionCancellation)
        .set({
          state: row.deliveredAt === null ? "already_exited" : "exited_observed",
          // 未送达时 delivered_at 必须 NULL（check_5 要求退出时间晚于送达时间）。
          deliveredAt: row.deliveredAt ?? now,
          exitedAt: now,
        })
        .where(eq(executionCancellation.id, row.id))
        .run();
}
function sameSession(a: WorkerSession, b: WorkerSession) {
  return (
    a.machineId === b.machineId &&
    a.generation === b.generation &&
    a.bootId === b.bootId &&
    a.attemptId === b.attemptId
  );
}
function delivery(report: RemoteReport, ctx: AuthenticatedWorkerContext) {
  const row = db
    .select()
    .from(remoteExecution)
    .where(eq(remoteExecution.id, report.executionId))
    .get();
  if (
    !row ||
    row.machineId !== ctx.session.machineId ||
    !sameSession(report.dispatchSession, ctx.session) ||
    row.projectId !== report.projectId ||
    row.machineId !== report.machineId ||
    row.authorizationGeneration !== report.authorizationGeneration ||
    row.holderInstanceId !== report.holderInstanceId ||
    row.payloadHash !== report.fingerprint ||
    row.dispatchConnectionGeneration !== ctx.session.generation ||
    row.dispatchSeq !== report.dispatchSeq
  )
    throw new RemoteError("not_found");
  const frame = db
    .select()
    .from(workerExchangeFrame)
    .where(
      and(
        eq(workerExchangeFrame.machineId, row.machineId),
        eq(workerExchangeFrame.connectionGeneration, ctx.session.generation),
        eq(workerExchangeFrame.seq, report.dispatchSeq),
      ),
    )
    .get();
  if (
    !frame ||
    !sameSession(frame.responseJson.session, ctx.session) ||
    !frame.responseJson.remote.commands.some(
      (command: RemoteCommand) =>
        command.executionId === row.id && command.fingerprint === report.fingerprint,
    )
  )
    throw new RemoteError("not_found");
  if (report.phase === "terminal" && report.payload.kind !== row.operationJson.kind)
    throw new RemoteError("remote_request_conflict");
  return row;
}
function remoteExchangeBytes(remote: RemoteWireOutput, ctx: AuthenticatedWorkerContext) {
  const root = db.select().from(machine).where(eq(machine.id, ctx.session.machineId)).get()!;
  const configuration =
    ctx.mode === "normal"
      ? {
          root: root.rootDirectory,
          rootRevision: root.rootRevision,
          bindings: machineBindings(ctx.session.machineId).map(({ projectId, description }) => ({
            projectId,
            description,
          })),
        }
      : null;
  return Buffer.byteLength(
    JSON.stringify({ mode: ctx.mode, session: ctx.session, seq: ctx.seq, configuration, remote }),
  );
}
/** Called only inside the gateway's authenticated immediate transaction; never awaits. */
export function applyRemoteExchange(
  input: WorkerExchangeRemoteInput,
  ctx: Omit<AuthenticatedWorkerContext, "mode"> & { mode: "normal" },
): NormalRemoteOutput;
export function applyRemoteExchange(
  input: WorkerExchangeRemoteInput,
  ctx: Omit<AuthenticatedWorkerContext, "mode"> & { mode: "drain" },
): DrainProjection;
export function applyRemoteExchange(
  input: WorkerExchangeRemoteInput,
  ctx: AuthenticatedWorkerContext,
): NormalRemoteOutput | DrainProjection {
  const output: RemoteWireOutput = {
    authorizations: [],
    commands: [],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
    logAcks: [],
    cancellations: [],
    mcp: [],
    mcpCursors: [],
  };
  const leases = db
    .select()
    .from(machineLease)
    .where(eq(machineLease.machineId, ctx.session.machineId))
    .all();
  for (const key of leases) expireExecutions(key, ctx.now, ctx.bootId);
  for (const report of input.results) {
    const row = delivery(report, ctx);
    if (report.phase === "running") {
      if (row.state === "dispatched")
        db.update(remoteExecution)
          .set({ state: "running" })
          .where(eq(remoteExecution.id, row.id))
          .run();
      continue;
    }
    const hash = payloadHash(report);
    const previous = db
      .select()
      .from(executionResult)
      .where(eq(executionResult.executionId, row.id))
      .get();
    let disposition: "accepted" | "ignored_terminal" = "accepted";
    // unknown/worker_lost 不是不可推翻的结论：真正的退出报告到了就归约成真实终态。
    // 已被 exited/timed_out/canceled/failed 封住的执行仍按 ignored_terminal 处理。
    const promotable = row.state === "unknown" && row.failureReason === "worker_lost";
    if (row.terminalAt && !promotable) {
      if (
        previous &&
        previous.payloadHash !== hash &&
        (row.state === "succeeded" || row.state === "failed")
      )
        throw new RemoteError("remote_request_conflict");
      disposition = previous?.payloadHash === hash ? "accepted" : "ignored_terminal";
      db.update(remoteExecution)
        .set({ drainedAt: ctx.now })
        .where(eq(remoteExecution.id, row.id))
        .run();
    } else {
      const lease = ensureLease(row, ctx.now);
      const authorized =
        lease.state === "held" &&
        lease.generation === row.authorizationGeneration &&
        lease.holderInstanceId === row.holderInstanceId;
      const outcome = authorized ? report.outcome : "rejected";
      const payload = authorized
        ? report.payload
        : { kind: row.operationJson.kind, failureReason: "authorization_revoked" as const };
      // shell 的 waitMs 快照（exited:false）只是「已启动」的观察：要把 pid/当前输出
      // 交给工具面，但不能把执行落成终态，否则长命令在窗口后既不能取消也不再采日志。
      // 真正的终态报告随后覆盖同一行结果，并把执行归约。
      const provisional =
        authorized &&
        !("failureReason" in report.payload) &&
        report.payload.kind === "shell" &&
        !report.payload.exited;
      if (provisional) {
        if (row.state === "dispatched")
          db.update(remoteExecution)
            .set({ state: "running" })
            .where(eq(remoteExecution.id, row.id))
            .run();
      } else
        db.update(remoteExecution)
          .set({
            state: outcome,
            drainedAt: ctx.now,
            terminalAt: ctx.now,
            failureReason: "failureReason" in payload ? payload.failureReason : null,
            // 没有 runner result 的退出把原因一起交上来：执行停在 understandable 的未知，
            // 不写成已知终态，也不让取消冒认「已观测到退出」。
            recoveryReason: report.recoveryReason ?? null,
          })
          .where(eq(remoteExecution.id, row.id))
          .run();
      const values = {
        executionId: row.id,
        projectId: row.projectId,
        machineId: row.machineId,
        authorizationGeneration: row.authorizationGeneration,
        holderInstanceId: row.holderInstanceId,
        payloadHash: hash,
        outcome,
        payloadJson: payload,
        recordedAt: ctx.now,
      } as const;
      if (previous)
        db.update(executionResult)
          .set({
            payloadHash: hash,
            outcome,
            payloadJson: payload,
            recordedAt: ctx.now,
          })
          .where(eq(executionResult.executionId, row.id))
          .run();
      else db.insert(executionResult).values(values).run();
      if (provisional) {
        output.resultAcks.push({ executionId: row.id, disposition });
        continue;
      }
    }
    // runner 落盘的 durable result 是取消的唯一退出证据；送达本身不算进程已停。
    settleCancellations(row.id, ctx.now, report.recoveryReason === undefined);
    output.resultAcks.push({ executionId: row.id, disposition });
  }
  const logRows = input.logFrames?.length ? applyLogFrames(input.logFrames, ctx) : new Map();
  for (const row of logRows.values()) {
    const ack = logAckOf(acknowledgeLogPrefix(row));
    if (ack) output.logAcks!.push(ack);
  }
  for (const recovery of input.recoveries ?? [])
    applyExecutionRecovery(recovery, { ...ctx, requestId: "worker-exchange" });
  for (const ack of input.fenceAcks) {
    const mutation = db
      .select()
      .from(leaseMutation)
      .where(eq(leaseMutation.id, ack.mutationId))
      .get();
    if (
      !mutation ||
      !sameSession(ack.dispatchSession, ctx.session) ||
      ack.machineId !== ctx.session.machineId ||
      mutation.projectId !== ack.projectId ||
      mutation.machineId !== ack.machineId ||
      mutation.expectedGeneration !== ack.authorizationGeneration
    )
      throw new RemoteError("not_found");
    // The acknowledgement may only name deliveries issued to this exact session.
    for (const id of ack.executionIds) {
      const row = db.select().from(remoteExecution).where(eq(remoteExecution.id, id)).get();
      if (
        !row ||
        row.projectId !== ack.projectId ||
        row.machineId !== ack.machineId ||
        row.authorizationGeneration !== ack.authorizationGeneration ||
        row.dispatchConnectionGeneration !== ctx.session.generation
      )
        throw new RemoteError("not_found");
      db.update(remoteExecution)
        .set({
          drainedAt: ctx.now,
          ...(!row.terminalAt
            ? {
                state: "rejected" as const,
                terminalAt: ctx.now,
                failureReason: "authorization_revoked" as const,
              }
            : {}),
        })
        .where(eq(remoteExecution.id, id))
        .run();
    }
    output.fenceAcks.push({ mutationId: ack.mutationId, executionIds: ack.executionIds });
  }
  for (const key of leases) completeLeaseMutation(key, ctx.now);
  for (const lease of db
    .select()
    .from(machineLease)
    .where(eq(machineLease.machineId, ctx.session.machineId))
    .all()) {
    if (ctx.mode === "normal")
      output.authorizations.push({
        projectId: lease.projectId,
        machineId: lease.machineId,
        generation: lease.generation,
        holderInstanceId: lease.holderInstanceId,
        state: lease.state === "held" ? "active" : lease.state === "fencing" ? "draining" : "free",
      });
    if (lease.state === "fencing") {
      const mutation = db
        .select()
        .from(leaseMutation)
        .where(
          and(
            eq(leaseMutation.projectId, lease.projectId),
            eq(leaseMutation.machineId, lease.machineId),
            eq(leaseMutation.state, "pending"),
          ),
        )
        .get()!;
      const executions = db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.projectId, lease.projectId),
            eq(remoteExecution.machineId, lease.machineId),
            eq(remoteExecution.authorizationGeneration, lease.generation),
            eq(remoteExecution.dispatchConnectionGeneration, ctx.session.generation),
            isNull(remoteExecution.drainedAt),
          ),
        )
        .all();
      if (executions.length)
        output.fences.push({
          mutationId: mutation.id,
          projectId: lease.projectId,
          machineId: lease.machineId,
          authorizationGeneration: lease.generation,
          executionIds: executions.map((row: Execution) => row.id),
        });
    }
  }
  try {
    const budget =
      1048576 -
      remoteExchangeBytes(output, ctx) +
      Buffer.byteLength(JSON.stringify({ mcp: [], mcpCursors: [] }));
    const { wakeSessions, ...mcpOutput } = applyMcpExchange(
      input,
      ctx,
      Math.min(budget, ctx.seq % 2 ? 655360 : 65536),
    );
    Object.assign(output, mcpOutput);
    // exchangeWorker owns an outer synchronous transaction. Run after that stack
    // commits, and suppress wakes if a later gateway failure rolled it back.
    if (wakeSessions.size)
      queueMicrotask(() => {
        for (const [sessionId, frameId] of wakeSessions) {
          if (db.select({ id: mcpFrame.id }).from(mcpFrame).where(eq(mcpFrame.id, frameId)).get())
            wakeMcpSession(sessionId);
        }
      });
  } catch (error) {
    if (error instanceof McpExchangeError) throw new RemoteError(error.code);
    throw error;
  }
  if (ctx.mode === "drain") {
    const projection: DrainProjection = {
      fences: output.fences,
      resultAcks: output.resultAcks,
      fenceAcks: output.fenceAcks,
      logAcks: output.logAcks ?? [],
      mcp: output.mcp,
      mcpCursors: output.mcpCursors,
    };
    return projection;
  }
  const normalOutput: NormalRemoteOutput = output;
  {
    normalOutput.cancellations!.push(...drainCancellationIntents(ctx.session.machineId, ctx.now));
    const conn = connection(ctx.session.machineId, ctx);
    for (const row of db
      .select()
      .from(remoteExecution)
      .where(
        and(
          eq(remoteExecution.machineId, ctx.session.machineId),
          eq(remoteExecution.state, "queued"),
        ),
      )
      .all()) {
      if (normalOutput.commands.length >= 8) break;
      const lease = db.select().from(machineLease).where(leaseWhere(row)).get();
      let failure:
        | "authorization_revoked"
        | "capability_unavailable"
        | "directory_unavailable"
        | null = null;
      if (
        !lease ||
        lease.state !== "held" ||
        lease.generation !== row.authorizationGeneration ||
        lease.holderInstanceId !== row.holderInstanceId
      )
        failure = "authorization_revoked";
      else if (!conn.capability?.remoteOperations.includes(row.operationJson.kind))
        failure = "capability_unavailable";
      else if (row.directoryRevision !== null) {
        const root = db.select().from(machine).where(eq(machine.id, row.machineId)).get()!;
        const observation = db
          .select()
          .from(directoryObservation)
          .where(
            and(
              eq(directoryObservation.machineId, row.machineId),
              eq(directoryObservation.generation, ctx.session.generation),
              eq(directoryObservation.projectId, row.projectId),
              eq(directoryObservation.revision, row.directoryRevision),
            ),
          )
          .get();
        if (
          root.rootRevision !== row.directoryRevision ||
          observation?.kind !== "accessible" ||
          row.operationJson.kind !== "shell" ||
          observation.realPath !== row.operationJson.cwd
        )
          failure = "directory_unavailable";
      }
      if (failure) {
        db.update(remoteExecution)
          .set({ state: "rejected", failureReason: failure, terminalAt: ctx.now })
          .where(eq(remoteExecution.id, row.id))
          .run();
        continue;
      }
      const runtimeDeadlineAt =
        row.runtimeDeadlineAt ??
        (row.maxRuntimeMs === null ? null : new Date(ctx.now.getTime() + row.maxRuntimeMs));
      const runnerToken = row.runnerToken ?? randomBytes(16).toString("hex");
      const command: RemoteCommand = {
        executionId: row.id,
        projectId: row.projectId,
        machineId: row.machineId,
        authorizationGeneration: row.authorizationGeneration,
        holderInstanceId: row.holderInstanceId,
        requestId: row.requestId,
        fingerprint: row.payloadHash,
        dispatchSession: ctx.session,
        dispatchSeq: ctx.seq,
        operation: row.operationJson as RemoteCommand["operation"],
        directoryRevision: row.directoryRevision,
        dispatchDeadlineAt: row.dispatchDeadlineAt.toISOString(),
        runtimeDeadlineAt: runtimeDeadlineAt?.toISOString() ?? null,
        maxRuntimeMs: row.maxRuntimeMs,
        runnerToken,
      };
      if (
        remoteExchangeBytes({ ...output, commands: [...output.commands, command] }, ctx) > 1048576
      )
        break;
      db.update(remoteExecution)
        .set({
          state: "dispatched",
          dispatchConnectionGeneration: ctx.session.generation,
          dispatchSeq: ctx.seq,
          dispatchedAt: ctx.now,
          runnerToken,
          runtimeDeadlineAt,
        })
        .where(eq(remoteExecution.id, row.id))
        .run();
      normalOutput.commands.push(command);
    }
  }
  return normalOutput;
}

/** Build the Worker drain envelope from its closed projection. */
export function drainRemoteResponse(projection: DrainProjection): RemoteWireOutput {
  return {
    authorizations: [],
    commands: [],
    cancellations: [],
    fences: projection.fences,
    resultAcks: projection.resultAcks,
    fenceAcks: projection.fenceAcks,
    logAcks: projection.logAcks,
    mcp: projection.mcp,
    mcpCursors: projection.mcpCursors,
  };
}
