import type { ConversationInfoView, TurnStartContext } from "../../contracts/info-hub";
import { RunFactsBlock, TurnStartContextBlock } from "./run-facts";

/** Conversation → 自身与成员视角：只消费 getConversationInfo 的视图对象，不自行查询。 */
export function ConversationInfoPanel({
  view,
  turnStart,
}: {
  view: ConversationInfoView;
  turnStart: TurnStartContext;
}) {
  return (
    <article
      data-testid="info-hub-conversation"
      className="space-y-4 rounded-lg border border-dashed p-6"
    >
      <h3 className="text-lg font-semibold">对话信息（Info Hub）</h3>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted-foreground">类型</dt>
        <dd data-testid="info-conversation-kind">
          {view.kind === "dm" ? "DM（一对一）" : view.kind}
        </dd>
        <dt className="text-muted-foreground">归档状态</dt>
        <dd data-testid="info-conversation-archived">{view.archived ? "已归档" : "未归档"}</dd>
        <dt className="text-muted-foreground">分身 Instance ID</dt>
        <dd data-testid="info-conversation-instance-id" className="font-mono text-xs break-all">
          {view.instance?.instanceId ?? "（缺少分身记录）"}
        </dd>
        <dt className="text-muted-foreground">消息数</dt>
        <dd data-testid="info-message-count">{view.messages.count}</dd>
        <dt className="text-muted-foreground">最后消息时间</dt>
        <dd data-testid="info-message-latest-at">{view.messages.latestAt ?? "（还没有消息）"}</dd>
      </dl>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">成员</h4>
        <ul data-testid="info-member-list" className="space-y-1 text-sm">
          {view.members.map((member) => (
            <li
              key={`${member.memberKind}:${member.memberId}`}
              data-testid="info-member-item"
              data-member-kind={member.memberKind}
            >
              {member.memberKind === "human" ? "你（Human）" : `${member.displayName}（Agent）`}
            </li>
          ))}
        </ul>
      </div>
      <RunFactsBlock runs={view.runs} testId="info-conversation-runs" />
      <TurnStartContextBlock context={turnStart} />
    </article>
  );
}
