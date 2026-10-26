import { describe, expect, it } from "vite-plus/test";
import { leaseViewSchema } from "../src/contracts/lease";
import { executionViewSchema } from "../src/contracts/remote";
import {
  EXECUTION_STATE_LABELS,
  executionTarget,
  failureReasonLabel,
  fencingExecutions,
  fencingMutation,
  fencingWaitLabel,
  reclaimErrorNote,
  groupLeasesByHolder,
  holderLabel,
  leaseStateLabel,
  mutationStateLabel,
  operationTarget,
  resultSummary,
  runLeaseRelation,
  visibleLeases,
} from "../src/components/machine/lease-view";
import {
  completedReceipt,
  demoExecutions,
  demoFreeLease,
  demoHolderNames,
  demoInstanceIds,
  demoLeases,
} from "../src/dev/scenes/machine/lease-fixtures";
import { demoProject, secondProject } from "../src/dev/scenes/machine/fixtures";

// 演示 fixture 必须是契约允许的形状，否则演示会掩盖真实数据的约束。
describe("租约与执行演示数据", () => {
  it("每条租约与执行都通过共享 schema", () => {
    for (const lease of [...demoLeases, demoFreeLease])
      expect(() => leaseViewSchema.parse(lease)).not.toThrow();
    for (const execution of demoExecutions)
      expect(() => executionViewSchema.parse(execution)).not.toThrow();
  });

  it("同一台物理 Machine 在两个 Project 上各有独立租约", () => {
    const shared = demoLeases.filter(
      (lease) => lease.holderInstanceId !== null && lease.projectId === secondProject.id,
    );
    expect(shared).toHaveLength(1);
    const currentProjectView = visibleLeases(demoLeases, demoProject.id);
    expect(currentProjectView.every((lease) => lease.projectId === demoProject.id)).toBe(true);
    expect(
      currentProjectView.some((lease) => lease.holderInstanceId === demoInstanceIds.foreign),
    ).toBe(false);
  });
});

describe("租约事实投影", () => {
  it("按 holder 归并，一个分身持有多台 Machine 在同一处可见", () => {
    const groups = groupLeasesByHolder(visibleLeases(demoLeases, demoProject.id));
    const primary = groups.find((group) => group.instanceId === demoInstanceIds.primary);
    expect(primary?.leases.length).toBe(2);
    expect(new Set(primary?.leases.map((lease) => lease.machineId)).size).toBe(2);
  });

  it("持有者同时给出分身名与 instanceId，缺名字时不冒充身份", () => {
    const held = demoLeases.find((lease) => lease.state === "held")!;
    expect(holderLabel(held, demoHolderNames)).toEqual({
      name: demoHolderNames[demoInstanceIds.primary],
      instanceId: demoInstanceIds.primary,
    });
    expect(holderLabel(held).name).toBe("未知分身");
    expect(holderLabel(demoFreeLease)).toEqual({ name: "无持有者", instanceId: null });
  });

  it("三种状态各有独立含义，空闲不被写成已释放记录", () => {
    expect(leaseStateLabel("free").label).toBe("空闲");
    expect(leaseStateLabel("held").label).toBe("持有中");
    expect(leaseStateLabel("fencing").label).toBe("等待 Worker 确认");
    expect(leaseStateLabel("free").detail).toContain("不等于已释放记录");
  });
});

