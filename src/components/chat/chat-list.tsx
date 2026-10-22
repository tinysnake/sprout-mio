import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Search } from "lucide-react";
import { cn } from "cn";
import type { AgentProfile } from "../../contracts/agent";
import type { Chat } from "../../contracts/chat";
import { Icon } from "../ui/icon";
import { isNarrowList, useChatWorkspace } from "../layout/chat-workspace";
import { ChatAvatar } from "./chat-avatar";
import type { ChatAgent } from "./chat-loader";

export type { ChatAgent };

/** 类型筛选只呈现真实契约：目前只有 DM，Group 与 Public Channel 未实现。 */
const CHAT_TYPES = [
  { id: "dm", label: "DM", available: true },
  { id: "group", label: "Group", available: false },
  { id: "public-channel", label: "Public Channel", available: false },
] as const;

/** 列表时间用固定格式而不是本地化模板，避免服务端与浏览器渲染出不同文案。 */
export function chatTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function chatAgentName(
  chatId: string,
  chatAgents: ChatAgent[],
  names: Map<string, string>,
): string {
  const profileId = chatAgents.find((entry) => entry.chatId === chatId)?.agentProfileId;
  if (!profileId) return "Agent";
  return names.get(profileId) ?? profileId;
}

export function filterChats(
  chats: Chat[],
  chatAgents: ChatAgent[],
  names: Map<string, string>,
  query: string,
): Chat[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return chats;
  return chats.filter(
    (chat) =>
      chat.id.toLowerCase().includes(needle) ||
      chatAgentName(chat.id, chatAgents, names).toLowerCase().includes(needle),
  );
}

/**
 * Chat 列表：搜索、新建入口与类型呈现。类型没有可选项时不做任何过滤，
 * 因此窄列表隐藏类型行不会留下用户无法解除的隐形筛选。
 */
export function ChatListPanel({
  projectId,
  chats,
  chatAgents,
  profiles,
  selectedChatId,
  newChatAction,
}: {
  projectId: string;
  chats: Chat[];
  chatAgents: ChatAgent[];
  profiles: AgentProfile[];
  selectedChatId?: string;
  /** 新建 DM 的触发入口由容器提供，列表本身不调用服务。 */
  newChatAction?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const { listWidth } = useChatWorkspace();
  const narrow = isNarrowList(listWidth);
  const names = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );
  const shown = filterChats(chats, chatAgents, names, query);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-list-content">
      <div className="px-4 pt-4 pb-3">
        <div className="flex h-8.75 items-center gap-2 rounded-control border border-border bg-background pl-2.5 text-muted-foreground focus-within:border-ring focus-within:outline-1 focus-within:outline-ring">
          <Icon as={Search} size={14} />
          <input
            aria-label="搜索 Chat"
            data-testid="chat-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Chat…"
            className="min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          {newChatAction}
        </div>
        <div
          role="group"
          aria-label="Chat 类型"
          data-testid="chat-type-filters"
          hidden={narrow}
          className="mt-3 flex items-stretch gap-0.75 border-b border-border"
        >
          {CHAT_TYPES.map((type) =>
            type.available ? (
              <span
                key={type.id}
                data-testid={`filter-${type.id}`}
                aria-current="true"
                className="border-b-2 border-foreground px-2 py-2 text-[10px] font-semibold text-foreground"
              >
                {type.label}
              </span>
            ) : (
              <button
                key={type.id}
                type="button"
                disabled
                data-testid={`filter-${type.id}`}
                aria-label={`${type.label}，未实现，P5`}
                title="未实现，P5"
                className="border-b-2 border-transparent px-2 py-2 text-[10px] text-muted-foreground"
              >
                {type.label}
              </button>
            ),
          )}
        </div>
        {!narrow && (
          <p className="pt-2 text-[10px] leading-4 text-muted-foreground">
            Group 与 Public Channel 未实现，P5。
          </p>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.25">
        <p className="flex items-center justify-between px-2 pt-3 pb-2.25 text-[10px] text-muted-foreground">
          <span>最近对话</span>
          <span data-testid="chat-count">{shown.length}</span>
        </p>
        {chats.length === 0 ? (
          <p
            data-testid="chats-empty"
            className="px-2 py-3 text-xs leading-6 text-muted-foreground"
          >
            还没有对话。从下面的 Agent 成员里发起第一条。
          </p>
        ) : shown.length === 0 ? (
          <p
            data-testid="chat-search-empty"
            className="px-2 py-3 text-xs leading-6 text-muted-foreground"
          >
            没有匹配的对话，试试更短的关键词。
          </p>
        ) : (
          <ul data-testid="chat-list">
            {shown.map((chat) => {
              const selected = chat.id === selectedChatId;
              return (
                <li key={chat.id}>
                  <Link
                    to="/projects/$projectId/chats/$chatId"
                    params={{ projectId, chatId: chat.id }}
                    search={(previous) => previous}
                    data-testid="chat-item"
                    data-chat-id={chat.id}
                    aria-current={selected ? "page" : undefined}
                    className={cn(
                      "mb-1 block rounded-lg border px-2.75 py-3.25 text-left",
                      selected
                        ? "border-border bg-selected"
                        : "border-transparent hover:border-input hover:bg-hover",
                    )}
                  >
                    <span className="mb-1.75 flex items-center gap-2">
                      <span
                        data-testid="chat-item-name"
                        className="min-w-0 flex-1 truncate text-xs font-medium"
                      >
                        {chat.title ?? chatAgentName(chat.id, chatAgents, names)}
                      </span>
                      <time
                        dateTime={chat.updatedAt}
                        className="shrink-0 text-[9px] text-muted-foreground"
                      >
                        {chatTimeLabel(chat.updatedAt)}
                      </time>
                    </span>
                    <span className="flex items-center gap-1.75 text-[11px] text-muted-foreground">
                      <ChatAvatar small name={chatAgentName(chat.id, chatAgents, names)} />
                      <span data-testid="chat-item-id" className="min-w-0 truncate font-mono">
                        {chat.id}
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/** 列表页与空对话页共用的提示图形。 */
export function ChatEmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: ReactNode;
}) {
  return (
    <div
      data-testid="chat-empty-state"
      className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center"
    >
      <span className="grid size-12 place-items-center rounded-container border border-border bg-secondary text-muted-foreground">
        <Icon as={MessageSquare} size={22} />
      </span>
      <h2 className="text-lg">{title}</h2>
      <p className="max-w-[30ch] text-xs leading-6 text-muted-foreground">{body}</p>
      {action}
    </div>
  );
}
