import { and, asc, desc, eq } from "drizzle-orm";
import { ID_PREFIXES, newId } from "../contracts/ids";
import type { LeaseKey } from "../contracts/lease";
import {
  detachMachineInputSchema,
  pendingFactInputSchema,
  pendingFactViewSchema,
  membershipViewSchema,
  rejoinProjectMachineInputSchema,
} from "../contracts/membership";
import type {
  DetachInput,
  MembershipRevocation,
  MembershipView,
  PendingFactInput,
  PendingFactView,
  RejoinInput,
} from "../contracts/membership";
import { membershipCauseId } from "../contracts/notice";
import { WORKER_STALE_AFTER_MS } from "../contracts/worker";
import { db, sqlite } from "../db";
import {
  diagnosticEvent,
  directoryObservation,
  leaseAuthorization,
  leaseMutation,
  machineConnection,
  machineConnectionCounter,
  machineLease,
  projectMachine,
  projectMachineMembership,
  remoteExecution,
} from "../db/schema";
import type { MachineContext } from "../domain/machine";
import { assertRemoteAccess, LeaseError, payloadHash, reclaimLeaseInTransaction } from "./lease";
import { insertRevokeNotice, oldestUndeliveredNotice } from "./notices";

export type MembershipRow = typeof projectMachineMembership.$inferSelect;
export type MembershipTx = Pick<typeof db, "select" | "insert" | "update" | "delete">;
/** 完成钩子只需要收据里的事实，调用方可以直接传自己的 `lease_mutation` 行。 */
export type CompletedLeaseMutation = Pick<
  typeof leaseMutation.$inferSelect,
  | "id"
  | "projectId"
  | "machineId"
  | "action"
  | "state"
  | "expectedGeneration"
  | "completedGeneration"
  | "completedAt"
>;

const FORCE_RECEIPT_PREFIX = "force-reclaim:";
const MEMBERSHIP_MAX_EPOCH = Number.MAX_SAFE_INTEGER;

export const membershipWhere = (key: LeaseKey) =>
  and(
    eq(projectMachineMembership.projectId, key.projectId),
    eq(projectMachineMembership.machineId, key.machineId),
  );

/**
 * 目录观察是当前关系事实，不是历史：绑定 revision 或 membership 生命周期一变化，
 * 旧观测立即失效。观测表没有绑定 revision 列，因此以删除旧行表达“不再属于当前关系”；
 * 接收与读取仍分别核对 wire 绑定 revision 和最新 active。
 */
export function invalidateDirectoryObservations(tx: MembershipTx, key: LeaseKey) {
  tx.delete(directoryObservation)
    .where(
      and(
        eq(directoryObservation.projectId, key.projectId),
        eq(directoryObservation.machineId, key.machineId),
      ),
    )
    .run();
}

/** 最新一段加入生命周期。缺行返回 undefined，调用方一律当作不成立。 */
export function latestMembership(key: LeaseKey): MembershipRow | undefined {
  return db
    .select()
    .from(projectMachineMembership)
    .where(membershipWhere(key))
    .orderBy(desc(projectMachineMembership.epoch))
    .limit(1)
    .get();
}

/** 只有最新 active 才授权本 Project × Machine 的操作；缺行不是 active。 */
export function membershipActive(projectId: string, machineId: string): boolean {
  return latestMembership({ projectId, machineId })?.state === "active";
}

/**
 * 列表的批量读：一次查询取本 Project 每台 Machine 的最新 epoch，不逐行补查。
 * 结果包含 detaching/removed 的历史关系；活动判定仍要用 `membershipActive`。
 */
export function liveMembership(projectId: string): Map<string, MembershipRow> {
  const rows = db
    .select()
    .from(projectMachineMembership)
    .where(eq(projectMachineMembership.projectId, projectId))
    .orderBy(asc(projectMachineMembership.machineId), desc(projectMachineMembership.epoch))
    .all();
  const latest = new Map<string, MembershipRow>();
  for (const row of rows) if (!latest.has(row.machineId)) latest.set(row.machineId, row);
  return latest;
}

function workerOnline(machineId: string, now: Date): boolean {
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

/**
 * 唯一的待处理投影。`overdue` 只比较年龄与冻结阈值，不推断 Worker 是否在线；
 * Worker 在线与离线都可能长时间等待。时间过去永远不自动完成任何事实。
 */
export function projectPendingFact(input: PendingFactInput, now: Date): PendingFactView {
  const parsed = pendingFactInputSchema.parse(input);
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(parsed.since));
  return pendingFactViewSchema.parse({
    kind: parsed.kind,
    since: parsed.since,
    elapsedMs,
    thresholdMs: WORKER_STALE_AFTER_MS,
    overdue: elapsedMs >= WORKER_STALE_AFTER_MS,
    workerOnline: parsed.workerOnline,
    evidence: parsed.evidence,
    canForceReclaim: parsed.canForceReclaim,
  });
}

