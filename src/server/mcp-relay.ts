import { EventEmitter } from "node:events";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  mcpCatalogGetInputSchema,
  mcpCatalogViewSchema,
  mcpSessionCloseInputSchema,
  mcpSessionCloseOutputSchema,
  mcpSessionExchangeInputSchema,
  mcpSessionExchangeOutputSchema,
  mcpSessionOpenInputSchema,
  mcpSessionOpenOutputSchema,
} from "../contracts/mcp";
import type {
  HostOutboundFrame,
  McpCatalogView,
  McpSession,
  ServerInboundFrame,
} from "../contracts/mcp";
import type { AppErrorCode } from "../contracts/result";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  diagnosticEvent,
  mcpFrame,
  mcpServerProcess,
  mcpServerRegistration,
  mcpSession,
  machineConnection,
  machineConnectionCounter,
} from "../db/schema";
import { assertAgentContext, ensureLease, payloadHash } from "./lease";
import type { AgentRemoteContext } from "./lease";

/**
 * Agent 侧 MCP 中继的四个分支：`mcp_catalog_get`、`mcp_session_open`、
 * `mcp_session_exchange`、`mcp_session_close`。
 *
 * 归属：服务端只解释 Sprout 信封（session 行、帧序号、授权代次、配额），
 * **不解释 MCP method**。帧内容原样进出，JSON-RPC 的解码与 id 归属交给 Pi 的
 * `parseJsonRpcMessage`。真实进程的起停与帧搬运由 `r1-worker` 在 Machine 侧完成。
 */
export class McpRelayError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "McpRelayError";
  }
}

export const MCP_MAX_PROCESS_IDENTITIES = 8;
export const MCP_MAX_SESSIONS_PER_MACHINE = 8;
export const MCP_MAX_QUEUED_FRAMES = 32;
export const MCP_MAX_UNACKED_BYTES = 2 * 1024 * 1024;
/** 每次 exchange 最多下发的 s2c 帧数（design §6.2 的 `frames` 上界）。 */
export const MCP_MAX_INBOUND_FRAMES = 2;

type Registration = typeof mcpServerRegistration.$inferSelect;
type Process = typeof mcpServerProcess.$inferSelect;
type SessionRow = typeof mcpSession.$inferSelect;
type FrameRow = typeof mcpFrame.$inferSelect;
type LeaseInput = { projectId: string; machineId: string; authorizationGeneration: number };
type ExchangeInput = ReturnType<typeof mcpSessionExchangeInputSchema.parse>;
type CloseInput = ReturnType<typeof mcpSessionCloseInputSchema.parse>;

/** 网关在 immediate 事务里只做形状校验，落盘与 hold 交给 `mcpSessionExchange`。 */
export function parseMcpExchange(raw: unknown): ExchangeInput {
  return mcpSessionExchangeInputSchema.parse(raw);
}

const wake = new EventEmitter();
wake.setMaxListeners(0);

/**
 * 进程内唤醒：有新帧落库时立刻叫醒正在有界 hold 的 exchange。
 * `r1-worker` 的 `applyRemoteExchange` 落完 s2c 帧后调用即可；本单元没有该文件的写权限，
 * 所以当前 hold 只能等超时唤醒（实测值见报告）。
 */
export function wakeMcpSession(sessionId: string): void {
  wake.emit(sessionId);
}

/** 与 `server-entry.ts` 共用同一个 drain 实例：`draining` 时不 hold。 */
function draining(): boolean {
  const scope = globalThis as typeof globalThis & { sproutHttpDrain?: { draining?: boolean } };
  return scope.sproutHttpDrain?.draining === true;
}

/**
 * 走既有机器连接的 freshness 与 `capability.mcpRelay` 门槛，不另写认证判定。
 * `mcpRelay` 缺席 = 未知 = 不支持（`src/contracts/machine.ts` 的可选可空字段），
 * 假宣告不可能发生在这里：只有 Worker 自己上报 running 的进程才会进 catalog。
 */
function liveWorkerConnection(machineId: string, ctx: AgentRemoteContext) {
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
    !row.capability ||
    !row.capability.mcpRelay
  )
    throw new McpRelayError("machine_unavailable");
  return row;
}

