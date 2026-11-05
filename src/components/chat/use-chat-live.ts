import { useEffect, useRef, useState } from "react";
import { CHANGE_SAFETY_POLL_MS, chatTopic } from "../../contracts/change-stream";
import { changeSource, onChangeStreamState, type ChangeSource } from "../../lib/change-stream";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import { laterMessageCursor } from "../../contracts/chat";
import type { ChatResult, Message, MessageCursor, MessageWindow } from "../../contracts/chat";
import type { ChatDetailLoaderData } from "./chat-loader";
import { getChatRunStateFn } from "../../server/functions/agent-run";
import { getChatContinuationFn } from "../../server/functions/chat-continuation";
import { listMessagesFn } from "../../server/functions/chat";
import type { AppResult } from "../../contracts/result";
import type { ChatContinuationData } from "../../domain/chat-continuation";

/** 活跃 run 的定点刷新节奏：沿用旧全树 invalidate 的 1.2s，不额外加快。 */
export const CHAT_LIVE_INTERVAL_MS = 1_200;

/**
 * 空闲时也要轮询：判定器可能在页面没有任何活动 run 时启动新 run，
 * 只靠活跃 run 门禁会让 Agent 回帖一直停在旧消息里。放慢到 5 秒，仍随页面隐藏暂停。
 */
export const CHAT_IDLE_INTERVAL_MS = 5_000;

/**
 * 一个 tick 读回的活动事实：会随判定与 run 变化的那几块，其余事实继续来自 loader。
 * 对话接续的判定不改消息也不改 run，只靠 run 指纹重读会让「正在检查」永远显示不出来。
 */
export type ChatLiveFacts = {
  messages: ChatResult<Message[]>;
  runState: AgentRunResult<ChatRunState>;
  continuation: AppResult<ChatContinuationData>;
};

/** 增量读的种子：loader 那批消息与它的尾巴游标。 */
export type ChatLiveSeed = { messages: Message[]; cursor: MessageCursor | null };

/** 活跃读的句柄：停止轮询，或在 loader 换了之后重置 overlay 与游标。 */
export type ChatLiveRefresh = {
  stop: () => void;
  reseed: (seed: ChatLiveSeed) => void;
};

type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
};

export function isActiveRunState(runState: AgentRunResult<ChatRunState>): boolean {
  return runState.ok && runState.data.active.length > 0;
}

/**
 * run 集合与状态的指纹：只要它变了，就有一次值得整树重读的转移
 * （新 run 出现、状态推进、本轮结束）。停止或起跑都要重读会话、对话接续、
 * 关联 Task 与 inspector 的轮初快照，而这些东西不在 tick 的读取范围内。
 */
function runSignature(runState: AgentRunResult<ChatRunState>): string | null {
  if (!runState.ok) return null;
  const { active, latest } = runState.data;
  const observed = active.map((run) => `${run.id}:${run.status}`);
  // 收尾那一 tick 只剩 latest 在变，它不在活跃集合里时也要算进指纹。
  if (latest && !active.some((run) => run.id === latest.id)) {
    observed.push(`${latest.id}:${latest.status}`);
  }
  return observed.join(",");
}

/**
 * 一次判定的读视图指纹：状态、轮次、结论、投递与提醒。判定既不写消息也不改 run，
 * 只要它变了，只由 loader 读来的那份对话接续（Info Hub 用的就是它）就已经过时，
 * 值得整树重读一次——否则判定在中栏失败之后，Info Hub 还会停在旧的「正在检查」。
 */
function continuationSignature(continuation: AppResult<ChatContinuationData>): string {
  if (!continuation.ok) return `unavailable:${continuation.error.code}`;
  const view = continuation.data.view;
  const evaluation = view.latestEvaluation;
  const attention = view.attention;
  return [
    view.mode,
    view.epoch,
    view.nextDueAt ?? "",
    view.remindedHuman ? "reminded" : "",
    evaluation?.evaluationId ?? "",
    evaluation?.state ?? "",
    evaluation?.attempt ?? 0,
    evaluation?.claimedAt ?? "",
    evaluation?.finishedAt ?? "",
    evaluation?.nextAttemptAt ?? "",
    evaluation?.errorCode ?? "",
    evaluation?.result?.decision ?? "",
    attention
      ? `${attention.errorCode}:${attention.deliveryId ?? attention.evaluationId ?? ""}`
      : "",
    view.deliveries.map((item) => `${item.deliveryId}:${item.state}:${item.runId ?? ""}`).join(","),
  ].join("|");
}

