import { describe, expect, it } from "vite-plus/test";
import type { ExecutionView } from "../src/contracts/remote";
import {
  executionAttention,
  executionSummary,
  type LeaseFacts,
} from "../src/components/machine/presentation";
import {
  demoCancellations,
  demoExecutionRecords,
  demoLeases,
} from "../src/dev/scenes/machine/lease-fixtures";

const now = new Date("2026-10-18T09:00:00.000Z");
const running = demoExecutionRecords.find((execution) => execution.state === "running")!;
const lease = demoLeases.find((item) => item.machineId === running.machineId)!;
const runningLease: LeaseFacts = {
  state: lease.state,
  holderInstanceId: lease.holderInstanceId,
  generation: lease.generation,
};
const runningWithoutCancellation: ExecutionView = { ...running, cancellation: null };
const runningWithCancellation: ExecutionView = {
  ...running,
  cancellation: demoCancellations[running.executionId]!,
};

describe("执行摘要", () => {
  it("零值状态不出现", () => {
    const summaries = executionSummary(demoExecutionRecords);
    const machine = summaries.find((item) => item.machineId === running.machineId)!;
    expect(machine.segments.every((segment) => segment.count > 0)).toBe(true);
    expect(machine.segments.some((segment) => segment.state === "queued")).toBe(false);
    expect(machine.segments.some((segment) => segment.state === "dispatched")).toBe(false);
  });

  it("总数、分段计数都与执行视图一致", () => {
    const summaries = executionSummary(demoExecutionRecords);
    expect(summaries).toHaveLength(
      new Set(demoExecutionRecords.map((item) => item.machineId)).size,
    );
    for (const summary of summaries) {
      const views = demoExecutionRecords.filter((item) => item.machineId === summary.machineId);
      expect(summary.total).toBe(views.length);
      expect(summary.segments.reduce((sum, segment) => sum + segment.count, 0)).toBe(summary.total);
      for (const segment of summary.segments) {
        expect(segment.count).toBe(views.filter((item) => item.state === segment.state).length);
      }
    }
  });
});

describe("需要处理的执行", () => {
  it("租约不再由该 holder 持有时命中 lease_released", () => {
    const attention = executionAttention(
      runningWithoutCancellation,
      { ...runningLease, state: "free", holderInstanceId: null },
      now,
    );
    expect(attention?.reason).toBe("lease_released");
    expect(attention?.kind).toBe("decision");
  });

  it("租约代次与授权代次不符时命中 generation_mismatch", () => {
    const attention = executionAttention(
      runningWithoutCancellation,
      { ...runningLease, generation: runningLease.generation + 1 },
      now,
    );
    expect(attention?.reason).toBe("generation_mismatch");
    expect(attention?.kind).toBe("decision");
  });

  it("queued 过了下发窗口时命中 dispatch_window_expired", () => {
    const attention = executionAttention(
      { ...runningWithoutCancellation, state: "queued" },
      runningLease,
      now,
    );
    expect(attention?.reason).toBe("dispatch_window_expired");
    expect(attention?.kind).toBe("pending");
  });

  it("取消停在 requested 超过确认窗口时命中 cancellation_unconfirmed", () => {
    const attention = executionAttention(runningWithCancellation, runningLease, now);
    expect(attention?.reason).toBe("cancellation_unconfirmed");
    expect(attention?.kind).toBe("pending");
  });

  it("draining 超过确认窗口仍无终态时命中 drain_unconfirmed", () => {
    const attention = executionAttention(
      { ...runningWithoutCancellation, state: "draining" },
      runningLease,
      now,
    );
    expect(attention?.reason).toBe("drain_unconfirmed");
    expect(attention?.kind).toBe("pending");
  });

  it("没有需要处理的事实时返回 null", () => {
    expect(executionAttention(runningWithoutCancellation, runningLease, now)).toBeNull();
    expect(
      executionAttention(
        {
          ...runningWithoutCancellation,
          state: "queued",
          dispatchDeadlineAt: "2026-10-18T10:00:00.000Z",
        },
        runningLease,
        now,
      ),
    ).toBeNull();
    expect(
      executionAttention(
        {
          ...running,
          cancellation: {
            ...demoCancellations[running.executionId]!,
            state: "requested",
            requestedAt: "2026-10-18T08:59:30.000Z",
          },
        },
        runningLease,
        now,
      ),
    ).toBeNull();
    expect(
      executionAttention(
        {
          ...runningWithoutCancellation,
          state: "draining",
          dispatchedAt: "2026-10-18T08:59:30.000Z",
        },
        runningLease,
        now,
      ),
    ).toBeNull();
    expect(
      executionAttention(
        { ...running, state: "succeeded", terminalAt: "2026-10-18T08:00:00.000Z" },
        { ...runningLease, state: "free", holderInstanceId: null },
        now,
      ),
    ).toBeNull();
  });

  it("没有租约事实时不误判 lease_released", () => {
    expect(executionAttention(runningWithoutCancellation, null, now)).toBeNull();
  });

  it("needsCancel 只在 kind === 'decision'", () => {
    const decision = executionAttention(
      runningWithoutCancellation,
      { ...runningLease, generation: runningLease.generation + 1 },
      now,
    );
    const pending = executionAttention(runningWithCancellation, runningLease, now);
    expect(decision?.needsCancel).toBe(true);
    expect(pending?.needsCancel).toBe(false);
  });
});
