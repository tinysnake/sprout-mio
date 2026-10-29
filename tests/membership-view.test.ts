import { expect, test } from "vite-plus/test";
import type { MembershipView, PendingFactView } from "../src/contracts/membership";
import type { ExecutionView } from "../src/contracts/remote";
import {
  membershipPresentation,
  pendingOrder,
  pendingPresentation,
  revocationPresentation,
  unfinishedExecutionCount,
} from "../src/components/machine/membership-view";

const basePending = {
  since: "2026-01-01T00:00:00.000Z",
  elapsedMs: 14_999,
  thresholdMs: 15_000,
  overdue: false,
  workerOnline: true,
  evidence: "awaiting_ack",
  canForceReclaim: false,
} as const;

function pending(overrides: Partial<PendingFactView>): PendingFactView {
  return { ...basePending, kind: "membership_detaching", ...overrides } as PendingFactView;
}

function membership(overrides: Partial<MembershipView>): MembershipView {
  return {
    projectId: "prj_00000000-0000-4000-8000-000000000001",
    machineId: "mch_00000000-0000-4000-8000-000000000001",
    epoch: 1,
    state: "active",
    joinedAt: "2026-01-01T00:00:00.000Z",
    requestedAt: null,
    removedAt: null,
    removalMutationId: null,
    revokedGeneration: null,
    revocation: null,
    pending: null,
    ...overrides,
  } as MembershipView;
}

test("pending 摘要优先级固定为移出 > 租约 > 通知", () => {
  const order = [
    pending({ kind: "notice_undelivered", evidence: "delivery_unconfirmed" }),
    pending({ kind: "lease_fencing" }),
    pending({ kind: "membership_detaching" }),
  ].sort(pendingOrder);
  expect(order.map((item) => item.kind)).toEqual([
    "membership_detaching",
    "lease_fencing",
    "notice_undelivered",
  ]);
});

test("overdue 只提高紧急度，不改变文案或权限", () => {
  const fresh = pendingPresentation(pending({}), 2);
  const overdue = pendingPresentation(pending({ elapsedMs: 15_000, overdue: true }), 2);
  expect(fresh.overdue).toBe(false);
  expect(overdue.overdue).toBe(true);
  expect(overdue.title).toBe(fresh.title);
  expect(overdue.detail).toBe(fresh.detail);
  expect(overdue.ageText).toContain("15 秒");
});

test("未投递通知按 evidence 说明不同原因，不提供强制收回", () => {
  const ended = pendingPresentation(
    pending({ kind: "notice_undelivered", evidence: "run_not_running" }),
    null,
  );
  const retry = pendingPresentation(
    pending({ kind: "notice_undelivered", evidence: "delivery_unconfirmed" }),
    null,
  );
  expect(ended.summary).toContain("目标 Run 已结束");
  expect(retry.summary).toContain("输入轮询");
  expect(ended.title).toBe("通知待投递");
});

test("active + fencing 仍在当前区但标暂不可用", () => {
  const view = membershipPresentation(membership({}), {
    projectId: "prj_00000000-0000-4000-8000-000000000001",
    machineId: "mch_00000000-0000-4000-8000-000000000001",
    generation: 3,
    state: "fencing",
    holderInstanceId: "ins_00000000-0000-4000-8000-000000000001",
    changedAt: "2026-01-01T00:00:00.000Z",
    pendingMutationId: null,
  });
  expect(view.label).toBe("项目资源 · 暂不可用");
  expect(view.unusable).toBe(true);
});

test("force 后的 unconfirmed 显示撤权未确认，而不是已停止", () => {
  const view = revocationPresentation("unconfirmed");
  expect(view?.label).toBe("撤权未确认");
  expect(view?.detail).toContain("无法确认远端执行已停止");
  expect(view?.detail).not.toContain("执行已确认停止");
});

test("执行计数只数已派发未排空的同一 scope", () => {
  const execution = (overrides: Partial<ExecutionView>) => ({ ...overrides }) as ExecutionView;
  const executions = [
    execution({ projectId: "p1", machineId: "m1", state: "dispatched", drainedAt: null }),
    execution({ projectId: "p1", machineId: "m1", state: "running", drainedAt: null }),
    execution({ projectId: "p1", machineId: "m1", state: "succeeded", drainedAt: null }),
    execution({ projectId: "p1", machineId: "m1", state: "running", drainedAt: "2026-01-01" }),
    execution({ projectId: "p2", machineId: "m1", state: "running", drainedAt: null }),
    execution({ projectId: "p1", machineId: "m2", state: "running", drainedAt: null }),
  ];
  expect(unfinishedExecutionCount(executions, "p1", "m1")).toBe(2);
});
