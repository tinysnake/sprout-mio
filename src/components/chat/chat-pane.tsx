import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunActivity, ChatRunState } from "../../contracts/agent-run";
import type { ChatSession, ChatResult, Message, MessageWindow } from "../../contracts/chat";
import type { ChatInfoView } from "../../contracts/info-hub";
import type { ChatContinuationData } from "../../domain/chat-continuation";
import type { FieldErrors } from "../../contracts/project";
import { isOffline } from "../../lib/connectivity";
import { ActionOutcomeNotice } from "../ui/action-outcome";
import type { ActionOutcome } from "../ui/action-outcome";
import type { AppError, AppResult } from "../../contracts/result";
import { abortAgentRunFn } from "../../server/functions/agent-run";
import { clearChatTitleFn, sendMessageFn, updateChatTitleFn } from "../../server/functions/chat";
import { ChatThread } from "./chat-thread";
import { AssistantPanel } from "./assistant-panel";
import type { ChatHistory } from "./chat-thread";
import { useChatWindow } from "./use-chat-window";
import type { ChatLiveFacts } from "./use-chat-live";
import type { MentionMember } from "./mention-picker";
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
  page,
  live,
  info,
  runState,
  runActivities,
  skills,
  continuation,
  inspectorOpen,
  onToggleInspector,
  onChanged,
}: {
  projectId: string;
  session: ChatSession;
  profile: AgentResult<AgentProfile> | null;
  humanName: string;
  /** 首屏那一页消息；窗口在这里起手，翻页与卸载都在这个容器里。 */
  page: ChatResult<MessageWindow>;
  /** tick 读到的最新事实；消息用它先接上，不必等整树重读。 */
  live: ChatLiveFacts | null;
  info: ChatResult<ChatInfoView>;
  runState: AgentRunResult<ChatRunState>;
  /** 已结束 run 的工作记录：按产出消息归属，在消息底部回看。 */
  runActivities: AgentRunResult<ChatRunActivity[]>;
  skills: import("../../contracts/skill").ChatSkillChoices;
  continuation: AppResult<ChatContinuationData>;
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onChanged: () => void;
}) {
  const chat = session.chat;
  const room = useChatWindow({ chatId: chat.id, page, live });
  // 分页窗口只改"渲染哪些消息"，错误仍按 loader 的结果原样呈现。
  const messages: ChatResult<Message[]> = page.ok ? { ...page, data: room.messages } : page;
  const history: ChatHistory = {
    breaks: room.breaks,
    hasOlder: room.hasOlder,
    loadingOlder: room.loadingOlder,
    hasNewer: room.hasNewer,
    loadingNewer: room.loadingNewer,
    aboveShift: room.aboveShift,
    onLoadOlder: room.loadOlder,
    onLoadNewer: room.loadNewer,
    onResetToLatest: room.resetToLatest,
    resetError: room.resetError,
    loadError: room.loadError,
    bodies: room.bodies,
    reportAnchor: room.reportAnchor,
  };
  const [draft, setDraft] = useChatDraft(chat.id);
  const [sendPending, setSendPending] = useState(false);
  const [sendError, setSendError] = useState<AppError | null>(null);
  const [sendOutcome, setSendOutcome] = useState<ActionOutcome>(null);
  const [stopOutcome, setStopOutcome] = useState<ActionOutcome>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [stoppingRunId, setStoppingRunId] = useState<string | null>(null);
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
  // @ 候选就是成员视图里的展示名；正文只插名字，所以这里不再带 memberKind。
  // 只列 Agent：点名只对 Agent 有唤醒语义，把人自己列进去只是一行点了没反应的空选项。
  const mentionMembers = useMemo<MentionMember[]>(() => {
    if (!info.ok) return [];
    return info.data.members
      .filter((member) => member.memberKind === "agent")
      .map((member) => ({
        memberId: member.memberId,
        name: member.displayName,
      }));
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
  // 只按 assistantMessageId 精确挂载：记录属于哪条回复由数据库的外键决定，不按时间推断。
  const runActivityByMessage = useMemo(() => {
    const map = new Map<string, ChatRunActivity>();
    if (!runActivities.ok) return map;
    for (const record of runActivities.data) map.set(record.assistantMessageId, record);
    return map;
  }, [runActivities]);
  // 读取失败不能折叠成“没有记录”：消息照常展示，但明确告知历史记录未加载。
  const runActivitiesError = runActivities.ok ? undefined : runActivities.error.message;

  const agentName =
    senderNames.get(
      senderKey("agent", session.kind === "dm" ? session.instance.agentProfileId : ""),
    ) ?? displayTitle;
  const runAgentNames = useMemo(() => {
    const names = new Map<string, string>();
    if (session.kind === "dm") {
      names.set(session.instance.id, agentName);
    } else {
      for (const instance of session.instances) {
        names.set(instance.instanceId, instance.profileName);
      }
    }
    return names;
  }, [session, agentName]);

  async function send() {
    if (sendPending) return;
    if (isOffline()) {
      setSendOutcome("failure");
      return;
    }
    setSendOutcome("processing");
    setSendPending(true);
    setSendError(null);
    setFieldErrors({});
    try {
      const result = await sendMessageFn({ data: { chatId: chat.id, body: draft } });
      if (!alive.current) return;
      if (!result.ok) {
        setSendOutcome("failure");
        setSendError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }
      setSendOutcome("success");
      setDraft("");
      onChanged();
    } catch {
      if (!alive.current) return;
      setSendOutcome("unknown");
    } finally {
      if (alive.current) setSendPending(false);
    }
  }

  async function stop(runId?: string) {
    const targetId = runId ?? (runState.ok ? (runState.data.latest?.id ?? undefined) : undefined);
    if (!targetId || stoppingRunId) return;
    if (isOffline()) {
      setStopOutcome("failure");
      return;
    }
    setStopOutcome("processing");
    setStoppingRunId(targetId);
    setStopError(null);
    try {
      const result = await abortAgentRunFn({ data: { runId: targetId } });
      if (!alive.current) return;
      if (!result.ok) {
        setStopOutcome("failure");
        setStopError(result.error);
        return;
      }
      setStopOutcome("success");
      onChanged();
    } catch {
      if (!alive.current) return;
      setStopOutcome("unknown");
    } finally {
      if (alive.current) setStoppingRunId(null);
    }
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ActionOutcomeNotice
        action="发送消息"
        state={sendOutcome}
        testId="send-outcome"
        detail={
          sendOutcome === "unknown"
            ? "未收到确认，草稿已保留。请先刷新核对消息，避免重复发送"
            : isOffline() && sendOutcome === "failure"
              ? "离线，未提交；草稿已保留"
              : undefined
        }
      />
      <ActionOutcomeNotice
        action="停止 run 请求"
        state={stopOutcome}
        testId="stop-outcome"
        detail={
          stopOutcome === "unknown"
            ? "未收到确认，请刷新核对 run 状态"
            : isOffline() && stopOutcome === "failure"
              ? "离线，未提交"
              : stopOutcome === "success"
                ? "服务已确认请求，以最新 run 状态为准"
                : undefined
        }
      />
      <ChatThread
        skills={skills}
        onSkillsRefresh={onChanged}
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
        assistantPanel={
          profile?.ok && profile.data.purpose === "assistant" ? (
            <AssistantPanel chatId={chat.id} />
          ) : undefined
        }
        agentName={agentName}
        members={mentionMembers}
        profile={session.kind === "dm" ? profile : null}
        humanName={humanName}
        messages={messages}
        history={history}
        runState={runState}
        continuation={continuation}
        inspectorOpen={inspectorOpen}
        onToggleInspector={onToggleInspector}
        draft={draft}
        onDraftChange={setDraft}
        onSend={() => void send()}
        sendPending={sendPending}
        sendError={sendError}
        fieldErrors={fieldErrors}
        onStop={session.kind === "dm" ? () => void stop() : undefined}
        stopPending={stoppingRunId !== null}
        stopError={stopError}
        onStopRun={(runId) => void stop(runId)}
        stoppingRunId={stoppingRunId}
        runAgentNames={runAgentNames}
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
        runActivityByMessage={runActivityByMessage}
        runActivitiesError={runActivitiesError}
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
    </div>
  );
}
