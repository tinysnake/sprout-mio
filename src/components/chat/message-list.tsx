import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { Message } from "../../contracts/chat";
import type { InfoHubRunSummary } from "../../contracts/info-hub";
import { ChatAvatar } from "./chat-avatar";
import { clockLabel } from "./format";
import { RUN_STATUS_LABELS } from "./run-status";
import { senderKey } from "./chat-session-display";

const GROUPING_WINDOW_MS = 5 * 60 * 1000;

type MessageRunFacts = Map<string, readonly InfoHubRunSummary[]>;

/**
 * 消息按领域服务给定的时间与 rowid 升序渲染。连续的同发送者表头在 5 分钟内归并，
 * 但每条消息仍单独保留 body、发送者与 run 关联；群聊绝不把某个 profile 应用到整列。
 */
export function MessageList({
  messages,
  profile,
  humanName,
  senderNames,
  knownSenders,
  runFacts,
}: {
  messages: Message[];
  /** DM 的既有身份快照；群聊逐条按 senderId 查 senderNames。 */
  profile: AgentResult<AgentProfile> | null;
  /** 当前登录者的名称来自已有会话；缺失时退回「你」。 */
  humanName: string;
  senderNames?: ReadonlyMap<string, string>;
  /** 成员查询成功时的已知发送者集合；缺失时不把未解析者误判为历史。 */
  knownSenders?: ReadonlySet<string>;
  /** 由 assistantMessageId 精确匹配的 run，不按时间或发送者猜测归属。 */
  runFacts?: MessageRunFacts;
}) {
  if (messages.length === 0)
    return (
      <p data-testid="messages-empty" className="text-xs leading-6 text-muted-foreground">
        还没有消息。发送第一条，开始协作。
      </p>
    );

  const agent = profile && profile.ok ? profile.data : null;
  const dmAgentName = agent?.name ?? "Agent";
  const persona = [agent?.jobTitle, agent?.persona?.split("。")[0]].filter(Boolean).join(" · ");

  return (
    <ol data-testid="message-list" className="space-y-1">
      {messages.map((message, index) => {
        const human = message.senderKind === "human";
        const key = senderKey(message.senderKind, message.senderId);
        const name =
          senderNames?.get(key) ??
          (human ? humanName || "你" : dmAgentName) ??
          (human ? "Human" : "Agent");
        const previous = messages[index - 1];
        const grouped =
          previous &&
          previous.senderKind === message.senderKind &&
          previous.senderId === message.senderId &&
          new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <=
            GROUPING_WINDOW_MS;
        const historical = knownSenders ? !knownSenders.has(key) : false;
        const links = runFacts?.get(message.id) ?? [];
        return (
          <li
            key={message.id}
            data-testid="message-item"
            data-message-id={message.id}
            data-sender-kind={message.senderKind}
            data-sender-id={message.senderId}
            className={
              grouped
                ? "grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 pt-1"
                : "grid grid-cols-[30px_minmax(0,1fr)] gap-x-3 pt-5"
            }
          >
            {grouped ? <span aria-hidden="true" /> : <ChatAvatar name={name} human={human} />}
            <div className="min-w-0">
              {!grouped && (
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
                  {historical && (
                    <span
                      data-testid="message-history-badge"
                      className="rounded-[3px] border border-dashed border-input px-1 text-[9px] text-muted-foreground"
                    >
                      已移出 · 历史发送者
                    </span>
                  )}
                  <time
                    data-testid="message-created-at"
                    dateTime={message.createdAt}
                    className="text-[10px] text-muted-foreground"
                  >
                    {clockLabel(message.createdAt)}
                  </time>
                </p>
              )}
              {!human && !grouped && persona && (
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
              {!human && (
                <p
                  data-testid="message-run-links"
                  className="mt-1 text-[10px] text-muted-foreground"
                >
                  {links.length === 0
                    ? "未关联 run · 不推断归属"
                    : links.map((run) => (
                        <span key={run.runId} className="mr-2 inline-flex items-center gap-1">
                          <span className="font-mono">{run.runId.slice(0, 12)}…</span>
                          <span>{RUN_STATUS_LABELS[run.status] ?? run.status}</span>
                        </span>
                      ))}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
