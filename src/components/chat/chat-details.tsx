import { useState } from "react";
import { ContinuationPanel } from "../continuation/continuation-panel";
import type { ContinuationPageData } from "../continuation/continuation-page-data";
import type { FormEvent } from "react";
import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, PanelRightClose, ShieldCheck } from "lucide-react";
import { agentDetailFromChat } from "../agent/agent-detail-search";
import { chatTimeLabel } from "./format";
import type { AgentProfile, AgentResult, ProjectMember } from "../../contracts/agent";
import type { ChatMember, ChatSession, ChatWakePolicy } from "../../contracts/chat";
import { chatDisplayTitle } from "../../contracts/chat";
import type { ChatInfoView, ChatRunAggregate, InfoHubResult } from "../../contracts/info-hub";
import type { TurnContextReadResult } from "../../contracts/turn-context";
import type { AppError } from "../../contracts/result";
import { ID_PREFIXES, newId } from "../../contracts/ids";
import { toAppError } from "../../contracts/result";
import {
  addGroupMemberFn,
  clearChatTitleFn,
  removeGroupMemberFn,
  setChatOwnerFn,
  updateChatTitleFn,
} from "../../server/functions/chat";
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
import { ChatErrorNotice } from "./chat-error-notice";
import { ChatAvatar } from "./chat-avatar";
import { ChatTitleEditor } from "./chat-title-editor";
import { ChatActivityFacts } from "../info-hub/chat-activity";
import { TaskAssociations } from "../tasks/task-associations";
import { governanceNote } from "./chat-governance";
import type { ChatMachineFacts } from "./chat-loader";
import { LeaseOverview } from "../machine/lease-panel";

