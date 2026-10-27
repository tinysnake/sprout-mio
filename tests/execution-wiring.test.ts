import { describe, expect, it } from "vite-plus/test";
import type { ExecutionLogReadInput } from "../src/contracts/remote";
import type { ExecutionCancellationView, ExecutionLogReadView } from "../src/contracts/remote";
import {
  EXECUTION_LOG_PAGE_BYTES,
  executionCanceller,
  executionLogInput,
  executionLogReader,
  mergeExecutionCancellations,
} from "../src/lib/execution-wiring";
import { demoExecutionRecords } from "../src/dev/scenes/machine/lease-fixtures";

const projectId = "prj_00000000-0000-4000-8000-000000000000";
const machineId = "mch_00000000-0000-4000-8000-000000000000";

const logView = (executionId: string): ExecutionLogReadView => ({
  projectId,
  machineId,
  executionId,
  frames: [],
  nextCursor: { nextSequence: 1 },
  availableFromSequence: null,
  acknowledgedThroughSequence: null,
  producedThroughSequence: null,
  gapRanges: [],
  logState: "none",
  workerOnline: true,
});

const cancellation = (
  executionId: string,
  overrides: Partial<ExecutionCancellationView> = {},
): ExecutionCancellationView => ({
  projectId,
  machineId,
  cancelId: "cnl_00000000-0000-4000-8000-000000000000",
  executionId,
  state: "requested",
  requestedAt: "2026-10-24T00:00:00.000Z",
  deliveredAt: null,
  exitedAt: null,
  signalOutcome: "none",
  failureReason: null,
  ...overrides,
});

describe("日志读取请求映射", () => {
  it("把页面请求补成服务端输入，并固定一页 32768 字节", () => {
    expect(
      executionLogInput(
        {
          executionId: "exe_00000000-0000-4000-8000-000000000000",
          cursor: null,
          limitBytes: 65536,
        },
        projectId,
        machineId,
      ),
    ).toEqual({
      projectId,
      machineId,
      executionId: "exe_00000000-0000-4000-8000-000000000000",
      cursor: null,
      limitBytes: 32768,
    });
    expect(EXECUTION_LOG_PAGE_BYTES).toBe(32768);
  });

  it("游标直传，不替页面重算下一序号", () => {
    expect(
      executionLogInput(
        {
          executionId: "exe_00000000-0000-4000-8000-000000000000",
          cursor: { nextSequence: 7 },
          limitBytes: 100,
        },
        projectId,
        machineId,
      )?.cursor,
    ).toEqual({ nextSequence: 7 });
  });

  it("没有 Machine 归属时返回 null，不拿别的 Machine 猜", () => {
    expect(
      executionLogInput(
        { executionId: "exe_00000000-0000-4000-8000-000000000000", cursor: null, limitBytes: 1024 },
        projectId,
        undefined,
      ),
    ).toBeNull();
  });
});

