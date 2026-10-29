import { and, desc, eq } from "drizzle-orm";
import type { LeaseKey } from "../contracts/lease";
import type { MembershipView, PendingFactView } from "../contracts/membership";
import { db } from "../db";
import { leaseMutation, projectMachineMembership } from "../db/schema";
import { getMachine, listProjectMachines } from "../domain/machine";
import type { MachineContext } from "../domain/machine";
import { assertRemoteAccess } from "./lease";
import { membershipViewAt, membershipViewFor, pendingFactFor } from "./membership";

export interface MachineRelationView {
  projectId: string;
  machineId: string;
  /** 缺行不是 active；页面按未知处理，不自行补一条关系。 */
  membership: MembershipView | null;
  /** 同一 scope 的摘要选择：membership_detaching > lease_fencing > notice_undelivered。 */
  pending: PendingFactView | null;
}

export interface MembershipReceiptView {
  mutationId: string;
  action: "acquire" | "release" | "handoff" | "reclaim";
  state: "pending" | "completed";
  expectedGeneration: number;
  completedGeneration: number | null;
  targetInstanceId: string | null;
  createdAt: string;
  completedAt: string | null;
  /** 这一行是 Human 强制收回收据；被它覆盖的原收据通过 `supersededBy` 指回。 */
  forced: boolean;
  supersededMutationId: string | null;
  /** 原收据被哪条强制收回收据覆盖。 */
  supersededBy: string | null;
}

export interface MembershipHistoryView {
  projectId: string;
  machineId: string;
  memberships: MembershipView[];
  receipts: MembershipReceiptView[];
}

function relationFor(key: LeaseKey, ctx: MachineContext): MachineRelationView {
  return {
    ...key,
    membership: membershipViewFor(key, ctx.now, { canForceReclaim: true }),
    pending: pendingFactFor(key, ctx.now, { canForceReclaim: true }),
  };
}

export function projectMachineRelations(
  projectId: string,
  ctx: MachineContext,
): MachineRelationView[] {
  // 先走既有 Machine 读边界核对 Project 与 Machine 归属，再按关系键组装视图。
  const machines = listProjectMachines(projectId, ctx);
  return machines.map((detail) => relationFor({ projectId, machineId: detail.machine.id }, ctx));
}

export function machineRelations(machineId: string, ctx: MachineContext): MachineRelationView[] {
  const detail = getMachine({ machineId }, ctx);
  return detail.bindings.map(({ intent }) =>
    relationFor({ projectId: intent.projectId, machineId }, ctx),
  );
}

/**
 * Human 只读历史：关系每一段（含已移出 epoch）、该 Project × Machine 的租约收据与
 * 执行记录分开查询。这里不检查 membership 是否 active；已经移出的关系仍可由
 * 拥有资源的 Human 读取。
 */
export function membershipHistory(
  input: { projectId: string; machineId: string },
  ctx: MachineContext,
): MembershipHistoryView {
  assertRemoteAccess(input, ctx);
  const memberships = db
    .select()
    .from(projectMachineMembership)
    .where(
      and(
        eq(projectMachineMembership.projectId, input.projectId),
        eq(projectMachineMembership.machineId, input.machineId),
      ),
    )
    .orderBy(desc(projectMachineMembership.epoch))
    .all()
    .map((row: typeof projectMachineMembership.$inferSelect) =>
      membershipViewAt(row, ctx.now, { canForceReclaim: false }),
    );
  const rows = db
    .select()
    .from(leaseMutation)
    .where(
      and(
        eq(leaseMutation.projectId, input.projectId),
        eq(leaseMutation.machineId, input.machineId),
      ),
    )
    .orderBy(desc(leaseMutation.createdAt), desc(leaseMutation.id))
    .limit(100)
    .all();
  const forcedBy = new Map<string, string>();
  for (const row of rows) {
    if (!row.requestId.startsWith("force-reclaim:")) continue;
    forcedBy.set(row.requestId.slice("force-reclaim:".length), row.id);
  }
  const receipts: MembershipReceiptView[] = rows.map((row: typeof leaseMutation.$inferSelect) => {
    const forced = row.requestId.startsWith("force-reclaim:");
    return {
      mutationId: row.id,
      action: row.action,
      state: row.state,
      expectedGeneration: row.expectedGeneration,
      completedGeneration: row.completedGeneration,
      targetInstanceId: row.targetInstanceId,
      createdAt: row.createdAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      forced,
      supersededMutationId: forced ? row.requestId.slice("force-reclaim:".length) : null,
      supersededBy: forcedBy.get(row.id) ?? null,
    };
  });
  return { ...input, memberships, receipts };
}
