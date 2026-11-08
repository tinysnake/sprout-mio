import { describe, expect, it } from "vite-plus/test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ChatRunState, RunActivity, RunActivityStep } from "../src/contracts/agent-run";
import type { Message } from "../src/contracts/chat";
import { MessageList } from "../src/components/chat/message-list";
import { RunStatusPanel } from "../src/components/chat/run-status";
import { WakeDiagnostic } from "../src/components/continuation/wake-diagnostic";
import { ContinuationDiagnostic } from "../src/components/continuation/continuation-diagnostic";
import { continuationFixture } from "./fixtures/p6a-pages";
import { renderWithRouter } from "./fixtures/router-ssr";

function record(assistantMessageId: string, activity: RunActivity) {
  return {
    runId: "run_e4d46820",
    instanceId: "ain_test",
    assistantMessageId,
    status: "completed" as const,
    activity,
  };
}

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
describe("对话接续状态", () => {
  const empty: ChatRunState = { enabled: true, active: [], latest: null, inputs: [] };
  const at = "2026-11-02T12:00:00.000Z";
  const read = (name: Parameters<typeof continuationFixture>[0]) => ({
    ok: true as const,
    data: { view: continuationFixture(name), allowedActions: [], denials: {} },
    requestId: "req_11111111",
  });

  it("没有 run 时也显示对话接续的下一次检查", () => {
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        state: empty,
        messages: [],
        continuation: read("scheduled"),
      }),
    );
    expect(html).toContain('data-testid="continuation-status"');
    expect(html).toContain("对话接续");
    expect(html).toContain("已安排下次检查");
    expect(html).toContain("下次检查");
  });

  it("检查失败显示需要处理，不冒充本轮无需接续", () => {
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: empty, messages: [], continuation: read("failure") }),
    );
    expect(html).toContain("需要处理");
    expect(html).toContain("判定器超时");
    expect(html).toContain('data-error-code="provider_timeout"');
    expect(html).not.toContain("本轮无需接续");
  });

  it("关闭后只陈述关闭，不展示下次检查", () => {
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: empty, messages: [], continuation: read("off") }),
    );
    expect(html).toContain("已关闭");
    expect(html).toContain("不会安排新的自动检查");
    expect(html).not.toContain("下次检查");
  });

  it("消息尾部只有一行状态，检查记录不往那儿堆", () => {
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: empty, messages: [], continuation: read("failure") }),
    );
    expect(html).toContain('data-testid="continuation-status"');
    expect(html).not.toContain('data-testid="continuation-lines"');
    expect(html).not.toContain('data-testid="continuation-activity"');
  });

  it("判定进行中显示转圈，不报已经等了多少秒", () => {
    const base = continuationFixture("idle");
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        state: empty,
        messages: [],
        continuation: {
          ok: true as const,
          data: {
            view: {
              ...base,
              latestEvaluation: {
                evaluationId: "evaluation-running",
                source: "message" as const,
                state: "claimed" as const,
                round: 4,
                attempt: 1,
                claimedAt: at,
                finishedAt: null,
                evaluatedAt: null,
                nextAttemptAt: null,
                result: null,
                errorCode: null,
                usage: null,
              },
              recentRounds: [
                {
                  evaluationId: "evaluation-running",
                  round: 4,
                  source: "message" as const,
                  state: "claimed" as const,
                  evaluatedAt: null,
                  result: null,
                  errorCode: null,
                  attempts: [
                    {
                      attempt: 1,
                      startedAt: at,
                      finishedAt: null,
                      outcome: null,
                      errorCode: null,
                      usage: null,
                    },
                  ],
                },
              ],
            },
            allowedActions: [],
            denials: {},
          },
          requestId: "req_11111111",
        },
      }),
    );
    expect(html).toContain('data-testid="continuation-spinner"');
    expect(html).toContain("正在检查");
    expect(html).not.toContain("已等待");
  });

  it("判定不借用对话接续的名字", () => {
    const view = continuationFixture("idle");
    view.latestEvaluation = {
      evaluationId: "evaluation-claimed",
      source: "message",
      state: "claimed",
      round: 2,
      attempt: 1,
      claimedAt: at,
      finishedAt: null,
      evaluatedAt: null,
      nextAttemptAt: null,
      result: null,
      errorCode: null,
      usage: null,
    };
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, {
        state: empty,
        messages: [],
        continuation: {
          ok: true as const,
          data: { view, allowedActions: [], denials: {} },
          requestId: "req_11111111",
        },
      }),
    );
    expect(html).toContain('data-subject="唤醒判定"');
    expect(html).toContain("唤醒判定：");
    expect(html).toContain("正在检查");
    // 判定正在检查时，页面不许把这行说成对话接续。
    expect(html).not.toContain("对话接续：正在检查");
  });

  it("选中的检查轮次把逐次尝试列在唤醒诊断正文里", () => {
    const view = continuationFixture("failure");
    const html = renderToStaticMarkup(
      createElement(WakeDiagnostic, { view, round: view.recentRounds[0] }),
    );
    expect(html).toContain("本轮信息");
    expect(html).toContain("第 1 轮检查");
    expect(html).toContain('data-testid="continuation-lines"');
  });

  it("一次检查花了多久、用了多少 token 都写在记录里", () => {
    const view = continuationFixture("failure");
    const rounds = [
      {
        evaluationId: "evaluation-usage",
        round: 3,
        source: "task_periodic" as const,
        state: "decided" as const,
        evaluatedAt: "2026-11-02T12:00:05.000Z",
        result: null,
        errorCode: null,
        attempts: [
          {
            attempt: 1,
            startedAt: "2026-11-02T12:00:00.000Z",
            finishedAt: "2026-11-02T12:00:04.200Z",
            outcome: "decided" as const,
            errorCode: null,
            usage: {
              inputTokens: 900,
              outputTokens: 32,
              inputCharacters: 3400,
              durationMs: 4200,
              resolvedModel: "fixture/model",
            },
          },
        ],
      },
    ];
    const html = renderToStaticMarkup(
      createElement(WakeDiagnostic, { view: { ...view, recentRounds: rounds }, round: rounds[0] }),
    );
    expect(html).toContain("第 3 轮检查");
    expect(html).toContain("932 tok \u00b7 4.2 \u79d2");
  });

  it("还在进行的尝试写明进行中，不编造时长", () => {
    const view = continuationFixture("failure");
    const html = renderToStaticMarkup(
      createElement(WakeDiagnostic, {
        view,
        round: {
          evaluationId: "evaluation-claimed",
          round: 2,
          source: "task_periodic" as const,
          state: "claimed" as const,
          evaluatedAt: null,
          result: null,
          errorCode: null,
          attempts: [
            {
              attempt: 1,
              startedAt: "2026-11-02T12:00:00.000Z",
              finishedAt: null,
              outcome: null,
              errorCode: null,
              usage: null,
            },
          ],
        },
      }),
    );
    expect(html).toContain("\u8fdb\u884c\u4e2d");
    expect(html).not.toContain("4.2 \u79d2");
  });

  it("没有任何检查记录时不渲染空列表", async () => {
    const html = await renderWithRouter(
      createElement(ContinuationDiagnostic, {
        data: { view: continuationFixture("scheduled"), denials: {} },
        evaluationId: "missing",
        kind: "wake",
        chatTitle: "对话",
      }),
    );
    expect(html).toContain("尚无检查记录");
    expect(html).not.toContain('data-testid="continuation-lines"');
  });
});

