import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatRunState } from "../src/contracts/agent-run";
import { RunStatusPanel } from "../src/components/chat/run-status";

/**
 * 失败横幅是使用者看到的最后一块事实：文案与错误码足够定位，`requestId` 属于内部标识（裁定 d43）。
 * 这里渲染真实组件而不是 grep 源码，断言的是「页面输出」而不是「有一行代码没写」。
 */
const state: ChatRunState = {
  enabled: true,
  runs: [
    {
      id: "run_11111111-1111-4111-8111-111111111111",
      instanceId: "ins_11111111-1111-4111-8111-111111111111",
      chatId: "cnv_11111111-1111-4111-8111-111111111111",
      projectId: "prj_11111111-1111-4111-8111-111111111111",
      requestId: "req_11111111-1111-4111-8111-111111111111",
      status: "failed",
      queuedAt: "2026-10-30T00:00:00.000Z",
      errorCode: "host_failed",
      errorMessage: "宿主进程异常退出",
      sessionId: "session-1",
    },
  ],
  inputs: [],
};

describe("失败横幅不显示内部请求标识", () => {
  const html = renderToStaticMarkup(createElement(RunStatusPanel, { state, messages: [] }));

  it("渲染结果里没有 requestId 字段与 req_ 前缀", () => {
    expect(html).not.toContain("requestId");
    expect(html).not.toMatch(/req_[0-9a-f-]{36}/);
    expect(html).not.toContain(state.runs[0].requestId);
  });

  it("保留失败文案与错误码，人还能据此定位", () => {
    expect(html).toContain("宿主进程异常退出");
    expect(html).toContain("host_failed");
    expect(html).toContain('data-error-code="host_failed"');
    expect(html).toContain('data-testid="run-failure"');
  });
});
