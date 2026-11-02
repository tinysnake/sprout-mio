import { useEffect, useRef, useState } from "react";
import type { AgentRunResult, ChatRunState } from "../../contracts/agent-run";
import type { ChatResult, Message } from "../../contracts/chat";
import type { ChatDetailLoaderData } from "./chat-loader";
import { getChatRunStateFn } from "../../server/functions/agent-run";
import { listMessagesFn } from "../../server/functions/chat";

/** 活跃 run 的定点刷新节奏：沿用旧全树 invalidate 的 1.2s，不额外加快。 */
export const CHAT_LIVE_INTERVAL_MS = 1_200;

/** 一个 tick 读回的活动事实：只有随 run 变化的两块，其余事实继续来自 loader。 */
export type ChatLiveFacts = {
  messages: ChatResult<Message[]>;
  runState: AgentRunResult<ChatRunState>;
};

type Environment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
};

export function isActiveRunState(runState: AgentRunResult<ChatRunState>): boolean {
  return runState.ok && runState.data.active.length > 0;
}

/**
 * run 集合与状态的指纹：只要它变了，就有一次值得整树重读的转移
 * （新 run 出现、状态推进、本轮结束）。停止或起跑都要重读会话、自动化、
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
 * 可见时每 1.2s 读一次这条 Chat 的消息与 run 状态，页面只把结果叠在 loader 事实之上。
 * run 指纹发生变化时回报一次 `onRunChanged`，由页面做一次整树 invalidate；
 * 每次 tick 只发两个读，不再重跑整棵路由的 loader。
 */
export function createChatLiveRefresh({
  reads,
  onFacts,
  onRunChanged,
  seedSignature = null,
  environment,
  intervalMs = CHAT_LIVE_INTERVAL_MS,
}: {
  reads: {
    messages: () => Promise<ChatResult<Message[]>>;
    runState: () => Promise<AgentRunResult<ChatRunState>>;
  };
  onFacts: (facts: ChatLiveFacts) => void;
  onRunChanged: () => void;
  /** loader 已经读到过的那份 run 指纹：tick 结果与它一致就不必重读整树。 */
  seedSignature?: string | null;
  environment: Environment;
  intervalMs?: number;
}): () => void {
  const { document } = environment;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  // 一次只允许一个 tick 在途：服务端挂起时排队重试只会把队列压得更长。
  let inFlight = false;
  let signature = seedSignature;

  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
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
      const [messages, runState] = await Promise.all([reads.messages(), reads.runState()]);
      if (stopped) return;
      onFacts({ messages, runState });
      const next = runSignature(runState);
      const active = isActiveRunState(runState);
      if (next !== null) {
        const moved = next !== signature;
        signature = next;
        // 只有指纹真的变了才重读：一个 tick 里的新 run、状态推进、本轮结束都算变化，
        // 而「loader 已经知道它是空闲的」不必再花一次全树重读。
        if (moved) onRunChanged();
      }
      // run 状态读不到时不改门禁：下一 tick 继续读，结束判定只认成功的响应。
      if (runState.ok && !active) {
        stopped = true;
        return;
      }
    } catch {
      // 单次读失败保持门禁不变：下一 tick 重试，不把失败当成本轮结束。
    } finally {
      inFlight = false;
      if (!stopped) schedule();
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
  document.addEventListener("visibilitychange", resume);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", resume);
  };
}

/** 生产接法：一次 tick 并发读消息与 run 状态，两个读各自保留自己的错误语义。 */
export function chatLiveReads(chatId: string) {
  return {
    messages: () => listMessagesFn({ data: { chatId } }),
    runState: () => getChatRunStateFn({ data: { chatId } }),
  };
}

/**
 * 页面的活跃读数。`loader` 同时是种子（已读到的 run 指纹）与重置锚点：
 * loader 一换（invalidate 之后）就丢掉旧读数，让更晚的 loader 事实优先，
 * 不让一次早于 loader 的 tick 覆盖它。换 Chat 时旧 tick 的结果按 chatId 丢弃。
 */
export function useChatLive({
  chatId,
  active,
  loader,
  onRunChanged,
}: {
  chatId: string;
  active: boolean;
  loader: ChatDetailLoaderData;
  onRunChanged: () => void;
}): ChatLiveFacts | null {
  const [state, setState] = useState<{ chatId: string; facts: ChatLiveFacts } | null>(null);
  const changed = useRef(onRunChanged);
  changed.current = onRunChanged;
  const seedSignature = loader.ok ? runSignature(loader.runState) : null;
  useEffect(() => {
    if (!active) return;
    const chat = chatId;
    return createChatLiveRefresh({
      reads: chatLiveReads(chat),
      onFacts: (facts) => setState({ chatId: chat, facts }),
      onRunChanged: () => changed.current(),
      seedSignature,
      environment: { document },
    });
  }, [active, chatId, seedSignature]);
  useEffect(() => setState(null), [loader]);
  return state && state.chatId === chatId ? state.facts : null;
}
