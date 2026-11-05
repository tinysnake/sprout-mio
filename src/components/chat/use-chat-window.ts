import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppError } from "../../contracts/result";
import type { ChatResult, Message, MessageWindow } from "../../contracts/chat";
import { CHAT_MESSAGE_PAGE_SIZE } from "../../contracts/chat";
import { listMessagesFn } from "../../server/functions/chat";
import type { ChatLiveFacts } from "./use-chat-live";
import {
  appendNew,
  appendNewer,
  evictFar,
  fromWindow,
  hasNewer as hasNewerOf,
  hasOlder as hasOlderOf,
  mergeNewest,
  newerCursor,
  olderCursor,
  pageBreaks,
  prependOlder,
  stillAtEdge,
  windowMessages,
  type ChatWindowState,
} from "./message-window";

/**
 * 消息窗口：一页首屏、两头按页翻、屏外按页卸载。
 * loader 重读只并回尾巴，用户已经翻上去的页不会被重读清空；两头的游标永远来自服务端，
 * 窗口里不重切页，所以"翻回哪一段"不会错位。
 */
export function useChatWindow({
  chatId,
  page,
  live,
}: {
  chatId: string;
  /** 首屏那一页：`hasOlder`/`hasNewer` 与两头的游标都由服务端给，客户端不自己猜。 */
  page: ChatResult<MessageWindow>;
  live: ChatLiveFacts | null;
}): {
  messages: Message[];
  breaks: number[];
  hasOlder: boolean;
  loadingOlder: boolean;
  hasNewer: boolean;
  loadingNewer: boolean;
  aboveShift: number;
  /** 窗口里出现过的消息正文，卸载后仍能给运行状态面板还原未投递的输入。 */
  bodies: ReadonlyMap<string, string>;
  /** 顶部自动加载与"加载更早"按钮共用；失败时窗口不动，下次滚动还会再试。 */
  loadOlder: () => void;
  /** 底部自动加载与"加载更新"按钮共用；只在尾巴被卸载后才可能为真。 */
  loadNewer: () => void;
  /** 丢过尾巴之后整体换回最新一页，回到真尾巴。 */
  resetToLatest: () => void;
  /** 回到最新失败时的错误；成功或再次尝试时清空。 */
  resetError: AppError | null;
  /** 往前或往后读一页失败时的错误；下一次尝试时清空。 */
  loadError: AppError | null;
  /** 视口所在页变了就报上来，窗口据此丢掉离锚点太远的页。 */
  reportAnchor: (pageIndex: number) => void;
} {
  // 首屏直接用 loader 那一页起手，免得挂载瞬间先闪一帧空列表。
  const [state, setState] = useState<ChatWindowState | null>(() =>
    page.ok ? fromWindow(page.data) : null,
  );
  const [bodies, setBodies] = useState<ReadonlyMap<string, string>>(new Map());
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [resetError, setResetError] = useState<AppError | null>(null);
  const [loadError, setLoadError] = useState<AppError | null>(null);
  const loadingOlderRef = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingLatestRef = useRef(false);

  // 锚点就存在 window state 里：插页与卸载都会带着它一起平移，这里只是按它收敛。
  const settle = (next: ChatWindowState): ChatWindowState => evictFar(next, next.anchor);

  useEffect(() => {
    if (!page.ok) return;
    const next = page.data;
    setState((prev) => settle(prev === null ? fromWindow(next) : mergeNewest(prev, next)));
  }, [page]);

  // 增量读已经排在 loader 前面把新消息拿到过：先接到尾巴，重读到达时再按 id 合并。
  useEffect(() => {
    if (live === null || !live.messages.ok) return;
    const fresh = live.messages.data;
    setState((prev) => (prev === null ? prev : settle(appendNew(prev, fresh))));
  }, [live]);

  // 正文按 id 攒着：正文很短，攒住它比"运行状态面板恰好需要一条已卸载的消息"更便宜。
  useEffect(() => {
    const seen = windowMessages(state ?? { pages: [], anchor: 0, aboveShift: 0 });
    if (seen.length === 0) return;
    setBodies((prev) => {
      let next: Map<string, string> | null = null;
      for (const message of seen) {
        if (prev.has(message.id)) continue;
        next ??= new Map(prev);
        next.set(message.id, message.body);
      }
      return next ?? prev;
    });
  }, [state]);

  const before = state === null ? null : olderCursor(state);
  const after = state === null ? null : newerCursor(state);
  const canLoadOlder = state !== null && before !== null && hasOlderOf(state);
  const canLoadNewer = state !== null && after !== null && hasNewerOf(state);

  const loadOlder = useCallback(() => {
    if (loadingOlderRef.current || before === null) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    setLoadError(null);
    void listMessagesFn({ data: { chatId, before, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) {
          setLoadError(result.error);
          return;
        }
        setState((prev) => {
          if (prev === null || !stillAtEdge(prev, { before })) return prev;
          return settle(prependOlder(prev, result.data));
        });
      })
      // 读失败保留窗口与 hasOlder：失败不等于"没有更早的消息"。
      .finally(() => {
        loadingOlderRef.current = false;
        setLoadingOlder(false);
      });
  }, [chatId, before]);

  const loadNewer = useCallback(() => {
    if (loadingNewerRef.current || after === null) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    setLoadError(null);
    void listMessagesFn({ data: { chatId, after, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) {
          setLoadError(result.error);
          return;
        }
        setState((prev) => {
          if (prev === null || !stillAtEdge(prev, { after })) return prev;
          return settle(appendNewer(prev, result.data));
        });
      })
      // 读失败保留窗口与 hasNewer：失败不等于"已经到最新了"。
      .finally(() => {
        loadingNewerRef.current = false;
        setLoadingNewer(false);
      });
  }, [chatId, after]);

  const resetToLatest = useCallback(() => {
    if (loadingLatestRef.current) return;
    loadingLatestRef.current = true;
    setResetError(null);
    void listMessagesFn({ data: { chatId, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) {
          setResetError(result.error);
          return;
        }
        setState((prev) => {
          const fresh = fromWindow(result.data);
          return {
            pages: fresh.pages,
            anchor: 0,
            aboveShift: prev?.aboveShift ?? 0,
          };
        });
      })
      .finally(() => {
        loadingLatestRef.current = false;
      });
  }, [chatId]);

  const reportAnchor = useCallback((pageIndex: number) => {
    setState((prev) => (prev === null ? prev : evictFar(prev, pageIndex)));
  }, []);

  const messages = useMemo(() => (state === null ? [] : windowMessages(state)), [state]);
  const breaks = useMemo(() => (state === null ? [] : pageBreaks(state)), [state]);

  return {
    messages,
    breaks,
    hasOlder: canLoadOlder,
    loadingOlder,
    hasNewer: canLoadNewer,
    loadingNewer,
    aboveShift: state?.aboveShift ?? 0,
    bodies,
    loadOlder,
    loadNewer,
    resetToLatest,
    resetError,
    loadError,
    reportAnchor,
  };
}
