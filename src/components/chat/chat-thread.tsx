import { useEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { PanelRight, PanelRightClose } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { Chat, ChatKind, ChatResult, Message } from "../../contracts/chat";
import type { FieldErrors } from "../../contracts/project";
import type { InfoHubRunSummary } from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ChatErrorNotice } from "./chat-error-notice";
import { MessageComposer } from "./message-composer";
import { MessageList } from "./message-list";
import { chatDisplayName } from "./chat-display";
import { RunStatusBadge, RunStatusPanel, isRunActive, runStatusLabel } from "./run-status";

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
  titleEditor,
  displayTitle,
  subtitle,
  kind,
  senderNames,
  knownSenders,
  runFacts,
  archived = false,
}: {
  /** 返回列表入口：正式路由传 Link，演示传按钮。 */
  back?: ReactNode;
  chat: Chat;
  agentName: string;
  profile: AgentResult<AgentProfile> | null;
  humanName: string;
  messages: ChatResult<Message[]>;
  runState: AgentRunResult<ChatRunState>;
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
  /** 重命名入口由容器注入：正式路由接 server function，演示接本地回调。 */
  titleEditor?: ReactNode;
  displayTitle?: string;
  subtitle?: string;
  kind?: ChatKind;
  senderNames?: ReadonlyMap<string, string>;
  knownSenders?: ReadonlySet<string>;
  runFacts?: Map<string, readonly InfoHubRunSummary[]>;
  archived?: boolean;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(false);
  const count = messages.ok ? messages.data.length : 0;
  const jobTitle = profile && profile.ok ? (profile.data.jobTitle ?? "") : "";
  const active = runState.ok ? isRunActive(runState.data) : false;
  const latestRun = runState.ok ? runState.data.runs.at(-1) : undefined;
  const first = useRef(true);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    if (first.current || atBottom) {
      element.scrollTop = element.scrollHeight;
      first.current = false;
      setNewSinceScroll(false);
      return;
    }
    setNewSinceScroll(true);
  }, [count, atBottom]);

  const title = displayTitle ?? chatDisplayName(chat, agentName);
  const subline =
    subtitle ??
    (kind === "public_channel"
      ? "Public Channel"
      : kind === "group"
        ? "Group"
        : `DM · 你与${agentName}`);

  return (
    <section data-testid="chat-pane" className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="flex min-h-20.75 items-center gap-3 border-b border-border px-6.75 py-4.5 max-desktop:min-h-19 max-desktop:gap-1 max-desktop:px-3 max-desktop:py-3.5">
        {back}
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <h2 data-testid="chat-title" className="min-w-0 truncate text-[17px] tracking-[-0.4px]">
              {title}
            </h2>
            {titleEditor}
          </span>
          <p className="mt-1 flex items-center gap-1.5 text-[10px] whitespace-nowrap text-muted-foreground">
            <span>{subline}</span>
            {kind === "dm" && jobTitle && (
              <>
                <span className="max-desktop:hidden">·</span>
                <span className="max-desktop:hidden">{jobTitle}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {latestRun && <RunStatusBadge status={latestRun.status} />}
          <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="toggle-inspector"
            aria-label={inspectorOpen ? "关闭会话详情" : "打开会话详情"}
            title="会话详情"
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
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          setAtBottom(bottom);
          if (bottom) setNewSinceScroll(false);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-5.75 pb-4.5 max-desktop:px-3.75 max-desktop:py-5"
      >
        {!messages.ok ? (
          <ChatErrorNotice error={messages.error} testId="messages-load-error" />
        ) : !runState.ok ? (
          <>
            <MessageList
              messages={messages.data}
              profile={profile}
              humanName={humanName}
              senderNames={senderNames}
              knownSenders={knownSenders}
              runFacts={runFacts}
            />
            <ChatErrorNotice error={runState.error} testId="run-state-load-error" />
          </>
        ) : (
          <>
            <MessageList
              messages={messages.data}
              profile={profile}
              humanName={humanName}
              senderNames={senderNames}
              knownSenders={knownSenders}
              runFacts={runFacts}
            />
            <RunStatusPanel
              state={runState.data}
              messages={messages.data}
              onRestoreDraft={onRestoreDraft}
            />
          </>
        )}
        {newSinceScroll && (
          <button
            type="button"
            data-testid="new-messages-jump"
            onClick={() => {
              const element = scroll.current;
              if (element) element.scrollTop = element.scrollHeight;
              setAtBottom(true);
              setNewSinceScroll(false);
            }}
            className="sticky bottom-2 mx-auto mt-3 block rounded-control border border-border bg-background px-3 py-2 text-[11px] text-foreground shadow-sm"
          >
            有新消息 · 回到最新
          </button>
        )}
      </div>
      {archived ? (
        <p
          data-testid="archived-notice"
          className="shrink-0 border-t border-border bg-secondary px-6 py-4 text-[11px] text-muted-foreground max-desktop:px-3"
        >
          这是已归档会话，仅可阅读消息与运行记录。
        </p>
      ) : (
        <MessageComposer
          agentName={title}
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
      )}
    </section>
  );
}
