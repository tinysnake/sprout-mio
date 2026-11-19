import * as React from "react";
import { Bell, BellRing } from "lucide-react";
import { cn } from "cn";

import type { AgentProfile } from "../../contracts/agent";
import type { Chat } from "../../contracts/chat";
import type { ChatUnreadItem } from "../../contracts/chat-read";
import { projectTopic } from "../../contracts/change-stream";
import { changeSource } from "../../lib/change-stream";
import {
  notificationPermission,
  requestNotificationPermission,
  showChatNotification,
} from "../../lib/browser-notifications";
import { listChatUnreadFn, markChatReadFn } from "../../server/functions/chat";
import { Icon } from "../ui/icon";
import { ToastHost, useToast } from "../ui/toast";
import { chatListName } from "./chat-list";
import type { ChatAgent } from "./chat-loader";
import { createChatUnreadTracker } from "./chat-unread-tracker";

type ChatUnreadContextValue = {
  /** 列表角标数据：只含未读 > 0 的对话。 */
  counts: ReadonlyMap<string, number>;
  /** 打开中的对话把游标推进到这条消息；只有推进到最新一条未读时才本地清角标，否则以服务端返回的剩余未读数为准。 */
  markRead: (chatId: string, messageId: string) => void;
};

const ChatUnreadContext = React.createContext<ChatUnreadContextValue | null>(null);

/** 清掉一条对话的角标；本来就没角标时返回原 Map，不空转重渲染。 */
function dropChat(
  items: ReadonlyMap<string, ChatUnreadItem>,
  chatId: string,
): ReadonlyMap<string, ChatUnreadItem> {
  if (!items.has(chatId)) return items;
  const next = new Map(items);
  next.delete(chatId);
  return next;
}

/** 没有 Provider 的场景（dev scene、单测）拿到 null，调用方必须安全跳过。 */
export function useChatUnread(): ChatUnreadContextValue | null {
  return React.useContext(ChatUnreadContext);
}

/**
 * chats 工作区唯一的未读 owner：一处订阅 Project topic，一处决定提醒方式。
 * 之所以不做全局 watcher：未读是需要 projectId 才能查的服务端事实，而 chats 之外的页面
 * 既不知道当前在哪个 Project，也没有列表可挂角标。
 */
export function ChatNotificationsProvider({
  projectId,
  activeChatId,
  chats,
  chatAgents,
  profiles,
  children,
}: {
  projectId: string;
  /** 打开中的对话：它的新消息由 ChatPane 标已读，不在右下角再提醒一次。 */
  activeChatId?: string | undefined;
  chats: Chat[];
  chatAgents: ChatAgent[];
  profiles: AgentProfile[];
  children: React.ReactNode;
}) {
  return (
    <ToastHost>
      <ChatNotifications
        projectId={projectId}
        activeChatId={activeChatId}
        chats={chats}
        chatAgents={chatAgents}
        profiles={profiles}
      >
        {children}
      </ChatNotifications>
    </ToastHost>
  );
}

function ChatNotifications({
  projectId,
  activeChatId,
  chats,
  chatAgents,
  profiles,
  children,
}: {
  projectId: string;
  activeChatId?: string | undefined;
  chats: Chat[];
  chatAgents: ChatAgent[];
  profiles: AgentProfile[];
  children: React.ReactNode;
}) {
  const toast = useToast();
  const [items, setItems] = React.useState<ReadonlyMap<string, ChatUnreadItem>>(new Map());
  // tracker 与「已提醒到哪条」都是跨渲染的状态，不能放进 state（否则提醒自己会触发重渲染循环）。
  const tracker = React.useRef(createChatUnreadTracker());
  const seeded = React.useRef(false);
  const lastMarked = React.useRef(new Map<string, string>());

  const names = React.useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );
  const titleFor = React.useCallback(
    (chatId: string) => {
      const chat = chats.find((entry) => entry.id === chatId);
      return chat ? chatListName(chat, chatAgents, names) : "新消息";
    },
    [chats, chatAgents, names],
  );

  const refresh = React.useCallback(async () => {
    const result = await listChatUnreadFn({ data: { projectId } });
    if (!result.ok) return;
    const next = result.data;
    setItems(new Map(next.map((item) => [item.chatId, item])));
    // 首屏只建基线：已经在等待的未读不该在进页面时补一轮提醒。
    if (!seeded.current) {
      tracker.current.seed(next);
      seeded.current = true;
      return;
    }
    for (const item of tracker.current.next(next, { activeChatId })) {
      const title = titleFor(item.chatId);
      const body = item.lastMessage?.preview ?? "有新消息";
      toast.show({ title, description: body });
      // 通知权限没开时这是 no-op，页面内 toast 已经兜住了提醒。
      showChatNotification({ title, body, tag: item.chatId });
    }
  }, [projectId, activeChatId, titleFor, toast]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    const source = changeSource([projectTopic(projectId)]);
    return source.subscribe(() => void refresh());
  }, [projectId, refresh]);

  // 页面隐藏时 change-stream 会断开，回到可见时必须主动补一次，否则这段时间的新消息没有提醒。
  React.useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const markRead = React.useCallback(
    (chatId: string, messageId: string) => {
      if (lastMarked.current.get(chatId) === messageId) return;
      lastMarked.current.set(chatId, messageId);
      setItems((previous) => {
        // 游标推到该对话最新一条他人消息才算看完：只推到视野底边时，下面还有没看到的未读，
        // 角标与「有新消息」不该因为滚动条动了一下就一起消失。
        const item = previous.get(chatId);
        return item?.lastMessage?.id === messageId ? dropChat(previous, chatId) : previous;
      });
      void markChatReadFn({ data: { chatId, messageId } }).then((result) => {
        if (!result.ok) {
          void refresh();
          return;
        }
        // 服务端才是权威：推进后没剩未读就本地清掉（例如游标跳过了自己刚发的消息），
        // 还剩未读说明只看到了一部分，重读一次拿回真实条数与最新一条。
        if (result.data.unreadCount === 0) setItems((previous) => dropChat(previous, chatId));
        else void refresh();
      });
    },
    [refresh],
  );

  const value = React.useMemo<ChatUnreadContextValue>(
    () => ({
      counts: new Map(Array.from(items, ([chatId, item]) => [chatId, item.unreadCount])),
      markRead,
    }),
    [items, markRead],
  );

  return <ChatUnreadContext.Provider value={value}>{children}</ChatUnreadContext.Provider>;
}

/**
 * 浏览器通知需要用户手势触发授权，所以开关必须是真的按钮；
 * 已授权 / 已拒绝时只显示状态不可点（浏览器不允许页面主动改回）。
 */
export function BrowserNotificationToggle() {
  const [permission, setPermission] = React.useState(() => notificationPermission());
  if (permission === "unsupported") return null;
  const granted = permission === "granted";
  const denied = permission === "denied";
  const label = granted ? "浏览器提醒已开启" : denied ? "浏览器通知已被拒绝" : "开启浏览器提醒";
  return (
    <button
      type="button"
      data-testid="enable-browser-notifications"
      data-permission={permission}
      aria-label={label}
      title={label}
      disabled={granted || denied}
      onClick={() => void requestNotificationPermission().then(setPermission)}
      className={cn(
        "grid size-6 shrink-0 place-items-center rounded-control text-muted-foreground",
        granted
          ? "text-status-success"
          : denied
            ? "cursor-default opacity-60"
            : "hover:bg-hover hover:text-foreground",
      )}
    >
      <Icon as={granted ? BellRing : Bell} size={14} />
    </button>
  );
}
