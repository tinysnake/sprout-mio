import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { MessageSquare, Search } from "lucide-react";
import { cn } from "cn";
import type { AgentProfile } from "../../contracts/agent";
import type { Chat } from "../../contracts/chat";
import type { ChatRunAggregate } from "../../contracts/info-hub";
import { Icon } from "../ui/icon";
import { isNarrowList, useChatWorkspace } from "../layout/chat-workspace";
import { ChatAvatar } from "./chat-avatar";
import { CHAT_AGENT_FALLBACK, chatDisplayName, chatSubtitleLabel } from "./chat-display";
import type { ChatAgent } from "./chat-loader";

export type { ChatAgent };

/** 三种真实会话类型都可以筛选；未知类型不会被静默排除。 */
const CHAT_TYPES = [
  { id: "all", label: "全部" },
  { id: "dm", label: "DM" },
  { id: "group", label: "Group" },
  { id: "public_channel", label: "Public Channel" },
] as const;
type ChatFilter = (typeof CHAT_TYPES)[number]["id"];

/** 列表时间用固定格式而不是本地化模板，避免服务端与浏览器渲染出不同文案。 */
export function chatTimeLabel(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * 列表行该显示的时刻。Info Hub 的 run 聚合只带 `latestRunAt`，`chat.updatedAt` 不会随
 * 活跃 run 往前跑；取较新的一条，列表页不轮询 loader 时时间戳才不会滞在后面。
 */
export function latestActivityAt(updatedAt: string, latestRunAt?: string): string {
  if (!latestRunAt) return updatedAt;
  return Date.parse(latestRunAt) > Date.parse(updatedAt) ? latestRunAt : updatedAt;
}

export function chatAgentName(
  chatId: string,
  chatAgents: ChatAgent[],
  names: Map<string, string>,
): string {
  const profileId = chatAgents.find((entry) => entry.chatId === chatId)?.agentProfileId;
  if (!profileId) return CHAT_AGENT_FALLBACK;
  // profile 名缺失时退回通用名，不把裸 profile id 当人类可读文案。
  return names.get(profileId) ?? CHAT_AGENT_FALLBACK;
}

export function chatListName(
  chat: Chat,
  chatAgents: ChatAgent[],
  names: Map<string, string>,
  aggregates?: ReadonlyMap<string, ChatRunAggregate>,
): string {
  const aggregate = aggregates?.get(chat.id);
  if (aggregate) return aggregate.displayTitle;
  if (chat.kind === "public_channel") return "公共频道（Project 范围）";
  return chatDisplayName(chat, chatAgentName(chat.id, chatAgents, names));
}

export function filterChats(
  chats: Chat[],
  chatAgents: ChatAgent[],
  names: Map<string, string>,
  query: string,
  aggregates?: ReadonlyMap<string, ChatRunAggregate>,
): Chat[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return chats;
  return chats.filter((chat) => {
    const name = chatListName(chat, chatAgents, names, aggregates);
    return (
      // id 不作可见文案，但粘贴 id 仍能定位到对话，保留既有搜索能力。
      chat.id.toLowerCase().includes(needle) ||
      name.toLowerCase().includes(needle) ||
      Boolean(chat.title?.toLowerCase().includes(needle))
    );
  });
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
  aggregates,
}: {
  projectId: string;
  chats: Chat[];
  chatAgents: ChatAgent[];
  profiles: AgentProfile[];
  selectedChatId?: string;
  /** Info Hub 的会话聚合提供标题与活动摘要；缺失时退回参与分身名。 */
  aggregates?: readonly ChatRunAggregate[];
  /** 新建 DM 的触发入口由容器提供，列表本身不调用服务。 */
  newChatAction?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChatFilter>("all");
  const [pendingOnly, setPendingOnly] = useState(false);
  const { listWidth } = useChatWorkspace();
  const narrow = isNarrowList(listWidth);
  const names = useMemo(
    () => new Map(profiles.map((profile) => [profile.id, profile.name])),
    [profiles],
  );
  const aggregateMap = useMemo(
    () => new Map((aggregates ?? []).map((entry) => [entry.chatId, entry])),
    [aggregates],
  );
  const searched = filterChats(chats, chatAgents, names, query, aggregateMap);
  const typed = filter === "all" ? searched : searched.filter((chat) => chat.kind === filter);
  const pending = (aggregates ?? []).filter((entry) => entry.activeRunIds.length > 0);
  const shown = pendingOnly
    ? typed.filter((chat) => (aggregateMap.get(chat.id)?.activeRunIds.length ?? 0) > 0)
    : typed;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-list-content">
      <div className="px-4 pt-4 pb-3">
        <div className="flex h-8.5 items-center gap-2 rounded-control border border-border bg-background pl-2.5 text-muted-foreground focus-within:border-ring focus-within:outline-1 focus-within:outline-ring max-desktop:h-11">
          <Icon as={Search} size={14} />
          <input
            aria-label="搜索 Chat"
            data-testid="chat-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索 Chat…"
            className="h-full min-w-0 flex-1 border-0 bg-transparent p-0 text-[11px] text-foreground outline-none placeholder:text-muted-foreground max-desktop:min-h-11"
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
          {CHAT_TYPES.map((type) => (
            <button
              key={type.id}
              type="button"
              data-testid={`filter-${type.id}`}
              aria-pressed={filter === type.id}
              onClick={() => setFilter(type.id)}
              className={cn(
                "border-b-2 px-2 py-2 text-[10px]",
                filter === type.id
                  ? "border-foreground font-semibold text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              {type.label}
            </button>
          ))}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.25">
        <p className="flex items-center justify-between gap-2 px-2 pt-3 pb-2.25 text-[10px] text-muted-foreground">
          <span>最近对话</span>
          {/* 待处理不再是第二个列表，而是同一份列表上的筛选（页面反馈：同一 Chat 不该列两次）。 */}
          {pending.length > 0 && (
            <button
              type="button"
              data-testid="filter-pending"
              aria-pressed={pendingOnly}
              onClick={() => setPendingOnly((value) => !value)}
              className={cn(
                "rounded-control border border-border px-1.5 py-0.5 text-[10px] hover:text-foreground",
                pendingOnly && "border-foreground font-semibold text-foreground",
              )}
            >
              待处理 {pending.length}
            </button>
          )}
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
            {pendingOnly ? "当前没有待处理的对话。" : "没有匹配的对话，试试更短的关键词。"}
          </p>
        ) : (
          <ul data-testid="chat-list">
            {shown.map((chat) => {
              const selected = chat.id === selectedChatId;
              const agentName = chatAgentName(chat.id, chatAgents, names);
              const name = chatListName(chat, chatAgents, names, aggregateMap);
              const aggregate = aggregateMap.get(chat.id);
              const shownAt = latestActivityAt(chat.updatedAt, aggregate?.latestRunAt);
              const kindLabel =
                chat.kind === "group"
                  ? "Group"
                  : chat.kind === "public_channel"
                    ? "Public Channel"
                    : chatSubtitleLabel(chat, agentName);
              const subtitle = aggregate?.activeRunIds.length
                ? `${kindLabel} · ${aggregate.activeRunIds.length} 个活动 run`
                : kindLabel;
              return (
                <li key={chat.id}>
                  <Link
                    to="/projects/$projectId/chats/$chatId"
                    params={{ projectId, chatId: chat.id }}
                    search={(previous) => previous}
                    data-testid="chat-item"
                    data-chat-id={chat.id}
                    data-chat-kind={chat.kind}
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
                        {name}
                      </span>
                      <time
                        dateTime={shownAt}
                        className="shrink-0 text-[9px] text-muted-foreground"
                      >
                        {chatTimeLabel(shownAt)}
                      </time>
                    </span>
                    <span className="flex items-center gap-1.75 text-[11px] text-muted-foreground">
                      <ChatAvatar small name={agentName} />
                      {/* 副行给出对话对象，裸 chat id 只进 title 属性，不作可见文案。 */}
                      <span data-testid="chat-item-id" title={chat.id} className="min-w-0 truncate">
                        {subtitle}
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