/** 匹配本 scope 的唯一 pending 收据才允许 Human 强制收回，和 pending 年龄无关。 */
function matchingFencingReceipt(key: LeaseKey, receiptId: string | null) {
  if (!receiptId) return null;
  const lease = db.select().from(machineLease).where(membershipLeaseWhere(key)).get();
  if (!lease || lease.state !== "fencing") return null;
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
  if (!pending || pending.id !== receiptId) return null;
  return pending;
}

const membershipLeaseWhere = (key: LeaseKey) =>
  and(eq(machineLease.projectId, key.projectId), eq(machineLease.machineId, key.machineId));

export interface PendingFactOptions {
  /** 只有 Human 调用方为 true；租约与移出待处理仍要匹配 fencing receipt。 */
  canForceReclaim?: boolean;
}

/**
 * 读时投影：`membership_detaching` 优先于 `lease_fencing`，再是未投递通知。
 * 三者都只读现有事实，不建行、不推进状态。
 */
export function pendingFactFor(
  key: LeaseKey,
  now: Date,
  options: PendingFactOptions = {},
): PendingFactView | null {
  const human = options.canForceReclaim === true;
  const membership = latestMembership(key);
  if (membership?.state === "detaching" && membership.requestedAt) {
    return projectPendingFact(
      {
        kind: "membership_detaching",
        since: membership.requestedAt.toISOString(),
        workerOnline: workerOnline(key.machineId, now),
        evidence: "awaiting_ack",
        canForceReclaim:
          human && matchingFencingReceipt(key, membership.removalMutationId) !== null,
      },
      now,
    );
  }
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
  if (pending)
    return projectPendingFact(
      {
        kind: "lease_fencing",
        since: pending.createdAt.toISOString(),
        workerOnline: workerOnline(key.machineId, now),
        evidence: "awaiting_ack",
        canForceReclaim: human && matchingFencingReceipt(key, pending.id) !== null,
      },
      now,
    );
  const notice = oldestUndeliveredNotice(key);
  if (notice)
    return projectPendingFact(
      {
        kind: "notice_undelivered",
        since: notice.since.toISOString(),
        workerOnline: workerOnline(key.machineId, now),
        evidence: notice.runNotRunning ? "run_not_running" : "delivery_unconfirmed",
        canForceReclaim: false,
      },
      now,
    );
  return null;
}

/** `revocation` 由关联 receipt 派生：force override 记录在原收据的收据里，不写进 membership 行。 */
function receiptRevocation(
  key: LeaseKey,
  mutationId: string | null,
  fallback: MembershipRevocation,
): MembershipRevocation {
  if (!mutationId) return fallback;
  const forced = db
    .select({ id: leaseMutation.id })
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, key.projectId),
        eq(leaseMutation.machineId, key.machineId),
        eq(leaseMutation.actorKind, "human"),
        eq(leaseMutation.requestId, `${FORCE_RECEIPT_PREFIX}${mutationId}`),
      ),
    )
    .get();
  return forced ? "unconfirmed" : "confirmed";
}

/**
 * 关系视图。detaching 的 `pending` 与 `requestedAt` 同源；removed 不再展示 pending。
 * 传入具体行而不是只按 key 取最新：移出请求的重放必须返回**原 epoch** 的收据视图，
 * 不能在 rejoin 之后被最新 active 行顶替。
 */
export function membershipViewAt(
  row: MembershipRow,
  now: Date,
  options: PendingFactOptions = {},
): MembershipView {
  const key: LeaseKey = { projectId: row.projectId, machineId: row.machineId };
  const base = {
    projectId: row.projectId,
    machineId: row.machineId,
    epoch: row.epoch,
    state: row.state,
    joinedAt: row.joinedAt.toISOString(),
    requestedAt: row.requestedAt?.toISOString() ?? null,
    removedAt: row.removedAt?.toISOString() ?? null,
    removalMutationId: row.removalMutationId,
    revokedGeneration: row.revokedGeneration,
  };
  if (row.state === "active")
    return membershipViewSchema.parse({ ...base, revocation: null, pending: null });
  if (row.state === "detaching") {
    const pending = pendingFactFor(key, now, options);
    return membershipViewSchema.parse({
      ...base,
      revocation: "pending",
      pending:
        pending && pending.kind === "membership_detaching"
          ? pending
          : projectPendingFact(
              {
                kind: "membership_detaching",
                since: (row.requestedAt ?? row.joinedAt).toISOString(),
                workerOnline: workerOnline(key.machineId, now),
                evidence: "awaiting_ack",
                canForceReclaim: false,
              },
              now,
            ),
    });
  }
  return membershipViewSchema.parse({
    ...base,
    revocation: receiptRevocation(key, row.removalMutationId, "confirmed"),
    pending: null,
  });
}

