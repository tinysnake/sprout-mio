import { describe, expect, it } from "vite-plus/test";
import { createChatUnreadTracker } from "../src/components/chat/chat-unread-tracker";
import type { ChatUnreadItem } from "../src/contracts/chat-read";

const item = (chatId: string, lastMessageId: string, unreadCount = 1): ChatUnreadItem => ({
  chatId,
  unreadCount,
  lastMessage: {
    id: lastMessageId,
    senderLabel: "助理",
    preview: "预览",
    createdAt: "2026-06-18T00:00:00.000Z",
  },
});

describe("chat 未读 tracker", () => {
  it("seed 过的未读不提醒，新 lastMessage 才提醒", () => {
    const tracker = createChatUnreadTracker();
    tracker.seed([item("cnv_a", "msg_1")]);
    expect(tracker.next([item("cnv_a", "msg_1")])).toEqual([]);
    expect(tracker.next([item("cnv_a", "msg_2")]).map((entry) => entry.lastMessage?.id)).toEqual([
      "msg_2",
    ]);
  });

  it("同一条消息只变未读数不重复提醒", () => {
    const tracker = createChatUnreadTracker();
    tracker.seed([item("cnv_a", "msg_1", 1)]);
    expect(tracker.next([item("cnv_a", "msg_1", 5)])).toEqual([]);
    expect(tracker.next([item("cnv_a", "msg_1", 9)])).toEqual([]);
  });

  it("基线里没有的对话也算新消息", () => {
    const tracker = createChatUnreadTracker();
    tracker.seed([item("cnv_a", "msg_1")]);
    const fresh = tracker.next([item("cnv_a", "msg_1"), item("cnv_b", "msg_9")]);
    expect(fresh.map((entry) => entry.chatId)).toEqual(["cnv_b"]);
  });

  it("activeChatId 命中的对话不提醒，但仍更新基线（不会下一轮补提醒）", () => {
    const tracker = createChatUnreadTracker();
    tracker.seed([]);
    expect(tracker.next([item("cnv_a", "msg_1")], { activeChatId: "cnv_a" })).toEqual([]);
    expect(tracker.next([item("cnv_a", "msg_1")], { activeChatId: "cnv_a" })).toEqual([]);
    expect(tracker.next([item("cnv_a", "msg_1")])).toEqual([]);
  });

  it("条目消失即从基线移除，读完再来的新消息仍会提醒", () => {
    const tracker = createChatUnreadTracker();
    tracker.seed([item("cnv_a", "msg_1")]);
    expect(tracker.next([])).toEqual([]);
    expect(tracker.next([item("cnv_a", "msg_1")]).map((entry) => entry.chatId)).toEqual(["cnv_a"]);
  });
});
