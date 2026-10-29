import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  forceReclaimLeaseInputSchema,
  leaseMutationInputSchema,
  leaseReadInputSchema,
} from "../contracts/lease";
import type {
  ForceReclaimLeaseInput,
  LeaseKey,
  LeaseMutationInput,
  LeaseMutationView,
  LeaseReadInput,
  LeaseView,
} from "../contracts/lease";
import type { AuthorityNow, ExecutionOrigin } from "../contracts/membership";
import type { AppErrorCode } from "../contracts/result";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  agentInstance,
  agentRun,
  chat,
  diagnosticEvent,
  leaseAuthorization,
  leaseMutation,
  machine,
  machineConnection,
  machineConnectionCounter,
  machineLease,
  project,
  projectMachine,
  remoteExecution,
  remoteToolGrant,
} from "../db/schema";
import type { MachineContext } from "../domain/machine";
import { assertMembershipOperable, latestMembership, onLeaseMutationCompleted } from "./membership";
import { hasNoticeCause, insertRevokeNotice } from "./notices";
import type { RevokedExecution } from "./notices";
import { membershipCauseId } from "../contracts/notice";

/**
 * Worker 重启后的恢复宽限：新连接代次接上后，先给归约事实留出这段时间。
 * 取值按 Worker 的退避上限（10s）加一次完整 exchange 往返留余量，不把重连抖动当丢失。
 * 只用 env 给私有验收缩短，产品默认值固定。
 */
export const WORKER_RECOVERY_GRACE_MS = (() => {
  const raw = process.env.SPROUT_WORKER_RECOVERY_GRACE_MS;
  const value = raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 30000;
})();

export type AgentRemoteContext = MachineContext & {
  projectId: string;
  chatId: string;
  instanceId: string;
  runId: string;
  grantId: string;
};
export class LeaseError extends Error {
  constructor(
    readonly code: AppErrorCode,
    message = code as string,
  ) {
    super(message);
    this.name = "LeaseError";
  }
}
export function payloadHash(value: unknown): string {
  const canonical = (v: unknown): string =>
    Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : v !== null && typeof v === "object"
        ? `{${Object.keys(v)
            .sort()
            .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
            .join(",")}}`
        : JSON.stringify(v);
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export const leaseWhere = (key: LeaseKey) =>
  and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId));
export const authorizationWhere = (key: LeaseKey, generation: number) =>
  and(
    eq(leaseAuthorization.projectId, key.projectId),
    eq(leaseAuthorization.machineId, key.machineId),
    eq(leaseAuthorization.generation, generation),
  );
export function assertRemoteScope(key: LeaseKey, ctx: MachineContext | AgentRemoteContext) {
  if (!ctx.userId) throw new LeaseError("unauthorized");
  if (
    ("projectId" in ctx && key.projectId !== ctx.projectId) ||
    !db
      .select()
      .from(project)
      .where(and(eq(project.id, key.projectId), eq(project.createdBy, ctx.userId)))
      .get() ||
    !db
      .select()
      .from(machine)
      .where(and(eq(machine.id, key.machineId), eq(machine.createdBy, ctx.userId)))
      .get() ||
    !db
      .select()
      .from(projectMachine)
      .where(
        and(
          eq(projectMachine.projectId, key.projectId),
          eq(projectMachine.machineId, key.machineId),
        ),
      )
      .get()
  )
    throw new LeaseError("not_found");
  if ("instanceId" in ctx) assertRunIdentity(key, ctx);
}
export const assertRemoteAccess = assertRemoteScope;

/** Read-only projection; never creates a lease or repairs authorization history. */
export function authorityNow(key: LeaseKey): AuthorityNow | undefined {
  const lease = db.select().from(machineLease).where(leaseWhere(key)).get();
  if (!lease) return;
  const authorization = db
    .select()
    .from(leaseAuthorization)
    .where(authorizationWhere(key, lease.generation))
    .get();
  if (!authorization || authorization.state === "revoked") return;
  return {
    generation: lease.generation,
    holderInstanceId: lease.holderInstanceId,
    state: authorization.state,
  };
}

export function assertActiveMembership(key: LeaseKey) {
  assertMembershipOperable(key.projectId, key.machineId);
}

