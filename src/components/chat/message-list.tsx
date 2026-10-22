import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { Message } from "../../contracts/chat";
import { ChatAvatar } from "./chat-avatar";
import { clockLabel } from "./format";

/** 消息按领域服务给定的时间与 rowid 升序渲染，human 与 agent 用可见标签区分。 */
export function MessageList({
  messages,
  profile,
  humanName,
}: {
  messages: Message[];
  profile: AgentResult<AgentProfile> | null;
  /** 当前登录者的名称来自已有会话；缺失时退回「你」。 */
  humanName: string;
}) {
  if (messages.length === 0)
    return (
      <p data-testid="messages-empty" className="text-xs leading-6 text-muted-foreground">
        还没有消息。发送第一条吧。
      </p>
    );

  const agent = profile && profile.ok ? profile.data : null;
  const agentName = agent?.name ?? "Agent";
  const persona = [agent?.jobTitle, agent?.persona?.split("。")[0]].filter(Boolean).join(" · ");

  return (
    <ol data-testid="message-list" className="space-y-6">
      {messages.map((message) => {
        const human = message.senderKind === "human";
        const name = human ? humanName || "你" : agentName;
        return (
          <li
            key={message.id}
            data-testid="message-item"
            data-message-id={message.id}
            data-sender-kind={message.senderKind}
            className="grid grid-cols-[30px_minmax(0,1fr)] gap-x-3"
          >
            <ChatAvatar name={name} human={human} />
            <div className="min-w-0">
              <p className="mb-1.75 flex flex-wrap items-center gap-2">
                <strong data-testid="message-sender" className="text-xs font-semibold">
                  {name}
                </strong>
                <span
                  data-testid="message-kind"
                  className="rounded-[3px] border border-border px-1 text-[9px] text-muted-foreground"
                >
                  {human ? "Human" : "Agent"}
                </span>
                <time
                  data-testid="message-created-at"
                  dateTime={message.createdAt}
                  className="text-[10px] text-muted-foreground"
                >
                  {clockLabel(message.createdAt)}
                </time>
              </p>
              {!human && persona && (
                <p data-testid="message-persona" className="mb-2 text-[10px] text-muted-foreground">
                  {persona}
                </p>
              )}
              <p
                data-testid="message-body"
                className={
                  human
                    ? "rounded-b-lg rounded-tr-lg bg-muted px-3.5 py-2.75 text-xs leading-6 break-words whitespace-pre-wrap"
                    : "text-xs leading-6 break-words whitespace-pre-wrap"
                }
              >
                {message.body}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
