import { describe, expect, it } from "vite-plus/test";
import { leaseViewSchema } from "../src/contracts/lease";
import { executionViewSchema } from "../src/contracts/remote";
import {
  EXECUTION_STATE_LABELS,
  executionTarget,
  failureReasonLabel,
  groupLeasesByHolder,
  holderLabel,
  leaseStateLabel,
  operationTarget,
  resultSummary,
  runLeaseRelation,
  visibleLeases,
} from "../src/components/machine/lease-view";
import {
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
    expect(leaseStateLabel("fencing").label).toBe("回收中");
    expect(leaseStateLabel("free").detail).toContain("不等于已释放记录");
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

  it("未到终态的执行不标为终态", () => {
    for (const state of ["queued", "dispatched", "running", "draining"] as const)
      expect(EXECUTION_STATE_LABELS[state].terminal).toBe(false);
    for (const state of ["succeeded", "failed", "rejected", "timed_out", "unknown"] as const)
      expect(EXECUTION_STATE_LABELS[state].terminal).toBe(true);
  });
});