/**
 * 逐请求重做授权检查：先 `assertAgentContext`（Project owner / Machine owner /
 * projectMachine 绑定 / instance / run / chat / grant / running），再过 lease 代次与持有者。
 * 撤权后连重放请求也不返回旧 success（design §6.2）。
 */
function requireRelay(input: LeaseInput, ctx: AgentRemoteContext) {
  assertAgentContext(input, ctx);
  const lease = ensureLease(input, ctx.now);
  if (lease.generation !== input.authorizationGeneration)
    throw new McpRelayError("lease_stale_generation");
  if (lease.state === "fencing") throw new McpRelayError("lease_fencing");
  if (lease.state !== "held" || lease.holderInstanceId !== ctx.instanceId)
    throw new McpRelayError("lease_not_holder");
  return lease;
}

function toSession(row: SessionRow): McpSession {
  return {
    id: row.id,
    projectId: row.projectId,
    machineId: row.machineId,
    authorizationGeneration: row.authorizationGeneration,
    holderInstanceId: row.holderInstanceId,
    processId: row.processId,
    registrationId: row.registrationId,
    registrationRevision: row.registrationRevision,
    transport: row.transport,
    configHash: row.configHash,
    workerIncarnationId: row.workerIncarnationId,
    runId: row.runId,
    grantId: row.grantId,
    chatId: row.chatId,
    openRequestId: row.openRequestId,
    openHash: row.openHash,
    state: row.state,
    createdAt: row.createdAt,
    attachedAt: row.attachedAt,
    connectedAt: row.connectedAt,
    endedAt: row.endedAt,
    endReason: row.endReason as McpSession["endReason"],
    protocolVersion: row.protocolVersion,
    clientHighWater: row.clientHighWater,
    workerAckClientSeq: row.workerAckClientSeq,
    serverHighWater: row.serverHighWater,
    hostAckServerSeq: row.hostAckServerSeq,
    workerStateRevision: row.workerStateRevision,
    workerStateHash: row.workerStateHash,
    workerDetachedAt: row.workerDetachedAt,
    fenceMutationId: row.fenceMutationId,
    workerConnectionGeneration: row.workerConnectionGeneration,
    serverBootId: row.serverBootId,
    workerAttemptId: row.workerAttemptId,
  };
}

function sessionRow(id: string): SessionRow {
  const row = db.select().from(mcpSession).where(eq(mcpSession.id, id)).get();
  if (!row) throw new McpRelayError("not_found");
  return row;
}

/** 三层校验的 session 行那一层：Project/Machine/代次/持有者，任一不等即拒绝。 */
function boundSession(input: LeaseInput & { sessionId: string }, ctx: AgentRemoteContext) {
  const row = sessionRow(input.sessionId);
  if (row.projectId !== input.projectId || row.machineId !== input.machineId)
    throw new McpRelayError("not_found");
  if (row.authorizationGeneration !== input.authorizationGeneration)
    throw new McpRelayError("lease_stale_generation");
  if (row.holderInstanceId !== ctx.instanceId) throw new McpRelayError("lease_not_holder");
  return row;
}

function terminal(row: SessionRow): boolean {
  return ["closed", "failed", "disconnected"].includes(row.state);
}

function inboundFrames(row: SessionRow, limit: number): ServerInboundFrame[] {
  const rows = db
    .select()
    .from(mcpFrame)
    .where(
      and(
        eq(mcpFrame.sessionId, row.id),
        eq(mcpFrame.direction, "server_to_client"),
        inArray(mcpFrame.state, ["queued", "sent"]),
      ),
    )
    .all()
    .sort((a: FrameRow, b: FrameRow) => a.seq - b.seq);
  const frames: ServerInboundFrame[] = [];
  for (const frame of rows) {
    if (frames.length >= limit) break;
    if (!frame.payloadBase64) continue;
    if (frame.state === "queued")
      db.update(mcpFrame)
        .set({ state: "sent", sentAt: frame.createdAt })
        .where(eq(mcpFrame.id, frame.id))
        .run();
    frames.push({
      frameId: frame.id,
      seq: frame.seq,
      payloadBase64: frame.payloadBase64,
      payloadBytes: frame.payloadBytes,
      payloadHash: frame.payloadHash,
      expiresAt: frame.expiresAt,
    });
  }
  return frames;
}

