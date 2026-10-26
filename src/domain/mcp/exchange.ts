import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import {
  MCP_SESSION_END_REASONS,
  mcpServerProcessSchema,
  mcpServerRegistrationSchema,
  mcpSessionSchema,
  type McpSession,
  type ServerMcpItem,
  type SessionCursor,
} from "../../contracts/mcp";
import type { WorkerExchangeRemoteInput } from "../../contracts/worker";
import type { AuthenticatedWorkerContext } from "../../server/remote";
import { db, sqlite } from "../../db";
import {
  agentRun,
  diagnosticEvent,
  leaseAuthorization,
  machineLease,
  mcpFrame,
  mcpServerProcess,
  mcpServerRegistration,
  mcpSession,
  projectMachine,
  remoteToolGrant,
} from "../../db/schema";
import { mcpBound, mcpHash, mcpPayloadHash, mcpSameBound } from "./protocol";

export class McpExchangeError extends Error {
  readonly code = "remote_request_conflict" as const;
}
type SessionRow = typeof mcpSession.$inferSelect;
const fail = (message: string): never => {
  throw new McpExchangeError(message);
};
const active = (state: string) => state === "connecting" || state === "connected";
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function audit(ctx: AuthenticatedWorkerContext, projectId: string, event: string) {
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event,
      requestId: newId(ID_PREFIXES.request),
      projectId,
      message: event,
    })
    .run();
}
function terminal(
  row: SessionRow,
  state: "failed" | "closed",
  reason: NonNullable<McpSession["endReason"]>,
  ctx: AuthenticatedWorkerContext,
) {
  if (!active(row.state)) return;
  const now = ctx.now.getTime();
  db.update(mcpSession)
    .set({ state, endReason: reason, endedAt: now })
    .where(eq(mcpSession.id, row.id))
    .run();
  db.update(mcpFrame)
    .set({
      state: "dropped",
      payloadBase64: null,
      terminalAt: now,
      dispositionReason:
        reason === "authorization_revoked" || reason === "client_closed" || reason === "worker_lost"
          ? reason
          : "transport_error",
    })
    .where(and(eq(mcpFrame.sessionId, row.id), isNull(mcpFrame.terminalAt)))
    .run();
  audit(ctx, row.projectId, "mcp.session.ended");
}
function authorized(row: SessionRow, ctx: AuthenticatedWorkerContext): McpSession["endReason"] {
  const key = and(
    eq(machineLease.projectId, row.projectId),
    eq(machineLease.machineId, row.machineId),
  );
  const lease = db.select().from(machineLease).where(key).get();
  const auth = db
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, row.projectId),
        eq(leaseAuthorization.machineId, row.machineId),
        eq(leaseAuthorization.generation, row.authorizationGeneration),
      ),
    )
    .get();
  if (
    !lease ||
    lease.state !== "held" ||
    lease.generation !== row.authorizationGeneration ||
    lease.holderInstanceId !== row.holderInstanceId ||
    auth?.state !== "active"
  )
    return "authorization_revoked";
  const grant = db.select().from(remoteToolGrant).where(eq(remoteToolGrant.id, row.grantId)).get();
  if (!grant || grant.revokedAt || grant.expiresAt.getTime() <= ctx.now.getTime())
    return "grant_expired";
  const run = db.select().from(agentRun).where(eq(agentRun.id, row.runId)).get();
  if (!run || run.settledAt !== null) return "run_ended";
  const process = db
    .select()
    .from(mcpServerProcess)
    .where(eq(mcpServerProcess.id, row.processId))
    .get();
  if (!process || process.state !== "running") return "target_lost";
  return null;
}
function sessionFor(item: ReturnType<typeof mcpBound>, ctx: AuthenticatedWorkerContext) {
  const row = db.select().from(mcpSession).where(eq(mcpSession.id, item.sessionId)).get();
  if (
    !row ||
    row.machineId !== ctx.session.machineId ||
    !mcpSameBound(item, mcpBound(mcpSessionSchema.parse(row))) ||
    item.workerSession.generation !== ctx.session.generation ||
    item.workerSession.bootId !== ctx.session.bootId ||
    item.workerSession.attemptId !== ctx.session.attemptId
  )
    return fail("MCP session identity mismatch");
  return row;
}

