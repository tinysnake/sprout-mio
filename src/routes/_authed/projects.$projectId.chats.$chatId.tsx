import { Outlet, createFileRoute } from "@tanstack/react-router";
import type { ChatDetailLoaderData } from "../../components/chat/chat-loader";
import { getAgentProfileFn } from "../../server/functions/agent";
import { getChatRunStateFn, listChatRunActivitiesFn } from "../../server/functions/agent-run";
import { getChatInfoFn, readTurnContextFn } from "../../server/functions/info-hub";
import { getChatSessionFn, listChatMembersFn, listMessagesFn } from "../../server/functions/chat";
import { getChatContinuationFn } from "../../server/functions/chat-continuation";

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
    const [members, messages, info, runState, runActivities, continuation] = await Promise.all([
      listChatMembersFn({ data: { chatId: params.chatId } }),
      listMessagesFn({ data: { chatId: params.chatId } }),
      getChatInfoFn({ data: { chatId: params.chatId } }),
      getChatRunStateFn({ data: { chatId: params.chatId } }),
      listChatRunActivitiesFn({ data: { chatId: params.chatId } }),
      getChatContinuationFn({ data: { projectId: params.projectId, chatId: params.chatId } }),
    ]);
    // Human 诊断按明确 runId 读持久化快照：优先活动 run，否则取这条 Chat 最近一条 run。
    // 不查「Chat 的第一个分身」来造快照；没有 run 就传 null，让页面显示「还没有本轮上下文快照」。
    const snapshotRun = runState.ok
      ? (runState.data.active[0] ?? runState.data.latest ?? undefined)
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
      runActivities,
      continuation,
    };
  },
  pendingComponent: ChatDetailPending,
  component: Outlet,
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