function queuedBudget(sessionId: string) {
  const rows = db
    .select()
    .from(mcpFrame)
    .where(
      and(
        eq(mcpFrame.sessionId, sessionId),
        eq(mcpFrame.direction, "client_to_server"),
        eq(mcpFrame.state, "queued"),
      ),
    )
    .all();
  return {
    count: rows.length,
    bytes: rows.reduce((sum: number, row: FrameRow) => sum + row.payloadBytes, 0),
  };
}

/** `mcp_catalog_get`：≤64 条显式登记摘要 + 每条 ≤8 个新鲜 process identity。 */
export function mcpCatalogGet(raw: unknown, ctx: AgentRemoteContext): McpCatalogView {
  const input = mcpCatalogGetInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      requireRelay(input, ctx);
      const registrations = db
        .select()
        .from(mcpServerRegistration)
        .where(
          and(
            eq(mcpServerRegistration.projectId, input.projectId),
            eq(mcpServerRegistration.machineId, input.machineId),
            isNull(mcpServerRegistration.retiredAt),
          ),
        )
        .all()
        .sort((a: Registration, b: Registration) => a.name.localeCompare(b.name))
        .slice(0, 64);
      return mcpCatalogViewSchema.parse({
        registrations: registrations.map((row: Registration) => {
          const processes = db
            .select()
            .from(mcpServerProcess)
            .where(
              and(
                eq(mcpServerProcess.registrationId, row.id),
                eq(mcpServerProcess.registrationRevision, row.revision),
                eq(mcpServerProcess.projectId, row.projectId),
                eq(mcpServerProcess.machineId, row.machineId),
                eq(mcpServerProcess.state, "running"),
                isNull(mcpServerProcess.endedAt),
              ),
            )
            .all()
            .slice(0, MCP_MAX_PROCESS_IDENTITIES);
          return {
            registrationId: row.id,
            registrationRevision: row.revision,
            projectId: row.projectId,
            machineId: row.machineId,
            name: row.name,
            transport: row.transport,
            configHash: row.configHash,
            exposure: row.configJson.exposure,
            ...(row.configJson.toolAllowlist === undefined
              ? {}
              : { toolAllowlist: row.configJson.toolAllowlist }),
            requestTimeoutMs: row.configJson.requestTimeoutMs,
            roots: row.configJson.roots,
            exposeSampling: row.configJson.exposeSampling,
            elicitation: row.configJson.elicitation,
            processes: processes.map((process: Process) => ({
              processId: process.id,
              workerIncarnationId: process.workerIncarnationId,
              lastObservedAt: process.lastObservedAt,
            })),
          };
        }),
      });
    })
    .immediate();
}

/**
 * `mcp_session_open`：幂等键 `(grantId, openRequestId)`，hash 覆盖
 * Project/Machine/代次/registration+revision/processId/incarnation。
 * 响应语义 = session 已登记为 `connecting`，**不表示 MCP 已连接**（那要等 Worker attach）。
 */
