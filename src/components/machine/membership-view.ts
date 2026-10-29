import type { LeaseView } from "../../contracts/lease";
import type { MembershipView, PendingFactView } from "../../contracts/membership";
import type { ExecutionView } from "../../contracts/remote";
import type { StatusTone } from "./machine-view";

/**
 * 关系、待处理与撤权的唯一文案投影。输入全部来自服务端
 * `MembershipView` / `PendingFactView`；这里不根据 epoch、generation 或
 * elapsedMs 重新判断授权，只把已有事实翻译成页面文本与 token。
 */

export const PENDING_PRIORITY: Record<PendingFactView["kind"], number> = {
  membership_detaching: 0,
  lease_fencing: 1,
  notice_undelivered: 2,
};

export function pendingOrder(left: PendingFactView, right: PendingFactView): number {
  return (
    PENDING_PRIORITY[left.kind] - PENDING_PRIORITY[right.kind] ||
    Date.parse(left.since) - Date.parse(right.since)
  );
}

export type MembershipPresentation = {
  label: string;
  detail: string;
  tone: StatusTone;
  /** active + fencing 仍在当前区，但不可新增使用。 */
  unusable: boolean;
};

export function membershipPresentation(
  membership: MembershipView | null,
  lease: LeaseView | undefined,
): MembershipPresentation {
  if (!membership)
    return {
      label: "关系未知",
      detail: "没有读到本 Project × Machine 的加入记录；不当作可使用资源。",
      tone: "muted",
      unusable: true,
    };
  if (membership.state === "detaching")
    return {
      label: "移出中 · 待处理",
      detail: "已停止新增使用，尚未完成移出。",
      tone: "warning",
      unusable: true,
    };
  if (membership.state === "removed")
    return {
      label: "已移出 · 历史",
      detail: "不再是当前项目资源。",
      tone: "muted",
      unusable: true,
    };
  if (lease?.state === "fencing")
    return {
      label: "项目资源 · 暂不可用",
      detail: "关系仍在项目中，当前不可新增使用。",
      tone: "warning",
      unusable: true,
    };
  if (lease?.state === "held")
    return {
      label: "项目资源 · 可使用",
      detail: "租约由持有者持有；实际新增执行仍由服务端授权裁决。",
      tone: "success",
      unusable: false,
    };
  return {
    label: "项目资源 · 可使用",
    detail: "当前没有持有者；实际新增执行仍由服务端授权裁决。",
    tone: "success",
    unusable: false,
  };
}

export const REVOCATION_LABELS = {
  pending: {
    label: "撤权等待确认",
    detail: "移出尚未完成，不能显示为已移出。",
    tone: "warning" as StatusTone,
  },
  confirmed: {
    label: "撤权已确认",
    detail: "不由此推断任意执行的 exit code。",
    tone: "muted" as StatusTone,
  },
  unconfirmed: {
    label: "撤权未确认",
    detail: "无法确认远端执行已停止。",
    tone: "warning" as StatusTone,
  },
} as const;

export function revocationPresentation(revocation: MembershipView["revocation"]) {
  return revocation ? REVOCATION_LABELS[revocation] : null;
}

function elapsedText(pending: PendingFactView): string {
  const seconds = Math.floor(pending.elapsedMs / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `已等 ${days > 0 ? `${days} 天 ` : ""}${hours} 小时 ${minutes} 分 ${seconds % 60} 秒`;
}

function sinceClock(pending: PendingFactView): string {
  const date = new Date(pending.since);
  if (Number.isNaN(date.getTime())) return pending.since;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}

export type PendingPresentation = {
  title: string;
  summary: string;
  detail: string;
  tone: StatusTone;
  /** overdue 只加视觉紧急度，不改变事实或权限。 */
  overdue: boolean;
  ageText: string;
  workerText: string;
  evidenceText: string;
};

export function pendingPresentation(
  pending: PendingFactView,
  executionCount: number | null,
): PendingPresentation {
  const waiting =
    executionCount === null ? "执行尚未读取确认" : `${executionCount} 项已派发执行尚未排空`;
  const ageText = `${elapsedText(pending)} · 自 ${sinceClock(pending)}`;
  const workerText = pending.workerOnline ? "Worker 在线" : "Worker 离线";
  const overdue = pending.overdue;
  if (pending.kind === "membership_detaching")
    return {
      title: "关系正在移出",
      summary: "已停止新增使用，尚未完成移出。",
      detail: `${waiting}，正在等待 Worker 确认。`,
      tone: "warning",
      overdue,
      ageText,
      workerText,
      evidenceText: "等待 Worker 确认移出。",
    };
  if (pending.kind === "lease_fencing")
    return {
      title: "租约交接中",
      summary: "正在等待 Worker 确认，期间不接受新的远端操作。",
      detail: `${waiting}，尚不能断言已排空。`,
      tone: "warning",
      overdue,
      ageText,
      workerText,
      evidenceText: "等待 Worker 确认旧授权已关闸。",
    };
  return {
    title: "通知待投递",
    summary:
      pending.evidence === "run_not_running"
        ? "目标 Run 已结束；未投递通知不会被标记为已读。"
        : "等待 Run 输入轮询重试投递；未投递通知不会自动完成。",
    detail: "投递成功也不表示模型已读，不替代 Agent 的输入轮询。",
    tone: "warning",
    overdue,
    ageText,
    workerText,
    evidenceText:
      pending.evidence === "run_not_running" ? "证据：目标 Run 已结束。" : "证据：投递未确认。",
  };
}

/** 只数既有的执行事实，不用授权代次或租约状态重新判定。 */
export function unfinishedExecutionCount(
  executions: readonly ExecutionView[],
  projectId: string,
  machineId: string,
): number {
  return executions.filter(
    (execution) =>
      execution.projectId === projectId &&
      execution.machineId === machineId &&
      (execution.state === "dispatched" ||
        execution.state === "running" ||
        execution.state === "draining") &&
      execution.drainedAt === null,
  ).length;
}

export function historyMembershipSummary(
  membership: MembershipView,
  epochHistory: readonly MembershipView[],
): { label: string; detail: string } {
  const older = epochHistory.filter(
    (item) =>
      item.projectId === membership.projectId &&
      item.machineId === membership.machineId &&
      item.epoch < membership.epoch,
  ).length;
  return {
    label: "已移出 · 历史",
    detail:
      older > 0
        ? `重新加入前的旧记录仍保留；本机共 ${older + 1} 段加入记录。`
        : "旧执行、日志与租约收据只读保留。重新加入会产生新的加入记录。",
  };
}
