import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentInstance, Chat, ChatMember } from "../../contracts/chat";
import { ResultError } from "../project/result-error";

/** 分身身份 = agent_instance 行；profile 只提供展示名与人设，编辑 profile 不改变 instance id。 */
export function ChatIdentity({
  chat,
  members,
  instances,
  profile,
}: {
  chat: Chat;
  members: ChatMember[];
  instances: AgentInstance[];
  profile: AgentResult<AgentProfile> | null;
}) {
  const instance = instances[0];
  const agentProfileId =
    instance?.agentProfileId ?? members.find((member) => member.memberKind === "agent")?.memberId;
  const agentName = profile && profile.ok ? profile.data.name : (agentProfileId ?? "Agent");
  const persona = profile && profile.ok ? profile.data.persona : "";

  return (
    <article data-testid="chat-identity" className="space-y-4 rounded-lg border p-6">
      <h3 className="text-lg font-semibold">对话身份</h3>
      {profile && !profile.ok && <ResultError error={profile.error} testId="chat-profile-error" />}
      <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
        <dt className="text-muted-foreground">Chat ID</dt>
        <dd data-testid="chat-id" className="font-mono text-xs break-all">
          {chat.id}
        </dd>
        <dt className="text-muted-foreground">分身 Instance ID</dt>
        <dd data-testid="chat-instance-id" className="font-mono text-xs break-all">
          {instance?.id ?? "（缺少分身记录）"}
        </dd>
        <dt className="text-muted-foreground">Agent profile</dt>
        <dd data-testid="chat-agent-name">{agentName}</dd>
        <dt className="text-muted-foreground">人设</dt>
        <dd data-testid="chat-agent-persona" className="whitespace-pre-wrap">
          {persona || "（空）"}
        </dd>
      </dl>
      <div className="space-y-2">
        <h4 className="text-sm font-medium text-muted-foreground">成员</h4>
        <ul data-testid="chat-member-list" className="space-y-1 text-sm">
          {members.map((member) => (
            <li
              key={`${member.memberKind}:${member.memberId}`}
              data-testid="chat-member-item"
              data-member-kind={member.memberKind}
            >
              {member.memberKind === "human" ? "你（Human）" : `${agentName}（Agent）`}
            </li>
          ))}
        </ul>
      </div>
    </article>
  );
}