/** 最新关系视图；缺行返回 null，调用方不得把它当成 active。 */
export function membershipViewFor(
  key: LeaseKey,
  now: Date,
  options: PendingFactOptions = {},
): MembershipView | null {
  const row = latestMembership(key);
  return row ? membershipViewAt(row, now, options) : null;
}

function detachPayloadHash(input: DetachInput): string {
  return payloadHash({
    projectId: input.projectId,
    machineId: input.machineId,
    requestId: input.requestId,
    expectedEpoch: input.expectedEpoch,
    expectedRevision: input.expectedRevision,
    expectedGeneration: input.expectedGeneration,
    confirm: input.confirm,
  });
}

function receiptRow(mutationId: string) {
  return db.select().from(leaseMutation).where(eq(leaseMutation.id, mutationId)).get();
}

function affectedExecutions(key: LeaseKey, generation: number) {
  if (generation === 0) return [];
  const rows: (typeof remoteExecution.$inferSelect)[] = db
    .select()
    .from(remoteExecution)
    .where(
      and(
        eq(remoteExecution.projectId, key.projectId),
        eq(remoteExecution.machineId, key.machineId),
        eq(remoteExecution.authorizationGeneration, generation),
      ),
    )
    .orderBy(asc(remoteExecution.createdAt), asc(remoteExecution.id))
    .all();
  return rows
    .filter((row) => row.drainedAt === null)
    .map((row) => ({ executionId: row.id, runId: row.runId, state: row.state }));
}

function holderAt(key: LeaseKey, generation: number): string | null {
  if (generation === 0) return null;
  const authorization = db
    .select()
    .from(leaseAuthorization)
    .where(
      and(
        eq(leaseAuthorization.projectId, key.projectId),
        eq(leaseAuthorization.machineId, key.machineId),
        eq(leaseAuthorization.generation, generation),
      ),
    )
    .get();
  return authorization?.holderInstanceId ?? null;
}

function diagnostic(ctx: MachineContext, key: LeaseKey, event: string, level: "info" | "warn") {
  db.insert(diagnosticEvent)
    .values({
      id: newId(ID_PREFIXES.diagnostic),
      at: ctx.now,
      level,
      event,
      requestId: ctx.requestId,
      projectId: key.projectId,
      message:
        event === "machine.detached" ? "Machine 已从 Project 移出" : "Machine 已重新加入 Project",
    })
    .run();
}

/**
 * 带租约移出。整笔一个 immediate 事务：撤权、membership 落态与通知行要么一起提交，要么都不写。
 * - 无租约或 free：本 epoch 直接 removed；
 * - held：复用 reclaim 内核建收据，无在途时同事务推进 removed，否则停在 detaching；
 * - 已有 fencing：拒绝，不接管别人的 pending。
 */
