import { useState } from "react";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, PanelRightClose, ShieldCheck } from "lucide-react";
import { agentDetailFromChat } from "../agent/agent-detail-search";
import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
import type { ChatMember, ChatSession, ChatWakePolicy } from "../../contracts/chat";
import type {
  ChatInfoView,
  ChatRunAggregate,
  InfoHubResult,
  TurnStartContext,
} from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import { addGroupMemberFn, removeGroupMemberFn, setChatOwnerFn } from "../../server/functions/chat";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { ResultError } from "../project/result-error";
import { ChatAvatar } from "./chat-avatar";
import { ChatFactsBlock } from "../info-hub/chat-info-panel";
import { RunFactsBlock, TurnStartContextBlock } from "../info-hub/run-facts";
import { governanceAvailability } from "./chat-governance";
import type { ChatMachineFacts } from "./chat-loader";
import { LeaseOverview } from "../machine/lease-panel";
import { ExecutionTargetTable, RemoteExecutionList } from "../machine/remote-execution-panel";

const WAKE_POLICY_LABELS: Record<ChatWakePolicy, string> = {
  owner_led: "owner_led · 未点名时回退 Owner",
  mention_only: "mention_only · 仅点名唤醒",
  contextual: "contextual · P5a 回退为 owner_led",
};

function memberKey(member: Pick<ChatMember, "memberKind" | "memberId">) {
  return `${member.memberKind}:${member.memberId}`;
}

function ownerKey(kind: "human" | "agent", id: string) {
  return `${kind}:${id}`;
}

