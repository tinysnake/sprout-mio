import { useEffect } from "react";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import { holderNames } from "../../components/machine/project-lease-actions";
import {
  Outlet,
  createFileRoute,
  useMatch,
  useRouteContext,
  useRouter,
} from "@tanstack/react-router";
import { ChatListPanel } from "../../components/chat/chat-list";
import { NewChatDialog } from "../../components/chat/new-chat-dialog";
import { useChatInspector, chatsSearchSchema } from "../../components/chat/chat-search";
import type { ChatDetailLoaderData, ChatsLoaderData } from "../../components/chat/chat-loader";
import { ChatDetails } from "../../components/chat/chat-details";
import { ChatWorkspace } from "../../components/layout/chat-workspace";
import { ChatDraftProvider } from "../../components/chat/chat-drafts";
import { ResultError } from "../../components/project/result-error";
import { listAgentProfilesFn, listProjectMembersFn } from "../../server/functions/agent";
import { listChatsFn } from "../../server/functions/chat";

const DETAIL_ROUTE_ID = "/_authed/projects/$projectId/chats/$chatId";

/**
 * Chats 的父路由：列表数据只在这里取一次，列表页与详情页共用同一份，
 * 因此进入某条对话后左栏仍然是同一份列表。三栏工作区与详情栏也由
 * 这一层持有，切换对话时列表和详情不重新挂载。
 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats")({
  validateSearch: chatsSearchSchema,
  loader: async ({ params }) => {
    const [chats, members, profiles, infoHub, executions] = await Promise.all([
      listChatsFn({ data: { projectId: params.projectId } }),
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
      listProjectExecutionsFn({ data: { projectId: params.projectId } }),
    ]);
    const chatAgents =
      infoHub.ok && chats.ok
        ? infoHub.data.agents.agents.flatMap((agent) =>
            agent.chatId && agent.agentProfileId
              ? [{ chatId: agent.chatId, agentProfileId: agent.agentProfileId }]
              : [],
          )
        : [];
    return {
      chats,
      members,
      profiles,
      chatAgents,
      infoHub,
      executions,
    } satisfies ChatsLoaderData & { executions: typeof executions };
  },
  component: ChatsLayout,
});

function ChatsLayout() {
  const { projectId } = Route.useParams();
  const loader = Route.useLoaderData();
  const router = useRouter();
  const active = loader.infoHub.ok
    ? loader.infoHub.data.chats.some((chat) => chat.activeRunIds.length > 0)
    : false;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void router.invalidate();
    }, 1200);
    const onVisible = () => {
      if (document.visibilityState === "visible") void router.invalidate();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [active, router]);
  const { human } = useRouteContext({ from: "/_authed" });
  const detail = useMatch({ from: DETAIL_ROUTE_ID, shouldThrow: false });
  const chatId = detail?.params.chatId;
  const { open, setOpen } = useChatInspector(projectId, chatId);
  const profiles = loader.profiles.ok ? loader.profiles.data : [];
  const members = loader.members.ok ? loader.members.data : [];
  const chat = detail?.loaderData as ChatDetailLoaderData | undefined;
  const selected = chat?.ok ? chat : undefined;
  const activity =
    selected && loader.infoHub.ok
      ? loader.infoHub.data.chats.find((entry) => entry.chatId === selected.session.chat.id)
      : undefined;
  const newChat =
    loader.members.ok && loader.profiles.ok && human ? (
      <NewChatDialog
        projectId={projectId}
        members={members}
        profiles={profiles}
        humanUserId={human.userId}
        humanName={human.name}
      />
    ) : undefined;
  const machineFactsError = !loader.infoHub.ok
    ? loader.infoHub.error
    : !loader.executions.ok
      ? loader.executions.error
      : undefined;
  const machineFacts =
    loader.infoHub.ok && loader.executions.ok
      ? {
          projectId,
          machines: loader.infoHub.data.machines,
          leases: loader.infoHub.data.leases.items,
          holderNames: holderNames(loader.infoHub.data),
          executions: loader.executions.data,
        }
      : null;

  return (
    <ChatDraftProvider>
      <ChatWorkspace
        selected={Boolean(chatId)}
        inspectorOpen={open}
        inspectorPersistent
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
            {!loader.infoHub.ok && (
              <div className="shrink-0 p-3">
                <ResultError error={loader.infoHub.error} testId="chat-activity-error" />
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
                aggregates={loader.infoHub.ok ? loader.infoHub.data.chats : undefined}
              />
            )}
          </>
        }
        chat={<Outlet />}
        inspector={
          selected ? (
            <ChatDetails
              projectId={projectId}
              session={selected.session}
              humanUserId={human?.userId ?? ""}
              humanName={human?.name ?? ""}
              members={selected.members}
              profile={selected.profile}
              info={selected.info}
              turnStart={selected.turnStart}
              activity={activity}
              projectMembers={members}
              projectProfiles={profiles}
              machineFacts={machineFacts}
              machineFactsError={machineFactsError}
              onClose={() => setOpen(false)}
              onChanged={() => void router.invalidate()}
            />
          ) : undefined
        }
      />
    </ChatDraftProvider>
  );
}
