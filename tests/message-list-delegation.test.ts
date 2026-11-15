import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vite-plus/test";
import type { Message } from "../src/contracts/chat";
import { MessageList } from "../src/components/chat/message-list";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    className,
    ...props
  }: {
    children: React.ReactNode;
    className?: string;
    "data-testid"?: string;
  }) => createElement("a", { className, "data-testid": props["data-testid"] }, children),
}));

const message: Message = {
  id: "msg_card",
  chatId: "cnv_crew",
  senderKind: "delegation_event",
  senderId: "dlg_one",
  body: "已生成报告",
  createdAt: "2026-11-15T10:00:00.000Z",
  mentions: [],
  skills: [],
  attachments: [],
  attachmentSpans: [],
  delegation: {
    delegationId: "dlg_one",
    childChatId: "cnv_child",
    title: "检查迁移",
    status: "completed",
    workerProfileName: "Researcher",
    summary: "已生成报告",
    settledAt: "2026-11-15T10:00:00.000Z",
  },
};

it("在消息流中渲染可进入 subchat 的委派完成卡片", () => {
  const html = renderToStaticMarkup(
    createElement(MessageList, {
      projectId: "prj_test",
      messages: [message],
      profile: null,
      humanName: "你",
    }),
  );
  expect(html).toContain('data-testid="delegation-message"');
  expect(html).toContain("检查迁移");
  expect(html).toContain("执行者 Researcher");
  expect(html).toContain("已生成报告");
  expect(html).toContain("已完成");
});
