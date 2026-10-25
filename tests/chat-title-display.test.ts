import { describe, expect, it } from "vite-plus/test";
import {
  CHAT_AGENT_FALLBACK,
  chatDisplayName,
  chatSubtitleLabel,
} from "../src/components/chat/chat-display";
import { chatAgentName } from "../src/components/chat/chat-list";

const CHAT_ID = "cnv_11111111-1111-4111-8111-111111111111";
const PROFILE_ID = "agp_22222222-2222-4222-8222-222222222222";

describe("Chat 展示名", () => {
  it("有人工标题时显示标题", () => {
    expect(chatDisplayName({ title: "仓库首页架构评审" }, "Amenda")).toBe("仓库首页架构评审");
  });

  it("没有标题时回落到参与分身名，而不是裸 chat id", () => {
    const name = chatDisplayName({}, "Amenda");
    expect(name).toBe("Amenda");
    expect(name).not.toBe(CHAT_ID);
    expect(name).not.toMatch(/^cnv_/);
  });

  it("标题只剩空白时同样回落，不显示空标题", () => {
    expect(chatDisplayName({ title: "   " }, "Amenda")).toBe("Amenda");
  });

  it("分身名也缺失时退回通用名，不退回任何一个裸 id", () => {
    const name = chatDisplayName({}, "  ");
    expect(name).toBe(CHAT_AGENT_FALLBACK);
    expect(name).not.toMatch(/^(cnv|agp)_/);
  });

  it("列表副行在有标题时给出对话对象，没有标题时为 DM", () => {
    expect(chatSubtitleLabel({ title: "迁移顺序拆解" }, "Amenda")).toBe("Amenda");
    expect(chatSubtitleLabel({}, "Amenda")).toBe("DM");
  });

  it("列表的分身名在 profile 名缺失时退回通用名，不把裸 profile id 当文案", () => {
    const chatAgents = [{ chatId: CHAT_ID, agentProfileId: PROFILE_ID }];
    expect(chatAgentName(CHAT_ID, chatAgents, new Map())).toBe(CHAT_AGENT_FALLBACK);
    expect(chatAgentName(CHAT_ID, chatAgents, new Map([[PROFILE_ID, "Amenda"]]))).toBe("Amenda");
    expect(chatAgentName(CHAT_ID, [], new Map())).toBe(CHAT_AGENT_FALLBACK);
  });
});
