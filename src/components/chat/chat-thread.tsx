import { useEffect, useRef } from "react";
import type { ReactNode, Ref } from "react";
import { PanelRight, PanelRightClose } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { AgentInstance, Chat, ChatMember, ChatResult, Message } from "../../contracts/chat";
import type { FieldErrors } from "../../contracts/project";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ThemeToggle } from "../layout/theme-toggle";
import { ResultError } from "../project/result-error";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";
import { RunStatusBadge, RunStatusPanel, isRunActive, runStatusLabel } from "./run-status";
import { ChatIdentity } from "./chat-identity";

/**
 * Chat 中栏的呈现层：头部上下文、消息记录与输入区。所有数据与操作都由
 * props 给出，因此同一份组件既驱动正式路由（服务调用在 chat-pane.tsx），
 * 也驱动开发演示（fixture 与本地回调）。
 */
export function ChatThread({
  back,
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
  draft,
  onDraftChange,
  onSend,
  sendPending,
  sendError,
  fieldErrors,
  onStop,
  stopPending,
  stopError,
  onRestoreDraft,
  inputRef,
}: {
  /** 返回列表入口：正式路由传 Link，演示传按钮。 */
  back?: ReactNode;
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
  draft: string;
  onDraftChange: (value: string) => void;
  onSend: () => void;
  sendPending: boolean;
  sendError: AppError | null;
  fieldErrors: FieldErrors;
  onStop: () => void;
  stopPending: boolean;
  stopError: AppError | null;
  onRestoreDraft: (body: string) => void;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const count = messages.ok ? messages.data.length : 0;
  const jobTitle = profile && profile.ok ? (profile.data.jobTitle ?? "") : "";
  const active = runState.ok ? isRunActive(runState.data) : false;
  const latestRun = runState.ok ? runState.data.runs.at(-1) : undefined;

  useEffect(() => {
    const element = scroll.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);

  return (
    <section data-testid="chat-pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-20.75 items-center gap-3 border-b border-border px-6.75 py-4.5 max-desktop:min-h-19 max-desktop:gap-1 max-desktop:px-3 max-desktop:py-3.5">
        {back}
        <div className="min-w-0 flex-1">
          <h2 data-testid="chat-title" className="truncate text-[17px] tracking-[-0.4px]">
            {chat.title ?? agentName}
          </h2>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] whitespace-nowrap text-muted-foreground">
            <span>DM</span>
            <span>·</span>
            <span className="min-w-0 truncate">你与{agentName}</span>
            {jobTitle && (
              <>
                <span className="max-desktop:hidden">·</span>
                <span className="max-desktop:hidden">{jobTitle}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {latestRun && <RunStatusBadge status={latestRun.status} />}
          <ThemeToggle />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="toggle-inspector"
            aria-label={inspectorOpen ? "关闭 Info Hub" : "打开 Info Hub"}
            title="Info Hub"
            aria-expanded={inspectorOpen}
            aria-controls="info-hub"
            onClick={onToggleInspector}
          >
            <Icon as={inspectorOpen ? PanelRightClose : PanelRight} />
          </Button>
        </div>
      </header>
      <div
        ref={scroll}
        role="log"
        aria-label="Chat 消息记录"
        data-testid="message-history"
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-5.75 pb-4.5 max-desktop:px-3.75 max-desktop:py-5"
      >
        <ChatIdentity
          chat={chat}
          members={members}
          instances={instances}
          profile={profile}
          agentName={agentName}
          humanName={humanName}
        />
        {!messages.ok ? (
          <ResultError error={messages.error} testId="messages-load-error" />
        ) : !runState.ok ? (
          <>
            <MessageList messages={messages.data} profile={profile} humanName={humanName} />
            <ResultError error={runState.error} testId="run-state-load-error" />
          </>
        ) : (
          <>
            <MessageList messages={messages.data} profile={profile} humanName={humanName} />
            <RunStatusPanel
              state={runState.data}
              messages={messages.data}
              onRestoreDraft={onRestoreDraft}
            />
          </>
        )}
      </div>
      <MessageComposer
        agentName={agentName}
        draft={draft}
        onDraftChange={onDraftChange}
        onSubmit={onSend}
        pending={sendPending}
        error={sendError}
        fieldErrors={fieldErrors}
        runActive={active}
        runStatusLabel={runState.ok ? runStatusLabel(runState.data) : ""}
        stopping={stopPending}
        stopError={stopError}
        onStop={onStop}
        inputRef={inputRef}
      />
    </section>
  );
}