const WAKE_POLICY_LABELS: Record<ChatWakePolicy, string> = {
  owner_led: "owner_led · 回退 Owner",
  mention_only: "mention_only · 仅点名",
  contextual: "contextual · 自动判定",
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
  turnContext,
  projectMembers,
  projectProfiles,
  machineFacts = null,
  machineFactsError,
  continuation,
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
  turnContext: InfoHubResult<TurnContextReadResult> | null;
  activity?: ChatRunAggregate;
  projectMembers: ProjectMember[];
  projectProfiles: AgentProfile[];
  machineFacts?: ChatMachineFacts | null;
  machineFactsError?: AppError;
  continuation?: ContinuationPageData;
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
  // 治理事实只读领域层算好的那一份（裁定 d45）：页面不抄能力表、不比 owner。
  // Agent 当 owner 时，`canChangeOwner` 已经包含 d6 的 Project 创建者兜底。
  const governance = session.governance;
  const currentMembers: ChatMember[] = members.ok ? members.data : [];
  const ownerCandidates =
    chat.kind === "public_channel"
      ? currentMembers.filter(
          (member) =>
            member.memberKind === "human" && member.memberId === governance.projectCreatedBy,
        )
      : currentMembers;
  const governanceCopy = governanceNote(chat.kind, governance);
  // 资料块跟着成员行的选中态；默认不选中，群组里因此没有「第一个 Agent」的猜测。
  // DM 只有一个 Agent 成员、没有歧义，沿用 P4b 的默认展示。
  const [selectedMember, setSelectedMember] = useState<string | null>(null);
  // 公共频道成员说明默认收起：只留一行结论，规则与入口藏在问号按钮后面。
  const [membersHelpOpen, setMembersHelpOpen] = useState(false);
  const [activityOpen, setActivityOpen] = useState(false);
  const soleDmAgent =
    chat.kind === "dm" ? currentMembers.filter((m) => m.memberKind === "agent") : [];
  const detailKey = selectedMember ?? (soleDmAgent.length === 1 ? memberKey(soleDmAgent[0]) : null);
  const detailMember = detailKey
    ? currentMembers.find((member) => memberKey(member) === detailKey)
    : undefined;
  const detailName = detailMember
    ? (names.get(memberKey(detailMember)) ??
      (detailMember.memberKind === "human"
        ? detailMember.memberId === humanUserId
          ? humanName || "你"
          : "Human"
        : (profileNames.get(detailMember.memberId) ?? "Agent")))
    : undefined;
  const detailProfile =
    detailMember?.memberKind === "agent"
      ? chat.kind === "dm" && profile?.ok
        ? profile.data
        : projectProfiles.find((entry) => entry.id === detailMember.memberId)
      : undefined;
  const currentKeys = new Set(currentMembers.map(memberKey));
  const allAgents = projectMembers.map((member) => ({
    id: member.agentProfileId,
    name: profileNames.get(member.agentProfileId) ?? "Agent",
  }));
  const addableAgents = allAgents.filter((agent) => !currentKeys.has(ownerKey("agent", agent.id)));

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
      <div className={`min-h-0 overflow-y-auto px-5 pt-2 ${activityOpen ? "flex-1 pb-12" : ""}`}>
        <div className="py-5">
          <ContinuationPanel data={continuation} chatKind={chat.kind} />
        </div>
        <section data-testid="inspector-tasks" className="space-y-3 border-b border-border py-5">
          <h3 className="text-[10px] font-medium text-muted-foreground">Task 摘要</h3>
          {info.ok ? (
            <TaskAssociations projectId={projectId} items={info.data.tasks.items} />
          ) : (
            <ChatErrorNotice error={info.error} testId="info-hub-tasks-error" />
          )}
        </section>
        <details
          open
          data-testid="chat-details-conversation"
          className="group border-b border-border py-4"
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <span>会话</span>
            <Icon
              as={ChevronRight}
              size={12}
              className="transition-transform group-open:rotate-90"
            />
          </summary>
          <div className="space-y-3 pt-3">
            {/* 会话自身的事实单独成段：时间不再挂在成员列表下面，成员段只讲成员。 */}
            <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 text-[11px]">
              {/* 群与频道可能有多个分身，单独一行只能指其中一个；DM 仍是一对一指代。 */}
              {chat.kind === "dm" && (
                <>
                  <dt className="text-muted-foreground">分身 Instance ID</dt>
                  <dd data-testid="inspector-instance-id" className="font-mono break-all">
                    {instanceId ?? "（还没有分身实例）"}
                  </dd>
                </>
              )}
              {info.ok && info.data.archived && (
                <>
                  <dt className="text-muted-foreground">归档状态</dt>
                  <dd data-testid="inspector-archived">已归档</dd>
                </>
              )}
              <dt className="text-muted-foreground">最后消息时间</dt>
              <dd className="whitespace-nowrap">
                {!info.ok ? (
                  "未知"
                ) : info.data.messages.latestAt ? (
                  <time
                    data-testid="inspector-message-latest-at"
                    dateTime={info.data.messages.latestAt}
                  >
                    {chatTimeLabel(info.data.messages.latestAt)}
                  </time>
                ) : (
                  <span data-testid="inspector-message-latest-at">（还没有消息）</span>
                )}
              </dd>
            </dl>
            {/* 复制 Chat ID 是「这到底是哪条会话」的操作，跟会话事实放一起。 */}
            <CopyChatIdButton chatId={chat.id} />
          </div>
        </details>
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
              <ChatErrorNotice error={members.error} testId="chat-load-error" />
            ) : (
              <ul data-testid="inspector-member-list" className="space-y-1.5">
                {currentMembers.map((member) => {
                  const key = memberKey(member);
                  // 这一行是不是 Owner 行：展示用的事实，不是权限判定（能不能治理来自 governance）。
                  const isOwnerRow =
                    chat.owner.kind === member.memberKind && chat.owner.id === member.memberId;
                  const name =
                    names.get(key) ??
                    (member.memberKind === "human"
                      ? member.memberId === humanUserId
                        ? humanName || "你"
                        : "Human"
                      : (profileNames.get(member.memberId) ?? "Agent"));
                  // 能力判定来自领域层；「所有者不能被移出」是数据事实（chat.owner），不是权限比较。
                  const canRemove = governance.canChangeMembers && !isOwnerRow;
                  // Agent 成员行可选中，选中后资料块展示这一位的职位与 persona。
                  const row =
                    member.memberKind === "agent" ? (
                      <button
                        type="button"
                        data-testid="chat-member-select"
                        data-member-key={key}
                        aria-pressed={detailKey === key}
                        aria-label={`查看 ${name} 的资料`}
                        onClick={() => setSelectedMember(detailKey === key ? null : key)}
                        className="flex min-w-0 flex-1 items-center gap-2 rounded-control border border-transparent px-1 py-0.5 text-left hover:border-input aria-pressed:border-border aria-pressed:bg-selected"
                      >
                        <ChatAvatar name={name} small />
                        <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
                      </button>
                    ) : (
                      <div className="flex min-w-0 flex-1 items-center gap-2 px-1 py-0.5">
                        <ChatAvatar name={name} human small />
                        <span className="min-w-0 flex-1 truncate text-[11px]">{name}</span>
                      </div>
                    );
                  return (
                    <li key={key} className="flex items-center gap-2">
                      {row}
                      {isOwnerRow && (
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
                          memberName={name}
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
                className="text-[10px] leading-5 text-muted-foreground"
              >
                <span className="flex items-center gap-1.5">
                  公共频道成员跟随项目自动同步
                  <button
                    type="button"
                    data-testid="channel-members-help"
                    aria-label="公共频道成员规则说明"
                    aria-expanded={membersHelpOpen}
                    onClick={() => setMembersHelpOpen((open) => !open)}
                    className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] leading-none hover:border-foreground hover:text-foreground"
                  >
                    ?
                  </button>
                </span>
                {/* 规则与入口默认不可见，但整段仍留在 DOM 里：它是频道成员治理的唯一说明。
                    上一句已经在行内说了「跟随项目自动同步」，这里只补真正要做的动作。 */}
                <p className={membersHelpOpen ? "pt-1 leading-5" : "hidden"}>
                  不可独立修改；到{" "}
                  <Link
                    to="/projects/$projectId/members"
                    params={{ projectId }}
                    data-testid="channel-project-members-link"
                    className="text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
                  >
                    Project Members
                  </Link>{" "}
                  调整成员。
                </p>
              </div>
            )}
            {chat.kind === "group" && (
              <div className="flex flex-wrap items-center gap-2">
                {governance.canChangeMembers ? (
                  <AddMemberDialog
                    chatId={chat.id}
                    revision={chat.governanceRevision}
                    agents={addableAgents}
                    onChanged={onChanged}
                  />
                ) : (
                  <p
                    data-testid="chat-member-note"
                    className="text-[10px] leading-5 text-muted-foreground"
                  >
                    成员决定谁能收到消息与唤醒；仍在活动 run 或持有租约的成员不能直接移除。
                  </p>
                )}
              </div>
            )}
            {chat.kind === "dm" && (
              <div
                data-testid="chat-member-note"
                className="text-[10px] leading-5 text-muted-foreground"
              >
                <span className="flex items-center gap-1.5">
                  DM 成员固定为两位参与者
                  <button
                    type="button"
                    data-testid="dm-members-help"
                    aria-label="DM 成员规则说明"
                    aria-expanded={membersHelpOpen}
                    onClick={() => setMembersHelpOpen((open) => !open)}
                    className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border text-[9px] leading-none hover:border-foreground hover:text-foreground"
                  >
                    ?
                  </button>
                </span>
                <p className={membersHelpOpen ? "pt-1 leading-5" : "hidden"}>
                  不提供独立成员治理。
                </p>
              </div>
            )}
            {detailMember && (
              <div
                data-testid="chat-inspector-identity"
                className="space-y-2 border-t border-border pt-3"
              >
                {profile && !profile.ok && (
                  <ChatErrorNotice error={profile.error} testId="inspector-profile-error" />
                )}
                <div className="flex items-center gap-2.5">
                  <ChatAvatar name={detailName ?? agentName} />
                  <div className="min-w-0 flex-1">
                    <strong
                      data-testid="inspector-agent-name"
                      className="block truncate text-xs font-semibold"
                    >
                      {detailName ?? agentName}
                    </strong>
                    {detailProfile?.jobTitle && (
                      <p
                        data-testid="inspector-agent-job-title"
                        className="mt-0.5 text-[10px] text-muted-foreground"
                      >
                        {detailProfile.jobTitle}
                      </p>
                    )}
                  </div>
                  {detailProfile && (
                    <Link
                      to="/agents/$agentProfileId"
                      params={{ agentProfileId: detailProfile.id }}
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
                  {detailProfile?.persona || "（空）"}
                </p>
              </div>
            )}
          </div>
        </details>
        {/* DM 保持 P4b 形状：没有独立成员治理，因此不渲染治理段。 */}
        {chat.kind !== "dm" && (
          <details
            open
            data-testid="chat-details-owner"
            className="group border-b border-border py-4"
          >
            <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
              <span>Owner</span>
              <span className="flex items-center gap-2 text-[10px] font-normal text-muted-foreground">
                <span data-testid="chat-owner-name">
                  {ownerName}
                  {ownerName !== (chat.owner.kind === "human" ? "Human" : "Agent") &&
                    `（${chat.owner.kind === "human" ? "Human" : "Agent"}）`}
                </span>
                <Icon
                  as={ChevronRight}
                  size={12}
                  className="transition-transform group-open:rotate-90"
                />
              </span>
            </summary>
            <div className="space-y-3 pt-3">
              <dl className="grid grid-cols-[4rem_minmax(0,1fr)] gap-y-1.5 text-[11px]">
                <dt className="text-muted-foreground">唤醒策略</dt>
                <dd data-testid="chat-wake-policy" className="whitespace-nowrap">
                  {WAKE_POLICY_LABELS[chat.wakePolicy]}
                </dd>
                <dt className="text-muted-foreground">治理版本</dt>
                <dd data-testid="chat-governance-revision">{chat.governanceRevision}</dd>
                {/* 公共频道的名字由 Project 派生，与页头同一句；这里不再复述。 */}
                {chat.kind !== "public_channel" && (
                  <>
                    <dt className="text-muted-foreground">标题</dt>
                    <dd data-testid="chat-details-title" className="break-words">
                      {chatDisplayTitle(chat, [agentName])}
                    </dd>
                  </>
                )}
              </dl>
              <div className="flex flex-wrap items-center gap-2">
                {governance.canChangeOwner && ownerCandidates.length > 0 && (
                  <OwnerDialog
                    chatId={chat.id}
                    currentOwnerKey={ownerKey(chat.owner.kind, chat.owner.id)}
                    revision={chat.governanceRevision}
                    members={ownerCandidates}
                    names={names}
                    humanUserId={humanUserId}
                    humanName={humanName}
                    agentNames={profileNames}
                    note={governanceCopy}
                    onChanged={onChanged}
                  />
                )}
                {governance.canRenameTitle && (
                  <ChatTitleEditor
                    chat={chat}
                    currentName={agentName}
                    submit={(title) => updateChatTitleFn({ data: { chatId: chat.id, title } })}
                    restore={() => clearChatTitleFn({ data: { chatId: chat.id } })}
                    onChanged={onChanged}
                    variant="button"
                  />
                )}
              </div>
              {/* 治理提示随「变更负责人」入口走：能改的人打开对话框才看到规则；
                  不能改的人没有那个入口，说明留在原处解释为什么。成员段只说成员规则。 */}
              {!governance.canChangeOwner && governanceCopy && (
                <p
                  data-testid="chat-governance-note"
                  className="text-[10px] leading-5 text-muted-foreground"
                >
                  {governanceCopy}
                </p>
              )}
            </div>
          </details>
        )}
        {/* 当前运行状态在中栏展示；活动段按需展开诊断。 */}
        <details
          data-testid="chat-details-activity"
          className="group border-border py-4 open:border-b"
          onToggle={(event) => setActivityOpen(event.currentTarget.open)}
        >
          <summary className="flex min-h-8 cursor-pointer list-none items-center justify-between gap-2 text-[11px] font-medium [&::-webkit-details-marker]:hidden">
            <span>活动</span>
            <span className="flex items-center gap-2 text-[10px] font-normal text-muted-foreground">
              活动记录
              <Icon
                as={ChevronRight}
                size={12}
                className="transition-transform group-open:rotate-90"
              />
            </span>
          </summary>
          <div className="space-y-4 pt-3">
            {!info.ok ? (
              <ChatErrorNotice error={info.error} testId="info-hub-chat-error" />
            ) : (
              <ChatActivityFacts info={info.data} turnContext={turnContext} />
            )}
            <div className="space-y-4 pt-1">
              {/* 读到租约事实时不再解释「与 Project settings 同一份」：租约块自己就是答案；
                  只有读失败或未接入才需要这一行说明。 */}
              {!machineFacts && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[10px] text-muted-foreground">Machine / Worker</span>
                  <span
                    data-testid="chat-machines-notice"
                    className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
                  >
                    {machineFactsError ? "读取失败" : "未接入，P4b 集成"}
                  </span>
                </div>
              )}
              {machineFactsError && (
                <ChatErrorNotice error={machineFactsError} testId="chat-machine-error" />
              )}
              {machineFacts && (
                <div data-testid="chat-machine-facts" className="space-y-4">
                  {/* 只呈现既有租约状态；远端操作的表格、柱状汇总与说明留在 Machine 详情页。 */}
                  <LeaseOverview
                    projectId={machineFacts.projectId}
                    machines={machineFacts.machines}
                    leases={machineFacts.leases}
                    holderNames={machineFacts.holderNames}
                    escrowNames={{
                      chats: machineFacts.chatNames ?? {},
                      chatKinds: machineFacts.chatKinds ?? {},
                      agents: machineFacts.agentNames ?? {},
                    }}
                    dense
                    showDenseNote={false}
                    hideEmpty
                    testId="chat-leases"
                  />
                </div>
              )}
            </div>
          </div>
        </details>
        {!machineFacts && (
          <p className="flex gap-2 pt-5 text-[10px] leading-5 text-muted-foreground">
            <Icon as={ShieldCheck} size={14} className="mt-0.5" />
            分析基于固定快照。分身可以读取仓库；远端操作的日志读取与取消在 Machine 详情页进行。
          </p>
        )}
      </div>
      <div className="shrink-0 border-t border-border px-5 py-3.5 text-[10px] text-muted-foreground max-desktop:pb-[max(14px,env(safe-area-inset-bottom))]">
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
          {error && <ChatErrorNotice error={error} testId="chat-member-add-error" />}
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
  memberName,
  onChanged,
}: {
  chatId: string;
  revision: number;
  memberKind: "human" | "agent";
  memberId: string;
  memberName: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
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
      setOpen(false);
      onChanged();
    } catch (cause) {
      setError(toAppError(cause, newId(ID_PREFIXES.request)));
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        setOpen(next);
        if (!next) setError(null);
      }}
    >
      <DialogTrigger
        data-testid="chat-member-remove"
        data-governance-action="member_remove"
        aria-label={`移除 ${memberName}`}
        title="移除成员"
        render={<Button type="button" variant="ghost" size="icon-xs" />}
      >
        ×
      </DialogTrigger>
      <DialogContent data-testid="chat-member-remove-dialog">
        <DialogHeader>
          <DialogTitle>移除成员</DialogTitle>
          <DialogDescription>
            把 {memberName} 移出这个群？移出后 TA 不再收到这个群的消息，历史消息保留。
          </DialogDescription>
        </DialogHeader>
        {error && <ChatErrorNotice error={error} testId="chat-member-remove-error" />}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            data-testid="chat-member-remove-cancel"
            disabled={pending}
            onClick={() => setOpen(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            data-testid="chat-member-remove-confirm"
            loading={pending}
            onClick={() => void remove()}
          >
            移除
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function OwnerDialog({
  chatId,
  currentOwnerKey,
  revision,
  members,
  names,
  humanUserId,
  humanName,
  agentNames,
  note,
  onChanged,
}: {
  currentOwnerKey: string;
  chatId: string;
  revision: number;
  members: ChatMember[];
  names: Map<string, string>;
  humanUserId: string;
  humanName: string;
  agentNames: Map<string, string>;
  note: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(currentOwnerKey);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const member = members.find((entry) => memberKey(entry) === selected);
    if (!member || selected === currentOwnerKey || pending) return;
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
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSelected(currentOwnerKey);
          setError(null);
        }
      }}
    >
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
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {/* 变更负责人是唯一能改它的地方，规则就放在这里，不在面板上重复一遍。 */}
          {note && (
            <p
              data-testid="chat-governance-note"
              className="text-[10px] leading-5 text-muted-foreground"
            >
              {note}
            </p>
          )}
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
                  {key === currentOwnerKey ? " · 当前" : ""}
                </option>
              );
            })}
          </select>
          {error && <ChatErrorNotice error={error} testId="chat-owner-error" />}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type="submit"
              data-testid="chat-owner-submit"
              loading={pending}
              disabled={!selected || selected === currentOwnerKey}
            >
              保存更改
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** 复制对话 ID：localhost 是安全上下文，点击本身是用户手势，因此只走 clipboard API。 */
function CopyChatIdButton({ chatId }: { chatId: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(chatId);
      setState("copied");
    } catch {
      setState("failed");
    }
    // 复制态是一次反馈，不是持久状态：过一会儿回到按钮本来的名字。
    setTimeout(() => setState("idle"), 1600);
  }
  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      data-testid="inspector-copy-chat-id"
      data-chat-id={chatId}
      data-copy-state={state}
      onClick={() => void copy()}
    >
      {state === "copied" ? "已复制" : state === "failed" ? "复制失败" : "复制 Chat ID"}
    </Button>
  );
}
