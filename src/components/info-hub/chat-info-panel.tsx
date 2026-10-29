import type { ChatInfoView } from "../../contracts/info-hub";

/** Chat → 自身与成员视角：只消费 getChatInfo 的视图对象，不自行查询。 */
export function ChatFactsBlock({ view }: { view: ChatInfoView }) {
  return (
    <section data-testid="info-hub-chat" className="space-y-3">
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 text-[11px]">
        <dt className="text-muted-foreground">类型</dt>
        <dd data-testid="info-chat-kind">{view.kind === "dm" ? "DM（一对一）" : view.kind}</dd>
        <dt className="text-muted-foreground">归档状态</dt>
        <dd data-testid="info-chat-archived">{view.archived ? "已归档" : "未归档"}</dd>
        <dt className="text-muted-foreground">分身 Instance ID</dt>
        <dd data-testid="info-chat-instance-id" className="font-mono break-all">
          {view.instances.at(0)?.instanceId ?? "（缺少分身记录）"}
        </dd>
        <dt className="text-muted-foreground">消息数</dt>
        <dd data-testid="info-message-count">{view.messages.count}</dd>
        <dt className="text-muted-foreground">最后消息时间</dt>
        <dd data-testid="info-message-latest-at">{view.messages.latestAt ?? "（还没有消息）"}</dd>
      </dl>
      <div className="space-y-1.5">
        <h4 className="text-[10px] font-medium text-muted-foreground">成员</h4>
        <ul data-testid="info-member-list" className="space-y-1 text-[11px]">
          {view.members.map((member) => (
            <li
              key={`${member.memberKind}:${member.memberId}`}
              data-testid="info-member-item"
              data-member-kind={member.memberKind}
            >
              {member.memberKind === "human"
                ? `${member.displayName}（Human）`
                : `${member.displayName}（Agent）`}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
