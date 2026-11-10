import { inArray } from "drizzle-orm";
import type {
  FeishuBindingView,
  FeishuConnectionSnapshot,
  FeishuTargetOption,
  FeishuTargetsView,
} from "../../contracts/feishu-channel";
import { db } from "../../db";
import { agentProfile } from "../../db/schema";
import { assistantSource, AssistantError } from "../../domain/assistant";
import { getChat, listChatMembers, listChats } from "../../domain/chat";
import { FeishuBindingError, getFeishuBinding, readFeishuChallenge } from "../../domain/feishu";
import type { ProjectContext } from "../../domain/project";
import { assertProjectAccess } from "../../domain/access";
import { channelRuntimeConfig, loadChannelConfigRow } from "../../domain/channel-config";

export function buildFeishuBindingView(input: {
  ctx: ProjectContext;
  projectId: string;
  connection: FeishuConnectionSnapshot;
  now?: Date;
}): FeishuBindingView {
  assertProjectAccess(input.ctx, input.projectId);
  const binding = getFeishuBinding(input.projectId, input.ctx);
  const route = binding.route;
  let target: FeishuBindingView["binding"]["target"] = null;
  if (route && route.projectId === input.projectId) {
    const chat = getChat(route.chatId, input.ctx);
    // DM 的 owner 是人类，参与分身要从有效成员里读，不能假定 owner 是 Agent。
    const agentIds = listChatMembers(route.chatId, input.ctx)
      .filter((member) => member.memberKind === "agent")
      .map((member) => member.memberId);
    const agents = agentIds.length
      ? db
          .select({ name: agentProfile.name })
          .from(agentProfile)
          .where(inArray(agentProfile.id, agentIds))
          .all()
      : [];
    target = {
      projectId: route.projectId,
      chatId: route.chatId,
      agentName: agents[0]?.name ?? null,
      chatTitle: chat.title ?? null,
    };
  }
  const challenge = readFeishuChallenge(input.projectId, input.ctx, input.now ?? new Date());
  return {
    adapter: "feishu",
    configured: channelRuntimeConfig(loadChannelConfigRow(input.projectId, "feishu")) !== null,
    connection: {
      phase: input.connection.phase,
      generation: input.connection.generation,
      epochId: input.connection.epochId,
    },
    binding: { revision: binding.revision, bound: binding.bound, target },
    challenge,
    humanNeedsConfirmation: !binding.bound && challenge !== null,
  };
}

/**
 * 可选绑定目标只来自当前 Project 的助理私聊，判定复用 assistantSource：
 * 归属、助理用途、Project 成员与归档状态都由域层裁决，换绑时不会看到跨 Project 的会话。
 */
export function buildFeishuTargetsView(input: {
  ctx: ProjectContext;
  projectId: string;
}): FeishuTargetsView {
  if (input.ctx.agent) throw new FeishuBindingError("forbidden");
  const targets = listChats(input.projectId, input.ctx).flatMap((chat): FeishuTargetOption[] => {
    if (chat.kind !== "dm" || chat.archivedAt) return [];
    try {
      const { current, profile } = assistantSource(chat.id, input.ctx);
      return [{ chatId: current.id, chatTitle: current.title ?? null, agentName: profile.name }];
    } catch (error) {
      if (error instanceof AssistantError) return [];
      throw error;
    }
  });
  return { targets };
}
