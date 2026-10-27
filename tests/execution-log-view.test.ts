import { describe, expect, it } from "vite-plus/test";
import { executionLogReadViewSchema, executionViewSchema } from "../src/contracts/remote";
import {
  CANCELLATION_STATE_LABELS,
  deadlineFacts,
  formatRuntime,
  shortExecutionId,
  timeoutSourceLabel,
  uncertainResultNote,
} from "../src/components/machine/lease-view";
import { cursorFacts, logRows, resumeFacts } from "../src/components/machine/execution-log";
import {
  LOG_STATE_LABELS,
  isIncompleteLogState,
  logCompleteness,
} from "../src/components/machine/presentation";
import {
  demoCancellationStates,
  demoCancellations,
  demoExecutionRecords,
  demoGapExecution,
  demoGapLogPage,
  demoLogPage,
  demoLogPages,
  demoLongExecution,
  demoTruncatedExecution,
  demoTruncatedLogPage,
} from "../src/dev/scenes/machine/lease-fixtures";

// 演示数据必须通过共享契约，否则演示会掩盖真实约束。
describe("长命令演示数据", () => {
  it("每条执行都通过执行视图 schema", () => {
    for (const execution of demoExecutionRecords)
      expect(() => executionViewSchema.parse(execution)).not.toThrow();
  });

  it("每一页日志都通过读视图 schema，且位点单调", () => {
    for (const page of Object.values(demoLogPages))
      expect(() => executionLogReadViewSchema.parse(page)).not.toThrow();
    for (const page of Object.values(demoLogPages)) {
      if (page.acknowledgedThroughSequence !== null)
        expect(page.acknowledgedThroughSequence).toBeLessThanOrEqual(page.producedThroughSequence!);
      if (page.availableFromSequence !== null)
        expect(page.availableFromSequence).toBeLessThanOrEqual(page.producedThroughSequence! + 1);
    }
  });

  it("下发的执行都落在下发窗口内，运行上限只在下发后成立", () => {
    for (const execution of demoExecutionRecords) {
      expect(Date.parse(execution.dispatchDeadlineAt)).toBeGreaterThan(
        Date.parse(execution.createdAt),
      );
      if (execution.runtimeDeadlineAt !== null) {
        expect(execution.dispatchedAt).not.toBeNull();
        expect(Date.parse(execution.runtimeDeadlineAt)).toBeGreaterThanOrEqual(
          Date.parse(execution.dispatchedAt!),
        );
        expect(execution.maxRuntimeMs).not.toBeNull();
      }
    }
  });
});

describe("下发窗口与运行上限是两个截止时间", () => {
  it("分开返回两条事实，不合成一个 deadline", () => {
    const facts = deadlineFacts(demoLongExecution);
    expect(facts.map((fact) => fact.key)).toEqual(["dispatch", "runtime"]);
    expect(facts[0]!.at).toBe(demoLongExecution.dispatchDeadlineAt);
    expect(facts[1]!.at).toBe(demoLongExecution.runtimeDeadlineAt);
    expect(facts[0]!.at).not.toBe(facts[1]!.at);
  });

  it("没有运行上限的执行明确说未登记，而不是复用下发窗口", () => {
    const withoutRuntime = demoExecutionRecords.find(
      (execution) => execution.runtimeDeadlineAt === null,
    )!;
    const facts = deadlineFacts(withoutRuntime);
    expect(facts[1]!.at).toBeNull();
    expect(facts[1]!.note).toContain("没有登记运行上限");
    expect(facts[1]!.at).toBeNull();
    // 只在下发窗口到期时才会超时，不会被补出一个运行上限。
    expect(timeoutSourceLabel({ ...withoutRuntime, state: "timed_out" })).toContain("下发窗口到期");
  });

  it("超时来源按运行上限是否存在区分", () => {
    const withRuntime = { ...demoLongExecution, state: "timed_out" as const };
    expect(timeoutSourceLabel(withRuntime)).toContain("运行上限到期");
    expect(timeoutSourceLabel(demoGapExecution)).toBeNull();
    expect(timeoutSourceLabel({ ...demoLongExecution, state: "succeeded" })).toBeNull();
    expect(formatRuntime(600000)).toBe("10 分");
    expect(formatRuntime(45000)).toBe("45 秒");
    expect(formatRuntime(null)).toBe("未登记时长");
  });
});

describe("用户可见文案", () => {
  it("unknown 与 timed_out 都不写成功，也不提供隐式重跑", () => {
    for (const state of ["unknown", "timed_out"] as const) {
      const note = uncertainResultNote({ ...demoLongExecution, state });
      expect(note).toBeTruthy();
      expect(note).toContain("重发");
      expect(note).not.toContain("成功");
    }
    expect(uncertainResultNote(demoLongExecution)).toBeNull();
  });

  it("执行定位是稳定短值，完整 id 留在工具提示", () => {
    expect(shortExecutionId("exe_12345678-1234-4234-8234-1234567890ab")).toBe("exe_12345678");
    expect(shortExecutionId(demoGapExecution.executionId)).toMatch(/^exe_77777777$/);
  });
});