export function mcpSessionOpen(raw: unknown, ctx: AgentRemoteContext) {
  const input = mcpSessionOpenInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      requireRelay(input, ctx);
      const hash = payloadHash(input);
      const existing = db
        .select()
        .from(mcpSession)
        .where(
          and(eq(mcpSession.grantId, ctx.grantId), eq(mcpSession.openRequestId, input.requestId)),
        )
        .get();
      if (existing) {
        if (existing.openHash !== hash) throw new McpRelayError("remote_request_conflict");
        return mcpSessionOpenOutputSchema.parse({ session: toSession(existing) });
      }
      const registration = db
        .select()
        .from(mcpServerRegistration)
        .where(
          and(
            eq(mcpServerRegistration.id, input.registrationId),
            eq(mcpServerRegistration.revision, input.registrationRevision),
            eq(mcpServerRegistration.projectId, input.projectId),
            eq(mcpServerRegistration.machineId, input.machineId),
            isNull(mcpServerRegistration.retiredAt),
          ),
        )
        .get();
      if (!registration) throw new McpRelayError("not_found");
      const process = db
        .select()
        .from(mcpServerProcess)
        .where(
          and(
            eq(mcpServerProcess.id, input.processId),
            eq(mcpServerProcess.registrationId, input.registrationId),
            eq(mcpServerProcess.registrationRevision, input.registrationRevision),
            eq(mcpServerProcess.projectId, input.projectId),
            eq(mcpServerProcess.machineId, input.machineId),
            eq(mcpServerProcess.workerIncarnationId, input.expectedWorkerIncarnationId),
          ),
        )
        .get();
      // 目标消失不改投：process 必须仍 running、incarnation 匹配、且没有别的 session 占着它。
      if (
        !process ||
        process.state !== "running" ||
        process.endedAt !== null ||
        (process.transport === "stdio" ? !process.pid : !process.endpoint)
      )
        throw new McpRelayError("machine_unavailable");
      if (
        db
          .select()
          .from(mcpSession)
          .where(
            and(
              eq(mcpSession.processId, process.id),
              inArray(mcpSession.state, ["connecting", "connected"]),
            ),
          )
          .get()
      )
        throw new McpRelayError("remote_request_conflict");
      if (
        db
          .select()
          .from(mcpSession)
          .where(
            and(
              eq(mcpSession.machineId, input.machineId),
              inArray(mcpSession.state, ["connecting", "connected"]),
            ),
          )
          .all().length >= MCP_MAX_SESSIONS_PER_MACHINE
      )
        throw new McpRelayError("too_many_requests");
      const connection = liveWorkerConnection(input.machineId, ctx);
      const id = newId(ID_PREFIXES.mcpSession);
      db.insert(mcpSession)
        .values({
          id,
          processId: process.id,
          projectId: process.projectId,
          machineId: process.machineId,
          registrationId: process.registrationId,
          registrationRevision: process.registrationRevision,
          transport: process.transport,
          configHash: process.configHash,
          workerIncarnationId: process.workerIncarnationId,
          runId: ctx.runId,
          holderInstanceId: ctx.instanceId,
          authorizationGeneration: input.authorizationGeneration,
          grantId: ctx.grantId,
          chatId: ctx.chatId,
          openRequestId: input.requestId,
          openHash: hash,
          state: "connecting",
          createdAt: ctx.now.getTime(),
          clientHighWater: 0,
          workerAckClientSeq: 0,
          serverHighWater: 0,
          hostAckServerSeq: 0,
          workerStateRevision: 0,
          workerConnectionGeneration: connection.generation,
          serverBootId: ctx.bootId,
          workerAttemptId: connection.attemptId,
        })
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "info",
          event: "mcp.session_opened",
          requestId: ctx.requestId,
          projectId: input.projectId,
          chatId: ctx.chatId,
          instanceId: ctx.instanceId,
          runId: ctx.runId,
          message: "MCP session 已登记为 connecting",
        })
        .run();
      return mcpSessionOpenOutputSchema.parse({ session: toSession(sessionRow(id)) });
    })
    .immediate();
}

