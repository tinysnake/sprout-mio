import { createHash, randomBytes } from "node:crypto";
import { machineBindings } from "../domain/machine";
import { applyMcpExchange, McpExchangeError } from "../domain/mcp/exchange";
import type { WorkerExchangeRemoteInput } from "../contracts/worker";
import { and, desc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { ShellFact } from "../contracts/machine";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  CANCELLATION_INTENT_NAMESPACE,
  EXECUTION_LOG_FRAME_MAX_BYTES,
  executionCancelInputSchema,
  executionLogReadInputSchema,
  executionReadInputSchema,
  executionSubmitInputSchema,
} from "../contracts/remote";
import type {
  ExecutionCancel,
  ExecutionCancelInput,
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
const RECOVERABLE_STATES = new Set(["unknown", "timed_out", "dispatched", "running", "draining"]);
export type AuthenticatedWorkerContext = {
  session: WorkerSession;
  mode: "normal" | "drain";
  seq: number;
  now: Date;
  bootId: string;
};
/** Worker v3 出站 wire 形状：基座 remote 加上 relay 空批字段。 */
type RemoteWireOutput = Extract<WorkerExchangeResponse, { ok: true }>["data"]["remote"];
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
function executionView(row: Execution): ExecutionView {
  const result = db
    .select()
    .from(executionResult)
    .where(eq(executionResult.executionId, row.id))
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
    result: result?.payloadJson ?? null,
    logState: row.logState,
    producedThroughSequence: row.producedThroughSeq,
    acknowledgedThroughSequence: row.acknowledgedThroughSeq,
    availableFromSequence: row.availableFromSeq,
  };
}
type LeaseClaim = { projectId: string; machineId: string; authorizationGeneration: number };
function liveLease(input: LeaseClaim, ctx: AgentRemoteContext) {
  const lease = ensureLease(input, ctx.now);
  if (lease.generation !== input.authorizationGeneration)
    throw new RemoteError("lease_stale_generation");
  if (lease.state === "fencing") throw new RemoteError("lease_fencing");
  if (lease.state !== "held" || lease.holderInstanceId !== ctx.instanceId)
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
    row && row.status === "open" && now.getTime() - row.lastSeenAt.getTime() < WORKER_STALE_AFTER_MS,
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
  const touched = new Map<string, Execution>();
  for (const frame of frames) {
    if (frame.machineId !== ctx.session.machineId) throw new RemoteError("not_found");
    const row = executionByKey(frame.executionId, frame);
    if (
      !row ||
      !sameSession(frame.dispatchSession, ctx.session) ||
      row.authorizationGeneration !== frame.authorizationGeneration ||
      row.holderInstanceId !== frame.holderInstanceId ||
      row.dispatchConnectionGeneration !== ctx.session.generation ||
      row.dispatchSeq !== frame.dispatchSeq
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
    touched.set(
      row.id,
      db.select().from(remoteExecution).where(eq(remoteExecution.id, row.id)).get()!,
    );
  }
  return touched;
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
const recoveryMessage =
  "已根据 runner 恢复事实把执行归约为终态";
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
  if (!RECOVERABLE_STATES.has(row.state)) return;
  const produced = recovery.producedThroughSequence;
  if (produced !== null && produced > (row.producedThroughSeq ?? 0))
    db.update(remoteExecution)
      .set({ producedThroughSeq: produced, logState: logStateAfterProduce(row, produced) })
      .where(eq(remoteExecution.id, row.id))
      .run();
  if (recovery.observedState === "unknown" || recovery.observedState === "running") return;
  // 证据不足时不归约：unknown 保留，不当作成功或失败。
  if (recovery.claimEvidenceAt === null || recovery.observedExitedAt === null) return;
  if (recovery.observedExitedAt < recovery.claimEvidenceAt) return;
  const succeeded = recovery.exitCode === 0 && recovery.signal === null;
  const failureReason = succeeded ? null : "executor_error";
  if (recovery.exitCode === null && recovery.signal === null) {
    // runner 只报了退出时间，没有退出事实：保留可恢复标记，不猜终态。
    db.update(remoteExecution)
      .set({ state: "unknown", failureReason: "worker_lost", terminalAt: ctx.now })
      .where(eq(remoteExecution.id, row.id))
      .run();
    return;
  }
  const existing = db
    .select()
    .from(executionResult)
    .where(eq(executionResult.executionId, row.id))
    .get();
  if (!existing) {
    const outcome = succeeded ? ("succeeded" as const) : ("failed" as const);
    // 恢复事实只带退出码与信号，不重写原本就未知的输出正文；`recovered: true` 让视图与 UI
    // 知道这份结果来自恢复而不是 runner 的原生报告，不把空正文当成「没有输出」。
    const payload = succeeded
      ? {
          kind: row.operationJson.kind,
          recovered: true,
          exitCode: 0,
          signal: null,
        }
      : {
          kind: row.operationJson.kind,
          recovered: true,
          exitCode: recovery.exitCode,
          signal: recovery.signal,
          failureReason: failureReason!,
        };
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
      drainedAt: row.drainedAt ?? ctx.now,
      terminalAt: ctx.now,
    })
    // 单向性：只允许从可恢复状态进入已知终态，已确定的终态不回头。
    .where(
      and(
        eq(remoteExecution.id, row.id),
        inArray(remoteExecution.state, [...RECOVERABLE_STATES]),
      ),
    )
    .run();
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
              or(
                isNull(remoteExecution.terminalAt),
                eq(remoteExecution.state, "unknown"),
              ),
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
      const cursor = input.cursor?.nextSequence ?? 0;
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
        if (used + size > input.limitBytes) break;
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
        nextCursor: { nextSequence },
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
      const key = `${CANCELLATION_INTENT_NAMESPACE}${ctx.instanceId}:${input.requestId}`;
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
      liveLease(row, ctx);
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
          actorInstanceId: ctx.instanceId,
          state: "requested",
          signalOutcome: "none",
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
/** 取消送达后等待 runner 确认退出证据的窗口。超时只写 delivery_unconfirmed。 */
const CANCELLATION_CONFIRM_WINDOW_MS = 15000;
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
        and(
          eq(machineLease.projectId, row.projectId),
          eq(machineLease.machineId, row.machineId),
        ),
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
      .where(and(eq(executionCancellation.id, row.id), eq(executionCancellation.state, "requested")))
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
      policy: "term_then_kill",
      termWaitMs: 2000,
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
    if (now.getTime() - sentAt < CANCELLATION_CONFIRM_WINDOW_MS) continue;
    db.update(executionCancellation)
      .set({ state: "failed", failureReason: "delivery_unconfirmed" })
      .where(and(eq(executionCancellation.id, row.id), eq(executionCancellation.state, "delivered")))
      .run();
    sends.delete(row.id);
  }
  return output;
}
/**
 * runner 落盘的 durable result 是取消的唯一退出证据：意图已送达而命令随后退出写 `exited_observed`，
 * 意图尚未送达而命令自然退出写 `already_exited`。不重写执行结果本身。
 */