describe("fencing 事实", () => {
  const lease = demoLeases.find((item) => item.state === "fencing")!;

  it("等待不承诺结束，不伪装空闲或撤权完成，原 holder 保留", () => {
    const label = leaseStateLabel("fencing");
    expect(label.label).not.toMatch(/空闲|已释放|已收回|成功/);
    expect(label.detail).toContain("无法保证等待会结束");
    expect(label.detail).toContain("重连本身不代表已确认");
    expect(label.detail).toContain("已启动的进程仍可能继续产生副作用");
    expect(holderLabel(lease).instanceId).toBe(demoInstanceIds.sibling);
    expect(groupLeasesByHolder([lease])[0]?.leases).toEqual([lease]);
  });

  it("从 changedAt 计算等待，不以最后心跳或 run 结束计时", () => {
    const start = Date.parse(lease.changedAt);
    expect(fencingWaitLabel(lease.changedAt, start + 90061000)).toBe(
      "已等待 1 天 1 小时 1 分 1 秒",
    );
    expect(fencingWaitLabel(lease.changedAt, start)).toBe("已等待 0 小时 0 分 0 秒");
    expect(fencingWaitLabel(lease.changedAt, start - 1)).toContain("无法计算");
  });

  it("结果不确定计数严格按 Project × Machine，含 deadline 终态但不推断 drain", () => {
    const unknown = demoExecutions.find((item) => item.state === "unknown")!;
    const deadline = demoExecutions.find((item) => item.failureReason === "deadline")!;
    const candidates = [
      { ...unknown, machineId: lease.machineId },
      { ...deadline, machineId: lease.machineId },
      unknown,
      { ...unknown, machineId: lease.machineId, projectId: secondProject.id },
      { ...demoExecutions[0]!, machineId: lease.machineId },
    ];
    expect(fencingExecutions(lease, candidates)).toEqual(candidates.slice(0, 2));
  });

  it("只用同租约同代次 pending 收据呈现动作，不从 ID 猜测", () => {
    const pending = {
      ...completedReceipt({
        action: "reclaim",
        projectId: lease.projectId,
        machineId: lease.machineId,
        expectedGeneration: lease.generation,
        confirm: true,
        requestId: demoExecutions[0]!.requestId,
      }),
      mutationId: lease.pendingMutationId!,
      state: "pending" as const,
      completedGeneration: null,
      completedAt: null,
    };
    expect(fencingMutation(lease, pending)?.action).toBe("reclaim");
    expect(mutationStateLabel(pending).tone).toBe("warning");
    expect(mutationStateLabel(pending).label).toBe("收回等待 Worker 确认");
    expect(mutationStateLabel({ ...pending, action: "release" }).label).not.toMatch(/已确认|成功/);
    expect(fencingMutation(lease, null)).toBeNull();
    expect(fencingMutation(lease, { ...pending, projectId: secondProject.id })).toBeNull();
    expect(fencingMutation(lease, { ...pending, machineId: demoFreeLease.machineId })).toBeNull();
    expect(
      fencingMutation(lease, { ...pending, expectedGeneration: lease.generation - 1 }),
    ).toBeNull();
    expect(fencingMutation(lease, { ...pending, state: "completed" })).toBeNull();
  });

  it("Human 强制收回覆盖原动作，但不投影为 Worker 已确认", () => {
    const receipt = completedReceipt({
      action: "handoff",
      projectId: lease.projectId,
      machineId: lease.machineId,
      expectedGeneration: lease.generation,
      targetInstanceId: demoInstanceIds.primary,
      requestId: demoExecutions[0]!.requestId,
    });
    const projected = mutationStateLabel({
      ...receipt,
      forcedReclaim: {
        mutationId: lease.pendingMutationId!,
        supersededMutationId: receipt.mutationId,
        forcedByUserId: "owner",
        forcedAt: receipt.completedAt!,
      },
    });
    expect(projected.label).toBe("Human 已强制收回");
    expect(projected.label).not.toMatch(/交接已确认|Worker 已确认/);
    expect(projected.detail).toContain("未确认 Worker 排空");
    expect(projected.tone).toBe("warning");
  });

  it("lease_fencing 如实解释收回受阻，不显示完成", () => {
    expect(reclaimErrorNote("lease_fencing")).toBe("等待 Worker 确认后才能完成收回。");
    expect(reclaimErrorNote("lease_stale_generation")).toBeNull();
  });
});

