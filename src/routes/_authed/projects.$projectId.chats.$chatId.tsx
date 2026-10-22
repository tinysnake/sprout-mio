import { useEffect } from "react";
import { Link, createFileRoute, useRouteContext, useRouter } from "@tanstack/react-router";
import { ChatPane } from "../../components/chat/chat-pane";
import { useChatInspector } from "../../components/chat/chat-search";
import { agentDisplayName, resolveAgentProfileId } from "../../components/chat/chat-loader";
import type { ChatDetailLoaderData } from "../../components/chat/chat-loader";
import { ResultError } from "../../components/project/result-error";
import { getAgentProfileFn } from "../../server/functions/agent";
import { getChatRunStateFn } from "../../server/functions/agent-run";
import { getChatInfoFn, getTurnStartContextFn } from "../../server/functions/info-hub";
import {
  getChatFn,
  listChatMembersFn,
  listInstancesForChatFn,
  listMessagesFn,
} from "../../server/functions/chat";

/** Project 上下文从 URL 推导：chat 不属于 URL 中的 projectId 时按 not_found 呈现。 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats/$chatId")({
  loader: async ({ params }): Promise<ChatDetailLoaderData> => {
    const chat = await getChatFn({ data: { chatId: params.chatId } });
    if (!chat.ok) return { ok: false, error: chat.error };
    if (chat.data.projectId !== params.projectId)
      return {
        ok: false,
        error: { code: "not_found", message: "对象不存在", requestId: chat.requestId },
      };
    const [members, instances, messages, info, turnStart, runState] = await Promise.all([
      listChatMembersFn({ data: { chatId: params.chatId } }),
      listInstancesForChatFn({ data: { chatId: params.chatId } }),
      listMessagesFn({ data: { chatId: params.chatId } }),
      getChatInfoFn({ data: { chatId: params.chatId } }),
      getTurnStartContextFn({ data: { chatId: params.chatId } }),
      getChatRunStateFn({ data: { chatId: params.chatId } }),
    ]);
    const agentProfileId = resolveAgentProfileId(instances, members);
    const profile = agentProfileId ? await getAgentProfileFn({ data: { agentProfileId } }) : null;
    return {
      ok: true,
      chat: chat.data,
      members,
      instances,
      messages,
      profile,
      info,
      turnStart,
      runState,
    };
  },
  component: ProjectChatDetailPage,
});

function ProjectChatDetailPage() {
  const loader = Route.useLoaderData();
  const { projectId, chatId } = Route.useParams();
  const router = useRouter();
  const { human } = useRouteContext({ from: "/_authed" });
  const { open, setOpen } = useChatInspector(projectId, chatId);

  const latestRun = loader.ok && loader.runState.ok ? loader.runState.data.runs.at(-1) : undefined;
  const watching = Boolean(
    loader.ok &&
    loader.runState.ok &&
    loader.runState.data.enabled &&
    (latestRun?.status === "queued" || latestRun?.status === "running"),
  );
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void router.invalidate(), 1200);
    return () => clearInterval(timer);
  }, [watching, router]);

  if (!loader.ok)
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        <Link
          to="/projects/$projectId/chats"
          params={{ projectId }}
          className="mb-4 inline-flex min-h-8.5 items-center gap-2 text-xs text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
        >
          返回对话列表
        </Link>
        <ResultError error={loader.error} testId="chat-error" />
      </div>
    );

  return (
    <ChatPane
      // 换一条对话就换一个实例：草稿、发送错误与停止 pending 都按 Chat 隔离，
      // 旧对话的异步结果也不会写进新对话。
      key={chatId}
      projectId={projectId}
      chat={loader.chat}
      agentName={agentDisplayName(
        loader.profile,
        resolveAgentProfileId(loader.instances, loader.members),
      )}
      profile={loader.profile}
      humanName={human?.name ?? ""}
      messages={loader.messages}
      runState={loader.runState}
      inspectorOpen={open}
      onToggleInspector={() => setOpen(!open)}
      onChanged={() => void router.invalidate()}
    />
  );
}