/**
 * 可见时每 1.2s 读一次这条 Chat 的消息、run 状态与对话接续判定，页面只把结果叠在 loader 事实之上。
 * 消息只读 loader 那批之后的增量，按 id 去重后追加到 overlay；run 指纹变化时回报一次
 * `onRunChanged`，新消息到达时回报一次 `onMessagesChanged`，由页面做一次整树 invalidate。
 * 每次 tick 只发三个读，不再重跑整棵路由的 loader。
 */
export function createChatLiveRefresh({
  seed,
  reads,
  onFacts,
  onRunChanged,
  onMessagesChanged,
  seedSignature = null,
  environment,
  intervalMs = CHAT_LIVE_INTERVAL_MS,
  stopWhenIdle = true,
  changes,
}: {
  seed: ChatLiveSeed;
  reads: {
    messages: (after: MessageCursor | null) => Promise<ChatResult<MessageWindow>>;
    runState: () => Promise<AgentRunResult<ChatRunState>>;
    continuation: () => Promise<AppResult<ChatContinuationData>>;
  };
  onFacts: (facts: ChatLiveFacts) => void;
  onRunChanged: () => void;
  /** 新消息到达时回报一次，让 Info Hub 的消息计数与最近消息时间同步。 */
  onMessagesChanged?: () => void;
  /** loader 已经读到过的那份 run 指纹：tick 结果与它一致就不必重读整树。 */
  seedSignature?: string | null;
  environment: Environment;
  intervalMs?: number;
  /** 默认在 run 收尾后停止；页面需要持续发现新 run 时传 false。 */
  stopWhenIdle?: boolean;
  /** 有推送时用安全间隔读一次，没有推送退回轮询节奏。 */
  changes?: ChangeSource;
}): ChatLiveRefresh {
  const { document } = environment;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // 一次只允许一个 tick 在途：服务端挂起时排队重试只会把队列压得更长。
  let inFlight = false;
  let pushPending = false;
  let signature = seedSignature;
  // 判定指纹只在 tick 之间比较：第一次读到的那份就是基准，不为了对齐它再重读一次整树。
  let continuationSeen: string | null = null;
  // overlay = loader 那批 + 之后 tick 追加的增量；`known` 用来去掉两者重叠的部分。
  let overlay = [...seed.messages];
  let known = new Set(overlay.map((entry) => entry.id));
  let cursor = seed.cursor;
  let messageSignature = overlay.at(-1)?.id ?? null;

  const reseed = (next: ChatLiveSeed) => {
    overlay = [...next.messages];
    known = new Set(overlay.map((entry) => entry.id));
    cursor = next.cursor;
    messageSignature = overlay.at(-1)?.id ?? null;
    continuationSeen = null;
  };

  const schedule = () => {
    if (stopped) return;
    const interval = changes?.connected() ? CHANGE_SAFETY_POLL_MS.chat : intervalMs;
    timer = setTimeout(() => void tick(), interval);
  };

  /** 推送到达：不必等满轮询间隔；正在读就记一笔，让这一轮结束立刻补读。 */
  const wake = () => {
    if (stopped || document.visibilityState !== "visible") return;
    if (inFlight) {
      pushPending = true;
      return;
    }
    clearTimeout(timer);
    timer = undefined;
    void tick();
  };

  async function tick() {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || inFlight) return;
    if (document.visibilityState !== "visible") {
      schedule();
      return;
    }
    inFlight = true;
    try {
      const [window, runState, continuation] = await Promise.all([
        reads.messages(cursor),
        reads.runState(),
        reads.continuation(),
      ]);
      if (stopped) return;
      let messages: ChatResult<Message[]>;
      if (window.ok) {
        // loader 与 tick 之间有竞态，同一条消息可能两边都出现；重叠是正常现象。
        for (const entry of window.data.messages) {
          if (known.has(entry.id)) continue;
          known.add(entry.id);
          overlay.push(entry);
        }
        // reseed 可能在本轮在途时把游标推后：取较后者，不回退也不重读。
        cursor = laterMessageCursor(cursor, window.data.tailCursor);
        messages = { ...window, data: overlay };
      } else {
        // 增量读失败照旧把错误交给页面，不回退成 loader 那批旧事实。
        messages = window;
      }
      onFacts({ messages, runState, continuation });
      const next = runSignature(runState);
      const active = isActiveRunState(runState);
      const nextMessage = overlay.at(-1)?.id ?? null;
      const messageMoved = nextMessage !== messageSignature;
      messageSignature = nextMessage;
      let runMoved = false;
      if (next !== null) {
        runMoved = next !== signature;
        signature = next;
      }
      const nextContinuation = continuationSignature(continuation);
      const continuationMoved = continuationSeen !== null && nextContinuation !== continuationSeen;
      continuationSeen = nextContinuation;
      // run 或判定变了就整树重读；只有消息变化时也重读一次，让不在 tick 读取范围内的
      // Info Hub 消息计数、最近消息时间与对话接续读视图跟上来。同一 tick 变化时只重读一次。
      if (runMoved || continuationMoved) onRunChanged();
      else if (messageMoved) onMessagesChanged?.();
      // run 状态读不到时不改门禁：下一 tick 继续读，结束判定只认成功的响应。
      if (runState.ok && !active && stopWhenIdle) {
        stop();
        return;
      }
    } catch {
      // 单次读失败保持门禁不变：下一 tick 重试，不把失败当成本轮结束。
    } finally {
      inFlight = false;
      if (!stopped) {
        if (pushPending) {
          pushPending = false;
          void tick();
        } else schedule();
      }
    }
  }

  // 从后台切回前台立刻补一次读数，而不是等满一个间隔。
  const resume = () => {
    if (stopped || inFlight) return;
    if (document.visibilityState !== "visible") return;
    clearTimeout(timer);
    timer = undefined;
    void tick();
  };
  const unsubscribe = changes?.subscribe(wake);
  // 连接状态一变就按新节奏重排定时器：断开立刻从 15 秒退回原间隔，不用等这一读到点。
  const unsubscribeState = changes
    ? onChangeStreamState(() => {
        if (stopped || inFlight) return;
        clearTimeout(timer);
        timer = undefined;
        schedule();
      })
    : undefined;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", resume);
    unsubscribe?.();
    unsubscribeState?.();
  }
  document.addEventListener("visibilitychange", resume);
  schedule();
  return {
    stop,
    reseed,
  };
}

