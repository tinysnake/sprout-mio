import { createHash } from "node:crypto";
import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import {
  forceReclaimLeaseInputSchema,
  leaseClaimInputSchema,
  leaseEscrowCancelInputSchema,
  leaseEscrowInputSchema,
  leaseMutationInputSchema,
  leaseReadInputSchema,
} from "../contracts/lease";
import type {
  ForceReclaimLeaseInput,
  LeaseClaimInput,
  LeaseEscrowCancelInput,
  LeaseEscrowInput,
  LeaseEscrowResult,
  LeaseEscrowView,
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
  chatEffectiveMember,
  projectMember,
  diagnosticEvent,
  leaseAuthorization,
  leaseEscrow,
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
import { readChatEffectiveMembers } from "../domain/channel";
import { leaseTimeoutFacts, projectLeaseTimeouts } from "../domain/lease-timeout";
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
export const escrowWhere = (key: LeaseKey) =>
  and(eq(leaseEscrow.projectId, key.projectId), eq(leaseEscrow.machineId, key.machineId));
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
  // 执行读只看执行连续性：任何非 active 关系（detaching/removed/缺行）都是
  // lease_not_holder；membership_removed 留给 request/cancel 等操作路径。
  if (latestMembership(execution)?.state !== "active") throw new LeaseError("lease_not_holder");
  const authority = authorityNow(execution);
  if (
    !authority ||
    authority.state === "free" ||
    // 挂靠中的发起者不再有操作权，连执行的读连续性也一并交出。
    authority.state === "escrowed" ||
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
  return {
    ...row,
    changedAt: row.changedAt.toISOString(),
    pendingMutationId: pending?.id ?? null,
    escrow: liveLeaseEscrow(row),
  };
}
export function leaseEscrowView(
  row: typeof leaseEscrow.$inferSelect,
  now: Date = new Date(),
): LeaseEscrowView {
  return {
    projectId: row.projectId,
    machineId: row.machineId,
    escrowId: row.id,
    state: row.state,
    chatId: row.chatId,
    targetAgentProfileId: row.targetAgentProfileId,
    escrowedByInstanceId: row.escrowedByInstanceId,
    escrowedAt: row.escrowedAt.toISOString(),
    escrowGeneration: row.escrowGeneration,
    claimedByInstanceId: row.claimedByInstanceId,
    claimedAt: row.claimedAt?.toISOString() ?? null,
    claimedGeneration: row.claimedGeneration,
    // I-P8b：超时只作为只读事实随挂靠给出，不参与任何占用/权限判定（T6）。
    timeout: leaseTimeoutFacts(row, projectLeaseTimeouts(row.projectId), now),
  };
}
function liveEscrowRow(key: LeaseKey) {
  return db
    .select()
    .from(leaseEscrow)
    .where(and(escrowWhere(key), eq(leaseEscrow.state, "escrowed")))
    .get();
}
function escrowRowById(key: LeaseKey, escrowId: string) {
  return db
    .select()
    .from(leaseEscrow)
    .where(and(escrowWhere(key), eq(leaseEscrow.id, escrowId)))
    .get();
}
/**
 * 租约视图里的挂靠事实只看「当前授权就是挂靠态」的那一行；已经领取/撤销/被收回的行
 * 不进入租约视图，避免把历史挂靠当成现在还在挂靠。
 */
export function liveLeaseEscrow(row: {
  projectId: string;
  machineId: string;
}): LeaseEscrowView | null {
  const authority = authorityNow(row);
  if (!authority || authority.state !== "escrowed" || !authority.holderInstanceId) return null;
  const escrowRow = liveEscrowRow(row);
  if (!escrowRow || escrowRow.escrowedByInstanceId !== authority.holderInstanceId) return null;
  return leaseEscrowView(escrowRow);
}
/** 结束活跃挂靠：领取会把行写成 claimed，收回/成员移除等一律写 superseded。 */
function closeLiveEscrow(key: LeaseKey, now: Date) {
  const row = liveEscrowRow(key);
  if (!row) return;
  db.update(leaseEscrow)
    .set({ state: "superseded", closedAt: now })
    .where(eq(leaseEscrow.id, row.id))
    .run();
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
  // 只有「自己释放、什么都没撤」才不落库：prod run_16d68a18 收到的
  // 「租约已释放。…受影响的执行：无」是自我通知，对模型没有新信息。
  // 交接（handoff）即使没有在途执行也要告诉旧 holder 它已失权，不能一并吞掉。
  if (mutation.action === "release" && mutation.actorKind === "agent" && executions.length === 0) {
    return;
  }
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
/**
 * pending handoff 的目标必须在确认时仍然可接管：目标分身还在本 Project、它的 Chat 没归档，
 * 它背后仍是当前 Project 成员与 Chat 有效成员。强制移除会同时抹掉后两项，所以确认门必须重查。
 */
function handoffTargetOperable(key: LeaseKey, targetInstanceId: string | null): boolean {
  if (!targetInstanceId) return false;
  const target = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.id, targetInstanceId))
    .get();
  if (!target || target.projectId !== key.projectId) return false;
  if (
    !db
      .select()
      .from(chat)
      .where(
        and(eq(chat.id, target.chatId), eq(chat.projectId, key.projectId), isNull(chat.archivedAt)),
      )
      .get()
  )
    return false;
  if (
    !db
      .select()
      .from(projectMember)
      .where(
        and(
          eq(projectMember.projectId, key.projectId),
          eq(projectMember.agentProfileId, target.agentProfileId),
        ),
      )
      .get()
  )
    return false;
  return Boolean(
    db
      .select()
      .from(chatEffectiveMember)
      .where(
        and(
          eq(chatEffectiveMember.projectId, key.projectId),
          eq(chatEffectiveMember.chatId, target.chatId),
          eq(chatEffectiveMember.memberKind, "agent"),
          eq(chatEffectiveMember.memberId, target.agentProfileId),
        ),
      )
      .get(),
  );
}

