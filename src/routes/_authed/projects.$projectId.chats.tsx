import { Outlet, createFileRoute, useMatch, useRouteContext } from "@tanstack/react-router";
import { ChatListPanel } from "../../components/chat/chat-list";
import { NewChatDialog } from "../../components/chat/new-chat-dialog";
import { useChatInspector, chatsSearchSchema } from "../../components/chat/chat-search";
import { agentDisplayName, resolveAgentProfileId } from "../../components/chat/chat-loader";
import type { ChatDetailLoaderData, ChatsLoaderData } from "../../components/chat/chat-loader";
import { ChatInspector } from "../../components/info-hub/chat-inspector";
import { ChatWorkspace } from "../../components/layout/chat-workspace";
import { ChatDraftProvider } from "../../components/chat/chat-drafts";
import { ResultError } from "../../components/project/result-error";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import { listChatsFn, listInstancesForChatFn } from "../../server/functions/chat";

const DETAIL_ROUTE_ID = "/_authed/projects/$projectId/chats/$chatId";

/**
 * Chats 的父路由：列表数据只在这里取一次，列表页与详情页共用同一份，
 * 因此进入某条对话后左栏仍然是同一份列表。三栏工作区与 inspector 也由
 * 这一层持有，切换对话时列表和 inspector 不重新挂载。
 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats")({
  validateSearch: chatsSearchSchema,
  loader: async ({ params }): Promise<ChatsLoaderData> => {
    const [chats, members, profiles] = await Promise.all([
      listChatsFn({ data: { projectId: params.projectId } }),
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
    ]);
    const chatAgents = chats.ok
      ? await Promise.all(
          chats.data.map(async (chat) => {
            const instances = await listInstancesForChatFn({ data: { chatId: chat.id } });
            if (!instances.ok) return { chatId: chat.id };
            return { chatId: chat.id, agentProfileId: instances.data[0]?.agentProfileId };
          }),
        )
      : [];
    return { chats, members, profiles, chatAgents };
  },
  component: ChatsLayout,
});

function ChatsLayout() {
  const { projectId } = Route.useParams();
  const loader = Route.useLoaderData();
  const { human } = useRouteContext({ from: "/_authed" });
  const detail = useMatch({ from: DETAIL_ROUTE_ID, shouldThrow: false });
  const chatId = detail?.params.chatId;
  const { open, setOpen } = useChatInspector(projectId, chatId);
  const profiles = loader.profiles.ok ? loader.profiles.data : [];
  const members = loader.members.ok ? loader.members.data : [];
  const chat = detail?.loaderData as ChatDetailLoaderData | undefined;
  const selected = chat?.ok ? chat : undefined;
  const agentName = selected
    ? agentDisplayName(
        selected.profile,
        resolveAgentProfileId(selected.instances, selected.members),
      )
    : "Agent";
  const newChat =
    loader.members.ok && loader.profiles.ok ? (
      <NewChatDialog projectId={projectId} members={members} profiles={profiles} />
    ) : undefined;

  return (
    <ChatDraftProvider>
      <ChatWorkspace
        selected={Boolean(chatId)}
        list={
          <>
            {!loader.chats.ok && (
              <div className="shrink-0 p-3">
                <ResultError error={loader.chats.error} testId="chats-error" />
              </div>
            )}
            {!loader.members.ok && (
              <div className="shrink-0 p-3">
                <ResultError error={loader.members.error} testId="members-load-error" />
              </div>
            )}
            {!loader.profiles.ok && (
              <div className="shrink-0 p-3">
                <ResultError error={loader.profiles.error} testId="profiles-error" />
              </div>
            )}
            {loader.chats.ok && (
              <ChatListPanel
                projectId={projectId}
                chats={loader.chats.data}
                chatAgents={loader.chatAgents}
                profiles={profiles}
                selectedChatId={chatId}
                newChatAction={newChat}
              />
            )}
          </>
        }
        chat={<Outlet />}
        inspector={
          open && selected ? (
            <ChatInspector
              chat={selected.chat}
              agentName={agentName}
              humanName={human?.name ?? ""}
              members={selected.members}
              instances={selected.instances}
              profile={selected.profile}
              info={selected.info}
              turnStart={selected.turnStart}
              onClose={() => setOpen(false)}
            />
          ) : undefined
        }
      />
    </ChatDraftProvider>
  );
}