describe("日志读取入口接真实服务端形状", () => {
  it("按 executionId 找到 Machine 后调用一次 transport，并原样返回结果", async () => {
    const calls: ExecutionLogReadInput[] = [];
    const view = logView("exe_00000000-0000-4000-8000-000000000000");
    const read = executionLogReader(
      {
        projectId,
        machineIdOf: (executionId) => (executionId === view.executionId ? machineId : null),
      },
      async (input) => {
        calls.push(input);
        return { ok: true, data: view, requestId: "req_test" };
      },
    );
    const result = await read({ executionId: view.executionId, cursor: null, limitBytes: 65536 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.machineId).toBe(machineId);
    expect(calls[0]?.limitBytes).toBe(EXECUTION_LOG_PAGE_BYTES);
    expect(result.ok && result.data).toEqual(view);
  });

  it("反证：页面没有这条执行的归属时不发请求，返回 not_found 而不是空页", async () => {
    let calls = 0;
    const read = executionLogReader({ projectId, machineIdOf: () => undefined }, async () => {
      calls += 1;
      return { ok: true, data: logView("exe_x"), requestId: "req_test" };
    });
    const result = await read({
      executionId: "exe_00000000-0000-4000-8000-000000000000",
      cursor: null,
      limitBytes: 32768,
    });
    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe("not_found");
  });
});

describe("取消入口的幂等键", () => {
  it("每次用户动作生成一个 requestId，拿到结论后下一次点击换新键", async () => {
    const seen: string[] = [];
    let n = 0;
    const cancel = executionCanceller(
      async (input) => {
        seen.push(input.requestId);
        return { ok: true, data: cancellation(input.executionId), requestId: "req_test" };
      },
      () => `req_${++n}`,
    );
    await cancel("exe_00000000-0000-4000-8000-000000000000");
    await cancel("exe_00000000-0000-4000-8000-000000000000");
    expect(seen).toEqual(["req_1", "req_2"]);
  });

  it("反证：没收到服务端结论（抛错）的重试复用同一个 requestId", async () => {
    const seen: string[] = [];
    let attempt = 0;
    const cancel = executionCanceller(
      async (input) => {
        seen.push(input.requestId);
        attempt += 1;
        if (attempt === 1) throw new Error("network down");
        return { ok: true, data: cancellation(input.executionId), requestId: "req_test" };
      },
      () => `req_${attempt + 1}`,
    );
    await expect(cancel("exe_00000000-0000-4000-8000-000000000000")).rejects.toThrow(
      "network down",
    );
    await cancel("exe_00000000-0000-4000-8000-000000000000");
    expect(seen[0]).toBe(seen[1]);
  });

  it("服务端拒绝也是一次结论：下一次点击不重放旧键", async () => {
    const seen: string[] = [];
    let n = 0;
    const cancel = executionCanceller(
      async (input) => {
        seen.push(input.requestId);
        return {
          ok: false,
          error: {
            code: "cancellation_already_terminal",
            message: "执行已到终态",
            requestId: "req_test",
          },
          requestId: "req_test",
        };
      },
      () => `req_${++n}`,
    );
    await cancel("exe_00000000-0000-4000-8000-000000000000");
    await cancel("exe_00000000-0000-4000-8000-000000000000");
    expect(seen).toEqual(["req_1", "req_2"]);
  });
});

describe("取消事实合并", () => {
  const records = demoExecutionRecords;
  const [first, second] = records;

  it("初值取服务端返回的取消事实，没有取消的执行不进 map", () => {
    const executions = records.map((execution, index) => ({
      ...execution,
      cancellation: index === 0 ? cancellation(execution.executionId) : null,
    }));
    const merged = mergeExecutionCancellations({}, executions);
    expect(Object.keys(merged ?? {})).toEqual([first?.executionId]);
    expect(merged?.[first!.executionId]?.state).toBe("requested");
  });

  it("本地刚收到的取消视图优先，刷新带回来的旧事实不覆盖它", () => {
    const executions = records.map((execution, index) => ({
      ...execution,
      cancellation:
        index === 0 ? cancellation(execution.executionId, { state: "requested" }) : null,
    }));
    const local = {
      [first!.executionId]: cancellation(first!.executionId, {
        state: "exited_observed" as const,
        exitedAt: "2026-10-24T00:00:05.000Z",
      }),
    };
    expect(mergeExecutionCancellations(local, executions)).toBeNull();
  });

  it("没有新事实时返回 null，避免多余渲染", () => {
    expect(
      mergeExecutionCancellations(
        {},
        records.map((e) => ({ ...e, cancellation: null })),
      ),
    ).toBe(null);
  });

  it("第二条执行的取消事实会被补进已有 map", () => {
    const executions = records.slice(0, 2).map((execution, index) => ({
      ...execution,
      cancellation: cancellation(execution.executionId, {
        state: index === 0 ? "requested" : "delivered",
      }),
    }));
    const merged = mergeExecutionCancellations(
      { [first!.executionId]: cancellation(first!.executionId) },
      executions,
    );
    expect(merged?.[second!.executionId]?.state).toBe("delivered");
    expect(merged?.[first!.executionId]?.state).toBe("requested");
  });
});