/** 右侧常驻详情：成员、Owner、活动三段默认展开，治理动作只在这里出现。 */
export function ChatDetails({
  projectId,
  session,
  humanUserId,
  humanName,
  members,
  profile,
  info,
  turnStart,
  activity,
  projectMembers,
  projectProfiles,
  machineFacts = null,
  machineFactsError,
  onClose,
  onChanged,
}: {
  projectId: string;
  session: ChatSession;
  humanUserId: string;
  humanName: string;
  members: AgentResult<ChatMember[]>;
  profile: AgentResult<AgentProfile> | null;
  info: AgentResult<ChatInfoView>;
  turnStart: InfoHubResult<TurnStartContext>;
  activity?: ChatRunAggregate;
  projectMembers: ProjectMember[];
  projectProfiles: AgentProfile[];
  machineFacts?: ChatMachineFacts | null;
  machineFactsError?: AppError;
  onClose: () => void;
  onChanged: () => void;
}) {
  const chat = session.chat;
  const infoMembers = info.ok ? info.data.members : [];
  const names = new Map(infoMembers.map((member) => [memberKey(member), member.displayName]));
  const profileNames = new Map(projectProfiles.map((entry) => [entry.id, entry.name]));
  const instanceId = session.kind === "dm" ? session.instance.id : session.instances[0]?.instanceId;
  const firstAgent = infoMembers.find((member) => member.memberKind === "agent");
  const agentName = profile?.ok
    ? profile.data.name
    : (firstAgent?.displayName ??
      (session.kind === "dm" ? undefined : session.instances[0]?.profileName) ??
      "Agent");
  const ownerName =
    chat.owner.kind === "human"
      ? (infoMembers.find(
          (member) => member.memberKind === "human" && member.memberId === chat.owner.id,
        )?.displayName ?? (chat.owner.id === humanUserId ? humanName || "你" : "Human"))
      : (infoMembers.find(
          (member) => member.memberKind === "agent" && member.memberId === chat.owner.id,
        )?.displayName ??
        profileNames.get(chat.owner.id) ??
        "Agent");
  const actions = governanceAvailability({
    kind: chat.kind,
    ownerKind: chat.owner.kind,
    ownerId: chat.owner.id,
    actorKind: "human",
    actorId: humanUserId,
  });
  const currentMembers: ChatMember[] = members.ok ? members.data : [];
  const currentKeys = new Set(currentMembers.map(memberKey));
  const allAgents = projectMembers.map((member) => ({
    id: member.agentProfileId,
    name: profileNames.get(member.agentProfileId) ?? "Agent",
  }));
  const addableAgents = allAgents.filter((agent) => !currentKeys.has(ownerKey("agent", agent.id)));
  const agentCount = activity ? activity.agentCount : null;
  const runCount = activity
    ? activity.statusCounts.reduce((total, entry) => total + entry.count, 0)
    : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="chat-details">
      <header className="flex min-h-15.25 items-center gap-2 border-b border-border px-5 max-desktop:min-h-19 max-desktop:px-3 max-desktop:py-3.5">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="back-to-chat"
          aria-label="返回聊天"
          title="返回聊天"
          onClick={onClose}
          className="hidden max-desktop:inline-flex"
        >
          <Icon as={ArrowLeft} />
        </Button>
        <h2 className="min-w-0 flex-1 truncate text-[13px]">会话详情</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="close-inspector"
          aria-label="收起会话详情"
          title="收起会话详情"
          onClick={onClose}
          className="max-desktop:hidden"
        >
          <Icon as={PanelRightClose} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-6">
        <details
          open
          data-testid="chat-details-members"
          className="group border-b border-border py-4"
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <span>成员</span>
            <span className="flex items-center gap-2 text-[10px] font-normal text-muted-foreground">
              {members.ok ? `${members.data.length} 位成员` : "成员读取失败"}
              <Icon
                as={ChevronRight}
                size={12}
                className="transition-transform group-open:rotate-90"
              />
            </span>
          </summary>
          <div className="space-y-3 pt-3">
            {!members.ok ? (
              <ResultError error={members.error} testId="chat-load-error" />
            ) : (
              <ul data-testid="chat-member-list" className="space-y-1.5">
                {currentMembers.map((member) => {
                  const key = memberKey(member);
                  const isOwner =
                    chat.owner.kind === member.memberKind && chat.owner.id === member.memberId;
                  const name =
                    names.get(key) ??
                    (member.memberKind === "human"
                      ? member.memberId === humanUserId
                        ? humanName || "你"
                        : "Human"
                      : (profileNames.get(member.memberId) ?? "Agent"));
                  const canRemove = actions.member_remove && !isOwner;
                  return (
                    <li key={key} className="flex items-center gap-2">
                      <ChatAvatar name={name} human={member.memberKind === "human"} small />
                      <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
                      {isOwner && (
                        <span className="rounded-[3px] border border-border px-1 text-[9px] text-muted-foreground">
                          Owner
                        </span>
                      )}
                      {canRemove && (
                        <RemoveMemberButton
                          chatId={chat.id}
                          revision={chat.governanceRevision}
                          memberKind={member.memberKind}
                          memberId={member.memberId}
                          onChanged={onChanged}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {chat.kind === "public_channel" && (
              <div
                data-testid="channel-members-readonly"
                data-error-code="channel_membership_managed"
                className="rounded-control border border-border bg-secondary px-3 py-2.5 text-[10px] leading-5 text-muted-foreground"
              >
                公共频道成员跟随项目自动同步，不可独立修改。到{" "}
                <Link
                  to="/projects/$projectId/members"
                  params={{ projectId }}
                  data-testid="channel-project-members-link"
                  className="text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
                >
                  Project Members
                </Link>{" "}
                调整成员。
              </div>
            )}
            {chat.kind === "group" && (
              <div className="flex flex-wrap items-center gap-2">
                {actions.member_add ? (
                  <AddMemberDialog
                    chatId={chat.id}
                    revision={chat.governanceRevision}
                    agents={addableAgents}
                    onChanged={onChanged}
                  />
                ) : (
                  <p className="text-[10px] leading-5 text-muted-foreground">
                    仅当前 Human owner 可修改。Agent owner 不拥有治理权限。
                  </p>
                )}
              </div>
            )}
            {chat.kind === "dm" && (
              <p className="text-[10px] leading-5 text-muted-foreground">
                DM 成员固定为两位参与者，不提供独立成员治理。
              </p>
            )}
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 pt-2 text-[11px]">
              <dt className="text-muted-foreground">Chat ID</dt>
              <dd data-testid="inspector-chat-id" className="font-mono break-all">
                {chat.id}
              </dd>
              <dt className="text-muted-foreground">分身 Instance ID</dt>
              <dd data-testid="inspector-instance-id" className="font-mono break-all">
                {instanceId ?? "（群内还没有分身）"}
              </dd>
              <dt className="text-muted-foreground">成员</dt>
              <dd data-testid="inspector-member-list">
                {infoMembers.map((member) => member.displayName).join("、") ||
                  (members.ok ? "（空）" : "成员读取失败")}
              </dd>
              <dt className="text-muted-foreground">消息数</dt>
              <dd data-testid="inspector-message-count">
                {info.ok ? info.data.messages.count : "未知"}
              </dd>
            </dl>
            {profile && (
              <div
                data-testid="chat-inspector-identity"
                className="space-y-2 border-t border-border pt-3"
              >
                {!profile.ok && (
                  <ResultError error={profile.error} testId="inspector-profile-error" />
                )}
                <div className="flex items-center gap-2.5">
                  <ChatAvatar name={agentName} />
                  <div className="min-w-0 flex-1">
                    <strong
                      data-testid="inspector-agent-name"
                      className="block truncate text-xs font-semibold"
                    >
                      {agentName}
                    </strong>
                    <p className="mt-0.5 text-[10px] text-muted-foreground">
                      {profile.ok && profile.data.jobTitle ? profile.data.jobTitle : "未设置职位"}
                    </p>
                  </div>
                  {profile.ok && (
                    <Link
                      to="/agents/$agentProfileId"
                      params={{ agentProfileId: profile.data.id }}
                      search={agentDetailFromChat(chat)}
                      data-testid="inspector-agent-profile-link"
                      className="shrink-0 text-[10px] text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
                    >
                      profile
                    </Link>
                  )}
                </div>
                <p
                  data-testid="inspector-agent-persona"
                  className="text-[11px] leading-6 break-words whitespace-pre-wrap"
                >
                  {profile.ok ? profile.data.persona || "（空）" : ""}
                </p>
              </div>
            )}
          </div>
        </details>

        <details
          open
          data-testid="chat-details-owner"
          className="group border-b border-border py-4"
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <span>Owner</span>
            <span className="flex items-center gap-2 text-[10px] font-normal text-muted-foreground">
              {ownerName}
              <Icon
                as={ChevronRight}
                size={12}
                className="transition-transform group-open:rotate-90"
              />
            </span>
          </summary>
          <div className="space-y-3 pt-3">
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1.5 text-[11px]">
              <dt className="text-muted-foreground">Owner</dt>
              <dd data-testid="chat-owner-name">
                {ownerName}（{chat.owner.kind === "human" ? "Human" : "Agent"}）
              </dd>
              <dt className="text-muted-foreground">唤醒策略</dt>
              <dd data-testid="chat-wake-policy">{WAKE_POLICY_LABELS[chat.wakePolicy]}</dd>
              <dt className="text-muted-foreground">治理版本</dt>
              <dd data-testid="chat-governance-revision">{chat.governanceRevision}</dd>
            </dl>
            {chat.kind === "group" && actions.owner_change ? (
              <OwnerDialog
                chatId={chat.id}
                revision={chat.governanceRevision}
                members={currentMembers}
                names={names}
                humanUserId={humanUserId}
                humanName={humanName}
                agentNames={profileNames}
                onChanged={onChanged}
              />
            ) : (
              <p className="text-[10px] leading-5 text-muted-foreground">
                {chat.kind === "public_channel"
                  ? "公共频道 Owner 固定为 Project 创建者。"
                  : "仅当前 Human owner 可修改。Agent owner 不拥有治理权限。"}
              </p>
            )}
          </div>
        </details>

        <details
          open
          data-testid="chat-details-activity"
          className="group border-b border-border py-4"
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <span>活动</span>
            <span className="flex items-center gap-2 text-[10px] font-normal text-muted-foreground">
              {agentCount === null ? "活动 Agent 数未知" : `${agentCount} 个 Agent`}
              <Icon
                as={ChevronRight}
                size={12}
                className="transition-transform group-open:rotate-90"
              />
            </span>
          </summary>
          <div className="space-y-4 pt-3">
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1.5 text-[11px]">
              <dt className="text-muted-foreground">活动 Agent</dt>
              <dd data-testid="activity-agent-count">
                {agentCount === null
                  ? "活动 Agent 数未知"
                  : agentCount === 0
                    ? "暂无活动 Agent"
                    : `${agentCount} 个（按 Agent 去重）`}
              </dd>
              <dt className="text-muted-foreground">活动 run</dt>
              <dd data-testid="activity-run-count">
                {runCount === null
                  ? "活动状态暂不可用"
                  : runCount === 0
                    ? "暂无活动 run"
                    : `${runCount} 条 run`}
              </dd>
            </dl>
            {activity && activity.statusCounts.length > 0 && (
              <ul data-testid="activity-status-counts" className="flex flex-wrap gap-1.5">
                {activity.statusCounts.map((entry) => (
                  <li
                    key={entry.status}
                    className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
                  >
                    {entry.status} · {entry.count}
                  </li>
                ))}
              </ul>
            )}
            {!info.ok ? (
              <ResultError error={info.error} testId="info-hub-chat-error" />
            ) : !turnStart.ok ? (
              <ResultError error={turnStart.error} testId="info-hub-turn-context-error" />
            ) : (
              <div className="space-y-4">
                <RunFactsBlock runs={info.data.runs} testId="info-chat-runs" />
                <TurnStartContextBlock context={turnStart.data} />
              </div>
            )}
            <details className="group border-t border-border pt-3" open>
              <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] hover:underline [&::-webkit-details-marker]:hidden">
                <span>Chat 事实与成员</span>
                <Icon
                  as={ChevronRight}
                  size={12}
                  className="transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="pt-2">
                {info.ok ? (
                  <ChatFactsBlock view={info.data} />
                ) : (
                  <p className="text-[11px] text-muted-foreground">
                    Chat 事实随上方错误一并不可用。
                  </p>
                )}
              </div>
            </details>
            <div className="space-y-4 pt-1">
              <div className="flex items-center justify-between gap-3">
                <span className="text-[10px] text-muted-foreground">Machine / Worker</span>
                <span
                  data-testid="chat-machines-notice"
                  className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
                >
                  {machineFacts
                    ? "与 Project settings 同一租约事实"
                    : machineFactsError
                      ? "读取失败"
                      : "未接入，P4b 集成"}
                </span>
              </div>
              {machineFactsError && <ResultError error={machineFactsError} />}
              {machineFacts && (
                <div data-testid="chat-machine-facts" className="space-y-4">
                  <LeaseOverview
                    projectId={machineFacts.projectId}
                    machines={machineFacts.machines}
                    leases={machineFacts.leases}
                    holderNames={machineFacts.holderNames}
                    dense
                    testId="chat-leases"
                  />
                  {machineFacts.executions.length > 0 && (
                    <ExecutionTargetTable
                      executions={machineFacts.executions}
                      machines={machineFacts.machines}
                      testId="chat-execution-targets"
                    />
                  )}
                  <RemoteExecutionList
                    executions={machineFacts.executions}
                    machines={machineFacts.machines}
                    holderNames={machineFacts.holderNames ?? {}}
                    dense
                    readOnlyNote="此面板只读：只展示已知的执行事实与日志位点。读取日志与取消这次执行请在 Machine 详情页操作。"
                    testId="chat-executions"
                  />
                </div>
              )}
            </div>
          </div>
        </details>

        <p className="flex gap-2 pt-5 text-[10px] leading-5 text-muted-foreground">
          <Icon as={ShieldCheck} size={14} className="mt-0.5" />
          {machineFacts
            ? "远端操作以 Worker 运行用户权限执行在工作目录之外；租约不随 run 结束释放。"
            : "分析基于固定快照。分身可以读取仓库；远端操作的日志读取与取消在 Machine 详情页进行。"}
        </p>
      </div>
      <div className="border-t border-border px-5 py-3.5 text-[10px] text-muted-foreground max-desktop:pb-[max(14px,env(safe-area-inset-bottom))]">
        仅 Project 成员可见
      </div>
    </div>
  );
}

function AddMemberDialog({
  chatId,
  revision,
  agents,
  onChanged,
}: {
  chatId: string;
  revision: number;
  agents: { id: string; name: string }[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(agents[0]?.id ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selected || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await addGroupMemberFn({
        data: {
          chatId,
          member: { kind: "agent", id: selected },
          expectedRevision: revision,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="chat-member-add"
        data-governance-action="member_add"
        render={<Button type="button" variant="secondary" size="sm" />}
      >
        添加成员
      </DialogTrigger>
      <DialogContent data-testid="chat-member-add-dialog">
        <DialogHeader>
          <DialogTitle>添加成员</DialogTitle>
          <DialogDescription>只列出尚未加入本群的 Project Agent。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {agents.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">没有可添加的 Agent。</p>
          ) : (
            <select
              data-testid="chat-member-add-select"
              value={selected}
              onChange={(event) => setSelected(event.target.value)}
              className="min-h-8.5 w-full rounded-control border border-input bg-background px-2.5 text-xs"
            >
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          )}
          {error && <ResultError error={error} testId="chat-member-add-error" />}
          <div className="flex justify-end">
            <Button type="submit" data-testid="chat-member-add-submit" loading={pending}>
              添加
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function RemoveMemberButton({
  chatId,
  revision,
  memberKind,
  memberId,
  onChanged,
}: {
  chatId: string;
  revision: number;
  memberKind: "human" | "agent";
  memberId: string;
  onChanged: () => void;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  async function remove() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await removeGroupMemberFn({
        data: {
          chatId,
          member: { kind: memberKind, id: memberId },
          expectedRevision: revision,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }
  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        data-testid="chat-member-remove"
        data-governance-action="member_remove"
        aria-label="移除成员"
        title="移除成员"
        disabled={pending}
        onClick={() => void remove()}
      >
        ×
      </Button>
      {error && <ResultError error={error} testId="chat-member-remove-error" />}
    </span>
  );
}

function OwnerDialog({
  chatId,
  revision,
  members,
  names,
  humanUserId,
  humanName,
  agentNames,
  onChanged,
}: {
  chatId: string;
  revision: number;
  members: ChatMember[];
  names: Map<string, string>;
  humanUserId: string;
  humanName: string;
  agentNames: Map<string, string>;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(() => (members[0] ? memberKey(members[0]) : ""));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const member = members.find((entry) => memberKey(entry) === selected);
    if (!member || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await setChatOwnerFn({
        data: {
          chatId,
          owner: { kind: member.memberKind, id: member.memberId },
          expectedRevision: revision,
        },
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        data-testid="chat-owner-edit"
        data-governance-action="owner_change"
        render={<Button type="button" variant="secondary" size="sm" />}
      >
        更改 Owner
      </DialogTrigger>
      <DialogContent data-testid="chat-owner-dialog">
        <DialogHeader>
          <DialogTitle>更改 Owner</DialogTitle>
          <DialogDescription>
            写入会携带当前治理版本 {revision}；并发冲突时不会自动重放。
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <select
            data-testid="chat-owner-select"
            value={selected}
            onChange={(event) => setSelected(event.target.value)}
            className="min-h-8.5 w-full rounded-control border border-input bg-background px-2.5 text-xs"
          >
            {members.map((member) => {
              const key = memberKey(member);
              const name =
                names.get(key) ??
                (member.memberKind === "human"
                  ? member.memberId === humanUserId
                    ? humanName || "你"
                    : "Human"
                  : (agentNames.get(member.memberId) ?? "Agent"));
              return (
                <option key={key} value={key}>
                  {name}（{member.memberKind === "human" ? "Human" : "Agent"}）
                </option>
              );
            })}
          </select>
          {error && <ResultError error={error} testId="chat-owner-error" />}
          <div className="flex justify-end">
            <Button type="submit" data-testid="chat-owner-submit" loading={pending}>
              保存 Owner
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
