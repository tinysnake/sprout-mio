import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRunsView } from "../src/contracts/info-hub";
import { RunFactsBlock } from "../src/components/info-hub/run-facts";

/**
 * Human 在最终评审里要求「完成在前，失败在后，完成数用绿色，失败数用红色」。
 * 断言渲染出来的页面顺序与着色，而不是断言源码里有一行排序代码。
 */
const run = (status: AgentRunsView["recent"][number]["status"], runId: string) => ({
  runId,
  status,
  queuedAt: "2026-10-30T00:00:00.000Z",
  requestId: `req_${runId}`,
  pendingInputs: 0,
});

const view: AgentRunsView = {
  available: true,
  hostEnabled: true,
  active: [],
  recent: [
    run("failed", "run_1"),
    run("completed", "run_2"),
    run("failed", "run_3"),
    run("aborted", "run_4"),
    run("completed", "run_5"),
  ],
};

const markup = renderToStaticMarkup(
  createElement(RunFactsBlock, { runs: view, testId: "info-hub-project-runs" }),
);

describe("run 聚合汇总行", () => {
  it("完成在前、失败在后，其余状态保持中性并夹在中间", () => {
    const completed = markup.indexOf("已完成 2");
    const aborted = markup.indexOf("已停止 1");
    const failed = markup.indexOf("失败 2");
    expect(completed).toBeGreaterThan(-1);
    expect(failed).toBeGreaterThan(-1);
    expect(completed).toBeLessThan(aborted);
    expect(aborted).toBeLessThan(failed);
  });

  it("只用颜色区分成功与失败", () => {
    expect(markup).toMatch(/text-status-success[^"]*"[^>]*>已完成 2/);
    expect(markup).toMatch(/text-destructive[^"]*"[^>]*>失败 2/);
    expect(markup).not.toMatch(/text-status-success[^"]*"[^>]*>已停止/);
  });

  it("没有历史 run 时不留空汇总", () => {
    const empty = renderToStaticMarkup(
      createElement(RunFactsBlock, {
        runs: { available: true, hostEnabled: false, active: [], recent: [] },
        testId: "info-hub-project-runs",
      }),
    );
    expect(empty).toContain("还没有历史 run。");
  });
});