/** 同一个待决收据只记一次：worker 心跳会反复重试，诊断不能跟着刷屏。 */
function recordStrandedHandoff(
  key: LeaseKey,
  pending: typeof leaseMutation.$inferSelect,
  now: Date,
): void {
  const data = JSON.stringify({
    machineId: key.machineId,
    pendingMutationId: pending.id,
    targetInstanceId: pending.targetInstanceId,
  });
  const seen = db
    .select({ id: diagnosticEvent.id })
    .from(diagnosticEvent)
    .where(
      and(
        eq(diagnosticEvent.projectId, key.projectId),
        eq(diagnosticEvent.event, "lease.handoff_target_removed"),
        eq(diagnosticEvent.data, data),
      ),
    )
    .get();
  if (seen) return;
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: now,
      level: "warn",
      event: "lease.handoff_target_removed",
      requestId: pending.requestId,
      projectId: key.projectId,
      message: "待决交接的目标分身已不是本 Project 成员，拒绝落地；租约保持占用待处理",
      data,
    })
    .run();
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
  // 交接的确认门必须重查目标：它可能在 fencing 期间被移出 Project，此时落地就是把租约交给
  // 一个已移除的实例。拒绝落地、保留 fencing + pending，交给 Human 在租约页释放。
  if (pending.action === "handoff" && !handoffTargetOperable(key, pending.targetInstanceId)) {
    recordStrandedHandoff(key, pending, now);
    return;
  }
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
  // 挂靠中的租约被收回或释放时，挂靠行随之作废，但保留为历史。
  closeLiveEscrow(key, now);
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
  // 挂靠期间 machine_lease 仍是 held、holder 仍是发起者，所以这里必须显式拦住：
  // 发起者不能挂靠后再释放/交接/申请，Human 收回不受影响。
  if (input.action !== "reclaim" && liveEscrowRow(key))
    throw new LeaseError(input.action === "acquire" ? "lease_conflict" : "lease_not_holder");
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
        .where(
          and(
            eq(chat.id, target.chatId),
            eq(chat.projectId, input.projectId),
            isNull(chat.archivedAt),
          ),
        )
        .get()
    )
      throw new LeaseError("not_found");
    if (
      !db
        .select()
        .from(projectMember)
        .where(
          and(
            eq(projectMember.projectId, input.projectId),
            eq(projectMember.agentProfileId, target.agentProfileId),
          ),
        )
        .get() ||
      !db
        .select()
        .from(chatEffectiveMember)
        .where(
          and(
            eq(chatEffectiveMember.projectId, input.projectId),
            eq(chatEffectiveMember.chatId, target.chatId),
            eq(chatEffectiveMember.memberKind, "agent"),
            eq(chatEffectiveMember.memberId, target.agentProfileId),
          ),
        )
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
      closeLiveEscrow(key, ctx.now);
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

// ---------------------------------------------------------------------------
// I-P8a：挂靠（escrow）与领取（claim）
// ---------------------------------------------------------------------------
/**
 * 挂靠 = 把租约的操作权交给一个 Group（或 Group 内指定 Agent 的化身）里的分身领取。
 * 它不改变 Machine 上的任何进程状态：不动 remote_execution、不动 Worker，只换授权。
 */
function assertEscrowTarget(input: LeaseEscrowInput) {
  const target = db.select().from(chat).where(eq(chat.id, input.chatId)).get();
  if (!target || target.archivedAt) throw new LeaseError("not_found");
  if (target.projectId !== input.projectId) throw new LeaseError("lease_escrow_cross_project");
  if (target.kind === "dm") throw new LeaseError("lease_escrow_dm_unsupported");
  // Group / Public Channel 都可以；指定 Agent 时必须确实是该 Group 的成员。
  if (
    input.targetAgentProfileId &&
    !readChatEffectiveMembers(input.chatId, input.projectId).some(
      (member) => member.memberKind === "agent" && member.memberId === input.targetAgentProfileId,
    )
  )
    throw new LeaseError("not_found");
}
/** 领取范围：领取者必须就是挂靠目标 Group 里的那个分身（指定了 Agent profile 时还必须是它）。 */
function assertClaimInScope(escrowRow: typeof leaseEscrow.$inferSelect, ctx: AgentRemoteContext) {
  if (escrowRow.chatId !== ctx.chatId) throw new LeaseError("lease_claim_out_of_scope");
  const instance = db
    .select()
    .from(agentInstance)
    .where(eq(agentInstance.id, ctx.instanceId))
    .get();
  if (!instance) throw new LeaseError("not_found");
  if (
    escrowRow.targetAgentProfileId !== null &&
    instance.agentProfileId !== escrowRow.targetAgentProfileId
  )
    throw new LeaseError("lease_claim_out_of_scope");
  if (
    !readChatEffectiveMembers(escrowRow.chatId, ctx.projectId).some(
      (member) => member.memberKind === "agent" && member.memberId === instance.agentProfileId,
    )
  )
    throw new LeaseError("lease_claim_out_of_scope");
}
/** 三个命令共用的事实门：代次、fencing、代次上限。挂靠不碰执行行，所以不跑 expireExecutions。 */
function escrowCommandRow(
  input: { projectId: string; machineId: string; expectedGeneration: number },
  ctx: AgentRemoteContext,
) {
  const row = ensureLease(input, ctx.now);
  if (row.generation !== input.expectedGeneration) throw new LeaseError("lease_stale_generation");
  if (row.state === "fencing") throw new LeaseError("lease_fencing");
  if (row.generation >= Number.MAX_SAFE_INTEGER) throw new LeaseError("conflict");
  return row;
}
function escrowResult(escrowRow: typeof leaseEscrow.$inferSelect): LeaseEscrowResult {
  const row = db.select().from(machineLease).where(leaseWhere(escrowRow)).get()!;
  return { lease: leaseView(row), escrow: leaseEscrowView(escrowRow) };
}
function escrowLeaseInTransaction(input: LeaseEscrowInput, ctx: AgentRemoteContext) {
  assertAgentContext(input, ctx);
  const key = { projectId: input.projectId, machineId: input.machineId };
  const hash = payloadHash(input);
  const existing = db
    .select()
    .from(leaseEscrow)
    .where(
      and(
        eq(leaseEscrow.escrowedByInstanceId, ctx.instanceId),
        eq(leaseEscrow.escrowRequestId, input.requestId),
      ),
    )
    .get();
  if (existing) {
    if (existing.escrowPayloadHash !== hash) throw new LeaseError("remote_request_conflict");
    return escrowResult(existing);
  }
  const row = escrowCommandRow(input, ctx);
  if (liveEscrowRow(key)) throw new LeaseError("lease_conflict");
  if (row.state !== "held" || row.holderInstanceId !== ctx.instanceId)
    throw new LeaseError("lease_not_holder");
  assertEscrowTarget(input);
  const generation = row.generation + 1;
  const escrowId = newId(ID_PREFIXES.leaseEscrow);
  db.update(leaseAuthorization)
    .set({ state: "revoked", revokedAt: ctx.now })
    .where(authorizationWhere(key, row.generation))
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation,
      holderInstanceId: ctx.instanceId,
      state: "escrowed",
      reason: "escrow",
      issuedAt: ctx.now,
    })
    .run();
  db.update(machineLease)
    .set({ generation, state: "held", holderInstanceId: ctx.instanceId, changedAt: ctx.now })
    .where(leaseWhere(key))
    .run();
  db.insert(leaseEscrow)
    .values({
      id: escrowId,
      ...key,
      state: "escrowed",
      chatId: input.chatId,
      targetAgentProfileId: input.targetAgentProfileId ?? null,
      escrowedByInstanceId: ctx.instanceId,
      escrowedAt: ctx.now,
      escrowRequestId: input.requestId,
      escrowPayloadHash: hash,
      escrowGeneration: generation,
    })
    .run();
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event: "lease.escrowed",
      requestId: ctx.requestId,
      projectId: key.projectId,
      message: "租约已挂靠；Machine 仍被占用，发起者已交出操作权",
    })
    .run();
  return escrowResult(db.select().from(leaseEscrow).where(eq(leaseEscrow.id, escrowId)).get()!);
}
function claimLeaseInTransaction(input: LeaseClaimInput, ctx: AgentRemoteContext) {
  assertAgentContext(input, ctx);
  const key = { projectId: input.projectId, machineId: input.machineId };
  const hash = payloadHash(input);
  const existing = escrowRowById(key, input.escrowId);
  if (!existing) throw new LeaseError("not_found");
  if (
    existing.claimedByInstanceId === ctx.instanceId &&
    existing.claimRequestId === input.requestId
  ) {
    if (existing.claimPayloadHash !== hash) throw new LeaseError("remote_request_conflict");
    return escrowResult(existing);
  }
  // 已经领取、已撤销或被收回的挂靠不能再领；重复领取走这里。
  if (existing.state !== "escrowed") throw new LeaseError("lease_not_escrowed");
  const row = escrowCommandRow(input, ctx);
  if (row.state !== "held" || liveEscrowRow(key)?.id !== existing.id)
    throw new LeaseError("lease_not_escrowed");
  assertClaimInScope(existing, ctx);
  const generation = row.generation + 1;
  db.update(leaseAuthorization)
    .set({ state: "revoked", revokedAt: ctx.now })
    .where(authorizationWhere(key, row.generation))
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation,
      holderInstanceId: ctx.instanceId,
      state: "active",
      reason: "claim",
      issuedAt: ctx.now,
    })
    .run();
  db.update(machineLease)
    .set({ generation, state: "held", holderInstanceId: ctx.instanceId, changedAt: ctx.now })
    .where(leaseWhere(key))
    .run();
  db.update(leaseEscrow)
    .set({
      state: "claimed",
      claimedByInstanceId: ctx.instanceId,
      claimedAt: ctx.now,
      claimedGeneration: generation,
      claimRequestId: input.requestId,
      claimPayloadHash: hash,
      closedAt: ctx.now,
    })
    .where(eq(leaseEscrow.id, existing.id))
    .run();
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event: "lease.claimed",
      requestId: ctx.requestId,
      projectId: key.projectId,
      message: "租约已被领取；领取者成为新持有者，原有进程仍在原样运行",
    })
    .run();
  return escrowResult(db.select().from(leaseEscrow).where(eq(leaseEscrow.id, existing.id)).get()!);
}
function cancelLeaseEscrowInTransaction(input: LeaseEscrowCancelInput, ctx: AgentRemoteContext) {
  assertAgentContext(input, ctx);
  const key = { projectId: input.projectId, machineId: input.machineId };
  const existing = escrowRowById(key, input.escrowId);
  if (!existing) throw new LeaseError("not_found");
  if (existing.state === "claimed" || existing.state === "superseded")
    throw new LeaseError("lease_not_escrowed");
  if (existing.state === "cancelled") {
    // 重放：撤销已经生效，代次已经推进，不能再拿旧期望代次判定。
    if (existing.escrowedByInstanceId !== ctx.instanceId) throw new LeaseError("lease_not_holder");
    return escrowResult(existing);
  }
  const row = escrowCommandRow(input, ctx);
  if (
    row.state !== "held" ||
    row.holderInstanceId !== ctx.instanceId ||
    existing.escrowedByInstanceId !== ctx.instanceId ||
    liveEscrowRow(key)?.id !== existing.id
  )
    throw new LeaseError("lease_not_holder");
  const generation = row.generation + 1;
  db.update(leaseAuthorization)
    .set({ state: "revoked", revokedAt: ctx.now })
    .where(authorizationWhere(key, row.generation))
    .run();
  db.insert(leaseAuthorization)
    .values({
      ...key,
      generation,
      holderInstanceId: ctx.instanceId,
      state: "active",
      reason: "escrow_cancel",
      issuedAt: ctx.now,
    })
    .run();
  db.update(machineLease)
    .set({ generation, state: "held", holderInstanceId: ctx.instanceId, changedAt: ctx.now })
    .where(leaseWhere(key))
    .run();
  db.update(leaseEscrow)
    .set({ state: "cancelled", closedAt: ctx.now })
    .where(eq(leaseEscrow.id, existing.id))
    .run();
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level: "info",
      event: "lease.escrow_cancelled",
      requestId: ctx.requestId,
      projectId: key.projectId,
      message: "挂靠已撤销；租约回到发起者手里",
    })
    .run();
  return escrowResult(db.select().from(leaseEscrow).where(eq(leaseEscrow.id, existing.id)).get()!);
}
export function escrowLease(raw: LeaseEscrowInput, ctx: AgentRemoteContext): LeaseEscrowResult {
  const input = leaseEscrowInputSchema.parse(raw);
  return sqlite.inTransaction
    ? escrowLeaseInTransaction(input, ctx)
    : sqlite.transaction(() => escrowLeaseInTransaction(input, ctx)).immediate();
}
export function claimLease(raw: LeaseClaimInput, ctx: AgentRemoteContext): LeaseEscrowResult {
  const input = leaseClaimInputSchema.parse(raw);
  return sqlite.inTransaction
    ? claimLeaseInTransaction(input, ctx)
    : sqlite.transaction(() => claimLeaseInTransaction(input, ctx)).immediate();
}
export function cancelLeaseEscrow(
  raw: LeaseEscrowCancelInput,
  ctx: AgentRemoteContext,
): LeaseEscrowResult {
  const input = leaseEscrowCancelInputSchema.parse(raw);
  return sqlite.inTransaction
    ? cancelLeaseEscrowInTransaction(input, ctx)
    : sqlite.transaction(() => cancelLeaseEscrowInTransaction(input, ctx)).immediate();
}
