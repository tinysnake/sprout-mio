import { useEffect, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, ChatResult, Message } from "../../contracts/chat";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { abortAgentRunFn } from "../../server/functions/agent-run";
import { sendMessageFn } from "../../server/functions/chat";
import { ChatThread } from "./chat-thread";
import { useChatDraft } from "./chat-drafts";

/**
 * Chat 中栏的容器：只负责服务调用与请求状态，呈现全部交给 ChatThread。
 * 成功后交给路由重新取数，不在本地插入消息或伪造运行状态。
 */
export function ChatPane({
  projectId,
  chat,
  agentName,
  profile,
  humanName,
  messages,
  runState,
  members,
  instances,
  inspectorOpen,
  onToggleInspector,
  onChanged,
}: {
  projectId: string;
  chat: Chat;
  agentName: string;
  profile: AgentResult<AgentProfile> | null;
  humanName: string;
  messages: ChatResult<Message[]>;
  runState: AgentRunResult<ChatRunState>;
  members: ChatResult<ChatMember[]>;
  instances: ChatResult<AgentInstance[]>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onChanged: () => void;
}) {
  const [draft, setDraft] = useChatDraft(chat.id);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<AppError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stopPending, setStopPending] = useState(false);
  const [stopError, setStopError] = useState<AppError | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // 导航离开这条 Chat 后，旧请求的结果不能再写回任何状态或触发刷新。
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function send() {
    if (sendPending) return;
    setSendPending(true);
    setSendError(null);
    setFieldErrors({});
    try {
      const result = await sendMessageFn({ data: { chatId: chat.id, body: draft } });
      if (!alive.current) return;
      if (!result.ok) {
        setSendError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setDraft("");
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      setSendError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (alive.current) setSendPending(false);
    }
  }

  async function stop() {
    const run = runState.ok ? runState.data.runs.at(-1) : undefined;
    if (!run || stopPending) return;
    setStopPending(true);
    setStopError(null);
    try {
      const result = await abortAgentRunFn({ data: { runId: run.id } });
      if (!alive.current) return;
      if (!result.ok) {
        setStopError(result.error);
        return;
      }
      onChanged();
    } catch (cause) {
      if (!alive.current) return;
      setStopError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      if (alive.current) setStopPending(false);
    }
  }

  return (
    <ChatThread
      back={
        <Link
          to="/projects/$projectId/chats"
          params={{ projectId }}
          aria-label="返回 Chat 列表"
          data-testid="back-to-chats"
          className="hidden size-8.5 shrink-0 place-items-center rounded-control border border-transparent text-foreground hover:border-input max-desktop:grid max-desktop:size-11"
        >
          <ArrowLeft size={16} strokeWidth={1.5} aria-hidden="true" />
        </Link>
      }
      chat={chat}
      agentName={agentName}
      profile={profile}
      humanName={humanName}
      messages={messages}
      runState={runState}
      members={members}
      instances={instances}
      inspectorOpen={inspectorOpen}
      onToggleInspector={onToggleInspector}
      draft={draft}
      onDraftChange={setDraft}
      onSend={() => void send()}
      sendPending={sendPending}
      sendError={sendError}
      fieldErrors={fieldErrors}
      onStop={() => void stop()}
      stopPending={stopPending}
      stopError={stopError}
      onRestoreDraft={(body) => {
        setDraft(body);
        input.current?.focus();
      }}
      inputRef={input}
    />
  );
}
