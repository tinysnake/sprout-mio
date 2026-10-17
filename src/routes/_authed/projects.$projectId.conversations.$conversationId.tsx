import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ConversationIdentity } from "../../components/conversation/conversation-identity";
import { MessageComposer } from "../../components/conversation/message-composer";
import { MessageList } from "../../components/conversation/message-list";
import { ResultError } from "../../components/project/result-error";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type {
  AgentInstance,
  Conversation,
  ConversationMember,
  ConversationResult,
  Message,
} from "../../contracts/conversation";
import type { AppError } from "../../contracts/result";
import { getAgentProfileFn } from "../../server/functions/agent";
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
    const [members, instances, messages] = await Promise.all([
      listConversationMembersFn({ data: { conversationId: params.conversationId } }),
      listInstancesForConversationFn({ data: { conversationId: params.conversationId } }),
      listMessagesFn({ data: { conversationId: params.conversationId } }),
    ]);
    const agentProfileId =
      (instances.ok ? instances.data[0]?.agentProfileId : undefined) ??
      (members.ok
        ? members.data.find((member) => member.memberKind === "agent")?.memberId
        : undefined);
    const profile = agentProfileId ? await getAgentProfileFn({ data: { agentProfileId } }) : null;
    return { ok: true, conversation: conversation.data, members, instances, messages, profile };
  },
  component: ProjectConversationDetailPage,
});

function ProjectConversationDetailPage() {
  const loader = Route.useLoaderData();
  const { projectId, conversationId } = Route.useParams();
  const router = useRouter();

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

  const { conversation, members, instances, messages, profile } = loader;

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
      {!messages.ok ? (
        <ResultError error={messages.error} testId="messages-load-error" />
      ) : (
        <>
          <MessageList messages={messages.data} profile={profile} />
          <MessageComposer
            conversationId={conversationId}
            onSent={() => void router.invalidate()}
          />
        </>
      )}
    </section>
  );
}