describe("日志状态不冒充完整", () => {
  it("每个 logState 都有独立文案，none 不等于没有输出", () => {
    expect(Object.keys(LOG_STATE_LABELS)).toEqual(["none", "partial", "full", "gap", "truncated"]);
    expect(LOG_STATE_LABELS.none.detail).toContain("不等于");
    expect(LOG_STATE_LABELS.none.tone).not.toBe("success");
    for (const state of ["partial", "gap", "truncated"] as const)
      expect(isIncompleteLogState(state), state).toBe(true);
    expect(isIncompleteLogState("full")).toBe(false);
    expect(isIncompleteLogState("none")).toBe(false);
  });

  it("三个位点分开表达，不折叠成一个进度", () => {
    const facts = cursorFacts(demoLogPage);
    expect(facts).toHaveLength(3);
    expect(facts[0]).toContain("已产出到 #24");
    expect(facts[1]).toContain("Worker 已确认到 #18");
    expect(facts[2]).toContain("可读起点 #1");
    for (const fact of facts) expect(fact).not.toMatch(/成功|完成/);
  });

  it("续读到产出位点后明确没有更多区段", () => {
    expect(resumeFacts(demoLogPage).canContinue).toBe(true);
    const finished = {
      ...demoLogPage,
      nextCursor: { ...demoLogPage.nextCursor, nextSequence: 25 },
    };
    expect(resumeFacts(finished).canContinue).toBe(false);
    expect(resumeFacts(finished).text).toContain("没有更多可读区段");
  });

  it("缺口行标记为缺失而不是空输出", () => {
    const rows = logRows(demoGapLogPage);
    const gaps = rows.filter((row) => row.kind === "gap");
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ fromSequence: 52, toSequence: 55 });
    // 同一个序号不会在缺口行与正文行里各出现一次。
    const sequences = rows.map((row) => (row.kind === "gap" ? row.fromSequence : row.sequence));
    expect(new Set(sequences).size).toBe(sequences.length);
    expect(rows.every((row) => row.kind !== "frame" || row.text.length > 0)).toBe(true);
  });

  it("裁剪态保留可读起点，不从新起点自称完整", () => {
    expect(isIncompleteLogState(demoTruncatedLogPage.logState)).toBe(true);
    expect(demoTruncatedLogPage.availableFromSequence).toBe(31);
    expect(cursorFacts(demoTruncatedLogPage)[2]).toContain("#31");
  });
});

describe("日志完整性与新鲜度", () => {
  it("Worker 离线时不把已知前缀说成整体完整", () => {
    const presentation = logCompleteness({
      logState: "full",
      workerOnline: false,
      connection: { online: true, detail: null },
    });
    expect(presentation.label).not.toBe(LOG_STATE_LABELS.full.label);
    expect(presentation.label).toContain("停在此处");
    expect(presentation.detail).toContain("Worker 离线");
    expect(presentation.stale).toBe(true);
  });

  it("Worker 在线且连接正常时完整才是完整", () => {
    const presentation = logCompleteness({
      logState: "full",
      workerOnline: true,
      connection: { online: true, detail: null },
    });
    expect(presentation.label).toBe(LOG_STATE_LABELS.full.label);
    expect(presentation.stale).toBe(false);
  });

  it("离线的缺口页仍点名缺口，同时标出不新鲜", () => {
    const presentation = logCompleteness({
      logState: demoGapLogPage.logState,
      workerOnline: demoGapLogPage.workerOnline,
      connection: { online: true, detail: null },
    });
    expect(presentation.label).toBe(LOG_STATE_LABELS.gap.label);
    expect(presentation.detail).toContain("离线");
    expect(presentation.stale).toBe(true);
  });

  it("连接断开但没有读视图时不冒充新鲜，也不改写过快照的 logState", () => {
    const presentation = logCompleteness({
      logState: demoLongExecution.logState,
      workerOnline: null,
      connection: { online: false, detail: "浏览器已离线" },
    });
    expect(presentation.label).toBe(LOG_STATE_LABELS[demoLongExecution.logState].label);
    expect(presentation.stale).toBe(true);
  });
});

describe("取消六态", () => {
  it("六态都有文案，且只有观察到退出才算停止", () => {
    expect(Object.keys(CANCELLATION_STATE_LABELS)).toHaveLength(6);
    for (const [state, label] of Object.entries(CANCELLATION_STATE_LABELS)) {
      expect(label.label.length).toBeGreaterThan(0);
      if (state !== "exited_observed" && state !== "already_exited")
        expect(label.stopped, state).toBe(false);
    }
    expect(CANCELLATION_STATE_LABELS.delivered.stopped).toBe(false);
    expect(CANCELLATION_STATE_LABELS.delivered.label).not.toContain("已停止");
    expect(CANCELLATION_STATE_LABELS.delivered.detail).toContain("送达不等于已停止");
  });

  it("演示的六态样例都是契约允许的形状，且 delivered 不指向退出", () => {
    expect(Object.keys(demoCancellationStates)).toHaveLength(6);
    const delivered = demoCancellationStates.delivered;
    expect(delivered.state).toBe("delivered");
    expect(delivered.exitedAt).toBeNull();
    expect(delivered.signalOutcome).toBe("term_delivered");
    for (const [executionId, cancellation] of Object.entries(demoCancellations))
      expect(cancellation.executionId).toBe(executionId);
  });

  it("取消事实与执行终态独立：已成功的执行仍可有送达中的取消", () => {
    const cancellation = demoCancellations[demoLongExecution.executionId]!;
    expect(demoLongExecution.state).toBe("succeeded");
    expect(cancellation.state).toBe("delivered");
    expect(cancellation.exitedAt).toBeNull();
  });

  it("断线样例的日志位点停在已知值", () => {
    expect(demoGapLogPage.workerOnline).toBe(false);
    expect(demoTruncatedExecution.logState).toBe("truncated");
    expect(demoGapExecution.state).toBe("unknown");
  });
});