export function assertExecutionContinuity(
  execution: ExecutionOrigin,
  ctx: MachineContext | AgentRemoteContext,
): AuthorityNow | undefined {
  assertRemoteScope(execution, ctx);
  if (!("instanceId" in ctx)) return;
  if (latestMembership(execution)?.state === "detaching") throw new LeaseError("lease_not_holder");
  assertActiveMembership(execution);
  const authority = authorityNow(execution);
  if (
    !authority ||
    authority.state === "free" ||
    authority.holderInstanceId !== ctx.instanceId ||
    execution.authorizationGeneration > authority.generation
  )
    throw new LeaseError("lease_not_holder");
  return authority;
}

export function assertExecutionWrite(
  key: LeaseKey,
  generation: number,
  ctx: MachineContext | AgentRemoteContext,
): AuthorityNow {
  assertRemoteScope(key, ctx);
  assertActiveMembership(key);
  const authority = authorityNow(key);
  if (authority && authority.generation !== generation)
    throw new LeaseError("lease_stale_generation");
  if (authority?.state === "draining") throw new LeaseError("lease_fencing");
  if (
    !authority ||
    authority.state !== "active" ||
    !authority.holderInstanceId ||
    ("instanceId" in ctx && authority.holderInstanceId !== ctx.instanceId)
  )
    throw new LeaseError("lease_not_holder");
  return authority;
}
export const assertCurrentWrite = assertExecutionWrite;

export function assertAgentContext(key: LeaseKey, ctx: AgentRemoteContext) {
  assertRemoteScope(key, ctx);
  assertActiveMembership(key);
}
function assertRunIdentity(key: LeaseKey, ctx: AgentRemoteContext) {
  const instance = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.id, ctx.instanceId))
    .get();
  const run = db.select().from(agentRun).where(eq(agentRun.id, ctx.runId)).get();
  const grant = db.select().from(remoteToolGrant).where(eq(remoteToolGrant.id, ctx.grantId)).get();
  if (
    !instance ||
    instance.projectId !== key.projectId ||
    instance.chatId !== ctx.chatId ||
    !run ||
    run.projectId !== key.projectId ||
    run.instanceId !== ctx.instanceId ||
    run.chatId !== ctx.chatId
  )
    throw new LeaseError("not_found");
  if (
    !grant ||
    grant.userId !== ctx.userId ||
    grant.projectId !== key.projectId ||
    grant.instanceId !== ctx.instanceId ||
    grant.runId !== ctx.runId ||
    grant.chatId !== ctx.chatId ||
    grant.revokedAt ||
    grant.expiresAt <= ctx.now
  )
    throw new LeaseError("remote_grant_invalid");
  if (run.status !== "running") throw new LeaseError("remote_run_inactive");
}
export function ensureLease(key: LeaseKey, now: Date) {
  let row = db.select().from(machineLease).where(leaseWhere(key)).get();
  if (!row) {
    db.insert(machineLease)
      .values({ ...key, generation: 0, state: "free", changedAt: now })
      .run();
    db.insert(leaseAuthorization)
      .values({ ...key, generation: 0, state: "free", reason: "initial", issuedAt: now })
      .run();
    row = db.select().from(machineLease).where(leaseWhere(key)).get()!;
  }
  return row;
}
/**
 * 到期判定分两种语义，不互相替代：
 * - 下发窗口到期且尚未下发：`timed_out` + `failure_reason='deadline'`，没有 runner 可以上报，必须收尾。
 * - 已下发却失联：保留可恢复的非终态位点（`dispatch_connection_generation` / `dispatch_seq` /
 *   `runner_token`），等带 token 的恢复事实单向归约；不先写 `unknown` 把自己封死。
 * - 运行上限到期：只记 `runtime_deadline_at`，归约交回恢复事实或 durable result。
 */
