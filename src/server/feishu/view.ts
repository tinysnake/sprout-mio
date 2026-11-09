import { inArray } from "drizzle-orm";
import type { FeishuBindingView, FeishuConnectionSnapshot } from "../../contracts/feishu-channel";
import { db } from "../../db";
import { agentProfile } from "../../db/schema";
import { getChat, listChatMembers } from "../../domain/chat";
import { getFeishuBinding, readFeishuChallenge } from "../../domain/feishu";
import type { ProjectContext } from "../../domain/project";

/**
 * 未来绑定页要渲染的全部事实。只读：目标对话与 Agent 名称都经过 Project 与成员权限核对，
 * 不属于当前 Project 的绑定只回 revision/bound，不回跨 Project 的对话标题。
 */
export function buildFeishuBindingView(input: {
  ctx: ProjectContext;
  projectId: string;
  configured: boolean;
  connection: FeishuConnectionSnapshot;
  now?: Date;
}): FeishuBindingView {
  const binding = getFeishuBinding(input.ctx);
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
  const challenge = readFeishuChallenge(input.ctx, input.now ?? new Date());
  return {
    adapter: "feishu",
    configured: input.configured,
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