describe("run 结束不改变租约", () => {
  const held = demoLeases.find((lease) => lease.state === "held")!;
  const fencing = demoLeases.find((lease) => lease.state === "fencing")!;

  it.each(["running", "completed", "failed", "interrupted"] as const)(
    "run 状态 %s 下持有关系保持不变",
    (status) => {
      const relation = runLeaseRelation(held, status);
      expect(relation.held).toBe(true);
    },
  );

  it("run 已结束时仍显示持有，并说明直到显式释放", () => {
    const relation = runLeaseRelation(held, "completed");
    expect(relation.held).toBe(true);
    expect(relation.note).toContain("仍由该分身持有");
    expect(relation.note).toContain("显式释放");
  });

  it("没有 run 事实时不推断释放", () => {
    const relation = runLeaseRelation(held, null);
    expect(relation.held).toBe(true);
    expect(relation.note).toContain("不推断");
  });

  it("回收中仍算持有，只有 free 才是无持有者", () => {
    expect(runLeaseRelation(fencing, "completed").held).toBe(true);
    expect(runLeaseRelation(fencing, "completed").note).toContain(
      "旧授权正在等待 Worker 确认已关闸",
    );
    expect(runLeaseRelation(fencing, "completed").note).not.toContain("直到显式释放");
    expect(runLeaseRelation(demoFreeLease, "completed").held).toBe(false);
  });
});

describe("远端操作目标与结果", () => {
  it("目标来自操作自身，不由当前页面推断", () => {
    const shell = demoExecutions.find((execution) => execution.operation.kind === "shell")!;
    expect(executionTarget(shell, "工作室 Mac mini")).toContain("工作室 Mac mini");
    expect(executionTarget(shell, "工作室 Mac mini")).toContain("远端 Worker");
    if (shell.operation.kind === "shell")
      expect(operationTarget(shell.operation)).toContain(shell.operation.cwd!);
  });

  it("结果摘要只给结构化元信息，不回显远端输出内容", () => {
    for (const execution of demoExecutions) {
      const lines = resultSummary(execution);
      for (const line of lines) {
        expect(line).not.toContain("ok 12 tests");
        expect(line).not.toContain("secret");
      }
    }
    const succeeded = demoExecutions.find((execution) => execution.state === "succeeded")!;
    expect(resultSummary(succeeded)[0]).toContain("退出码 0");
  });

  it("失败、超时与未知都有可读原因，未知不显示为成功", () => {
    const timedOut = demoExecutions.find((execution) => execution.state === "timed_out")!;
    expect(failureReasonLabel(timedOut.failureReason)).toContain("超过截止时间");
    // 失败原因只在原因行出现一次，不在结果摘要里重复。
    expect(resultSummary(timedOut)).toEqual([]);
    const unknown = demoExecutions.find((execution) => execution.state === "unknown")!;
    expect(EXECUTION_STATE_LABELS[unknown.state].label).toBe("结果未知");
    expect(EXECUTION_STATE_LABELS[unknown.state].tone).not.toBe("success");
    expect(EXECUTION_STATE_LABELS[unknown.state].terminal).toBe(true);
  });

  it("所有非终态都不使用成功色", () => {
    for (const [state, label] of Object.entries(EXECUTION_STATE_LABELS)) {
      if (!label.terminal) expect(label.tone, state).not.toBe("success");
    }
  });

  it("成功状态保留终态语义与成功色", () => {
    expect(EXECUTION_STATE_LABELS.succeeded).toMatchObject({ terminal: true, tone: "success" });
  });

  it("未到终态的执行不标为终态", () => {
    for (const state of ["queued", "dispatched", "running", "draining"] as const)
      expect(EXECUTION_STATE_LABELS[state].terminal).toBe(false);
    for (const state of ["succeeded", "failed", "rejected", "timed_out", "unknown"] as const)
      expect(EXECUTION_STATE_LABELS[state].terminal).toBe(true);
  });
});
