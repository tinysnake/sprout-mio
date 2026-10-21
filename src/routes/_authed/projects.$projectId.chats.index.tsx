import { createFileRoute } from "@tanstack/react-router";
import { ChatList } from "../../components/chat/chat-list";
import { ResultError } from "../../components/project/result-error";
import type { AgentProfile, ProjectMember } from "../../contracts/agent";
import type { Chat } from "../../contracts/chat";
import type { AppResult } from "../../contracts/result";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import { listChatsFn, listInstancesForChatFn } from "../../server/functions/chat";

type ChatAgent = { chatId: string; agentProfileId?: string };
type ChatsLoader = {
  chats: AppResult<Chat[]>;
  members: AppResult<ProjectMember[]>;
  profiles: AppResult<AgentProfile[]>;
  chatAgents: ChatAgent[];
};

/** 列表页把每条 DM 关联到它的分身 profile，成员集合决定可以发起对话的对象。 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats/")({
  loader: async ({ params }): Promise<ChatsLoader> => {
    const [chats, members, profiles] = await Promise.all([
      listChatsFn({ data: { projectId: params.projectId } }),
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
    ]);
    const chatAgents = chats.ok
      ? await Promise.all(
          chats.data.map(async (chat) => {
            const instances = await listInstancesForChatFn({
              data: { chatId: chat.id },
            });
            if (!instances.ok) return { chatId: chat.id };
            return {
              chatId: chat.id,
              agentProfileId: instances.data[0]?.agentProfileId,
            };
          }),
        )
      : [];
    return { chats, members, profiles, chatAgents };
  },
  component: ProjectChatsPage,
});

function ProjectChatsPage() {
  const { chats, members, profiles, chatAgents } = Route.useLoaderData();
  const { projectId } = Route.useParams();

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <h2 data-testid="chats-title" className="text-xl font-semibold">
          对话
        </h2>
        <p className="text-sm text-muted-foreground">
          与 Project 内 Agent 成员的一对一 DM；同一成员始终对应同一条对话与同一个分身。
        </p>
      </header>
      {!chats.ok ? (
        <ResultError error={chats.error} testId="chats-error" />
      ) : (
        <>
          {!members.ok && <ResultError error={members.error} testId="members-load-error" />}
          {!profiles.ok && <ResultError error={profiles.error} testId="profiles-error" />}
          {members.ok && profiles.ok && (
            <ChatList
              projectId={projectId}
              chats={chats.data}
              chatAgents={chatAgents}
              members={members.data}
              profiles={profiles.data}
            />
          )}
        </>
      )}
    </section>
  );
}