/** 生产接法：一次 tick 并发读消息增量、run 状态与对话接续判定，每个读各自保留自己的错误语义。 */
export function chatLiveReads(chatId: string, projectId: string) {
  return {
    messages: (after: MessageCursor | null) =>
      listMessagesFn({ data: { chatId, ...(after === null ? {} : { after }) } }),
    runState: () => getChatRunStateFn({ data: { chatId } }),
    continuation: () => getChatContinuationFn({ data: { projectId, chatId } }),
  };
}

/** loader 那批是首屏与重置锚点：tick 只读它之后的增量，叠在它上面。 */
function loaderSeed(loader: ChatDetailLoaderData): ChatLiveSeed {
  if (!loader.ok || !loader.messages.ok) return { messages: [], cursor: null };
  return { messages: loader.messages.data.messages, cursor: loader.messages.data.tailCursor };
}

/**
 * 页面的活跃读数。`loader` 同时是种子（已读到的 run 指纹）与重置锚点：
 * loader 一换（invalidate 之后）就丢掉 overlay，游标回到 loader 的尾巴，
 * 让更晚的 loader 事实优先，不让一次早于 loader 的 tick 覆盖它。换 Chat 时旧 tick 的结果按 chatId 丢弃。
 * 可见时始终轮询：有活动 run 用 1.2s，空闲用 5s，确保判定器后来启动的 run 也能被发现。
 */
export function useChatLive({
  chatId,
  projectId,
  active,
  loader,
  onRunChanged,
}: {
  chatId: string;
  projectId: string;
  active: boolean;
  loader: ChatDetailLoaderData;
  onRunChanged: () => void;
}): ChatLiveFacts | null {
  const [state, setState] = useState<{ chatId: string; facts: ChatLiveFacts } | null>(null);
  const changed = useRef(onRunChanged);
  changed.current = onRunChanged;
  const seed = loaderSeed(loader);
  const seedRef = useRef(seed);
  seedRef.current = seed;
  const refresh = useRef<ChatLiveRefresh | null>(null);
  const seedSignature = loader.ok ? runSignature(loader.runState) : null;
  useEffect(() => {
    const chat = chatId;
    const instance = createChatLiveRefresh({
      seed: seedRef.current,
      reads: chatLiveReads(chat, projectId),
      onFacts: (facts) => setState({ chatId: chat, facts }),
      onRunChanged: () => changed.current(),
      onMessagesChanged: () => changed.current(),
      seedSignature,
      intervalMs: active ? CHAT_LIVE_INTERVAL_MS : CHAT_IDLE_INTERVAL_MS,
      stopWhenIdle: false,
      changes: changeSource([chatTopic(chat)]),
      environment: { document },
    });
    refresh.current = instance;
    return () => {
      if (refresh.current === instance) refresh.current = null;
      instance.stop();
    };
  }, [active, chatId, projectId, seedSignature]);
  useEffect(() => {
    setState(null);
    refresh.current?.reseed(seedRef.current);
  }, [loader]);
  return state && state.chatId === chatId ? state.facts : null;
}
