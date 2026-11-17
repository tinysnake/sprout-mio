import { Link, createFileRoute, useRouteContext, useRouter } from "@tanstack/react-router";
import { ChatPane } from "../../components/chat/chat-pane";
import { SelectedRunPanel } from "../../components/chat/run-status";
import { useChatFilesEntry, useChatInspector } from "../../components/chat/chat-search";
import { isActiveRunState, useChatLive } from "../../components/chat/use-chat-live";
import type { ChatDetailLoaderData } from "../../components/chat/chat-loader";
import { ResultError } from "../../components/project/result-error";
import { useInfoHubLive } from "../../components/info-hub/info-hub-live";
import { mergeChatRuns } from "../../components/info-hub/merge-info-hub";
import { requestRouteReload } from "../../lib/route-reload";

import { Route as ChatRoute } from "./projects.$projectId.chats.$chatId";

export const Route = createFileRoute("/_authed/projects/$projectId/chats/$chatId/")({
  component: ProjectChatDetailPage,
});

/**
 * 有没有值得继续轮询的活动 run。run 状态机是唯一真值：它读得到就只认它，
 * 免得会话读模型里一个过期的 `activeRun` 让轮询永远停不下来。
 */
function hasActiveRun(loader: ChatDetailLoaderData): boolean {
  if (!loader.ok) return false;
  if (loader.runState.ok) return isActiveRunState(loader.runState);
  return loader.session.kind !== "dm" && loader.session.instances.some((item) => item.activeRun);
}

function ProjectChatDetailPage() {
  const loader = ChatRoute.useLoaderData();
  const { projectId, chatId } = Route.useParams();
  const router = useRouter();
  const { human } = useRouteContext({ from: "/_authed" });
  const { open, setOpen } = useChatInspector(projectId, chatId);
  // 右栏收起时也要能直接回到文件：按钮自带「再点收起」的切换语义。
  const { filesOpen, toggleFiles } = useChatFilesEntry(projectId, chatId);
  const live = useInfoHubLive();
  const watching = hasActiveRun(loader);
  // 活跃 run 期间只重读消息与 run 状态，不再重跑整棵路由的 loader；
  // run 一推进或收尾，这里回报一次 invalidate，让会话、关联 Task 与 inspector 快照跟上。
  const facts = useChatLive({
    chatId,
    projectId,
    active: watching,
    loader,
    onRunChanged: () => void requestRouteReload(router),
  });

  if (!loader.ok)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Link
          to="/projects/$projectId/chats"
          params={{ projectId }}
          className="mb-4 inline-flex min-h-8.5 items-center gap-2 text-xs text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
        >
          返回会话列表
        </Link>
        <ResultError error={loader.error} testId="chat-error" />
      </div>
    );

  const liveInfo = loader.info.ok
    ? { ...loader.info, data: mergeChatRuns(loader.info.data, live?.view ?? null) }
    : loader.info;
  const runState = facts?.runState ?? loader.runState;

  return (
    <>
      {loader.selectedRun && <SelectedRunPanel result={loader.selectedRun} />}
      <ChatPane
        // 换一条对话就换一个实例：草稿、发送错误与停止 pending 都按 Chat 隔离，
        // 旧对话的异步结果也不会写进新对话。
        key={chatId}
        projectId={projectId}
        session={loader.session}
        profile={loader.profile}
        humanName={human?.name ?? ""}
        page={loader.messages}
        live={facts}
        info={liveInfo}
        runState={runState}
        runActivities={loader.runActivities}
        skills={loader.skills.ok ? loader.skills.data : { state: "unavailable", items: [] }}
        inspectorOpen={open}
        onToggleInspector={() => setOpen(!open)}
        filesOpen={filesOpen}
        onToggleFiles={toggleFiles}
        onChanged={() => void router.invalidate()}
      />
    </>
  );
}