function settleCancellations(executionId: string, now: Date) {
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
  ctx: AuthenticatedWorkerContext,
): RemoteWireOutput {
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
    if (row.terminalAt) {
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
      db.update(remoteExecution)
        .set({
          state: outcome,
          drainedAt: ctx.now,
          terminalAt: ctx.now,
          failureReason: "failureReason" in payload ? payload.failureReason : null,
        })
        .where(eq(remoteExecution.id, row.id))
        .run();
      db.insert(executionResult)
        .values({
          executionId: row.id,
          projectId: row.projectId,
          machineId: row.machineId,
          authorizationGeneration: row.authorizationGeneration,
          holderInstanceId: row.holderInstanceId,
          payloadHash: hash,
          outcome,
          payloadJson: payload,
          recordedAt: ctx.now,
        })
        .run();
    }
    // runner 落盘的 durable result 是取消的唯一退出证据；送达本身不算进程已停。
    settleCancellations(row.id, ctx.now);
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
  if (ctx.mode === "normal") {
    output.cancellations!.push(...drainCancellationIntents(ctx.session.machineId, ctx.now));
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
      if (output.commands.length >= 8) break;
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
        (row.maxRuntimeMs === null
          ? null
          : new Date(ctx.now.getTime() + row.maxRuntimeMs));
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
      output.commands.push(command);
    }
  }
  return output;
}
