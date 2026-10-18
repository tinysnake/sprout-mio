import { useEffect } from "react";
import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ConversationInfoPanel } from "../../components/info-hub/conversation-info-panel";
import { ConversationIdentity } from "../../components/conversation/conversation-identity";
import { MessageComposer } from "../../components/conversation/message-composer";
import { MessageList } from "../../components/conversation/message-list";
import { RunStatusPanel } from "../../components/conversation/run-status";
import { ResultError } from "../../components/project/result-error";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ConversationRunState } from "../../contracts/agent-run";
import type {
  AgentInstance,
  Conversation,
  ConversationMember,
  ConversationResult,
  Message,
} from "../../contracts/conversation";
import type {
  ConversationInfoView,
  InfoHubResult,
  TurnStartContext,
} from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import { getConversationInfoFn, getTurnStartContextFn } from "../../server/functions/info-hub";
import { getAgentProfileFn } from "../../server/functions/agent";
import { getConversationRunStateFn } from "../../server/functions/agent-run";
import {
  getConversationFn,
  listConversationMembersFn,
  listInstancesForConversationFn,
  listMessagesFn,
} from "../../server/functions/conversation";

type DetailLoader =
  | { ok: false; error: AppError }
  | {
      ok: true;
      conversation: Conversation;
      members: ConversationResult<ConversationMember[]>;
      instances: ConversationResult<AgentInstance[]>;
      messages: ConversationResult<Message[]>;
      profile: AgentResult<AgentProfile> | null;
      info: ConversationResult<ConversationInfoView>;
      turnStart: InfoHubResult<TurnStartContext>;
      runState: AgentRunResult<ConversationRunState>;
    };

/** Project 上下文从 URL 推导：conversation 不属于 URL 中的 projectId 时按 not_found 呈现。 */
export const Route = createFileRoute("/_authed/projects/$projectId/conversations/$conversationId")({
  loader: async ({ params }): Promise<DetailLoader> => {
    const conversation = await getConversationFn({
      data: { conversationId: params.conversationId },
    });
    if (!conversation.ok) return { ok: false, error: conversation.error };
    if (conversation.data.projectId !== params.projectId)
      return {
        ok: false,
        error: { code: "not_found", message: "对象不存在", requestId: conversation.requestId },
      };
    const [members, instances, messages, info, turnStart, runState] = await Promise.all([
      listConversationMembersFn({ data: { conversationId: params.conversationId } }),
      listInstancesForConversationFn({ data: { conversationId: params.conversationId } }),
      listMessagesFn({ data: { conversationId: params.conversationId } }),
      getConversationInfoFn({ data: { conversationId: params.conversationId } }),
      getTurnStartContextFn({ data: { conversationId: params.conversationId } }),
      getConversationRunStateFn({ data: { conversationId: params.conversationId } }),
    ]);
    const agentProfileId =
      (instances.ok ? instances.data[0]?.agentProfileId : undefined) ??
      (members.ok
        ? members.data.find((member) => member.memberKind === "agent")?.memberId
        : undefined);
    const profile = agentProfileId ? await getAgentProfileFn({ data: { agentProfileId } }) : null;
    return {
      ok: true,
      conversation: conversation.data,
      members,
      instances,
      messages,
      profile,
      info,
      turnStart,
      runState,
    };
  },
  component: ProjectConversationDetailPage,
});

function ProjectConversationDetailPage() {
  const loader = Route.useLoaderData();
  const { projectId, conversationId } = Route.useParams();
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
    <Link
      to="/projects/$projectId/conversations"
      params={{ projectId }}
      className="text-sm underline"
    >
      返回对话列表
    </Link>
  );

  if (!loader.ok)
    return (
      <section className="space-y-6">
        {heading}
        <ResultError error={loader.error} testId="conversation-error" />
      </section>
    );

  const { conversation, members, instances, messages, profile, info, turnStart } = loader;

  return (
    <section className="space-y-6">
      {heading}
      {!members.ok ? (
        <ResultError error={members.error} testId="conversation-load-error" />
      ) : !instances.ok ? (
        <ResultError error={instances.error} testId="conversation-load-error" />
      ) : (
        <ConversationIdentity
          conversation={conversation}
          members={members.data}
          instances={instances.data}
          profile={profile}
        />
      )}
      {!info.ok ? (
        <ResultError error={info.error} testId="info-hub-conversation-error" />
      ) : !turnStart.ok ? (
        <ResultError error={turnStart.error} testId="info-hub-turn-context-error" />
      ) : (
        <ConversationInfoPanel view={info.data} turnStart={turnStart.data} />
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
          <MessageComposer
            conversationId={conversationId}
            onSent={() => void router.invalidate()}
          />
        </>
      )}
    </section>
  );
}
