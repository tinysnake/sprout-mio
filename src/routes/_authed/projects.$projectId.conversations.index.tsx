import { createFileRoute } from "@tanstack/react-router";
import { ConversationList } from "../../components/conversation/conversation-list";
import { ResultError } from "../../components/project/result-error";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import type { Conversation } from "../../contracts/conversation";
import type { AppResult } from "../../contracts/result";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import {
  listConversationsFn,
  listInstancesForConversationFn,
} from "../../server/functions/conversation";

type ConversationAgent = { conversationId: string; agentProfileId?: string };
type ConversationsLoader = {
  conversations: AppResult<Conversation[]>;
  members: AppResult<ProjectMember[]>;
  profiles: AppResult<AgentProfile[]>;
  conversationAgents: ConversationAgent[];
};

/** 列表页把每条 DM 关联到它的分身 profile，成员集合决定可以发起对话的对象。 */
export const Route = createFileRoute("/_authed/projects/$projectId/conversations/")({
  loader: async ({ params }): Promise<ConversationsLoader> => {
    const [conversations, members, profiles] = await Promise.all([
      listConversationsFn({ data: { projectId: params.projectId } }),
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
    ]);
    const conversationAgents = conversations.ok
      ? await Promise.all(
          conversations.data.map(async (conversation) => {
            const instances = await listInstancesForConversationFn({
              data: { conversationId: conversation.id },
            });
            if (!instances.ok) return { conversationId: conversation.id };
            return {
              conversationId: conversation.id,
              agentProfileId: instances.data[0]?.agentProfileId,
            };
          }),
        )
      : [];
    return { conversations, members, profiles, conversationAgents };
  },
  component: ProjectConversationsPage,
});

function ProjectConversationsPage() {
  const { conversations, members, profiles, conversationAgents } = Route.useLoaderData();
  const { projectId } = Route.useParams();

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 data-testid="conversations-title" className="text-xl font-semibold">
          对话
        </h2>
        <p className="text-sm text-muted-foreground">
          与 Project 内 Agent 成员的一对一 DM；同一成员始终对应同一条对话与同一个分身。
        </p>
      </header>
      {!conversations.ok ? (
        <ResultError error={conversations.error} testId="conversations-error" />
      ) : (
        <>
          {!members.ok && <ResultError error={members.error} testId="members-load-error" />}
          {!profiles.ok && <ResultError error={profiles.error} testId="profiles-error" />}
          {members.ok && profiles.ok && (
            <ConversationList
              projectId={projectId}
              conversations={conversations.data}
              conversationAgents={conversationAgents}
              members={members.data}
              profiles={profiles.data}
            />
          )}
        </>
      )}
    </section>
  );
}
