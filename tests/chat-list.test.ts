import { describe, expect, it } from "vite-plus/test";
import type { Chat, ChatKind } from "../src/contracts/chat";
import { chatListChats } from "../src/components/chat/chat-list";

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
