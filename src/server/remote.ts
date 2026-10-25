import { and, desc, eq, isNull } from "drizzle-orm";
import type { ShellFact } from "../contracts/machine";
import { ID_PREFIXES, newId } from "../contracts/ids";
import { executionReadInputSchema, executionSubmitInputSchema } from "../contracts/remote";
import type {
  ExecutionReadInput,
  ExecutionSubmitInput,
  ExecutionView,
  RemoteCommand,
  RemoteExchangeInput,
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
  executionResult,
  leaseMutation,
  machine,
  machineConnection,
  machineConnectionCounter,
  machineLease,
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
    deadlineAt: row.deadlineAt.toISOString(),
    terminalAt: row.terminalAt?.toISOString() ?? null,
    failureReason: row.failureReason,
    result: result?.payloadJson ?? null,
  };
}
function liveLease(input: ExecutionSubmitInput, ctx: AgentRemoteContext) {
  const lease = ensureLease(input, ctx.now);
  if (lease.generation !== input.authorizationGeneration)
    throw new RemoteError("lease_stale_generation");
  if (lease.state === "fencing") throw new RemoteError("lease_fencing");
  if (lease.state !== "held" || lease.holderInstanceId !== ctx.instanceId)
    throw new RemoteError("lease_not_holder");
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
              isNull(remoteExecution.terminalAt),
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
          deadlineAt: new Date(ctx.now.getTime() + 30000),
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
/** Called only inside the gateway's authenticated immediate transaction; never awaits. */
// MCP relay 的领域处理与落库由 r1-worker 交付；此处只保持 wire 形状自洽。
export function applyRemoteExchange(
  input: RemoteExchangeInput,
  ctx: AuthenticatedWorkerContext,
): RemoteWireOutput {
  const output: RemoteWireOutput = {
    authorizations: [],
    commands: [],
    fences: [],
    resultAcks: [],
    fenceAcks: [],
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
    output.resultAcks.push({ executionId: row.id, disposition });
  }
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
  if (ctx.mode === "normal") {
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
        deadlineAt: row.deadlineAt.toISOString(),
      };
      db.update(remoteExecution)
        .set({
          state: "dispatched",
          dispatchConnectionGeneration: ctx.session.generation,
          dispatchSeq: ctx.seq,
          dispatchedAt: ctx.now,
        })
        .where(eq(remoteExecution.id, row.id))
        .run();
      output.commands.push(command);
    }
  }
  return output;
}
