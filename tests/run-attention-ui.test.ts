import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vite-plus/test";
import type { ChatRunState } from "../src/contracts/agent-run";
import type { Message } from "../src/contracts/chat";
import { RUN_ATTENTION_SENDER_ID, type RunAttentionFacts } from "../src/contracts/run-attention";
import { RunStatusPanel, SelectedRunPanel } from "../src/components/chat/run-status";
import { MessageList } from "../src/components/chat/message-list";

const attention: RunAttentionFacts = {
  deadlineAt: "2026-11-11T00:30:00.000Z",
  humanReminderAt: "2026-11-11T01:00:00.000Z",
  attentionAt: "2026-11-11T00:30:01.000Z",
  humanRequiredAt: "2026-11-11T00:30:01.000Z",
  humanNotifiedAt: null,
  awaitingHandling: true,
  ownerAutoAttemptsPaused: false,
};
const run = {
  id: "run_11111111",
  instanceId: "ain_11111111",
  chatId: "cnv_11111111",
  projectId: "prj_11111111",
  requestId: "req_11111111",
  sessionId: "session-probe",
  status: "running" as const,
  queuedAt: "2026-11-11T00:00:00.000Z",
  attention,
};
const state: ChatRunState = { enabled: true, active: [run], latest: run, inputs: [] };

it("DM 和群组逐 run 呈现人类关注事实，运行和停止入口仍可见", () => {
  for (const chatKind of ["dm", "group"] as const) {
    const html = renderToStaticMarkup(
      createElement(RunStatusPanel, { state, messages: [], chatKind, onStopRun: () => {} }),
    );
    expect(html).toContain("需要人类关注");
    expect(html).toContain("运行中");
    expect(html).toContain(attention.attentionAt);
    expect(html).toContain(attention.humanReminderAt);
    if (chatKind === "group") expect(html).toContain('data-testid="agent-run-stop"');
  }
});
it("owner 通知与人类提醒区分，终态只保留历史标记", () => {
  const owner = { ...attention, humanRequiredAt: null, awaitingHandling: false };
  const ownerHtml = renderToStaticMarkup(
    createElement(SelectedRunPanel, {
      result: { ok: true, requestId: run.requestId, data: { ...run, attention: owner } },
    }),
  );
  expect(ownerHtml).toContain("已请 owner 关注");
  const escalated = {
    ...attention,
    humanNotifiedAt: attention.humanReminderAt,
    ownerAutoAttemptsPaused: true,
  };
  const activeHtml = renderToStaticMarkup(
    createElement(SelectedRunPanel, {
      result: { ok: true, requestId: run.requestId, data: { ...run, attention: escalated } },
    }),
  );
  expect(activeHtml).toContain("owner 自动重试已暂停");
  const history = renderToStaticMarkup(
    createElement(SelectedRunPanel, {
      result: {
        ok: true,
        requestId: run.requestId,
        data: { ...run, status: "completed", attention: { ...escalated, awaitingHandling: false } },
      },
    }),
  );
  expect(history).toContain("曾需要人类关注");
  expect(history).toContain("已完成");
  expect(history).not.toContain("owner 自动重试已暂停");
  expect(history).not.toContain("人类提醒时间");
});
it("新保留 sender 有独立名称，不冒充成员或历史发送者", () => {
  const message: Message = {
    id: "msg_11111111",
    attachments: [],
    attachmentSpans: [],
    chatId: run.chatId,
    senderKind: "agent",
    senderId: RUN_ATTENTION_SENDER_ID,
    body: "请关注 run",
    mentions: [],
    skills: [],
    createdAt: attention.humanReminderAt,
  };
  const html = renderToStaticMarkup(
    createElement(MessageList, {
      messages: [message],
      profile: null,
      humanName: "你",
      knownSenders: new Set<string>(),
    }),
  );
  expect(html).toContain("运行注意力提醒");
  expect(html).toContain("System");
  expect(html).not.toContain("历史发送者");
  expect(html).not.toContain("未关联 run");
});
