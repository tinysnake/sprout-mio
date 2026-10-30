import { Link } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight, PanelRightClose, ShieldCheck } from "lucide-react";
import { agentDetailFromChat } from "../agent/agent-detail-search";
import type { AgentProfile, AgentResult } from "../../contracts/agent";
import type { AgentInstance, Chat, ChatMember, ChatResult } from "../../contracts/chat";
import type { ChatInfoView, InfoHubResult, TurnStartContext } from "../../contracts/info-hub";
import type { AppError } from "../../contracts/result";
import type { MachineDetail } from "../../contracts/machine";
import type { LeaseView } from "../../contracts/lease";
import type { ExecutionView } from "../../contracts/remote";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { ResultError } from "../project/result-error";
import { TaskAssociations } from "../tasks/task-associations";
import { ChatAvatar } from "../chat/chat-avatar";
import { ChatFactsBlock } from "./chat-info-panel";
import { RunFactsBlock, TurnStartContextBlock } from "./run-facts";
import { LeaseOverview } from "../machine/lease-panel";
import { ExecutionTargetTable, RemoteExecutionList } from "../machine/remote-execution-panel";

/**
 * Chat 侧的 Machine 事实：与 Project settings、Machine 详情读同一份租约与执行视图，
 * 不在这里重新推导持有者或状态。
 */
export type ChatMachineFacts = {
  projectId: string;
  machines: MachineDetail[];
  leases: readonly LeaseView[];
  executions: readonly ExecutionView[];
  holderNames?: Readonly<Record<string, string>>;
};

/**
 * Chat 的 Info Hub：摘要常显，运行事实与 Chat 事实按需展开。原有诊断字段
 * 只被折叠，不被删除；未实现的能力显式标出阶段，不用空值冒充。
 */
export function ChatInspector({
  chat,
  agentName,
  humanName,
  members,
  instances,
  profile,
  info,
  turnStart,
  machineFacts = null,
  machineFactsError,
  onClose,
}: {
  chat: Chat;
  agentName: string;
  humanName: string;
  members: ChatResult<ChatMember[]>;
  instances: ChatResult<AgentInstance[]>;
  profile: AgentResult<AgentProfile> | null;
  info: ChatResult<ChatInfoView>;
  turnStart: InfoHubResult<TurnStartContext>;
  /** 为 null 时按未接入呈现；不伪造空租约或空执行列表。 */
  machineFacts?: ChatMachineFacts | null;
  machineFactsError?: AppError;
  onClose: () => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
        <h2 className="min-w-0 flex-1 truncate text-[13px]">Info Hub</h2>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          data-testid="close-inspector"
          aria-label="收起 Info Hub 侧栏"
          title="收起 Info Hub 侧栏"
          onClick={onClose}
          className="max-desktop:hidden"
        >
          <Icon as={PanelRightClose} />
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 pt-2 pb-6">
        <section className="border-b border-border py-5" data-testid="inspector-tasks">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">Task 摘要</h3>
          {info.ok ? (
            <TaskAssociations projectId={chat.projectId} items={info.data.tasks.items} />
          ) : (
            <ResultError error={info.error} testId="info-hub-tasks-error" />
          )}
        </section>
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">分身上下文</h3>
          {!members.ok ? (
            <ResultError error={members.error} testId="chat-load-error" />
          ) : !instances.ok ? (
            <ResultError error={instances.error} testId="chat-load-error" />
          ) : (
            <div data-testid="chat-inspector-identity" className="space-y-2.5">
              {profile && !profile.ok && (
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
                    {profile?.ok && profile.data.jobTitle ? profile.data.jobTitle : "未设置职位"}
                  </p>
                </div>
                {profile?.ok && (
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
                {profile?.ok ? profile.data.persona || "（空）" : ""}
              </p>
              <p className="text-[10px] leading-5 text-muted-foreground">
                profile 修改将在下一轮生效，当前轮与历史回复保留原上下文。
              </p>
              <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-y-1 text-[11px]">
                <dt className="text-muted-foreground">Chat ID</dt>
                <dd data-testid="inspector-chat-id" className="font-mono break-all">
                  {chat.id}
                </dd>
                <dt className="text-muted-foreground">分身 Instance ID</dt>
                <dd data-testid="inspector-instance-id" className="font-mono break-all">
                  {instances.data[0]?.id ?? "（缺少分身记录）"}
                </dd>
                <dt className="text-muted-foreground">成员</dt>
                <dd data-testid="inspector-member-list">
                  {members.data
                    .map((member) =>
                      member.memberKind === "human" ? humanName || "你" : agentName,
                    )
                    .join("、")}
                </dd>
              </dl>
            </div>
          )}
        </section>
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">运行</h3>
          {!info.ok ? (
            <ResultError error={info.error} testId="info-hub-chat-error" />
          ) : !turnStart.ok ? (
            <ResultError error={turnStart.error} testId="info-hub-turn-context-error" />
          ) : (
            <details className="group" open>
              <summary className="flex min-h-9.5 cursor-pointer list-none items-center justify-between gap-2 text-[11px] hover:underline [&::-webkit-details-marker]:hidden">
                <span>运行事实与轮初上下文</span>
                <span className="flex items-center gap-2 text-muted-foreground">
                  <span>
                    {info.data.runs.active.length > 0
                      ? `${info.data.runs.active.length} 个活动 run`
                      : "无排队中或运行中的 run"}
                  </span>
                  <Icon
                    as={ChevronRight}
                    size={12}
                    className="transition-transform group-open:rotate-90"
                  />
                </span>
              </summary>
              <div className="space-y-4 pt-2 pb-3">
                <RunFactsBlock runs={info.data.runs} testId="info-chat-runs" />
                <TurnStartContextBlock context={turnStart.data} />
              </div>
            </details>
          )}
        </section>
        <section className="border-b border-border py-5">
          <h3 className="mb-3.75 text-[10px] font-medium text-muted-foreground">关联信息</h3>
          {info.ok ? (
            <details className="group" open>
              <summary className="flex min-h-9.5 cursor-pointer list-none items-center justify-between gap-2 text-[11px] hover:underline [&::-webkit-details-marker]:hidden">
                <span>Chat 事实与成员</span>
                <Icon
                  as={ChevronRight}
                  size={12}
                  className="transition-transform group-open:rotate-90"
                />
              </summary>
              <div className="pt-2 pb-3">
                <ChatFactsBlock view={info.data} />
              </div>
            </details>
          ) : (
            <p className="text-[11px] text-muted-foreground">Chat 事实随上方错误一并不可用。</p>
          )}
          <div className="space-y-4 pt-3">
            <div className="flex items-center justify-between gap-3">
              <span className="text-[10px] text-muted-foreground">Machine / Worker</span>
              {machineFacts ? (
                <span
                  data-testid="chat-machines-notice"
                  className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
                >
                  与 Project settings 同一租约事实
                </span>
              ) : (
                <span
                  data-testid="chat-machines-notice"
                  className="rounded-control border border-border px-1.75 py-0.75 text-[10px] text-muted-foreground"
                >
                  {machineFactsError ? "读取失败" : "未接入，P4b 集成"}
                </span>
              )}
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
        </section>
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