/** 第一段：校验并落盘上行帧、推进两端游标；返回此刻可下发的内容。 */
function exchangeApply(raw: unknown, ctx: AgentRemoteContext) {
  const input = mcpSessionExchangeInputSchema.parse(raw);
  requireRelay(input, ctx);
  const row = boundSession(input, ctx);
  if (terminal(row))
    // 已终结的 session 不再受理新帧，也绝不改投别的 session。
    return {
      row,
      input,
      frames: [] as ServerInboundFrame[],
      hasMore: false,
      ended: true,
    };
  if (input.ackServerSeq > row.serverHighWater) throw new McpRelayError("remote_request_conflict");
  // ack 回退不是冲突：幂等重放只推进已确认水位。
  if (input.ackServerSeq > row.hostAckServerSeq) {
    db.update(mcpFrame)
      .set({ state: "acked", terminalAt: ctx.now.getTime() })
      .where(
        and(
          eq(mcpFrame.sessionId, row.id),
          eq(mcpFrame.direction, "server_to_client"),
          eq(mcpFrame.state, "sent"),
        ),
      )
      .run();
  }
  for (const seq of input.cancelClientSeqs) {
    if (seq > row.clientHighWater) throw new McpRelayError("remote_request_conflict");
    db.update(mcpFrame)
      .set({
        state: "dropped",
        terminalAt: ctx.now.getTime(),
        dispositionReason: "client_closed",
        payloadBase64: null,
      })
      .where(
        and(
          eq(mcpFrame.sessionId, row.id),
          eq(mcpFrame.direction, "client_to_server"),
          eq(mcpFrame.seq, seq),
          eq(mcpFrame.state, "queued"),
        ),
      )
      .run();
  }
  let clientHighWater = row.clientHighWater;
  const budget = queuedBudget(row.id);
  let unacked = budget.bytes;
  let queued = budget.count;
  for (const frame of input.frames as HostOutboundFrame[]) {
    if (frame.seq <= clientHighWater)
      // 同 seq 重放只有在 payload 相同时才算幂等确认；异 hash 必须显式冲突。
      throw new McpRelayError("remote_request_conflict");
    clientHighWater = frame.seq;
    const existing = db
      .select()
      .from(mcpFrame)
      .where(
        and(
          eq(mcpFrame.sessionId, row.id),
          eq(mcpFrame.direction, "client_to_server"),
          eq(mcpFrame.seq, frame.seq),
        ),
      )
      .get();
    if (existing) {
      if (existing.payloadHash !== frame.payloadHash)
        throw new McpRelayError("remote_request_conflict");
      continue;
    }
    queued += 1;
    unacked += frame.payloadBytes;
    // 满时拒新入队，绝不截断帧、绝不伪造空 result。
    if (queued > MCP_MAX_QUEUED_FRAMES || unacked > MCP_MAX_UNACKED_BYTES)
      throw new McpRelayError("too_many_requests");
    db.insert(mcpFrame)
      .values({
        id: frame.frameId,
        sessionId: row.id,
        projectId: row.projectId,
        machineId: row.machineId,
        authorizationGeneration: row.authorizationGeneration,
        holderInstanceId: row.holderInstanceId,
        processId: row.processId,
        direction: "client_to_server",
        seq: frame.seq,
        payloadBase64: frame.payloadBase64,
        payloadBytes: frame.payloadBytes,
        payloadHash: frame.payloadHash,
        state: "queued",
        createdAt: ctx.now.getTime(),
        expiresAt: Math.max(frame.expiresAt, ctx.now.getTime() + 1),
      })
      .run();
  }
  const patch: Partial<typeof mcpSession.$inferInsert> = {};
  if (clientHighWater !== row.clientHighWater) patch.clientHighWater = clientHighWater;
  if (input.ackServerSeq > row.hostAckServerSeq) patch.hostAckServerSeq = input.ackServerSeq;
  if (input.protocolVersion !== null) {
    if (row.protocolVersion !== null && row.protocolVersion !== input.protocolVersion)
      throw new McpRelayError("remote_request_conflict");
    if (row.protocolVersion === null) patch.protocolVersion = input.protocolVersion;
  }
  const protocolVersion = row.protocolVersion ?? input.protocolVersion;
  // `confirmInitialized` 表示 Pi 原生 connect 成功，不是 tools/list 成功。
  if (
    row.state === "connecting" &&
    input.confirmInitialized &&
    row.attachedAt !== null &&
    protocolVersion
  )
    Object.assign(patch, { state: "connected", connectedAt: ctx.now.getTime() });
  if (Object.keys(patch).length > 0)
    db.update(mcpSession).set(patch).where(eq(mcpSession.id, row.id)).run();
  const current = Object.keys(patch).length > 0 ? sessionRow(row.id) : row;
  const frames = inboundFrames(current, MCP_MAX_INBOUND_FRAMES);
  const remaining = db
    .select()
    .from(mcpFrame)
    .where(
      and(
        eq(mcpFrame.sessionId, row.id),
        eq(mcpFrame.direction, "server_to_client"),
        inArray(mcpFrame.state, ["queued", "sent"]),
      ),
    )
    .all().length;
  return { row: current, input, frames, hasMore: remaining > frames.length, ended: false };
}

