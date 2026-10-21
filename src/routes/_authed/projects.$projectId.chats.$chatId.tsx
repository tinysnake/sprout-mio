import { useEffect } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ChatInfoPanel } from "../../components/info-hub/chat-info-panel";
import { ChatIdentity } from "../../components/chat/chat-identity";
import { MessageComposer } from "../../components/chat/message-composer";
import { MessageList } from "../../components/chat/message-list";
import { RunStatusPanel } from "../../components/chat/run-status";
import { ResultError } from "../../components/project/result-error";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, ChatResult, Message } from "../../contracts/chat";
import type { ChatInfoView, InfoHubResult, TurnStartContext } from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import { getChatInfoFn, getTurnStartContextFn } from "../../server/functions/info-hub";
import { getAgentProfileFn } from "../../server/functions/agent";
import { getChatRunStateFn } from "../../server/functions/agent-run";
import {
  getChatFn,
  listChatMembersFn,
  listInstancesForChatFn,
  listMessagesFn,
} from "../../server/functions/chat";

type DetailLoader =
  | { ok: false; error: AppError }
  | {
      ok: true;
      chat: Chat;
      members: ChatResult<ChatMember[]>;
      instances: ChatResult<AgentInstance[]>;
      messages: ChatResult<Message[]>;
      profile: AgentResult<AgentProfile> | null;
      info: ChatResult<ChatInfoView>;
      turnStart: InfoHubResult<TurnStartContext>;
      runState: AgentRunResult<ChatRunState>;
    };

/** Project 上下文从 URL 推导：chat 不属于 URL 中的 projectId 时按 not_found 呈现。 */
export const Route = createFileRoute("/_authed/projects/$projectId/chats/$chatId")({
  loader: async ({ params }): Promise<DetailLoader> => {
    const chat = await getChatFn({
      data: { chatId: params.chatId },
    });
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
    const agentProfileId =
      (instances.ok ? instances.data[0]?.agentProfileId : undefined) ??
      (members.ok
        ? members.data.find((member) => member.memberKind === "agent")?.memberId
        : undefined);
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

  const heading = (
    <Link to="/projects/$projectId/chats" params={{ projectId }} className="text-sm underline">
      返回对话列表
    </Link>
  );

  if (!loader.ok)
    return (
      <section className="space-y-6">
        {heading}
        <ResultError error={loader.error} testId="chat-error" />
      </section>
    );

  const { chat, members, instances, messages, profile, info, turnStart } = loader;

  return (
    <section className="space-y-6">
      {heading}
      {!members.ok ? (
        <ResultError error={members.error} testId="chat-load-error" />
      ) : !instances.ok ? (
        <ResultError error={instances.error} testId="chat-load-error" />
      ) : (
        <ChatIdentity
          chat={chat}
          members={members.data}
          instances={instances.data}
          profile={profile}
        />
      )}
      {!info.ok ? (
        <ResultError error={info.error} testId="info-hub-chat-error" />
      ) : !turnStart.ok ? (
        <ResultError error={turnStart.error} testId="info-hub-turn-context-error" />
      ) : (
        <ChatInfoPanel view={info.data} turnStart={turnStart.data} />
      )}
      {!messages.ok ? (
        <ResultError error={messages.error} testId="messages-load-error" />
      ) : (
        <>
          <MessageList messages={messages.data} profile={profile} />
          {!loader.runState.ok ? (
            <ResultError error={loader.runState.error} testId="run-state-load-error" />
          ) : (
            <RunStatusPanel state={loader.runState.data} onAbort={() => void router.invalidate()} />
          )}
          <MessageComposer chatId={chatId} onSent={() => void router.invalidate()} />
        </>
      )}
    </section>
  );
}
