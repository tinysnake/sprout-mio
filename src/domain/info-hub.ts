import type {
  ConversationInfoView,
  ProjectAgentEntry,
  ProjectInfoHub,
} from "../contracts/info-hub";
import { MACHINES_UNAVAILABLE_REASON, RUNS_UNAVAILABLE_REASON } from "../contracts/info-hub";
import { assertProjectAccess } from "./access";
import type { ProjectContext } from "./access";
import { getAgentProfile, listProjectMembers } from "./agent";
import {
  getConversation,
  listConversationMembers,
  listConversations,
  listInstancesForConversation,
  listMessages,
} from "./conversation";

const PERSONA_SUMMARY_LIMIT = 120;

function personaSummary(persona: string): string {
  const trimmed = persona.trim();
  return trimmed.length <= PERSONA_SUMMARY_LIMIT
    ? trimmed
    : `${trimmed.slice(0, PERSONA_SUMMARY_LIMIT)}…`;
}

/** Project → Agents 视角：成员 profile、本 Project 内的 DM 与分身，外加 run 与 Machine 的显式不可用标记。 */
export function getProjectInfoHub(projectId: string, ctx: ProjectContext): ProjectInfoHub {
  assertProjectAccess(ctx, projectId);
  const members = listProjectMembers(projectId, ctx);
  const dmLinks = listConversations(projectId, ctx).flatMap((conversation) =>
    listInstancesForConversation(conversation.id, ctx).map((instance) => ({
      agentProfileId: instance.agentProfileId,
      conversationId: conversation.id,
      instanceId: instance.id,
    })),
  );
  const agents: ProjectAgentEntry[] = members.map((member) => {
    const profile = getAgentProfile(member.agentProfileId, ctx);
    const link = dmLinks.find((entry) => entry.agentProfileId === member.agentProfileId);
    return {
      agentProfileId: profile.id,
      name: profile.name,
      personaSummary: personaSummary(profile.persona),
      ...(link ? { conversationId: link.conversationId, instanceId: link.instanceId } : {}),
    };
  });
  return {
    projectId,
    agents: {
      agents,
      runs: { available: false, reason: RUNS_UNAVAILABLE_REASON },
    },
    machines: { available: false, reason: MACHINES_UNAVAILABLE_REASON },
  };
}

/** Conversation → 自身与成员视角：授权经 conversation 自带的 projectId，越权与不存在同样抛 not_found。 */
export function getConversationInfo(
  conversationId: string,
  ctx: ProjectContext,
): ConversationInfoView {
  const conversation = getConversation(conversationId, ctx);
  const members = listConversationMembers(conversationId, ctx);
  const instances = listInstancesForConversation(conversationId, ctx);
  const messages = listMessages(conversationId, ctx);
  const instance = instances.at(0);
  const latest = messages.at(-1);
  return {
    conversationId: conversation.id,
    projectId: conversation.projectId,
    kind: conversation.kind,
    archived: conversation.archivedAt !== undefined,
    members: members.map((member) => ({
      memberKind: member.memberKind,
      memberId: member.memberId,
      displayName:
        member.memberKind === "human" ? "Human" : getAgentProfile(member.memberId, ctx).name,
    })),
    instance: instance
      ? {
          instanceId: instance.id,
          agentProfileId: instance.agentProfileId,
          profileName: getAgentProfile(instance.agentProfileId, ctx).name,
        }
      : null,
    messages: {
      count: messages.length,
      ...(latest ? { latestAt: latest.createdAt } : {}),
    },
    runs: { available: false, reason: RUNS_UNAVAILABLE_REASON },
  };
}
