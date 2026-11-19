import { describe, expect, it } from "vite-plus/test";
import type { Chat, ChatKind } from "../src/contracts/chat";
import {
  chatListChats,
  mostRecentOutOfViewUnread,
  type ChatListVisibilityItem,
} from "../src/components/chat/chat-list";

function chat(id: string, kind: ChatKind): Chat {
  return {
    id,
    projectId: "prj_one",
    kind,
    crewEpoch: 0,
    owner: { kind: "human", id: "usr_one" },
    governanceRevision: 0,
    createdBy: "usr_one",
    createdAt: "2026-11-15T00:00:00.000Z",
    updatedAt: "2026-11-15T00:00:00.000Z",
  };
}

describe("聊天列表不重复显示委派子对话", () => {
  it("保留 DM 与 Crew，只从列表移除 delegation", () => {
    expect(
      chatListChats([
        chat("cnv_dm", "dm"),
        chat("cnv_crew", "crew"),
        chat("cnv_child", "delegation"),
      ]).map((item) => item.kind),
    ).toEqual(["dm", "crew"]);
  });

  it("只有子对话时列表为空，不伪造一行", () => {
    expect(chatListChats([chat("cnv_child", "delegation")])).toEqual([]);
    expect(chatListChats([])).toEqual([]);
  });
});

// 可见框固定为 100–300，坐标按「列表从上到下 = 最近活动到最旧」传入。
const VIEWPORT = { top: 100, bottom: 300 };

function item(chatId: string, top: number, bottom: number, unread = true): ChatListVisibilityItem {
  return { chatId, top, bottom, unread };
}

describe("总体未读提示只在未读项完全离开可见框时出现", () => {
  it("未读项完全在框下方或上方都算不可见", () => {
    expect(mostRecentOutOfViewUnread([item("cnv_below", 310, 380)], VIEWPORT)).toBe("cnv_below");
    expect(mostRecentOutOfViewUnread([item("cnv_above", 20, 90)], VIEWPORT)).toBe("cnv_above");
  });

  it("只露出一半算在区域内，不提示", () => {
    expect(mostRecentOutOfViewUnread([item("cnv_partial", 270, 340)], VIEWPORT)).toBeNull();
    expect(mostRecentOutOfViewUnread([item("cnv_visible", 120, 180)], VIEWPORT)).toBeNull();
  });

  it("未读都在可见框内时不提示", () => {
    expect(
      mostRecentOutOfViewUnread([item("cnv_a", 100, 160), item("cnv_b", 160, 220)], VIEWPORT),
    ).toBeNull();
  });

  it("取显示顺序里最近活动的那条，而不是离视口最近的那条", () => {
    expect(
      mostRecentOutOfViewUnread([item("cnv_recent", 20, 80), item("cnv_near", 310, 370)], VIEWPORT),
    ).toBe("cnv_recent");
  });

  it("跳过框外已读项，只看未读", () => {
    expect(
      mostRecentOutOfViewUnread(
        [item("cnv_read", 20, 80, false), item("cnv_unread", 310, 370)],
        VIEWPORT,
      ),
    ).toBe("cnv_unread");
  });

  it("空列表没有目标", () => {
    expect(mostRecentOutOfViewUnread([], VIEWPORT)).toBeNull();
  });
});
