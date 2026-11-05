import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";
import { PanelRight, PanelRightClose } from "lucide-react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentRunResult, ChatRunActivity, ChatRunState } from "../../contracts/agent-run";
import type { Chat, ChatKind, ChatResult, Message } from "../../contracts/chat";
import type { FieldErrors } from "../../contracts/project";
import type { InfoHubRunSummary } from "../../contracts/info-hub";
import type { ChatContinuationData } from "../../domain/chat-continuation";
import type { AppError, AppResult } from "../../contracts/result";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ChatErrorNotice } from "./chat-error-notice";
import { MessageComposer } from "./message-composer";
import type { MentionMember } from "./mention-picker";
import { MessageList } from "./message-list";
import { chatDisplayName } from "./chat-display";
import { RunStatusBadge, RunStatusPanel, isRunActive, runStatusLabel } from "./run-status";

/** 顶部自动加载更早消息的触发距离（像素）。 */
const LOAD_OLDER_PX = 900;
/** 视口顶端那条消息与它的偏移，用来把插页后的位置钉回去。 */
const MESSAGE_ITEM = '[data-testid="message-item"]';
/** 插页后既有行的高度可能重排（表头归并、字体落定）；钉位置最多盯这么久。 */
const PIN_FRAMES = 16;
const PIN_RETRY_MS = 250;

type ViewportAnchor = {
  /** scrollHeight - scrollTop：视口顶端到内容底边的距离，插入内容时保持不变。 */
  delta: number;
  /** 视口顶端那条消息；消息被卸载或为空时为 null。 */
  id: string | null;
  /** 那条消息相对容器内容起点的偏移。 */
  offset: number | null;
};

function messageItem(element: HTMLElement, id: string): HTMLElement | null {
  return element.querySelector<HTMLElement>(`${MESSAGE_ITEM}[data-message-id="${CSS.escape(id)}"]`);
}

/** 视口顶端落在第几页：页就是渲染与卸载的单位，报页号就够了。 */
function visiblePage(element: HTMLElement): number | null {
  const top = element.getBoundingClientRect().top;
  for (const block of element.querySelectorAll<HTMLElement>("[data-message-page]")) {
    if (block.getBoundingClientRect().bottom <= top) continue;
    return Number(block.dataset.messagePage ?? 0);
  }
  return null;
}

/** 量当前视口：delta 用于插页后第一次还原，锚点消息用于随后几帧的重排纠正。 */
function measureViewport(element: HTMLElement): ViewportAnchor {
  const top = element.getBoundingClientRect().top;
  const item = [...element.querySelectorAll<HTMLElement>(MESSAGE_ITEM)].find(
    (candidate) => candidate.getBoundingClientRect().bottom > top,
  );
  return {
    delta: element.scrollHeight - element.scrollTop,
    id: item?.dataset.messageId ?? null,
    offset: item === undefined ? null : item.getBoundingClientRect().top - top,
  };
}

/**
 * 分页窗口交给呈现层的部分：页切分点、还能不能往前翻、以及视口所在页。
 * 消息本身仍走 `messages`，这里只管"翻页、卸载、滚动位置"这三件事。
 */
export type ChatHistory = {
  breaks: readonly number[];
  hasOlder: boolean;
  loadingOlder: boolean;
  /** 窗口的下界不挨着真尾巴时为 true：往下翻要重新取页，不能就地追加。 */
  hasNewer: boolean;
  loadingNewer: boolean;
  /** 视口上方内容变化的次数：变了就得把滚动位置按不变量还原。 */
  aboveShift: number;
  onLoadOlder: () => void;
  onLoadNewer: () => void;
  /** 整体换回最新一页：丢过尾巴之后靠它回到真尾巴。 */
  onResetToLatest: () => void;
  /** 回到最新这次的失败：窗口没换、尾巴仍是卸载过的状态。 */
  resetError: AppError | null;
  /** 窗口里出现过的消息正文，卸载后仍能给运行状态还原未投递的输入。 */
  bodies: ReadonlyMap<string, string>;
  reportAnchor: (pageIndex: number) => void;
};

/**
 * Chat 中栏的呈现层：头部上下文、消息记录与输入区。所有数据与操作都由
 * props 给出，因此同一份组件既驱动正式路由（服务调用在 chat-pane.tsx），
 * 也驱动开发演示（fixture 与本地回调）。
 */
