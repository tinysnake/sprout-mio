import { describe, expect, it } from "vite-plus/test";
import {
  agentDetailBackTarget,
  agentDetailFromChat,
  agentDetailSearchSchema,
} from "../src/components/agent/agent-detail-search";

const projectId = "prj_11111111-1111-4111-8111-111111111111";
const chatId = "cnv_22222222-2222-4222-9222-222222222222";

describe("Agent 详情返回来源", () => {
  it("从 chat 进入时保留该 chat 的 projectId 与 chatId，返回目标是同一个 chat", () => {
    const search = agentDetailSearchSchema.parse(agentDetailFromChat({ id: chatId, projectId }));
    expect(agentDetailBackTarget(search)).toEqual({ kind: "chat", projectId, chatId });
  });

  it("没有来源时返回 Agents 列表，不凭空造 chatId", () => {
    expect(agentDetailBackTarget(agentDetailSearchSchema.parse({}))).toEqual({ kind: "agents" });
    expect(agentDetailBackTarget(agentDetailSearchSchema.parse({ fromChatId: chatId }))).toEqual({
      kind: "agents",
    });
    expect(
      agentDetailBackTarget(agentDetailSearchSchema.parse({ fromProjectId: projectId })),
    ).toEqual({ kind: "agents" });
  });

  it("坏来源参数被丢弃而不是让 URL 解析失败", () => {
    const search = agentDetailSearchSchema.parse({
      fromProjectId: "not-a-project",
      fromChatId: "../other-chat",
    });
    expect(search).toEqual({ fromProjectId: undefined, fromChatId: undefined });
    expect(agentDetailBackTarget(search)).toEqual({ kind: "agents" });
  });

  it("前缀混用不作为可用的返回来源", () => {
    const search = agentDetailSearchSchema.parse({
      fromProjectId: chatId,
      fromChatId: projectId,
    });
    expect(agentDetailBackTarget(search)).toEqual({ kind: "agents" });
  });
});
