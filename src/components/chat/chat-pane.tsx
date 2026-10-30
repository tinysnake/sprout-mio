import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { ChatSession, ChatResult, Message } from "../../contracts/chat";
import type { ChatInfoView } from "../../contracts/info-hub";
import type { FieldErrors } from "../../contracts/project";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import type { AppError } from "../../contracts/result";
import { abortAgentRunFn } from "../../server/functions/agent-run";
import { clearChatTitleFn, sendMessageFn, updateChatTitleFn } from "../../server/functions/chat";
import { ChatThread } from "./chat-thread";
import { ChatTitleEditor } from "./chat-title-editor";
import { useChatDraft } from "./chat-drafts";
import {
  sessionDisplayTitle,
  sessionSenderNames,
  sessionSubtitle,
  senderKey,
} from "./chat-session-display";

/**
 * Chat 中栏的容器：只负责服务调用与请求状态，呈现全部交给 ChatThread。
 * 成功后交给路由重新取数，不在本地插入消息或伪造运行状态。
 */
export function ChatPane({
  projectId,
  session,
  profile,
  humanName,
  messages,
  info,
  runState,
  inspectorOpen,
  onToggleInspector,
  onChanged,
}: {
  projectId: string;
  session: ChatSession;
  profile: AgentResult<AgentProfile> | null;
  humanName: string;
  messages: ChatResult<Message[]>;
  info: ChatResult<ChatInfoView>;
  runState: AgentRunResult<ChatRunState>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onChanged: () => void;
}) {
  const chat = session.chat;
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

  const displayTitle = sessionDisplayTitle(session, info.ok ? info.data : undefined);
  const senderNames = useMemo(
    () => sessionSenderNames(session, info.ok ? info.data : undefined, humanName),
    [session, info, humanName],
  );
  const knownSenders = useMemo(() => {
    if (!info.ok) return undefined;
    return new Set(
      info.data.members.map((member) => senderKey(member.memberKind, member.memberId)),
    );
  }, [info]);
  const runFacts = useMemo(() => {
    const map = new Map<string, import("../../contracts/info-hub").InfoHubRunSummary[]>();
    if (!info.ok) return map;
    for (const run of [...info.data.runs.active, ...info.data.runs.recent]) {
      if (!run.assistantMessageId) continue;
      const list = map.get(run.assistantMessageId) ?? [];
      list.push(run);
      map.set(run.assistantMessageId, list);
    }
    return map;
  }, [info]);

  const agentName =
    senderNames.get(
      senderKey("agent", session.kind === "dm" ? session.instance.agentProfileId : ""),
    ) ?? displayTitle;

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
      profile={session.kind === "dm" ? profile : null}
      humanName={humanName}
      messages={messages}
      runState={runState}
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
      displayTitle={displayTitle}
      subtitle={sessionSubtitle(session)}
      kind={session.kind}
      senderNames={senderNames}
      knownSenders={knownSenders}
      runFacts={runFacts}
      archived={Boolean(chat.archivedAt)}
      titleEditor={
        // DM 保留消息头部的铅笔（P4b 形状，窄屏也能直接改名）；能不能改由治理事实决定，不按 kind 判。
        session.kind === "dm" && session.governance.canRenameTitle ? (
          <ChatTitleEditor
            chat={chat}
            currentName={displayTitle}
            submit={(title) => updateChatTitleFn({ data: { chatId: chat.id, title } })}
            restore={() => clearChatTitleFn({ data: { chatId: chat.id } })}
            onChanged={onChanged}
          />
        ) : undefined
      }
    />
  );
}