describe("已结束 run 的工作记录", () => {
  const message = (
    overrides: Partial<Extract<Message, { senderKind: "agent" | "human" }>> = {},
  ): Message => ({
    id: "msg_11111111",
    chatId: "cnv_11111111",
    senderKind: "agent",
    senderId: "ins_11111111",
    body: "第一轮完成",
    createdAt: "2026-11-02T12:00:06.000Z",
    skills: [],
    mentions: [],
    ...overrides,
  });
  const assistant = message();
  const human = message({
    id: "msg_22222222",
    senderKind: "human",
    senderId: "usr_11111111",
    body: "继续",
  });
  const settled: RunActivity = {
    current: null,
    entries: [2, 1, 0].map((index) => step(index)),
    updatedAt: "2026-11-02T12:00:05.000Z",
  };
  const html = renderToStaticMarkup(
    createElement(MessageList, {
      messages: [human, assistant],
      profile: null,
      humanName: "Human",
      runActivityByMessage: new Map([
        [assistant.id, record(assistant.id, settled)],
        [human.id, record(human.id, settled)],
      ]),
    }),
  );

  it("记录挂在产出它的 assistant 消息底部，不随 run 结束消失", () => {
    expect(html).toContain('data-testid="message-run-activity"');
    expect(html).toContain('data-testid="run-activity"');
    expect(html.indexOf("第一轮完成")).toBeLessThan(
      html.indexOf('data-testid="message-run-activity"'),
    );
    expect(html).toContain("3 条");
  });

  it.each([
    { kind: "project_webhook", triggerId: "wht_11111111" } as const,
    {
      kind: "project_cron",
      triggerId: "wht_11111111",
      expression: "0 9 * * *",
      timezone: "UTC",
      instruction: "Check @Agent /skill:danger",
      scheduledAt: null,
      mode: "trial",
    } as const,
  ])("系统来源 $kind 不冒用 Agent 人设或回复运行记录", (automationSource) => {
    const source: Message = {
      id: "msg_33333333",
      chatId: human.chatId,
      body: "Webhook event",
      createdAt: human.createdAt,
      mentions: [],
      skills: [],
      senderKind: "automation",
      senderId: "wht_11111111",
      automationSource,
    };
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        messages: [source],
        profile: {
          ok: true,
          requestId: "req_11111111",
          data: {
            id: "agt_11111111",
            name: "Worker",
            persona: "Worker persona",
            harness: "pi",
            purpose: "worker",
            createdBy: "user",
            createdAt: source.createdAt,
            updatedAt: source.createdAt,
          },
        },
        humanName: "Human",
        runActivityByMessage: new Map([[source.id, record(source.id, settled)]]),
      }),
    );
    expect(html).toContain(
      automationSource.kind === "project_cron" ? "Project cron" : "Project webhook",
    );
    expect(html).toContain("Source");
    expect(html).not.toContain("Worker persona");
    expect(html).not.toContain('data-testid="message-run-links"');
    expect(html).not.toContain('data-testid="message-run-activity"');
  });

  it("human 消息不承接 run 记录", () => {
    const humanOnly = renderToStaticMarkup(
      createElement(MessageList, {
        messages: [human],
        profile: null,
        humanName: "Human",
        runActivityByMessage: new Map([[human.id, record(human.id, settled)]]),
      }),
    );
    expect(humanOnly).not.toContain('data-testid="message-run-activity"');
  });

  it("持久化记录提供归属时不再声称“未关联 run”", () => {
    const html = renderToStaticMarkup(
      createElement(MessageList, {
        messages: [assistant],
        profile: null,
        humanName: "Human",
        runFacts: new Map(),
        runActivityByMessage: new Map([[assistant.id, record(assistant.id, settled)]]),
      }),
    );
    expect(html).toContain("run_e4d46820");
    expect(html).not.toContain("未关联 run");
  });

  it("已结束的失败 run 也保留可回看的记录", () => {
    const failed: ChatRunState = {
      enabled: true,
      active: [],
      latest: {
        ...stateWith().latest!,
        status: "failed",
        errorCode: "tool_failed",
        errorMessage: "boom",
        activity,
      },
      inputs: [],
    };
    const panel = renderToStaticMarkup(
      createElement(RunStatusPanel, { state: failed, messages: [] }),
    );
    expect(panel).toContain('data-testid="run-failure"');
    expect(panel).toContain("pnpm test --filter case-5");
  });
});
