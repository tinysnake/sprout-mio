import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  windowMessages,
  type ChatWindowState,
} from "./message-window";

/**
 * 消息窗口：一页首屏、两头按页翻、屏外按页卸载。
 * loader 重读只替换尾巴页，用户已经翻上去的页不会被重读清空；
 * 尾巴被卸载后重读也不会凭空接出一段缺口（窗口先按"回到最新"整体换新）。
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
  revision: number;
  aboveShift: number;
  /** 顶部自动加载与"加载更早"按钮共用；失败时窗口不动，下次滚动还会再试。 */
  loadOlder: () => void;
  /** 底部自动加载与"加载更新"按钮共用；只在尾巴被卸载后才可能为真。 */
  loadNewer: () => void;
  /** 丢过尾巴之后整体换回最新一页，回到真尾巴。 */
  resetToLatest: () => void;
  /** 视口所在页变了就报上来，窗口据此丢掉离锚点太远的页。 */
  reportAnchor: (pageIndex: number) => void;
} {
  // 首屏直接用 loader 那一页起手，免得挂载瞬间先闪一帧空列表。
  const [state, setState] = useState<ChatWindowState | null>(() =>
    page.ok ? fromWindow(page.data) : null,
  );
  // 最近一次上报的视口页：每次窗口变化都按它重新算距离，否则一直停在最早一页
  // 会永远只"往上加"而从不卸载。
  const anchor = useRef(-1);
  const loading = useRef(false);
  const loadingNewerRef = useRef(false);
  const loadingLatestRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);

  // 窗口一变就按锚点页重新算距离卸载：页是内存单位，攒着不丢等于没做分页。
  const settle = (next: ChatWindowState): ChatWindowState =>
    anchor.current < 0 ? next : evictFar(next, anchor.current);

  // 每次整树重读只替换尾巴页：用户已经翻上去的页不会被重读清空。
  useEffect(() => {
    if (!page.ok) return;
    const next = page.data;
    setState((prev) => settle(prev === null ? fromWindow(next) : mergeNewest(prev, next)));
  }, [page]);

  // 增量读已经排在 loader 前面把新消息拿到过：先接到尾巴页，重读到达时再按 id 合并。
  useEffect(() => {
    if (live === null || !live.messages.ok) return;
    const fresh = live.messages.data;
    setState((prev) =>
      prev === null ? prev : settle(appendNew(prev, fresh, CHAT_MESSAGE_PAGE_SIZE)),
    );
  }, [live]);

  const before = state === null ? null : olderCursor(state);
  const after = state === null ? null : newerCursor(state);
  const canLoadOlder = state !== null && before !== null && hasOlderOf(state);
  const canLoadNewer = state !== null && after !== null && hasNewerOf(state);

  const loadOlder = useCallback(() => {
    if (loading.current || before === null) return;
    loading.current = true;
    setLoadingOlder(true);
    void listMessagesFn({ data: { chatId, before, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) return;
        setState((prev) => (prev === null ? prev : settle(prependOlder(prev, result.data))));
      })
      // 读失败保留窗口与 hasOlder：失败不等于"没有更早的消息"。
      .finally(() => {
        loading.current = false;
        setLoadingOlder(false);
      });
  }, [chatId, before]);

  const loadNewer = useCallback(() => {
    if (loadingNewerRef.current || after === null) return;
    loadingNewerRef.current = true;
    setLoadingNewer(true);
    void listMessagesFn({ data: { chatId, after, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) return;
        setState((prev) => (prev === null ? prev : settle(appendNewer(prev, result.data))));
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
    void listMessagesFn({ data: { chatId, limit: CHAT_MESSAGE_PAGE_SIZE } })
      .then((result) => {
        if (!result.ok) return;
        setState((prev) => {
          const fresh = fromWindow(result.data);
          // revision 只增不减，渲染按它刷新；锚点位置和卸载计数沿用原来的。
          anchor.current = 0;
          return {
            pages: fresh.pages,
            revision: (prev?.revision ?? 0) + 1,
            aboveShift: prev?.aboveShift ?? 0,
          };
        });
      })
      .finally(() => {
        loadingLatestRef.current = false;
      });
  }, [chatId]);

  const reportAnchor = useCallback((pageIndex: number) => {
    anchor.current = pageIndex;
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
    revision: state?.revision ?? 0,
    aboveShift: state?.aboveShift ?? 0,
    loadOlder,
    loadNewer,
    resetToLatest,
    reportAnchor,
  };
}