/** 第二段：hold 结束后只重读可下发帧，不再接受新输入。 */
function exchangeDrain(
  sessionId: string,
  context: { bootId: string; now: Date; requestId: string },
) {
  const row = sessionRow(sessionId);
  if (terminal(row))
    return { session: toSession(row), frames: [] as ServerInboundFrame[], hasMore: false };
  const frames = inboundFrames(row, MCP_MAX_INBOUND_FRAMES);
  const remaining = db
    .select()
    .from(mcpFrame)
    .where(
      and(
        eq(mcpFrame.sessionId, sessionId),
        eq(mcpFrame.direction, "server_to_client"),
        inArray(mcpFrame.state, ["queued", "sent"]),
      ),
    )
    .all().length;
  void context;
  return { session: toSession(row), frames, hasMore: remaining > frames.length };
}

/**
 * `mcp_session_exchange`：有界 hold 的那个 call。
 *
 * hold 的界是 `input.holdMs ≤ 2000`；`draining` 为真时不 hold，立即返回空并按既有
 * `retry-after` 语义让宿主退避（响应时间 < 100 ms，这是 design §6.1 的验收断言）。
 * 不做空闲轮询：一次 exchange 最多一次有界等待，等不到就返回空批让下一次调用继续。
 */
export async function mcpSessionExchange(raw: unknown, ctx: AgentRemoteContext) {
  const applied = sqlite.transaction(() => exchangeApply(raw, ctx)).immediate();
  if (applied.ended)
    return mcpSessionExchangeOutputSchema.parse({
      session: toSession(applied.row),
      acceptedClientSeq: applied.row.clientHighWater,
      frames: [],
      hasMore: false,
    });
  const { input } = applied;
  let drained = {
    session: toSession(applied.row),
    frames: applied.frames,
    hasMore: applied.hasMore,
  };
  const holdMs = draining() ? 0 : input.holdMs;
  if (drained.frames.length === 0 && holdMs > 0) {
    await wakeHold(applied.row.id, holdMs);
    drained = sqlite.transaction(() => exchangeDrain(applied.row.id, ctx)).immediate();
  }
  return mcpSessionExchangeOutputSchema.parse({
    session: drained.session,
    acceptedClientSeq: applied.row.clientHighWater,
    frames: drained.frames,
    hasMore: drained.hasMore,
  });
}

let holds = 0;
/** 实测用的 hold 计数，供验收读取「空转请求次数」。 */
export function mcpHoldCount(): number {
  return holds;
}

function wakeHold(sessionId: string, holdMs: number): Promise<void> {
  holds += 1;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      wake.off(sessionId, finish);
      resolve();
    };
    const timer = setTimeout(finish, holdMs);
    wake.on(sessionId, finish);
  });
}

/**
 * `mcp_session_close`：幂等。重复 close 不报错，因为 Pi 侧断开时机不可控；
 * 只做 detach —— 把 queued 的 c2s 帧标 `dropped(client_closed)`、保留已 sent 的帧，
 * **绝不**触达 Machine 上的 MCP server 进程。
 */
export function mcpSessionClose(raw: unknown, ctx: AgentRemoteContext) {
  const input: CloseInput = mcpSessionCloseInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      requireRelay(input, ctx);
      const row = boundSession(input, ctx);
      if (terminal(row)) return mcpSessionCloseOutputSchema.parse({ session: toSession(row) });
      db.update(mcpFrame)
        .set({
          state: "dropped",
          terminalAt: ctx.now.getTime(),
          dispositionReason: "client_closed",
          payloadBase64: null,
        })
        .where(
          and(
            eq(mcpFrame.sessionId, row.id),
            eq(mcpFrame.direction, "client_to_server"),
            eq(mcpFrame.state, "queued"),
          ),
        )
        .run();
      db.update(mcpSession)
        .set({ state: "closed", endedAt: ctx.now.getTime(), endReason: "client_closed" })
        .where(eq(mcpSession.id, row.id))
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "info",
          event: "mcp.session_closed",
          requestId: ctx.requestId,
          projectId: row.projectId,
          chatId: ctx.chatId,
          instanceId: ctx.instanceId,
          runId: ctx.runId,
          message: "MCP session 已 detach；Machine 上的 server 进程不受影响",
        })
        .run();
      return mcpSessionCloseOutputSchema.parse({ session: toSession(sessionRow(row.id)) });
    })
    .immediate();
}
