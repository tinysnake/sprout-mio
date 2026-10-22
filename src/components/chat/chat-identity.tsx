import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentInstance, Chat, ChatMember, ChatResult } from "../../contracts/chat";
import { ChevronRight } from "lucide-react";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";
import { ChatAvatar } from "./chat-avatar";

/**
 * 对话身份：Chat 与分身 instance 的绑定事实，以及成员集合。
 * 它属于这条对话本身，因此常驻对话区并可展开查看；ID 是诊断用的原始值，
 * 展开后按等宽字体换行呈现，不撑出水平滚动。
 * 分身身份 = agent_instance 行；profile 只提供展示名与人设。
 */
export function ChatIdentity({
  chat,
  members,
  instances,
  profile,
  agentName,
  humanName,
  open = true,
}: {
  chat: Chat;
  members: ChatResult<ChatMember[]>;
  instances: ChatResult<AgentInstance[]>;
  profile: AgentResult<AgentProfile> | null;
  agentName: string;
  humanName: string;
  open?: boolean;
}) {
  const instance = instances.ok ? instances.data[0] : undefined;
  const agentProfileId = instance?.agentProfileId ?? (profile?.ok ? profile.data.id : undefined);
  const persona = profile && profile.ok ? profile.data.persona : "";
  const jobTitle = profile && profile.ok ? (profile.data.jobTitle ?? "") : "";

  return (
    <details data-testid="chat-identity" open={open} className="group mb-6">
      <summary className="flex min-h-9.5 cursor-pointer list-none items-center gap-2.5 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChatAvatar name={agentName} small />
        <span className="min-w-0 flex-1 truncate">
          对话身份 · {agentName}
          {jobTitle && ` · ${jobTitle}`}
        </span>
        <Icon as={ChevronRight} size={12} className="transition-transform group-open:rotate-90" />
      </summary>
      <div className="mt-2 space-y-2 rounded-lg border border-border px-3 py-2.5">
        {profile && !profile.ok && (
          <ResultError error={profile.error} testId="chat-profile-error" />
        )}
        {!members.ok && <ResultError error={members.error} testId="chat-load-error" />}
        {!instances.ok && <ResultError error={instances.error} testId="chat-load-error" />}
        <p data-testid="chat-agent-persona" className="text-[11px] leading-6 break-words">
          {persona || "（空）"}
        </p>
        <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 text-[11px]">
          <dt className="text-muted-foreground">Chat ID</dt>
          <dd data-testid="chat-id" className="font-mono break-all">
            {chat.id}
          </dd>
          <dt className="text-muted-foreground">分身 Instance ID</dt>
          <dd data-testid="chat-instance-id" className="font-mono break-all">
            {instances.ok ? (instance?.id ?? "（缺少分身记录）") : "（读取失败）"}
          </dd>
          <dt className="text-muted-foreground">Agent profile</dt>
          <dd data-testid="chat-agent-name">{agentName}</dd>
          <dt className="text-muted-foreground">Agent profile ID</dt>
          <dd data-testid="chat-profile-id" className="font-mono break-all">
            {agentProfileId ?? "（缺少 profile 记录）"}
          </dd>
        </dl>
        <div className="space-y-1">
          <p className="text-[10px] text-muted-foreground">成员</p>
          <ul data-testid="chat-member-list" className="space-y-1 text-[11px]">
            {members.ok ? (
              members.data.map((member) => (
                <li
                  key={`${member.memberKind}:${member.memberId}`}
                  data-testid="chat-member-item"
                  data-member-kind={member.memberKind}
                >
                  {member.memberKind === "human"
                    ? `${humanName || "你"}（Human）`
                    : `${agentName}（Agent）`}
                </li>
              ))
            ) : (
              <li>成员读取失败。</li>
            )}
          </ul>
        </div>
      </div>
    </details>
  );
}
