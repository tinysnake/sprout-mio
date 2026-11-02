import { beforeEach, describe, expect, it } from "vite-plus/test";
import { RUN_ACTIVITY_ENTRY_LIMIT } from "../src/contracts/agent-run";
import { describeToolCall } from "../src/lib/run-activity";
import {
  clearRunActivity,
  readRunActivity,
  recordRunActivity,
  reduceRunActivity,
} from "../src/server/pi-host/run-activity";
import { piHostEvent } from "../src/server/pi-host/protocol";
import type { PiHostProgress } from "../src/server/pi-host/protocol";

const at = Date.parse("2026-11-02T12:00:00.000Z");

function progress(overrides: Partial<PiHostProgress>): PiHostProgress {
  return { type: "progress", id: "run_11111111", kind: "tool_start", ...overrides };
}

function start(
  toolCallId: string,
  toolName: string,
  label: string,
  detail?: string,
): PiHostProgress {
  const activity = { kind: "bash" as const, label, ...(detail ? { detail } : {}), toolName };
  return progress({ kind: "tool_start", toolCallId, toolName, activity });
}

describe("工具调用摘要", () => {
  it("Bash 只取命令首行并压成一行", () => {
    const described = describeToolCall("bash", {
      command: "pnpm test\npnpm typecheck",
    });
    expect(described.kind).toBe("bash");
    expect(described.label).toBe("Bash 命令");
    expect(described.detail).toBe("pnpm test");
  });

  it("文件路径缩成仓库内相对路径", () => {
    const described = describeToolCall(
      "read",
      { path: "/Users/snake/workspace/sprout-mio/src/contracts/agent-run.ts" },
      { cwd: "/Users/snake/workspace/sprout-mio" },
    );
    expect(described.label).toBe("读取文件");
    expect(described.detail).toBe("src/contracts/agent-run.ts");
  });

  it("MCP 工具拆出 server 与 tool，并带上第一个可读参数", () => {
    const described = describeToolCall("mcp__sentry__list_issues", {
      query: "is:unresolved",
    });
    expect(described.kind).toBe("mcp");
    expect(described.detail).toBe("sentry · list_issues · is:unresolved");
  });

  it("Code Mode 的嵌套调用保留内层动作名", () => {
    const described = describeToolCall("bash", { command: "rg --files" }, { nested: true });
    expect(described.kind).toBe("code_mode");
    expect(described.label).toBe("Code Mode · Bash 命令");
    expect(described.detail).toBe("rg --files");
  });

  it("未知工具不丢事件，回落到工具名或第一个字符串参数", () => {
    expect(describeToolCall("some_new_tool", {}).detail).toBe("some_new_tool");
    expect(describeToolCall("some_new_tool", { description: "整理报告" }).detail).toBe("整理报告");
  });

  it("超长摘要统一截断，避免把整段脚本文本塞进状态", () => {
    const described = describeToolCall("bash", { command: `echo ${"x".repeat(400)}` });
    expect(described.detail?.length).toBe(160);
    expect(described.detail?.endsWith("…")).toBe(true);
  });
});

