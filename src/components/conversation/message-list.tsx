import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { Message } from "../../contracts/conversation";

/** 消息按领域服务给定的时间与 rowid 升序渲染，human 与 agent 用可见标签区分。 */
export function MessageList({
  messages,
  profile,
}: {
  messages: Message[];
  profile: AgentResult<AgentProfile> | null;
}) {
  if (messages.length === 0)
    return (
      <p data-testid="messages-empty" className="text-sm text-muted-foreground">
        还没有消息。发送第一条吧。
      </p>
    );

  const agentName = profile && profile.ok ? profile.data.name : "Agent";

  return (
    <ol data-testid="message-list" className="space-y-3">
      {messages.map((message) => (
        <li
          key={message.id}
          data-testid="message-item"
          data-message-id={message.id}
          data-sender-kind={message.senderKind}
          className="rounded-lg border px-4 py-3"
        >
          <p className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
            <span data-testid="message-sender">
              {message.senderKind === "human" ? "你" : agentName}
            </span>
            <span
              data-testid="message-kind"
              className={
                message.senderKind === "human"
                  ? "rounded bg-secondary px-1.5 py-0.5 text-secondary-foreground"
                  : "rounded bg-primary/10 px-1.5 py-0.5 text-primary"
              }
            >
              {message.senderKind === "human" ? "Human" : "Agent"}
            </span>
            <span data-testid="message-created-at">{message.createdAt}</span>
          </p>
          <p data-testid="message-body" className="text-sm break-words whitespace-pre-wrap">
            {message.body}
          </p>
        </li>
      ))}
    </ol>
  );
}
