import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, ChatResult, Message } from "../../contracts/chat";
import type { ChatInfoView, InfoHubResult, TurnStartContext } from "../../contracts/info-hub";
import type { AppError, AppResult } from "../../contracts/result";

/** 列表里的每条 DM 关联到它的分身 profile。 */
export type ChatAgent = { chatId: string; agentProfileId?: string };

/** 父 Chats 路由的列表数据：列表与详情共用，详情不再单独取一次列表。 */
export type ChatsLoaderData = {
  chats: AppResult<Chat[]>;
  members: AppResult<ProjectMember[]>;
  profiles: AppResult<AgentProfile[]>;
  chatAgents: ChatAgent[];
};

/** 详情数据：身份、消息、Info Hub 与 run 状态各自带成功或失败，逐块呈现。 */
export type ChatDetailLoaderData =
  | { ok: false; error: AppError }
  | {
      ok: true;
      chat: Chat;
      members: ChatResult<ChatMember[]>;
      instances: ChatResult<AgentInstance[]>;
      messages: ChatResult<Message[]>;
      profile: AgentResult<AgentProfile> | null;
      info: ChatResult<ChatInfoView>;
      turnStart: InfoHubResult<TurnStartContext>;
      runState: AgentRunResult<ChatRunState>;
    };

/** 分身身份优先取 instance 的 profile，其次取成员表里的 agent 成员。 */
export function resolveAgentProfileId(
  instances: ChatResult<AgentInstance[]>,
  members: ChatResult<ChatMember[]>,
): string | undefined {
  const fromInstance = instances.ok ? instances.data[0]?.agentProfileId : undefined;
  if (fromInstance) return fromInstance;
  if (!members.ok) return undefined;
  return members.data.find((member) => member.memberKind === "agent")?.memberId;
}

/** 展示名来自 profile；profile 缺失或失败时退回 id 或通用名。 */
export function agentDisplayName(
  profile: AgentResult<AgentProfile> | null,
  fallback?: string,
): string {
  if (profile?.ok) return profile.data.name;
  return fallback ?? "Agent";
}