describe("活动记录", () => {
  it("tool_start 建立当前步骤，tool_end 用真实耗时收进记录", () => {
    const running = reduceRunActivity(
      undefined,
      start("call_1", "bash", "Bash 命令", "pnpm test"),
      at,
    );
    expect(running?.current?.status).toBe("running");
    expect(running?.entries[0]?.startedAt).toBe("2026-11-02T12:00:00.000Z");

    const done = reduceRunActivity(
      running,
      progress({
        kind: "tool_end",
        toolCallId: "call_1",
        toolName: "bash",
        isError: false,
        durationMs: 500,
      }),
      at + 500,
    );
    expect(done?.current).toBeNull();
    expect(done?.entries[0]).toMatchObject({
      id: "call_1",
      status: "done",
      durationMs: 500,
      detail: "pnpm test",
    });
  });

  it("没有 durationMs 时按开始时间计算；失败步骤标记 error", () => {
    const running = reduceRunActivity(undefined, start("call_2", "read", "读取文件", "a.ts"), at);
    const failed = reduceRunActivity(
      running,
      progress({ kind: "tool_end", toolCallId: "call_2", isError: true }),
      at + 1200,
    );
    expect(failed?.entries[0]).toMatchObject({ status: "error", durationMs: 1200 });
  });

  it("漏掉 end 的下一个 start 会把旧步骤按完成收尾，不丢历史", () => {
    const first = reduceRunActivity(undefined, start("call_1", "bash", "Bash 命令"), at);
    const second = reduceRunActivity(first, start("call_2", "read", "读取文件", "b.ts"), at + 800);
    expect(second?.current?.id).toBe("call_2");
    expect(second?.entries[0]?.id).toBe("call_2");
    expect(second?.entries[1]).toMatchObject({ id: "call_1", status: "done", durationMs: 800 });
  });

  it("没看到 start 的 end 也留下一条已完成记录", () => {
    const ended = reduceRunActivity(
      undefined,
      progress({
        kind: "tool_end",
        toolCallId: "call_9",
        toolName: "bash",
        activity: { kind: "bash", label: "Bash 命令", toolName: "bash" },
        durationMs: 50,
      }),
      at,
    );
    expect(ended?.current).toBeNull();
    expect(ended?.entries[0]).toMatchObject({ id: "call_9", status: "done", durationMs: 50 });
  });

  it("结束事件可以收尾一个已被新步骤替换的旧记录", () => {
    const first = reduceRunActivity(undefined, start("call_1", "bash", "Bash 命令"), at);
    const second = reduceRunActivity(first, start("call_2", "read", "读取文件", "b.ts"), at + 10);
    const done = reduceRunActivity(
      second,
      progress({ kind: "tool_end", toolCallId: "call_1", isError: false, durationMs: 900 }),
      at + 900,
    );
    expect(done?.current?.id).toBe("call_2");
    expect(done?.entries.find((entry) => entry.id === "call_1")).toMatchObject({
      status: "done",
      durationMs: 900,
    });
  });

  it("assistant 文本不进入工作记录", () => {
    const previous = reduceRunActivity(undefined, start("call_1", "bash", "Bash 命令"), at);
    const next = reduceRunActivity(
      previous,
      progress({ kind: "text_delta", text: "我正在检查测试文件" }),
      at + 10,
    );
    expect(next).toBeUndefined();
    expect(previous?.entries).toHaveLength(1);
  });

  it("MCP 工具面刷新失败作为独立错误记录", () => {
    const snapshot = reduceRunActivity(
      undefined,
      progress({
        kind: "mcp_surface_failed",
        message: "工具目录未刷新",
      }),
      at,
    );
    expect(snapshot?.entries[0]).toMatchObject({
      kind: "mcp",
      status: "error",
      detail: "工具目录未刷新",
    });
  });

  it("不再只保留 3/5 条，普通 run 的全部记录都在", () => {
    let snapshot = reduceRunActivity(undefined, start("call_0", "bash", "Bash 命令"), at);
    for (let index = 1; index <= 7; index += 1) {
      snapshot = reduceRunActivity(
        snapshot,
        start(`call_${index}`, "bash", "Bash 命令"),
        at + index * 10,
      );
    }
    expect(snapshot?.entries).toHaveLength(8);
    expect(snapshot?.entries[0]?.id).toBe("call_7");
    expect(snapshot?.entries[7]?.id).toBe("call_0");
  });

  it("超长 run 仍有上限，避免无限占用进程内存", () => {
    let snapshot = reduceRunActivity(undefined, start("call_0", "bash", "Bash 命令"), at);
    for (let index = 1; index <= RUN_ACTIVITY_ENTRY_LIMIT + 4; index += 1) {
      snapshot = reduceRunActivity(
        snapshot,
        start(`call_${index}`, "bash", "Bash 命令"),
        at + index * 10,
      );
    }
    expect(snapshot?.entries).toHaveLength(RUN_ACTIVITY_ENTRY_LIMIT);
    expect(snapshot?.entries[0]?.id).toBe(`call_${RUN_ACTIVITY_ENTRY_LIMIT + 4}`);
  });
});

describe("进程内活动存储", () => {
  const runId = "run_22222222";
  const at = 1_760_000_000_000;

  beforeEach(() => clearRunActivity(runId));

  it("写入后按 run 读取，未写入时为空", () => {
    expect(readRunActivity(runId)).toBeUndefined();
    recordRunActivity(runId, start("call_1", "bash", "Bash 命令", "pnpm test"), at);
    const activity = readRunActivity(runId);
    expect(activity?.current?.label).toBe("Bash 命令");
    expect(activity?.current?.detail).toBe("pnpm test");
    expect(activity?.entries).toHaveLength(1);
    expect(activity?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("收尾清除后不残留旧活动", () => {
    recordRunActivity(runId, start("call_1", "bash", "Bash 命令"), at);
    clearRunActivity(runId);
    expect(readRunActivity(runId)).toBeUndefined();
  });
});

describe("progress 协议", () => {
  it("接受活动描述与 tool_end 的结果字段", () => {
    const parsed = piHostEvent.safeParse(
      progress({
        kind: "tool_end",
        toolCallId: "call_1",
        toolName: "bash",
        activity: { kind: "bash", label: "Bash 命令", detail: "pnpm test", toolName: "bash" },
        isError: false,
        durationMs: 500,
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("接受 mcp_surface_failed，不再静默丢弃这条事件", () => {
    const parsed = piHostEvent.safeParse(
      progress({ kind: "mcp_surface_failed", message: "工具目录未刷新" }),
    );
    expect(parsed.success).toBe(true);
  });
});
