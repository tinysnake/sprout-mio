import { useEffect } from "react";
import { Link, createFileRoute, useRouteContext, useRouter } from "@tanstack/react-router";
import { ChatPane } from "../../components/chat/chat-pane";
import { TaskAssociations } from "../../components/tasks/task-associations";
import { useChatInspector } from "../../components/chat/chat-search";
import type { ChatDetailLoaderData } from "../../components/chat/chat-loader";
import { ResultError } from "../../components/project/result-error";
import { useInfoHubLive } from "../../components/info-hub/info-hub-live";
import { mergeChatRuns } from "../../components/info-hub/merge-info-hub";
import { getAgentProfileFn } from "../../server/functions/agent";
import { getChatRunStateFn } from "../../server/functions/agent-run";
import { getChatInfoFn, readTurnContextFn } from "../../server/functions/info-hub";
import { getChatSessionFn, listChatMembersFn, listMessagesFn } from "../../server/functions/chat";

/** Project 上下文从 URL 推导：chat 不属于 URL 中的 projectId 时按 not_found 呈现。 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats/$chatId")({
  loader: async ({ params }): Promise<ChatDetailLoaderData> => {
    const session = await getChatSessionFn({ data: { chatId: params.chatId } });
    if (!session.ok) return { ok: false, error: session.error };
    if (session.data.chat.projectId !== params.projectId)
      return {
        ok: false,
        error: { code: "not_found", message: "对象不存在", requestId: session.requestId },
      };
    const [members, messages, info, runState] = await Promise.all([
      listChatMembersFn({ data: { chatId: params.chatId } }),
      listMessagesFn({ data: { chatId: params.chatId } }),
      getChatInfoFn({ data: { chatId: params.chatId } }),
      getChatRunStateFn({ data: { chatId: params.chatId } }),
    ]);
    // Human 诊断按明确 runId 读持久化快照：优先活动 run，否则取这条 Chat 最近一条 run。
    // 不查「Chat 的第一个分身」来造快照；没有 run 就传 null，让页面显示「还没有本轮上下文快照」。
    const snapshotRun = runState.ok
      ? (runState.data.runs.find((run) => run.status === "running" || run.status === "queued") ??
        runState.data.runs.at(-1))
      : undefined;
    const turnContext = snapshotRun
      ? await readTurnContextFn({ data: { projectId: params.projectId, runId: snapshotRun.id } })
      : null;
    const agentProfileId =
      session.data.kind === "dm"
        ? session.data.instance.agentProfileId
        : session.data.instances[0]?.agentProfileId;
    const profile = agentProfileId ? await getAgentProfileFn({ data: { agentProfileId } }) : null;
    return {
      ok: true,
      session: session.data,
      members,
      messages,
      profile,
      info,
      turnContext,
      runState,
    };
  },
  pendingComponent: ChatDetailPending,
  component: ProjectChatDetailPage,
});

function ChatDetailPending() {
  return (
    <div
      data-testid="chat-loading"
      aria-busy="true"
      className="flex min-h-0 flex-1 flex-col gap-3 p-6"
    >
      <p className="text-xs text-muted-foreground">正在加载消息…</p>
      <p className="text-xs text-muted-foreground">正在读取活动状态…</p>
    </div>
  );
}

/** 任一 run 仍在排队或运行就继续刷新；全部结束就停止活动轮询。 */
function hasActiveRun(loader: ChatDetailLoaderData): boolean {
  if (!loader.ok) return false;
  if (loader.session.kind !== "dm" && loader.session.instances.some((item) => item.activeRun))
    return true;
  return (
    loader.runState.ok &&
    loader.runState.data.runs.some((run) => run.status === "queued" || run.status === "running")
  );
}

function ProjectChatDetailPage() {
  const loader = Route.useLoaderData();
  const { projectId, chatId } = Route.useParams();
  const router = useRouter();
  const { human } = useRouteContext({ from: "/_authed" });
  const { open, setOpen } = useChatInspector(projectId, chatId);
  const live = useInfoHubLive();
  const watching = hasActiveRun(loader);

  useEffect(() => {
    if (!watching) return;
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
  }, [watching, router]);

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

  return (
    <>
      {liveInfo?.ok && liveInfo.data.tasks.items.length > 0 && (
        <div
          className="max-h-36 shrink-0 overflow-y-auto border-b border-border px-5 py-3"
          aria-label="关联 Task"
        >
          <TaskAssociations projectId={projectId} items={liveInfo.data.tasks.items} compact />
        </div>
      )}
      <ChatPane
        // 换一条对话就换一个实例：草稿、发送错误与停止 pending 都按 Chat 隔离，
        // 旧对话的异步结果也不会写进新对话。
        key={chatId}
        projectId={projectId}
        session={loader.session}
        profile={loader.profile}
        humanName={human?.name ?? ""}
        messages={loader.messages}
        info={liveInfo}
        runState={loader.runState}
        inspectorOpen={open}
        onToggleInspector={() => setOpen(!open)}
        onChanged={() => void router.invalidate()}
      />
    </>
  );
}
