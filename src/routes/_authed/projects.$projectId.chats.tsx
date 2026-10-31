import { useEffect } from "react";
import { getProjectInfoHubFn, refreshInfoHubFn } from "../../server/functions/info-hub";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import { listMachinesFn } from "../../server/functions/machine";
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
import {
  InfoHubLiveProvider,
  InfoHubPollingStatus,
  unwrapRefreshResult,
  useInfoHubLive,
} from "../../components/info-hub/info-hub-live";
import { mergeChatRuns, mergeProjectChats } from "../../components/info-hub/merge-info-hub";
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
    const [chats, members, profiles, infoHub, executions, machines] = await Promise.all([
      listChatsFn({ data: { projectId: params.projectId } }),
      listProjectMembersFn({ data: { projectId: params.projectId } }),
      listAgentProfilesFn(),
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
      listProjectExecutionsFn({ data: { projectId: params.projectId } }),
      listMachinesFn({ data: {} }),
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
      machines,
    } satisfies ChatsLoaderData & { executions: typeof executions; machines: typeof machines };
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
          // Machine 事实用 MachineDetail：摘要投影不能当详情用（bindings / rootDir 不在里面）。
          machines: loader.machines.ok ? loader.machines.data : [],
          leases: loader.infoHub.data.leases.items,
          holderNames: holderNames(loader.infoHub.data),
          executions: loader.executions.data,
        }
      : null;

  // 一个页面只挂一个 owner：有选中 Chat 时刷这个 Chat 的活动 run，列表页刷 Project 的 Chats 聚合。
  const liveQuery = chatId
    ? ({ view: "chat", chatId, section: "runs", limit: 25 } as const)
    : ({ view: "project", section: "chats", limit: 25 } as const);

  return (
    <InfoHubLiveProvider
      projectId={projectId}
      query={liveQuery}
      // transport 是真实 server function；页面只声明 scope，不自己拼请求。
      refresh={(input, signal) => unwrapRefreshResult(refreshInfoHubFn({ data: input, signal }))}
    >
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
              <div className="shrink-0 px-3 pb-2">
                <InfoHubPollingStatus />
              </div>
              {loader.chats.ok && (
                <ChatListLive
                  projectId={projectId}
                  chats={loader.chats.data}
                  chatAgents={loader.chatAgents}
                  profiles={profiles}
                  selectedChatId={chatId}
                  newChatAction={newChat}
                  infoHub={loader.infoHub}
                />
              )}
            </>
          }
          chat={<Outlet />}
          inspector={
            selected ? (
              <ChatDetailsLive
                projectId={projectId}
                session={selected.session}
                humanUserId={human?.userId ?? ""}
                humanName={human?.name ?? ""}
                members={selected.members}
                profile={selected.profile}
                info={selected.info}
                turnContext={selected.turnContext}
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
    </InfoHubLiveProvider>
  );
}

/** 列表与 inspector 只消费 views；轮询结果由页面的唯一 owner 合进来。 */
function ChatListLive({
  infoHub,
  ...props
}: Parameters<typeof ChatListPanel>[0] & { infoHub: ChatsLoaderData["infoHub"] }) {
  const live = useInfoHubLive();
  const hub = infoHub.ok ? mergeProjectChats(infoHub.data, live?.view ?? null) : null;
  return <ChatListPanel {...props} aggregates={hub?.chats} />;
}

function ChatDetailsLive({ info, ...props }: Parameters<typeof ChatDetails>[0]) {
  const live = useInfoHubLive();
  const merged = info.ok ? { ...info, data: mergeChatRuns(info.data, live?.view ?? null) } : info;
  return <ChatDetails {...props} info={merged} />;
}