export function detachMachine(raw: DetachInput, ctx: MachineContext): MembershipView {
  const input = detachMachineInputSchema.parse(raw);
  if ("instanceId" in ctx) throw new LeaseError("forbidden");
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      const key: LeaseKey = { projectId: input.projectId, machineId: input.machineId };
      const replay = db
        .select()
        .from(projectMachineMembership)
        .where(
          and(
            eq(projectMachineMembership.requestedBy, ctx.userId),
            eq(projectMachineMembership.requestId, input.requestId),
          ),
        )
        .get();
      if (replay) {
        if (replay.payloadHash !== detachPayloadHash(input))
          throw new LeaseError("remote_request_conflict");
        return membershipViewAt(replay, ctx.now, { canForceReclaim: true });
      }
      const lease = db.select().from(machineLease).where(membershipLeaseWhere(key)).get();
      const generation = lease?.generation ?? 0;
      if (generation !== input.expectedGeneration) throw new LeaseError("lease_stale_generation");
      const current = latestMembership(key);
      if (!current) throw new LeaseError("not_found");
      if (current.state === "removed") throw new LeaseError("membership_removed");
      if (current.state === "detaching") throw new LeaseError("detach_pending");
      if (lease?.state === "fencing") throw new LeaseError("lease_fencing");
      if (current.epoch !== input.expectedEpoch) throw new LeaseError("conflict");
      const binding = db
        .select()
        .from(projectMachine)
        .where(
          and(
            eq(projectMachine.projectId, input.projectId),
            eq(projectMachine.machineId, input.machineId),
          ),
        )
        .get();
      if (!binding || binding.revision !== input.expectedRevision) throw new LeaseError("conflict");
      const hash = detachPayloadHash(input);
      const causeId = membershipCauseId(input.projectId, input.machineId, current.epoch);
      const base = {
        requestedBy: ctx.userId,
        requestId: input.requestId,
        payloadHash: hash,
        requestedAt: ctx.now,
      };
      if (!lease || lease.state === "free") {
        const executions = affectedExecutions(key, generation);
        const holder = holderAt(key, generation);
        db.update(projectMachineMembership)
          .set({
            ...base,
            state: "removed",
            removedAt: ctx.now,
            revokedGeneration: generation,
            removalMutationId: null,
          })
          .where(and(membershipWhere(key), eq(projectMachineMembership.epoch, current.epoch)))
          .run();
        invalidateDirectoryObservations(db, key);
        insertRevokeNotice(db, {
          key,
          kind: "machine_removed",
          causeId,
          generation,
          revocation: "confirmed",
          executions,
          holderInstanceId: holder,
          membershipEpoch: current.epoch,
          now: ctx.now,
        });
        diagnostic(ctx, key, "machine.detached", "info");
        return membershipViewAt(
          db
            .select()
            .from(projectMachineMembership)
            .where(and(membershipWhere(key), eq(projectMachineMembership.epoch, current.epoch)))
            .get()!,
          ctx.now,
          { canForceReclaim: true },
        );
      }
      const executions = affectedExecutions(key, generation);
      const holder = holderAt(key, generation);
      const receipt = reclaimLeaseInTransaction(
        {
          ...key,
          requestId: input.requestId,
          action: "reclaim",
          expectedGeneration: input.expectedGeneration,
          confirm: true,
        },
        ctx,
      );
      const row = receiptRow(receipt.mutationId);
      if (!row) throw new LeaseError("conflict");
      const pending = row.state === "pending";
      db.update(projectMachineMembership)
        .set({
          ...base,
          state: pending ? "detaching" : "removed",
          removalMutationId: row.id,
          removedAt: pending ? null : ctx.now,
          revokedGeneration: pending ? null : row.expectedGeneration,
        })
        .where(and(membershipWhere(key), eq(projectMachineMembership.epoch, current.epoch)))
        .run();
      invalidateDirectoryObservations(db, key);
      insertRevokeNotice(db, {
        key,
        kind: "machine_removed",
        causeId,
        generation: row.expectedGeneration,
        revocation: pending ? "pending" : "confirmed",
        executions,
        holderInstanceId: holder,
        membershipEpoch: current.epoch,
        now: ctx.now,
      });
      diagnostic(ctx, key, "machine.detached", pending ? "warn" : "info");
      return membershipViewAt(
        db
          .select()
          .from(projectMachineMembership)
          .where(and(membershipWhere(key), eq(projectMachineMembership.epoch, current.epoch)))
          .get()!,
        ctx.now,
        { canForceReclaim: true },
      );
    })
    .immediate();
}

/**
 * 显式重新加入：只对最新 removed epoch 生效，插入 epoch+1/active，旧行原样保留。
 * 固定收敛规则不引入第三张收据表：最新已是 expectedEpoch+1/active 时只返回该关系视图。
 */
