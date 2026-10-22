import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "../../contracts/ids";

/**
 * Agent 详情页的返回来源由 URL 表达：从 chat inspector 进来时带上该 chat 的
 * projectId 与 chatId，刷新、直接打开与前进后退都得到同一个返回目标。
 * 无法解析的值一律丢弃，退化为返回 Agents 列表，不凭空造一个 chatId。
 */
export const agentDetailSearchSchema = z.object({
  fromProjectId: z.string().regex(appIdPattern(ID_PREFIXES.project)).optional().catch(undefined),
  fromChatId: z.string().regex(appIdPattern(ID_PREFIXES.chat)).optional().catch(undefined),
});

export type AgentDetailSearch = z.infer<typeof agentDetailSearchSchema>;

/** 从 chat 进入 profile 时携带的返回来源。 */
export function agentDetailFromChat(chat: { id: string; projectId: string }): AgentDetailSearch {
  return { fromProjectId: chat.projectId, fromChatId: chat.id };
}

/** 返回目标：来源齐全才回 chat，否则回到 Agents 列表，不凭空造 chatId。 */
export type AgentDetailBackTarget =
  | { kind: "chat"; projectId: string; chatId: string }
  | { kind: "agents" };

export function agentDetailBackTarget(search: AgentDetailSearch): AgentDetailBackTarget {
  return search.fromProjectId && search.fromChatId
    ? { kind: "chat", projectId: search.fromProjectId, chatId: search.fromChatId }
    : { kind: "agents" };
}