export function expireExecutions(key: LeaseKey, now: Date, bootId?: string) {
  for (const row of db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.projectId, key.projectId),
        eq(remoteExecution.machineId, key.machineId),
        isNull(remoteExecution.terminalAt),
      ),
    )
    .all()) {
    const dispatched = row.dispatchConnectionGeneration !== null;
    if (!dispatched) {
      if (row.dispatchDeadlineAt <= now)
        db.update(remoteExecution)
          .set({ state: "timed_out", failureReason: "deadline", terminalAt: now })
          .where(eq(remoteExecution.id, row.id))
          .run();
      continue;
    }
    const counter = db
      .select()
      .from(machineConnectionCounter)
      .where(eq(machineConnectionCounter.machineId, row.machineId))
      .get();
    const connection = db
      .select()
      .from(machineConnection)
      .where(
        and(
          eq(machineConnection.machineId, row.machineId),
          eq(machineConnection.generation, row.dispatchConnectionGeneration!),
        ),
      )
      .get();
    const lost =
      !connection ||
      connection.status !== "open" ||
      connection.generation !== counter?.highWater ||
      (bootId !== undefined && connection.bootId !== bootId) ||
      now.getTime() - connection.lastSeenAt.getTime() >= WORKER_STALE_AFTER_MS;
    // 连接丢失只影响新鲜度与租约，不产生终态：命令可能还在跑，结果也可能已经落盘，
    // 这两件事都只能由 Worker 的归约事实回答。把它写成 unknown 会把真实终态封在门外。
    if (!lost) continue;
    const successor = counter
      ? db
          .select()
          .from(machineConnection)
          .where(
            and(
              eq(machineConnection.machineId, row.machineId),
              eq(machineConnection.generation, counter.highWater),
            ),
          )
          .get()
      : undefined;
    if (row.state === "unknown") continue;
    // 宿主侧只有两个收尾出口，都要等恢复宽限走完：
    // (b) 更新代次已经接上，却从未对这条执行交过任何归约报告（Worker 报告过 running
    //     就是在看着它，不能替它收尾）；
    // (b') 派发会话已经正常关闭，且机器上始终没有更新的活连接——不会再有任何一代能报告，
    //     一直挂在 running 比带原因的 unknown 更假。
    const successorLive =
      successor !== undefined &&
      successor.status === "open" &&
      successor.generation > row.dispatchConnectionGeneration! &&
      (bootId === undefined || successor.bootId === bootId);
    const closedAt =
      connection?.status === "closed" ? (connection.closedAt ?? connection.lastSeenAt) : null;
    const abandoned =
      !successorLive &&
      closedAt !== null &&
      now.getTime() - closedAt.getTime() >= WORKER_RECOVERY_GRACE_MS &&
      (row.recoveryReportedAt === null || row.recoveryReportedAt.getTime() < closedAt.getTime());
    const superseded =
      successorLive &&
      now.getTime() - successor!.openedAt.getTime() >= WORKER_RECOVERY_GRACE_MS &&
      (row.recoveryReportedAt === null ||
        row.recoveryReportedAt.getTime() < successor!.openedAt.getTime());
    if (!abandoned && !superseded) continue;
    db.update(remoteExecution)
      .set({
        state: "unknown",
        failureReason: "worker_lost",
        recoveryReason: null,
        terminalAt: now,
      })
      .where(eq(remoteExecution.id, row.id))
      .run();
  }
}
// Internal idempotency namespace cannot collide with public req_* request IDs.
const forceRequestId = (mutationId: string) => `force-reclaim:${mutationId}`;
function mutationView(row: typeof leaseMutation.$inferSelect): LeaseMutationView {
  const forced = row.requestId.startsWith("force-reclaim:")
    ? row
    : db
        .select()
        .from(leaseMutation)
        .where(
          and(
            eq(leaseMutation.projectId, row.projectId),
            eq(leaseMutation.machineId, row.machineId),
            eq(leaseMutation.actorKind, "human"),
            eq(leaseMutation.requestId, forceRequestId(row.id)),
          ),
        )
        .get();
  return {
    mutationId: row.id,
    projectId: row.projectId,
    machineId: row.machineId,
    action: row.action,
    state: row.state,
    expectedGeneration: row.expectedGeneration,
    completedGeneration: row.completedGeneration,
    targetInstanceId: row.targetInstanceId,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    ...(forced
      ? {
          forcedReclaim: {
            mutationId: forced.id,
            supersededMutationId: forced.requestId.slice("force-reclaim:".length),
            forcedByUserId: forced.actorId,
            forcedAt: forced.completedAt!.toISOString(),
          },
        }
      : {}),
  };
}
function leaseView(row: typeof machineLease.$inferSelect): LeaseView {
  const pending = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, row.projectId),
        eq(leaseMutation.machineId, row.machineId),
        eq(leaseMutation.state, "pending"),
      ),
    )
    .get();
  return { ...row, changedAt: row.changedAt.toISOString(), pendingMutationId: pending?.id ?? null };
}
function affectedExecutions(key: LeaseKey, generation: number): RevokedExecution[] {
  return db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.projectId, key.projectId),
        eq(remoteExecution.machineId, key.machineId),
        lte(remoteExecution.authorizationGeneration, generation),
        or(
          isNull(remoteExecution.terminalAt),
          and(
            isNotNull(remoteExecution.dispatchConnectionGeneration),
            isNull(remoteExecution.drainedAt),
          ),
        ),
      ),
    )
    .all()
    .map((row: typeof remoteExecution.$inferSelect) => ({
      executionId: row.id,
      runId: row.runId,
      state: row.state,
    }));
}
function revokeNotice(
  mutation: typeof leaseMutation.$inferSelect,
  holderInstanceId: string | null,
  executions: RevokedExecution[],
  revocation: "pending" | "confirmed" | "unconfirmed",
  now: Date,
) {
  if (mutation.action === "acquire") return;
  const key = { projectId: mutation.projectId, machineId: mutation.machineId };
  const member = latestMembership(key);
  if (
    member?.removalMutationId === mutation.id ||
    (member &&
      hasNoticeCause(
        "machine_removed",
        membershipCauseId(key.projectId, key.machineId, member.epoch),
      ))
  )
    return;
  const kind =
    mutation.action === "handoff"
      ? "lease_handed_off"
      : mutation.action === "release"
        ? "lease_released"
        : "lease_reclaimed";
  if (hasNoticeCause(kind, mutation.id)) return;
  insertRevokeNotice(db, {
    key,
    kind,
    causeId: mutation.id,
    generation: mutation.expectedGeneration,
    holderInstanceId,
    executions,
    targetInstanceId: mutation.targetInstanceId,
    revocation,
    now,
  });
}
export function completeLeaseMutation(key: LeaseKey, now: Date, emitNotice = true) {
  const pending = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, key.projectId),
        eq(leaseMutation.machineId, key.machineId),
        eq(leaseMutation.state, "pending"),
      ),
    )
    .get();
  if (!pending) return;
  if (
    db
      .select()
      .from(remoteExecution)
      .where(
        and(
          eq(remoteExecution.projectId, key.projectId),
          eq(remoteExecution.machineId, key.machineId),
          lte(remoteExecution.authorizationGeneration, pending.expectedGeneration),
          isNull(remoteExecution.drainedAt),
        ),
      )
      .all()
      .some((row: typeof remoteExecution.$inferSelect) => row.dispatchConnectionGeneration !== null)
  )
    return;
  const old = ensureLease(key, now);
  const executions = affectedExecutions(key, old.generation);
  if (old.generation >= Number.MAX_SAFE_INTEGER) throw new LeaseError("conflict");
  const generation = old.generation + 1;
  const holderInstanceId =
    pending.action === "handoff"
      ? pending.targetInstanceId
      : pending.action === "acquire"
        ? pending.actorId
        : null;
  db.update(leaseAuthorization)
    .set({ state: "revoked", revokedAt: now })
    .where(authorizationWhere(key, old.generation))
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation,
      state: holderInstanceId ? "active" : "free",
      holderInstanceId,
      reason: pending.action,
      issuedAt: now,
    })
    .run();
  db.update(machineLease)
    .set({
      generation,
      state: holderInstanceId ? "held" : "free",
      holderInstanceId,
      changedAt: now,
    })
    .where(leaseWhere(key))
    .run();
  db.update(leaseMutation)
    .set({ state: "completed", completedGeneration: generation, completedAt: now })
    .where(eq(leaseMutation.id, pending.id))
    .run();
  const completed = db.select().from(leaseMutation).where(eq(leaseMutation.id, pending.id)).get()!;
  onLeaseMutationCompleted(db, completed);
  if (emitNotice) revokeNotice(completed, old.holderInstanceId, executions, "confirmed", now);
}
function mutate(
  raw: LeaseMutationInput,
  ctx: MachineContext | AgentRemoteContext,
): LeaseMutationView {
  return sqlite.inTransaction
    ? mutateLeaseInTransaction(raw, ctx)
    : sqlite.transaction(() => mutateLeaseInTransaction(raw, ctx)).immediate();
}
function mutateLeaseInTransaction(
  raw: LeaseMutationInput,
  ctx: MachineContext | AgentRemoteContext,
  membershipRemoval = false,
): LeaseMutationView {
  const input = leaseMutationInputSchema.parse(raw);
  if (input.action === "reclaim") {
    if ("instanceId" in ctx) throw new LeaseError("forbidden");
    assertRemoteAccess(input, ctx);
    assertActiveMembership(input);
  } else {
    if (!("instanceId" in ctx)) throw new LeaseError("forbidden");
    assertAgentContext(input, ctx);
  }
  const actorKind = input.action === "reclaim" ? "human" : "agent";
  const actorId = "instanceId" in ctx ? ctx.instanceId : ctx.userId;
  const hash = payloadHash(input);
  const existing = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.actorKind, actorKind),
        eq(leaseMutation.actorId, actorId),
        eq(leaseMutation.requestId, input.requestId),
      ),
    )
    .get();
  if (existing) {
    if (existing.payloadHash !== hash) throw new LeaseError("remote_request_conflict");
    return mutationView(existing);
  }
  const key = { projectId: input.projectId, machineId: input.machineId };
  const row = ensureLease(key, ctx.now);
  const executions = affectedExecutions(key, row.generation);
  expireExecutions(key, ctx.now, ctx.bootId);
  if (row.generation !== input.expectedGeneration) throw new LeaseError("lease_stale_generation");
  if (row.state === "fencing") throw new LeaseError("lease_fencing");
  if (row.generation >= Number.MAX_SAFE_INTEGER) throw new LeaseError("conflict");
  if (input.action === "acquire") {
    if (row.state === "held" && row.holderInstanceId !== actorId)
      throw new LeaseError("lease_conflict");
  } else if (
    row.state !== "held" ||
    (input.action !== "reclaim" && row.holderInstanceId !== actorId)
  )
    throw new LeaseError("lease_not_holder");
  if (input.action === "handoff") {
    const target = db
      .select()
      .from(agentInstance)
      .where(eq(agentInstance.id, input.targetInstanceId))
      .get();
    if (
      !target ||
      target.projectId !== input.projectId ||
      !db
        .select()
        .from(chat)
        .where(and(eq(chat.id, target.chatId), eq(chat.projectId, input.projectId)))
        .get()
    )
      throw new LeaseError("not_found");
    if (target.id === actorId) throw new LeaseError("conflict");
  }
  const id = newId(ID_PREFIXES.leaseMutation);
  const noop = input.action === "acquire" && row.state === "held";
  if (input.action === "acquire" && !noop) {
    const generation = row.generation + 1;
    db.update(leaseAuthorization)
      .set({ state: "revoked", revokedAt: ctx.now })
      .where(authorizationWhere(key, row.generation))
      .run();
    db.insert(leaseAuthorization)
      .values({
        ...key,
        generation,
        holderInstanceId: actorId,
        state: "active",
        reason: "acquire",
        issuedAt: ctx.now,
      })
      .run();
    db.update(machineLease)
      .set({ generation, state: "held", holderInstanceId: actorId, changedAt: ctx.now })
      .where(leaseWhere(key))
      .run();
  }
  const completed = input.action === "acquire";
  db.insert(leaseMutation)
    .values({
      id,
      ...key,
      actorKind,
      actorId,
      requestId: input.requestId,
      payloadHash: hash,
      action: input.action,
      expectedGeneration: row.generation,
      targetInstanceId: input.action === "handoff" ? input.targetInstanceId : null,
      state: completed ? "completed" : "pending",
      completedGeneration: completed ? row.generation + (noop ? 0 : 1) : null,
      createdAt: ctx.now,
      completedAt: completed ? ctx.now : null,
    })
    .run();
  if (!completed) {
    {
      db.update(machineLease)
        .set({ state: "fencing", changedAt: ctx.now })
        .where(leaseWhere(key))
        .run();
      db.update(leaseAuthorization)
        .set({ state: "draining" })
        .where(authorizationWhere(key, row.generation))
        .run();
      for (const execution of db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.projectId, key.projectId),
            eq(remoteExecution.machineId, key.machineId),
            lte(remoteExecution.authorizationGeneration, row.generation),
            isNull(remoteExecution.terminalAt),
          ),
        )
        .all()) {
        db.update(remoteExecution)
          .set(
            execution.state === "queued"
              ? {
                  state: "rejected",
                  failureReason: "authorization_revoked",
                  terminalAt: ctx.now,
                }
              : { state: "draining" },
          )
          .where(eq(remoteExecution.id, execution.id))
          .run();
      }
    }
    completeLeaseMutation(key, ctx.now, false);
    if (!membershipRemoval) {
      const mutation = db.select().from(leaseMutation).where(eq(leaseMutation.id, id)).get()!;
      revokeNotice(
        mutation,
        row.holderInstanceId,
        executions,
        mutation.state === "pending" ? "pending" : "confirmed",
        ctx.now,
      );
    }
  }
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event: "lease.mutated",
      requestId: ctx.requestId,
      projectId: input.projectId,
      message: "租约动作已记录",
    })
    .run();
  return mutationView(db.select().from(leaseMutation).where(eq(leaseMutation.id, id)).get()!);
}
export const acquireLease = (
  input: Extract<LeaseMutationInput, { action: "acquire" }>,
  ctx: AgentRemoteContext,
) => mutate(input, ctx);
export const releaseLease = (
  input: Extract<LeaseMutationInput, { action: "release" }>,
  ctx: AgentRemoteContext,
) => mutate(input, ctx);
export const handoffLease = (
  input: Extract<LeaseMutationInput, { action: "handoff" }>,
  ctx: AgentRemoteContext,
) => mutate(input, ctx);
export const reclaimLeaseInTransaction = (
  input: Extract<LeaseMutationInput, { action: "reclaim" }>,
  ctx: MachineContext,
) => mutateLeaseInTransaction(input, ctx, true);
export const reclaimLease = (
  input: Extract<LeaseMutationInput, { action: "reclaim" }>,
  ctx: MachineContext,
) => mutate(input, ctx);
/** Human override: completes the blocked receipt and records a distinct reclaim receipt.
 * The original requested action remains auditable; forcedReclaim identifies its override.
 * This path never asserts drain and never sends process or file operations to the Worker.
 */
