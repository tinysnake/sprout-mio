import type { ChatUnreadItem } from "../../contracts/chat-read";

/** 未读 tracker 是纯逻辑（不碰 DOM、不碰网络），所以可以单测。 */
export type ChatUnreadTracker = {
  /** 首屏基线：只记「当前有哪些未读、最后一条是谁」，不把已有未读当新消息再提醒一次。 */
  seed(items: readonly ChatUnreadItem[]): void;
  /**
   * 与基线比较后返回真正变新的项。判据只看 `lastMessage.id`：同一条消息未读数变化不算新消息。
   * `activeChatId` 命中的对话由 ChatPane 单独标已读，不在这里提醒。
   */
  next(
    items: readonly ChatUnreadItem[],
    options?: { activeChatId?: string | undefined },
  ): ChatUnreadItem[];
};

const lastIdOf = (item: ChatUnreadItem): string => item.lastMessage?.id ?? "";

export function createChatUnreadTracker(): ChatUnreadTracker {
  let baseline = new Map<string, string>();
  return {
    seed(items) {
      baseline = new Map(items.map((item) => [item.chatId, lastIdOf(item)]));
    },
    next(items, { activeChatId } = {}) {
      const updated = new Map<string, string>();
      const fresh: ChatUnreadItem[] = [];
      for (const item of items) {
        const lastId = lastIdOf(item);
        const previous = baseline.get(item.chatId);
        const isNew = previous === undefined || previous !== lastId;
        updated.set(item.chatId, lastId);
        if (!isNew || item.chatId === activeChatId) continue;
        fresh.push(item);
      }
      // 条目消失即从基线移除：对话读完后不该在下次出现时又被当成新消息。
      baseline = updated;
      return fresh;
    },
  };
}