function reconciliation(rows: SessionRow[], ctx: AuthenticatedWorkerContext) {
  const retained = rows.filter(
    (row) => ctx.mode === "normal" && active(row.state) && !authorized(row, ctx),
  );
  const ids = new Set(retained.map((row) => row.id));
  return {
    machineId: ctx.session.machineId,
    workerSession: ctx.session,
    closedHash: mcpHash(
      rows
        .filter((row) => !ids.has(row.id))
        .map((row) => row.id)
        .sort(),
    ),
    sessions: retained
      .map((row) => mcpBound(mcpSessionSchema.parse(row)))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  };
}

/** Runs inside the authenticated exchange transaction; callers cannot admit a new lease here. */
export function applyMcpExchange(
  input: Pick<WorkerExchangeRemoteInput, "mcp" | "mcpCursors">,
  ctx: AuthenticatedWorkerContext,
  maxBytes = 655360,
): { mcp: ServerMcpItem[]; mcpCursors: SessionCursor[]; wakeSessions: Map<string, string> } {
  return sqlite.transaction(() => {
    const wakeSessions = new Map<string, string>();
    const output: { mcp: ServerMcpItem[]; mcpCursors: SessionCursor[] } = {
      mcp: [],
      mcpCursors: [],
    };
    let controls = 0,
      frames = 0;
    const emit = (item: ServerMcpItem) => {
      const cost = bytes(item);
      if (
        output.mcp.length >= 64 ||
        bytes(output) + cost + 8192 > maxBytes ||
        (item.type === "frame" ? frames + cost > 524288 : controls + cost > 65536)
      )
        return false;
      output.mcp.push(item);
      if (item.type === "frame") frames += cost;
      else controls += cost;
      return true;
    };
    if (ctx.mode === "normal") {
      for (const row of db
        .select()
        .from(mcpSession)
        .where(eq(mcpSession.machineId, ctx.session.machineId))
        .all()) {
        if (
          row.workerConnectionGeneration !== ctx.session.generation ||
          row.serverBootId !== ctx.session.bootId ||
          row.workerAttemptId !== ctx.session.attemptId
        )
          terminal(row, "closed", "worker_lost", ctx);
      }
    }
    for (const item of input.mcp) {
      if (item.type === "registration_fact") {
        if (ctx.mode !== "normal") fail("MCP registration during drain");
        const registration = mcpServerRegistrationSchema.parse(item.registration);
        if (
          registration.machineId !== ctx.session.machineId ||
          registration.configHash !== mcpHash(registration.configJson)
        )
          fail("MCP registration mismatch");
        const binding = db
          .select()
          .from(projectMachine)
          .where(
            and(
              eq(projectMachine.projectId, registration.projectId),
              eq(projectMachine.machineId, registration.machineId),
            ),
          )
          .get();
        if (!binding) fail("MCP Project binding missing");
        const old = db
          .select()
          .from(mcpServerRegistration)
          .where(
            and(
              eq(mcpServerRegistration.id, registration.id),
              eq(mcpServerRegistration.revision, registration.revision),
            ),
          )
          .get();
        if (old && mcpHash(old) !== mcpHash({ ...registration, retiredAt: old.retiredAt }))
          fail("MCP registration replay conflict");
        if (!old) {
          db.insert(mcpServerRegistration).values(registration).run();
          audit(ctx, registration.projectId, "mcp.registration.created");
        }
      } else if (item.type === "registration_retire") {
        const old = db
          .select()
          .from(mcpServerRegistration)
          .where(
            and(
              eq(mcpServerRegistration.id, item.registrationId),
              eq(mcpServerRegistration.revision, item.revision),
            ),
          )
          .get();
        if (!old || old.machineId !== ctx.session.machineId || item.configHash !== old.configHash)
          fail("MCP retirement mismatch");
        db.update(mcpServerRegistration)
          .set({ retiredAt: old!.retiredAt ?? ctx.now.getTime() })
          .where(
            and(
              eq(mcpServerRegistration.id, item.registrationId),
              eq(mcpServerRegistration.revision, item.revision),
            ),
          )
          .run();
        audit(ctx, old!.projectId, "mcp.registration.retired");
      } else if (item.type === "process_fact") {
        if (ctx.mode !== "normal") fail("MCP process during drain");
        const fact = mcpServerProcessSchema.parse(item.process);
        const { stateHash, ...value } = fact;
        if (
          fact.machineId !== ctx.session.machineId ||
          mcpHash(value) !== stateHash ||
          fact.lastObservedAt > ctx.now.getTime() + 30000
        )
          fail("MCP process fact mismatch");
        const registration = db
          .select()
          .from(mcpServerRegistration)
          .where(
            and(
              eq(mcpServerRegistration.id, fact.registrationId),
              eq(mcpServerRegistration.revision, fact.registrationRevision),
            ),
          )
          .get();
        if (
          !registration ||
          registration.projectId !== fact.projectId ||
          registration.machineId !== fact.machineId ||
          registration.configHash !== fact.configHash ||
          registration.transport !== fact.transport
        )
          fail("MCP process configuration mismatch");
        const old = db
          .select()
          .from(mcpServerProcess)
          .where(eq(mcpServerProcess.id, fact.id))
          .get();
        if (old) {
          const identity = (p: typeof fact | typeof old) => [
            p.id,
            p.projectId,
            p.machineId,
            p.registrationId,
            p.registrationRevision,
            p.transport,
            p.configHash,
            p.workerIncarnationId,
            p.launchNonce,
            p.createdAt,
          ];
          if (mcpHash(identity(old)) !== mcpHash(identity(fact)))
            fail("MCP process identity changed");
          if (
            fact.stateRevision < old.stateRevision ||
            (fact.stateRevision === old.stateRevision && fact.stateHash !== old.stateHash)
          )
            fail("MCP process revision conflict");
          if (fact.stateRevision > old.stateRevision) {
            if (
              ["exited", "failed", "lost"].includes(old.state) ||
              (old.state === "stopping" && ["starting", "running"].includes(fact.state)) ||
              (old.state === "running" && fact.state === "starting")
            )
              fail("MCP process terminal regression");
            db.update(mcpServerProcess).set(fact).where(eq(mcpServerProcess.id, fact.id)).run();
            audit(ctx, fact.projectId, "mcp.process.changed");
          }
        } else {
          db.insert(mcpServerProcess).values(fact).run();
          audit(ctx, fact.projectId, "mcp.process.created");
        }
        if (["exited", "failed", "lost"].includes(fact.state))
          for (const row of db
            .select()
            .from(mcpSession)
            .where(eq(mcpSession.processId, fact.id))
            .all())
            terminal(row, "failed", "target_lost", ctx);
      } else if (item.type === "session_reconcile_ack") {
        if (
          item.machineId !== ctx.session.machineId ||
          mcpHash(item.workerSession) !== mcpHash(ctx.session)
        )
          fail("MCP reconciliation identity mismatch");
        const retained: SessionRow[] = db
          .select()
          .from(mcpSession)
          .where(
            and(
              eq(mcpSession.machineId, ctx.session.machineId),
              eq(mcpSession.workerConnectionGeneration, ctx.session.generation),
              eq(mcpSession.serverBootId, ctx.session.bootId),
              eq(mcpSession.workerAttemptId, ctx.session.attemptId),
            ),
          )
          .all();
        for (const bound of item.sessions) sessionFor(bound, ctx);
        const expected = reconciliation(retained, ctx);
        if (
          item.closedHash !== expected.closedHash ||
          mcpHash(expected.sessions) !==
            mcpHash([...item.sessions].sort((a, b) => a.sessionId.localeCompare(b.sessionId)))
        )
          continue;
        for (const row of retained) {
          if (active(row.state) || row.workerDetachedAt !== null) continue;
          db.update(mcpSession)
            .set({ workerDetachedAt: ctx.now.getTime() })
            .where(eq(mcpSession.id, row.id))
            .run();
          audit(ctx, row.projectId, "mcp.session.detached");
        }
      } else if (item.type === "session_fact") {
        const row = sessionFor(item, ctx);
        const { stateHash, ...value } = item;
        if (mcpHash(value) !== stateHash) fail("MCP session state hash mismatch");
        if (
          item.stateRevision < row.workerStateRevision ||
          (item.stateRevision === row.workerStateRevision && stateHash !== row.workerStateHash)
        )
          fail("MCP session revision conflict");
        if (item.stateRevision > row.workerStateRevision) {
          const now = ctx.now.getTime();
          if (active(row.state)) {
            if (item.state === "attached") {
              db.update(mcpSession)
                .set({
                  attachedAt: row.attachedAt ?? now,
                  ...(row.attachedAt !== null && row.protocolVersion !== null
                    ? { state: "connected" as const, connectedAt: row.connectedAt ?? now }
                    : {}),
                  workerStateRevision: item.stateRevision,
                  workerStateHash: stateHash,
                })
                .where(eq(mcpSession.id, row.id))
                .run();
            } else {
              const reason =
                MCP_SESSION_END_REASONS.find((reason) => reason === item.reason) ??
                (item.state === "failed" ? "transport_error" : "client_closed");
              terminal(row, item.state === "failed" ? "failed" : "closed", reason, ctx);
              db.update(mcpSession)
                .set({
                  workerStateRevision: item.stateRevision,
                  workerStateHash: stateHash,
                  workerDetachedAt: now,
                })
                .where(eq(mcpSession.id, row.id))
                .run();
            }
          } else
            db.update(mcpSession)
              .set({
                workerStateRevision: item.stateRevision,
                workerStateHash: stateHash,
                workerDetachedAt: item.state === "attached" ? row.workerDetachedAt : now,
              })
              .where(eq(mcpSession.id, row.id))
              .run();
          audit(ctx, row.projectId, "mcp.session.observed");
        }
      } else if (item.type === "frame") {
        const row = sessionFor(item, ctx);
        if (!active(row.state) || authorized(row, ctx)) fail("MCP frame authorization rejected");
        const payload = Buffer.from(item.payloadBase64, "base64");
        if (
          payload.length !== item.payloadBytes ||
          mcpPayloadHash(payload) !== item.payloadHash ||
          item.expiresAt <= ctx.now.getTime()
        )
          fail("MCP frame payload or expiry mismatch");
        const old = db
          .select()
          .from(mcpFrame)
          .where(
            and(
              eq(mcpFrame.sessionId, row.id),
              eq(mcpFrame.direction, "server_to_client"),
              eq(mcpFrame.seq, item.seq),
            ),
          )
          .get();
        if (old) {
          if (
            old.id !== item.frameId ||
            old.payloadHash !== item.payloadHash ||
            old.payloadBytes !== item.payloadBytes
          )
            fail("MCP frame replay conflict");
          continue;
        }
        if (item.seq !== row.serverHighWater + 1) fail("MCP server frame gap");
        const pending: (typeof mcpFrame.$inferSelect)[] = db
          .select()
          .from(mcpFrame)
          .where(and(eq(mcpFrame.sessionId, row.id), isNull(mcpFrame.terminalAt)))
          .all();
        if (
          pending.length >= 64 ||
          pending.reduce((sum, f) => sum + f.payloadBytes, item.payloadBytes) > 1048576
        ) {
          terminal(row, "failed", "overflow", ctx);
          continue;
        }
        db.insert(mcpFrame)
          .values({
            id: item.frameId,
            sessionId: row.id,
            projectId: row.projectId,
            machineId: row.machineId,
            authorizationGeneration: row.authorizationGeneration,
            holderInstanceId: row.holderInstanceId,
            processId: row.processId,
            direction: "server_to_client",
            seq: item.seq,
            payloadBase64: item.payloadBase64,
            payloadBytes: item.payloadBytes,
            payloadHash: item.payloadHash,
            state: "queued",
            createdAt: ctx.now.getTime(),
            expiresAt: item.expiresAt,
            sentAt: null,
            terminalAt: null,
            dispositionReason: null,
          })
          .run();
        db.update(mcpSession)
          .set({ serverHighWater: item.seq })
          .where(eq(mcpSession.id, row.id))
          .run();
        wakeSessions.set(row.id, item.frameId);
        audit(ctx, row.projectId, "mcp.frame.received");
      } else if (item.type === "session_fence_ack") {
        if (
          item.workerSession.generation !== ctx.session.generation ||
          item.workerSession.bootId !== ctx.session.bootId ||
          item.workerSession.attemptId !== ctx.session.attemptId ||
          item.machineId !== ctx.session.machineId
        )
          fail("MCP fence identity mismatch");
        for (const target of item.sessions) {
          const row = db.select().from(mcpSession).where(eq(mcpSession.id, target.sessionId)).get();
          if (
            !row ||
            row.processId !== target.processId ||
            row.machineId !== item.machineId ||
            row.workerConnectionGeneration !== ctx.session.generation ||
            row.serverBootId !== ctx.session.bootId ||
            row.workerAttemptId !== ctx.session.attemptId ||
            row.projectId !== item.projectId ||
            row.authorizationGeneration !== item.authorizationGeneration ||
            row.holderInstanceId !== item.holderInstanceId ||
            row.fenceMutationId !== item.mutationId
          )
            fail("MCP fence target mismatch");
          terminal(row!, "closed", "authorization_revoked", ctx);
          db.update(mcpSession)
            .set({ workerDetachedAt: ctx.now.getTime() })
            .where(eq(mcpSession.id, target.sessionId))
            .run();
          audit(ctx, row!.projectId, "mcp.session.fenced");
        }
      }
    }
    for (const cursor of input.mcpCursors) {
      const row = sessionFor(cursor, ctx);
      if (
        cursor.clientAcceptedThrough > row.clientHighWater ||
        cursor.serverAcceptedThrough > row.serverHighWater
      )
        fail("MCP cursor exceeds high water");
      if (cursor.clientAcceptedThrough > row.workerAckClientSeq) {
        const pending: (typeof mcpFrame.$inferSelect)[] = db
          .select()
          .from(mcpFrame)
          .where(
            and(
              eq(mcpFrame.sessionId, row.id),
              eq(mcpFrame.direction, "client_to_server"),
              lte(mcpFrame.seq, cursor.clientAcceptedThrough),
              isNull(mcpFrame.terminalAt),
            ),
          )
          .all();
        if (pending.some((f) => f.sentAt === null)) fail("MCP acknowledgement before dispatch");
        db.update(mcpFrame)
          .set({ state: "acked", payloadBase64: null, terminalAt: ctx.now.getTime() })
          .where(
            and(
              eq(mcpFrame.sessionId, row.id),
              eq(mcpFrame.direction, "client_to_server"),
              lte(mcpFrame.seq, cursor.clientAcceptedThrough),
              isNull(mcpFrame.terminalAt),
            ),
          )
          .run();
        db.update(mcpSession)
          .set({ workerAckClientSeq: cursor.clientAcceptedThrough })
          .where(eq(mcpSession.id, row.id))
          .run();
        audit(ctx, row.projectId, "mcp.frames.acknowledged");
      }
    }
    for (const frame of db
      .select()
      .from(mcpFrame)
      .where(
        and(
          eq(mcpFrame.machineId, ctx.session.machineId),
          lte(mcpFrame.expiresAt, ctx.now.getTime()),
          isNull(mcpFrame.terminalAt),
        ),
      )
      .all()) {
      db.update(mcpFrame)
        .set({
          state: "dropped",
          payloadBase64: null,
          terminalAt: ctx.now.getTime(),
          dispositionReason: "expired",
        })
        .where(eq(mcpFrame.id, frame.id))
        .run();
      const row = db.select().from(mcpSession).where(eq(mcpSession.id, frame.sessionId)).get()!;
      terminal(row, "failed", "timeout", ctx);
    }
    const rows: SessionRow[] = db
      .select()
      .from(mcpSession)
      .where(
        and(
          eq(mcpSession.machineId, ctx.session.machineId),
          eq(mcpSession.workerConnectionGeneration, ctx.session.generation),
          eq(mcpSession.serverBootId, ctx.session.bootId),
          eq(mcpSession.workerAttemptId, ctx.session.attemptId),
        ),
      )
      .orderBy(asc(mcpSession.createdAt))
      .all()
      .map((row: SessionRow) => {
        if (!active(row.state)) return row;
        const reason = authorized(row, ctx);
        if (reason || ctx.mode === "drain") {
          terminal(
            row,
            reason === "target_lost" ? "failed" : "closed",
            reason ?? "worker_lost",
            ctx,
          );
          return db.select().from(mcpSession).where(eq(mcpSession.id, row.id)).get()!;
        }
        return row;
      });
    const retained = rows.filter((row) => active(row.state));
    // This authoritative retry is independent of all acknowledgements and terminal history.
    const reconciled = emit({ type: "session_reconcile", ...reconciliation(rows, ctx) });
    const deferredAttach = new Set<string>();
    for (const row of retained) {
      if (
        row.attachedAt === null &&
        (!reconciled ||
          !emit({
            type: "session_attach",
            ...mcpBound(mcpSessionSchema.parse(row)),
            session: mcpSessionSchema.parse(row),
            configHash: row.configHash,
          }))
      )
        deferredAttach.add(row.id);
    }
    for (const row of [...retained, ...rows.filter((row) => !active(row.state))]) {
      const bound = mcpBound(mcpSessionSchema.parse(row));
      const cursor = {
        ...bound,
        clientAcceptedThrough: row.workerAckClientSeq,
        serverAcceptedThrough: row.serverHighWater,
      };
      if (output.mcpCursors.length < 8 && bytes(output) + bytes(cursor) + 1 <= maxBytes)
        output.mcpCursors.push(cursor);
      if (!active(row.state)) {
        if (row.workerDetachedAt === null && row.fenceMutationId !== null) {
          emit({
            type: "session_fence",
            projectId: row.projectId,
            machineId: row.machineId,
            authorizationGeneration: row.authorizationGeneration,
            holderInstanceId: row.holderInstanceId,
            workerSession: bound.workerSession,
            mutationId: row.fenceMutationId,
            sessions: [{ sessionId: row.id, processId: row.processId }],
          });
        }
        continue;
      }
      if (ctx.mode !== "normal" || deferredAttach.has(row.id)) continue;
      if (
        row.protocolVersion !== null &&
        row.connectedAt === null &&
        !emit({ type: "session_protocol", ...bound, protocolVersion: row.protocolVersion })
      )
        continue;
      for (const frame of db
        .select()
        .from(mcpFrame)
        .where(
          and(
            eq(mcpFrame.sessionId, row.id),
            eq(mcpFrame.direction, "client_to_server"),
            gt(mcpFrame.seq, row.workerAckClientSeq),
          ),
        )
        .orderBy(asc(mcpFrame.seq))
        .all()) {
        if (frame.payloadBase64 === null) {
          if (
            !emit({
              type: "cancel_frames",
              ...bound,
              tombstones: [
                { clientSeq: frame.seq, frameId: frame.id, payloadHash: frame.payloadHash },
              ],
            })
          )
            break;
          continue;
        }
        if (
          !emit({
            type: "frame",
            direction: "client_to_server",
            ...bound,
            frameId: frame.id,
            seq: frame.seq,
            payloadBase64: frame.payloadBase64!,
            payloadBytes: frame.payloadBytes,
            payloadHash: frame.payloadHash,
            expiresAt: frame.expiresAt,
          })
        )
          break;
        if (frame.sentAt === null) {
          db.update(mcpFrame)
            .set({ state: "sent", sentAt: ctx.now.getTime() })
            .where(eq(mcpFrame.id, frame.id))
            .run();
          audit(ctx, row.projectId, "mcp.frame.dispatched");
        }
      }
    }
    return { ...output, wakeSessions };
  })();
}