export function forceReclaimLease(raw: ForceReclaimLeaseInput, ctx: MachineContext) {
  if ("instanceId" in ctx) throw new LeaseError("forbidden");
  const input = forceReclaimLeaseInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      const requestId = forceRequestId(input.mutationId);
      const hash = payloadHash(input);
      const existing = db
        .select()
        .from(leaseMutation)
        .where(
          and(
            eq(leaseMutation.actorKind, "human"),
            eq(leaseMutation.actorId, ctx.userId),
            eq(leaseMutation.requestId, requestId),
          ),
        )
        .get();
      if (existing) {
        if (existing.payloadHash !== hash) throw new LeaseError("remote_request_conflict");
        return mutationView(existing);
      }
      const key = { projectId: input.projectId, machineId: input.machineId };
      const row = ensureLease(key, ctx.now);
      if (row.generation !== input.expectedGeneration)
        throw new LeaseError("lease_stale_generation");
      const pending = db
        .select()
        .from(leaseMutation)
        .where(eq(leaseMutation.id, input.mutationId))
        .get();
      if (
        row.state !== "fencing" ||
        !pending ||
        pending.state !== "pending" ||
        pending.projectId !== key.projectId ||
        pending.machineId !== key.machineId ||
        pending.expectedGeneration !== row.generation
      )
        throw new LeaseError("conflict");
      if (row.generation >= Number.MAX_SAFE_INTEGER) throw new LeaseError("conflict");
      const executions = affectedExecutions(key, row.generation);
      // Dispatched but unacknowledged work is uncertain even if an earlier result said success.
      for (const execution of db
        .select()
        .from(remoteExecution)
        .where(
          and(
            eq(remoteExecution.projectId, key.projectId),
            eq(remoteExecution.machineId, key.machineId),
            lte(remoteExecution.authorizationGeneration, row.generation),
            isNull(remoteExecution.drainedAt),
          ),
        )
        .all()) {
        db.update(remoteExecution)
          .set(
            execution.dispatchConnectionGeneration !== null
              ? { state: "unknown", failureReason: "worker_lost", terminalAt: ctx.now }
              : { state: "rejected", failureReason: "authorization_revoked", terminalAt: ctx.now },
          )
          .where(eq(remoteExecution.id, execution.id))
          .run();
      }
      const generation = row.generation + 1;
      db.update(leaseAuthorization)
        .set({ state: "revoked", revokedAt: ctx.now })
        .where(authorizationWhere(key, row.generation))
        .run();
      db.insert(leaseAuthorization)
        .values({
          ...key,
          generation,
          state: "free",
          holderInstanceId: null,
          reason: "reclaim",
          issuedAt: ctx.now,
        })
        .run();
      db.update(machineLease)
        .set({ generation, state: "free", holderInstanceId: null, changedAt: ctx.now })
        .where(leaseWhere(key))
        .run();
      db.update(leaseMutation)
        .set({ state: "completed", completedGeneration: generation, completedAt: ctx.now })
        .where(eq(leaseMutation.id, pending.id))
        .run();
      const completed = db
        .select()
        .from(leaseMutation)
        .where(eq(leaseMutation.id, pending.id))
        .get()!;
      onLeaseMutationCompleted(db, completed);
      revokeNotice(completed, row.holderInstanceId, executions, "unconfirmed", ctx.now);
      const id = newId(ID_PREFIXES.leaseMutation);
      db.insert(leaseMutation)
        .values({
          id,
          ...key,
          actorKind: "human",
          actorId: ctx.userId,
          requestId,
          payloadHash: hash,
          action: "reclaim",
          expectedGeneration: row.generation,
          state: "completed",
          completedGeneration: generation,
          createdAt: ctx.now,
          completedAt: ctx.now,
        })
        .run();
      db.insert(diagnosticEvent)
        .values({
          id: newId(ID_PREFIXES.diagnostic),
          at: ctx.now,
          level: "warn",
          event: "lease.force_reclaimed",
          requestId: ctx.requestId,
          projectId: key.projectId,
          message: "Human 已强制收回；未确认排空，旧副作用可能继续发生",
        })
        .run();
      return mutationView(db.select().from(leaseMutation).where(eq(leaseMutation.id, id)).get()!);
    })
    .immediate();
}
export function getLease(raw: LeaseReadInput, ctx: MachineContext | AgentRemoteContext) {
  const input = leaseReadInputSchema.parse(raw);
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      if ("instanceId" in ctx) assertActiveMembership(input);
      const row = ensureLease(input, ctx.now);
      expireExecutions(input, ctx.now, ctx.bootId);
      const mutation = input.mutationId
        ? db
            .select()
            .from(leaseMutation)
            .where(
              and(
                eq(leaseMutation.id, input.mutationId),
                eq(leaseMutation.projectId, input.projectId),
                eq(leaseMutation.machineId, input.machineId),
              ),
            )
            .get()
        : null;
      if (input.mutationId && !mutation) throw new LeaseError("not_found");
      return { lease: leaseView(row), mutation: mutation ? mutationView(mutation) : null };
    })
    .immediate();
}
export function listProjectLeases(input: { projectId: string }, ctx: MachineContext): LeaseView[] {
  return sqlite
    .transaction(() => {
      if (!ctx.userId) throw new LeaseError("unauthorized");
      if (
        !db
          .select()
          .from(project)
          .where(and(eq(project.id, input.projectId), eq(project.createdBy, ctx.userId)))
          .get()
      )
        throw new LeaseError("not_found");
      return db
        .select()
        .from(projectMachine)
        .where(eq(projectMachine.projectId, input.projectId))
        .all()
        .map((key: typeof projectMachine.$inferSelect) => {
          assertRemoteAccess(key, ctx);
          expireExecutions(key, ctx.now, ctx.bootId);
          return leaseView(ensureLease(key, ctx.now));
        });
    })
    .immediate();
}
