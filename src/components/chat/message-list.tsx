import type { ReactNode } from "react";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { ChatRunActivity } from "../../contracts/agent-run";
import type { AutomationSource } from "../../contracts/automation";
import type { MentionSpan, Message } from "../../contracts/chat";
import type { InfoHubRunSummary } from "../../contracts/info-hub";
import { ChatAvatar } from "./chat-avatar";
import { clockLabel } from "./format";
import { RunActivityGroup } from "./run-activity";
import { RUN_STATUS_LABELS } from "./run-status";
import { senderKey } from "./chat-session-display";
import { LEASE_TIMEOUT_SENDER_NAME, isLeaseTimeoutSender } from "./lease-timeout-message";
import { splitMessageSegments } from "./message-segments";
import { SkillMark } from "./skill-mark";
import type { MessageSkillSpan } from "../../contracts/skill";
import { runAttentionSenderLabel } from "../../contracts/run-attention";
import { RunAttentionNotice } from "./run-attention";

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
  runActivityByMessage,
  breaks = [],
  automationRuleLink,
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
  /** 已结束 run 的完整工作记录：键是产出它的 assistant 消息 id。 */
  runActivityByMessage?: ReadonlyMap<string, ChatRunActivity>;
  /** 每页首条消息在全量列表里的下标；缺省时整段当成一页。 */
  breaks?: readonly number[];
  /** 自动化消息指向其来源规则的入口；容器提供可导航元素，缺省时不渲染。 */
  automationRuleLink?: (source: AutomationSource) => ReactNode;
}) {
  if (messages.length === 0)
    return (
      <p data-testid="messages-empty" className="text-xs leading-6 text-muted-foreground">
        还没有消息。发送第一条，开始协作。
      </p>
    );

  const agent = profile && profile.ok ? profile.data : null;
  const dmAgentName = agent?.name ?? "Agent";

  const renderItem = (message: Message, index: number) => {
    const human = message.senderKind === "human";
    const source =
      message.senderKind === "automation" ||
      message.senderKind === "assistant_event" ||
      message.senderKind === "assistant_work";
    const attentionName =
      message.senderKind === "agent" ? runAttentionSenderLabel(message.senderId) : null;
    const systemNotice =
      Boolean(attentionName) || isLeaseTimeoutSender(message.senderKind, message.senderId);
    const agentMessage = message.senderKind === "agent";
    const key =
      message.senderKind === "automation"
        ? `automation:${message.senderId}`
        : message.senderKind === "assistant_event" || message.senderKind === "assistant_work"
          ? `${message.senderKind}:${message.senderId}`
          : senderKey(message.senderKind, message.senderId);
    const name =
      (systemNotice
        ? (attentionName ?? LEASE_TIMEOUT_SENDER_NAME)
        : message.senderKind === "automation"
          ? message.automationSource.kind === "project_cron"
            ? "Project cron"
            : "Project webhook"
          : message.senderKind === "assistant_event"
            ? "Assistant 通知"
            : message.senderKind === "assistant_work"
              ? "Human 已确认的工作提案"
              : senderNames?.get(key)) ??
      (human ? humanName || "你" : dmAgentName) ??
      (human ? "Human" : "Agent");
    const previous = messages[index - 1];
    const grouped =
      previous &&
      previous.senderKind === message.senderKind &&
      previous.senderId === message.senderId &&
      new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() <=
        GROUPING_WINDOW_MS;
    const historical = !source && !systemNotice && knownSenders ? !knownSenders.has(key) : false;
    const links = runFacts?.get(message.id) ?? [];
    const activityRecord = runActivityByMessage?.get(message.id);
    const activity = activityRecord?.activity;
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
              {/* 系统通知与自动化来源需要身份标识；Human/Agent 的名字已经说明身份，不再重复挂标签。 */}
              {(systemNotice || source) && (
                <span
                  data-testid="message-kind"
                  className="rounded-[3px] border border-border px-1 text-[9px] text-muted-foreground"
                >
                  {systemNotice ? "System" : "Source"}
                </span>
              )}
              {message.senderKind === "automation" &&
                automationRuleLink?.(message.automationSource)}
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
          {message.senderKind === "assistant_event" && (
            <a
              className="mb-2 block text-xs underline"
              data-testid="assistant-run-link"
              href={`/projects/${message.nativeSource.projectId}/chats/${message.nativeSource.chatId}${message.nativeSource.runId ? `?run=${message.nativeSource.runId}#selected-run-${message.nativeSource.runId}` : "?info=1"}`}
            >
              {message.nativeSource.runId ? "查看工作结果" : "查看工作对话"}
            </a>
          )}
          <p
            data-testid="message-body"
            className={
              human
                ? "rounded-b-lg rounded-tr-lg bg-muted px-3.5 py-2.75 text-xs leading-6 break-words whitespace-pre-wrap"
                : "text-xs leading-6 break-words whitespace-pre-wrap"
            }
          >
            <MessageBody
              body={
                message.senderKind === "assistant_event"
                  ? (message.nativeSource.summary ?? message.body)
                  : message.body
              }
              mentions={message.mentions}
              skills={message.skills}
            />
          </p>
          {message.senderKind === "assistant_event" && message.nativeSource.summary && (
            <details className="mt-2 text-xs text-muted-foreground">
              <summary className="w-fit cursor-pointer">查看通知详情</summary>
              <p className="mt-2 whitespace-pre-wrap break-words">{message.body}</p>
            </details>
          )}
          {!human && !systemNotice && !source && (links.length > 0 || activityRecord) && (
            <p data-testid="message-run-links" className="mt-1 text-[10px] text-muted-foreground">
              {links.length > 0
                ? links.map((run) => (
                    <span
                      id={`run-${run.runId}`}
                      key={run.runId}
                      className="mr-2 inline-flex items-center gap-1"
                    >
                      <span className="font-mono">{run.runId}</span>
                      <span>{RUN_STATUS_LABELS[run.status] ?? run.status}</span>
                    </span>
                  ))
                : activityRecord && (
                    <span
                      key={activityRecord.runId}
                      className="mr-2 inline-flex items-center gap-1"
                    >
                      <span className="font-mono">{activityRecord.runId}</span>
                      <span>
                        {RUN_STATUS_LABELS[activityRecord.status] ?? activityRecord.status}
                      </span>
                    </span>
                  )}
            </p>
          )}
          {activityRecord && (
            <RunAttentionNotice
              attention={activityRecord.attention}
              status={activityRecord.status}
            />
          )}
          {agentMessage && activity && (
            <div data-testid="message-run-activity" className="mt-2">
              <RunActivityGroup activity={activity} />
            </div>
          )}
        </div>
      </li>
    );
  };

  // 页是渲染、锚点与卸载的单位；窗口只留离视口几页以内的内容，条目数因此有上限。
  // 分组判定用全量列表的 index，所以跨页边界也不会把同一个人的连续发言拆成两段表头。
  const spans = (breaks.length > 0 ? breaks : [0]).map(
    (start, index, all) => [start, all[index + 1] ?? messages.length] as const,
  );
  return (
    <div data-testid="message-list">
      {spans.map(([start, end], pageIndex) => (
        <div key={messages[start]?.id ?? pageIndex} data-message-page={pageIndex}>
          <ol className="space-y-1">
            {messages
              .slice(start, end)
              .map((message, offset) => renderItem(message, start + offset))}
          </ol>
        </div>
      ))}
    </div>
  );
}

function MessageBody({
  body,
  mentions,
  skills,
}: {
  body: string;
  mentions: readonly MentionSpan[];
  skills: readonly MessageSkillSpan[];
}) {
  return (
    <>
      {splitMessageSegments(body, mentions, skills).map((segment, index) =>
        segment.skill ? (
          <SkillMark
            key={index}
            data-testid="message-skill"
            name={segment.skill.name}
            text={segment.text}
            edge={segment.skillEdge}
          />
        ) : segment.span ? (
          <span
            key={index}
            data-testid="message-mention"
            data-member-kind={segment.span.memberKind}
            data-member-id={segment.span.memberId}
            className="rounded-[3px] bg-selected px-1 font-medium [box-decoration-break:clone]"
          >
            {segment.text}
          </span>
        ) : (
          segment.text
        ),
      )}
    </>
  );
}