export function rejoinProjectMachine(raw: RejoinInput, ctx: MachineContext): MembershipView {
  const input = rejoinProjectMachineInputSchema.parse(raw);
  if ("instanceId" in ctx) throw new LeaseError("forbidden");
  return sqlite
    .transaction(() => {
      assertRemoteAccess(input, ctx);
      const key: LeaseKey = { projectId: input.projectId, machineId: input.machineId };
      const current = latestMembership(key);
      if (!current) throw new LeaseError("not_found");
      if (current.state === "active" && current.epoch === input.expectedEpoch + 1)
        return membershipViewFor(key, ctx.now, { canForceReclaim: true })!;
      if (current.state === "detaching") throw new LeaseError("detach_pending");
      if (current.state !== "removed") throw new LeaseError("conflict");
      if (current.epoch !== input.expectedEpoch) throw new LeaseError("conflict");
      if (current.epoch >= MEMBERSHIP_MAX_EPOCH) throw new LeaseError("conflict");
      const binding = db
        .select()
        .from(projectMachine)
        .where(
          and(
            eq(projectMachine.projectId, input.projectId),
            eq(projectMachine.machineId, input.machineId),
          ),
        )
        .get();
      if (
        !binding ||
        binding.revision !== input.expectedRevision ||
        binding.revision >= MEMBERSHIP_MAX_EPOCH
      )
        throw new LeaseError("conflict");
      db.update(projectMachine)
        .set({ revision: binding.revision + 1, updatedAt: ctx.now })
        .where(
          and(
            eq(projectMachine.projectId, input.projectId),
            eq(projectMachine.machineId, input.machineId),
          ),
        )
        .run();
      db.insert(projectMachineMembership)
        .values({
          ...key,
          epoch: current.epoch + 1,
          state: "active",
          joinedAt: ctx.now,
        })
        .run();
      diagnostic(ctx, key, "machine.rejoined", "info");
      return membershipViewFor(key, ctx.now, { canForceReclaim: true })!;
    })
    .immediate();
}

/**
 * 收据完成钩子。`completeLeaseMutation` 与 `forceReclaimLease` 在**各自已有事务内**调用，
 * 以 `removal_mutation_id` 匹配唯一 detaching epoch 推进 removed；不相关 handoff ack、
 * 非 reclaim 动作、最终不是 free/null 的代次都不推进。重复完成是 no-op。
 */
export function onLeaseMutationCompleted(
  tx: MembershipTx,
  mutation: CompletedLeaseMutation,
): boolean {
  if (mutation.state !== "completed" || mutation.action !== "reclaim") return false;
  if (mutation.completedGeneration === null || mutation.completedAt === null) return false;
  const key: LeaseKey = { projectId: mutation.projectId, machineId: mutation.machineId };
  const member = tx
    .select()
    .from(projectMachineMembership)
    .where(
      and(
        membershipWhere(key),
        eq(projectMachineMembership.state, "detaching"),
        eq(projectMachineMembership.removalMutationId, mutation.id),
      ),
    )
    .get();
  if (!member) return false;
  const lease = tx.select().from(machineLease).where(membershipLeaseWhere(key)).get();
  if (
    !lease ||
    lease.state !== "free" ||
    lease.holderInstanceId !== null ||
    lease.generation !== mutation.completedGeneration
  )
    return false;
  const updated = tx
    .update(projectMachineMembership)
    .set({
      state: "removed",
      removedAt: mutation.completedAt,
      revokedGeneration: mutation.expectedGeneration,
    })
    .where(
      and(
        membershipWhere(key),
        eq(projectMachineMembership.epoch, member.epoch),
        eq(projectMachineMembership.state, "detaching"),
      ),
    )
    .run();
  if (updated.changes > 0) invalidateDirectoryObservations(tx, key);
  return updated.changes > 0;
}

/**
 * 首次绑定与首次 epoch 同事务创建。调用点：`src/domain/machine.ts` 的
 * `saveProjectMachineBinding` 在插入新绑定后、同一事务内调用；已有任意 epoch 的键不再插入，
 * 因此 save binding 不会悄悄复活 removed。
 */
export function openInitialMembership(
  tx: MembershipTx,
  input: { projectId: string; machineId: string; now: Date },
): MembershipRow {
  const key: LeaseKey = { projectId: input.projectId, machineId: input.machineId };
  const existing = tx.select().from(projectMachineMembership).where(membershipWhere(key)).get();
  if (existing) return existing;
  tx.insert(projectMachineMembership)
    .values({ ...key, epoch: 1, state: "active", joinedAt: input.now })
    .run();
  return tx.select().from(projectMachineMembership).where(membershipWhere(key)).get()!;
}

/**
 * 操作总闸：最新 removed 拒 `membership_removed`，detaching 拒 `detach_pending`，缺行按不存在。
 * Human 的历史读取、收据查询与强制收回不走这个闸。
 */
export function assertMembershipOperable(projectId: string, machineId: string): MembershipRow {
  const row = latestMembership({ projectId, machineId });
  if (!row || row.state === "removed") throw new LeaseError("membership_removed");
  if (row.state === "detaching") throw new LeaseError("detach_pending");
  return row;
}
