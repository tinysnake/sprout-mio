import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatRunState, RunActivity, RunActivityStep } from "../src/contracts/agent-run";
import { RunStatusPanel } from "../src/components/chat/run-status";

function step(index: number, overrides: Partial<RunActivityStep> = {}): RunActivityStep {
  return {
    id: `call_${index}`,
    kind: "bash",
    label: "Bash 命令",
    detail: `pnpm test --filter case-${index}`,
    toolName: "bash",
    startedAt: `2026-11-02T12:00:0${index}.000Z`,
    status: "done",
    durationMs: 100 + index,
    ...overrides,
  };
}

const activity: RunActivity = {
  current: step(5, { status: "running", durationMs: undefined }),
  entries: [5, 4, 3, 2, 1, 0].map((index) => step(index)),
  updatedAt: "2026-11-02T12:00:05.000Z",
};

function stateWith(entries?: RunActivity): ChatRunState {
  return {
    enabled: true,
    active: [
      {
        id: "run_11111111",
        instanceId: "ins_11111111",
        status: "running",
        ...(entries ? { activity: entries } : {}),
      },
    ],
    latest: {
      id: "run_11111111",
      instanceId: "ins_11111111",
      chatId: "cnv_11111111",
      projectId: "prj_11111111",
      requestId: "req_11111111",
      status: "running",
      queuedAt: "2026-11-02T11:59:00.000Z",
      sessionId: "session-1",
    },
    inputs: [],
  };
}

describe("运行中工作记录组", () => {
  const html = renderToStaticMarkup(
    createElement(RunStatusPanel, { state: stateWith(activity), messages: [] }),
  );

  it("默认收起，只露出最后一条，并给出总数", () => {
    expect(html).toContain('data-testid="run-activity"');
    expect(html).not.toMatch(/<details[^>]*\sopen/);
    const summary = html.match(/data-testid="run-activity-last"[\s\S]*?<\/summary>/)?.[0] ?? "";
    expect(summary).toContain("pnpm test --filter case-5");
    expect(summary).not.toContain("case-4");
    expect(html).toContain("6 条");
  });

  it("展开内容包含本轮全部记录，最新在前", () => {
    for (let index = 0; index <= 5; index += 1) {
      expect(html).toContain(`pnpm test --filter case-${index}`);
    }
    expect(html.indexOf("case-4")).toBeLessThan(html.indexOf("case-3"));
    expect(html.indexOf("case-1")).toBeLessThan(html.indexOf("case-0"));
  });

  it("没有活动时不渲染空卡片", () => {
    const empty = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: stateWith(), messages: [] }),
    );
    expect(empty).not.toContain('data-testid="run-activity"');
  });
});

describe("群组按 Agent 展示运行状态", () => {
  const first = stateWith(activity).latest!;
  const second = { ...first, id: "run_22222222", instanceId: "ins_22222222" };
  const group: ChatRunState = {
    enabled: true,
    active: [
      { id: first.id, instanceId: first.instanceId, status: "running", activity },
      { id: second.id, instanceId: second.instanceId, status: "queued" },
    ],
    latest: second,
    inputs: [],
  };
  const names = new Map([
    [first.instanceId, "阿尔法"],
    [second.instanceId, "贝塔"],
  ]);
  const html = renderToStaticMarkup(
    createElement(RunStatusPanel, {
      state: group,
      messages: [],
      chatKind: "group",
      agentNames: names,
      onStopRun: () => undefined,
    }),
  );

  it("每个活动 run 一行，带 Agent 名、状态和独立停止按钮", () => {
    expect(html.match(/data-testid="agent-run-row"/g)).toHaveLength(2);
    expect(html).toContain("阿尔法");
    expect(html).toContain("贝塔");
    expect(html).toContain("运行中");
    expect(html).toContain("排队中");
    expect(html.match(/data-testid="agent-run-stop"/g)).toHaveLength(2);
    expect(html).toContain("2 个 Agent 进行中");
  });

  it("活动记录挂在所属 Agent 行内，没有活动时明确等待", () => {
    expect(html).toContain("pnpm test --filter case-5");
    expect(html).toContain("等待工具调用");
    expect(html.match(/data-testid="run-activity"/g)).toHaveLength(1);
  });

  it("没有逐 run 停止回调时不渲染停止按钮", () => {
    const readonly = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        state: group,
        messages: [],
        chatKind: "group",
        agentNames: names,
      }),
    );
    expect(readonly).not.toContain('data-testid="agent-run-stop"');
  });

  it("DM 仍保持单行状态，不渲染 Agent 行", () => {
    const dm = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: stateWith(activity), messages: [], chatKind: "dm" }),
    );
    expect(dm).not.toContain('data-testid="agent-run-row"');
    expect(dm).toContain("分身运行状态");
  });
});