export function ChatThread({
  back,
  chat,
  agentName,
  members,
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
  onStopRun,
  stoppingRunId,
  runAgentNames,
  onRestoreDraft,
  inputRef,
  titleEditor,
  displayTitle,
  subtitle,
  kind,
  senderNames,
  knownSenders,
  runFacts,
  runActivityByMessage,
  runActivitiesError,
  continuation,
  archived = false,
  history,
}: {
  /** 返回列表入口：正式路由传 Link，演示传按钮。 */
  back?: ReactNode;
  chat: Chat;
  agentName: string;
  /** 输入区 @ 成员候选；由容器从成员视图算出名字，不在这里重算。 */
  members: readonly MentionMember[];
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
  onStop?: () => void;
  stopPending: boolean;
  stopError: AppError | null;
  /** 群组里按行停止具体 run；DM 继续用输入区的全局停止。 */
  onStopRun?: (runId: string) => void;
  stoppingRunId?: string | null;
  /** instanceId → 分身名，群组运行状态分行时使用。 */
  runAgentNames?: ReadonlyMap<string, string>;
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
  /** 已结束 run 的完整工作记录：键是产出该记录的 assistant 消息。 */
  runActivityByMessage?: ReadonlyMap<string, ChatRunActivity>;
  runActivitiesError?: string;
  continuation?: AppResult<ChatContinuationData>;
  archived?: boolean;
  /** 消息分页窗口；缺省时按单页全量渲染，演示场景不需要它。 */
  history?: ChatHistory;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  /** 上一次落定后的视口：上方内容变化时据此把位置还原回去。 */
  const viewport = useRef<ViewportAnchor | null>(null);
  const anchorPage = useRef(-1);
  const [atBottom, setAtBottom] = useState(true);
  const [newSinceScroll, setNewSinceScroll] = useState(false);
  const count = messages.ok ? messages.data.length : 0;
  const jobTitle = profile && profile.ok ? (profile.data.jobTitle ?? "") : "";
  const active = runState.ok ? isRunActive(runState.data) : false;
  const latestRun = runState.ok ? (runState.data.latest ?? undefined) : undefined;
  // 多个 Agent 同时活动时，页头徽标跟随仍在跑的那条，而不是最后创建的 run。
  const activeStatus = runState.ok
    ? (runState.data.active.find((row) => row.status === "running")?.status ??
      runState.data.active[0]?.status)
    : undefined;
  const effectiveKind = kind ?? chat.kind;
  const composerStatusLabel = runState.ok
    ? effectiveKind !== "dm" && runState.data.active.length > 0
      ? `${runState.data.active.length} 个 Agent 进行中`
      : runStatusLabel(runState.data)
    : "";
  const first = useRef(true);
  const oldestId = messages.ok ? (messages.data[0]?.id ?? null) : null;
  const newestId = messages.ok ? (messages.data.at(-1)?.id ?? null) : null;
  // 头部那条消息换了，说明变的是上方（往前插页、卸载上方页），不是尾巴来了新消息。
  const seenOldest = useRef(oldestId);
  // 尾部没换、只是中间少了页，不该亮"有新消息"。
  const seenNewest = useRef(newestId);

  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const shiftedAbove = oldestId !== seenOldest.current;
    const appendedBelow = newestId !== seenNewest.current;
    seenOldest.current = oldestId;
    seenNewest.current = newestId;
    if (first.current || atBottom) {
      element.scrollTop = element.scrollHeight;
      first.current = false;
      setNewSinceScroll(false);
      return;
    }
    // 往上翻出来的历史不该亮"回到底部"的提示。
    if (shiftedAbove || !appendedBelow) {
      setNewSinceScroll(false);
      return;
    }
    setNewSinceScroll(true);
  }, [count, atBottom, oldestId, newestId]);

  const aboveShift = history?.aboveShift ?? 0;
  const pinning = useRef(false);
  // 钉位置期间要能被用户的真实手势打断：手势由输入事件表达，不靠算 scrollTop 差值。
  const cancelPin = useRef<() => void>(() => {});
  const historyRef = useRef(history);
  historyRef.current = history;
  const releasePin = () => {
    if (!pinning.current) return;
    cancelPin.current();
    const element = scroll.current;
    if (element !== null) viewport.current = measureViewport(element);
  };

  // 上方内容变了：按锚点消息的实际位置把视口钉回去，而不是靠"高度差"。
  // 同一个提交里也可能丢掉视口下方的页，高度差就不再等于上方的变化量；
  // 按元素位置纠正只依赖"这条消息在屏幕上待过哪儿"，两头怎么变都对。
  useLayoutEffect(() => {
    const element = scroll.current;
    const anchor = viewport.current;
    if (element === null || anchor === null) return;
    const { id, offset, delta } = anchor;
    let expected = element.scrollTop;
    let frame = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let frames = 0;
    pinning.current = true;
    // 上方内容变了，页号也跟着平移：这里记的旧页号对新数组不再成立，落定后必须重报。
    anchorPage.current = -1;

    // 锚点还在就按它的位置纠偏；被卸载了就退回高度不变量（那时变化的都在视口上方）。
    const drift = () => {
      const item = id === null ? null : messageItem(element, id);
      if (item !== null && offset !== null)
        return item.getBoundingClientRect().top - element.getBoundingClientRect().top - offset;
      return element.scrollHeight - delta - element.scrollTop;
    };
    // 收手只解自己的锁：cleanup 里不能重新量视口，那一刻测到的是"变完之后"的样子，
    // 拿它当基准会让下一次还原原地不动。
    const cleanup = () => {
      pinning.current = false;
      cancelAnimationFrame(frame);
      if (timer !== null) clearTimeout(timer);
    };
    // 钉稳之后要主动收手：`pinning` 一直为真会吞掉后续的滚动手势与翻页检查。
    const finish = () => {
      cleanup();
      // 记下落定后的视口：下一次（用户没再滚动就再来一次）还原才有真值。
      viewport.current = measureViewport(element);
      // 落定之后视口停在哪一页就报哪一页。不报的话，程序化还原的滚动不会更新锚点，
      // 锚点就会一直停在插页前的位置，最后把刚插进来的那页当成"离得太远"丢掉。
      const page = visiblePage(element);
      if (page === null) return;
      anchorPage.current = page;
      historyRef.current?.reportAnchor(page);
    };
    const pin = () => {
      // 用户自己滚动了就放手，不跟人抢（scrollTop 会被取整，差不超过半像素算没动）。
      if (Math.abs(element.scrollTop - expected) > 0.5) return finish();
      const gap = drift();
      if (Math.abs(gap) >= 1) {
        element.scrollTop += gap;
        expected = element.scrollTop;
      }
      if (++frames < PIN_FRAMES) frame = requestAnimationFrame(pin);
      else if (timer === null) timer = setTimeout(pin, PIN_RETRY_MS);
      else finish();
    };
    // 此刻布局已刷新，量到的就是真值；之后几帧只是等既有行重排落定。
    pin();
    frame = requestAnimationFrame(pin);
    cancelPin.current = cleanup;
    return () => {
      cleanup();
      cancelPin.current = () => {};
    };
  }, [aboveShift]);

  const title = displayTitle ?? chatDisplayName(chat, agentName);
  const subline =
    subtitle ??
    (effectiveKind === "public_channel"
      ? "Public Channel"
      : effectiveKind === "group"
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
            {effectiveKind === "dm" && jobTitle && (
              <>
                <span className="max-desktop:hidden">·</span>
                <span className="max-desktop:hidden">{jobTitle}</span>
              </>
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {latestRun && <RunStatusBadge status={activeStatus ?? latestRun.status} />}
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
        onWheel={releasePin}
        onTouchStart={releasePin}
        onPointerDown={releasePin}
        onKeyDown={releasePin}
        onScroll={(event) => {
          const element = event.currentTarget;
          const bottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
          setAtBottom(bottom);
          if (bottom) setNewSinceScroll(false);
          if (history === undefined) return;
          // 还原滚动位置的那几帧里别重量视口：量到的可能是还没落定的中间态。
          if (!pinning.current) viewport.current = measureViewport(element);
          // 接近顶部就再往前要一页；滚到真顶部反而不如提前一屏，滚动手感更连续。
          if (element.scrollTop < LOAD_OLDER_PX && history.hasOlder && !history.loadingOlder) {
            history.onLoadOlder();
          }
          // 接近底部同理往后再要一页：只在尾巴被卸载后才可能，挨着真尾巴时按增量读走。
          if (
            element.scrollHeight - element.scrollTop - element.clientHeight < LOAD_OLDER_PX &&
            history.hasNewer &&
            !history.loadingNewer
          ) {
            history.onLoadNewer();
          }
          // 还原中的位置不算用户的选择，不然半路丢掉页会让还原基准失效。
          if (pinning.current) return;
          const page = visiblePage(element);
          if (page === null || page === anchorPage.current) return;
          anchorPage.current = page;
          history.reportAnchor(page);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-7 pt-5.75 pb-4.5 max-desktop:px-3.75 max-desktop:py-5 [overflow-anchor:none]"
      >
        {runActivitiesError && (
          <p
            role="status"
            data-testid="run-activities-error"
            className="mb-3 rounded-control border border-border bg-muted px-3 py-2 text-[11px] text-muted-foreground"
          >
            历史 run 工作记录暂时无法读取：{runActivitiesError}
          </p>
        )}
        {history !== undefined && history.hasOlder && (
          <div className="mb-3 flex justify-center">
            <button
              type="button"
              data-testid="load-older-messages"
              disabled={history.loadingOlder}
              onClick={() => history.onLoadOlder()}
              className="rounded-control border border-border bg-background px-3 py-1.5 text-[11px] text-foreground disabled:opacity-60"
            >
              {history.loadingOlder ? "正在加载更早的消息…" : "加载更早的消息"}
            </button>
          </div>
        )}
        {!messages.ok ? (
          <ChatErrorNotice error={messages.error} testId="messages-load-error" />
        ) : !runState.ok ? (
          <>
            <MessageList
              messages={messages.data}
              breaks={history?.breaks}
              profile={profile}
              humanName={humanName}
              senderNames={senderNames}
              knownSenders={knownSenders}
              runFacts={runFacts}
              runActivityByMessage={runActivityByMessage}
            />
            <ChatErrorNotice error={runState.error} testId="run-state-load-error" />
          </>
        ) : (
          <>
            <MessageList
              messages={messages.data}
              breaks={history?.breaks}
              profile={profile}
              humanName={humanName}
              senderNames={senderNames}
              knownSenders={knownSenders}
              runFacts={runFacts}
              runActivityByMessage={runActivityByMessage}
            />
            <RunStatusPanel
              state={runState.data}
              messages={messages.data}
              bodies={history?.bodies}
              onRestoreDraft={onRestoreDraft}
              chatKind={effectiveKind}
              agentNames={runAgentNames}
              onStopRun={onStopRun}
              stoppingRunId={stoppingRunId}
              continuation={continuation}
            />
          </>
        )}
        {history !== undefined && history.hasNewer && (
          <div className="mt-3 flex justify-center">
            <button
              type="button"
              data-testid="load-newer-messages"
              disabled={history.loadingNewer}
              onClick={() => history.onLoadNewer()}
              className="rounded-control border border-border bg-background px-3 py-1.5 text-[11px] text-foreground disabled:opacity-60"
            >
              {history.loadingNewer ? "正在加载更新的消息…" : "加载更新的消息"}
            </button>
          </div>
        )}
        {(newSinceScroll || (history !== undefined && history.hasNewer && !atBottom)) && (
          <button
            type="button"
            data-testid="new-messages-jump"
            onClick={() => {
              // 尾巴被卸载过就先整体换回最新一页，否则只是把当前窗口滚到底。
              if (history !== undefined && history.hasNewer) history.onResetToLatest();
              setAtBottom(true);
              setNewSinceScroll(false);
            }}
            className="sticky bottom-2 mx-auto mt-3 block rounded-control border border-border bg-background px-3 py-2 text-[11px] text-foreground shadow-sm"
          >
            {newSinceScroll ? "有新消息 · 回到最新" : "回到最新"}
          </button>
        )}
        {history?.resetError != null && (
          <p
            role="status"
            data-testid="reset-latest-error"
            className="mt-2 text-center text-[11px] text-muted-foreground"
          >
            回到最新失败，稍后再试。
          </p>
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
          members={members}
          draft={draft}
          onDraftChange={onDraftChange}
          onSubmit={onSend}
          pending={sendPending}
          error={sendError}
          fieldErrors={fieldErrors}
          runActive={active}
          runStatusLabel={composerStatusLabel}
          stopping={stopPending}
          stopError={stopError}
          onStop={onStop}
          inputRef={inputRef}
        />
      )}
    </section>
  );
}
