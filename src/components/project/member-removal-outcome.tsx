import { Link } from "@tanstack/react-router";
import type {
  ProjectMemberRemovalBlockers,
  ProjectMemberRemovalChatRef,
  ProjectMemberRemovalLeaseRef,
  ProjectMemberRemovalOutcome,
  ProjectMemberRemovalRunRef,
  ProjectMemberRemovalTaskRef,
} from "../../contracts/project-member-removal";
import { LEASE_STATE_LABELS } from "../machine/lease-view";
import { StatusLine } from "../machine/machine-list";
import { Button } from "../ui/button";

/**
 * 强制移除去重无法确认撤销时的原因码翻译。这里只翻译已知原因，
 * 未知原因原样显示，不猜测成「已释放」。
 */
const RETAINED_REASON_LABELS: Record<string, string> = {
  pending_dispatched_executions: "仍有已下发、未收口的执行",
  detach_pending: "Machine 正在从本 Project 移出，确认尚未完成",
};

function reasonLabel(reason: string | null) {
  if (!reason) return "未能确认旧操作权已撤销";
  return RETAINED_REASON_LABELS[reason] ?? `未能确认旧操作权已撤销（${reason}）`;
}

function MachineLeaseLink({
  projectId,
  machineId,
  machineName,
}: {
  projectId: string;
  machineId: string;
  machineName: string;
}) {
  return (
    <Link
      to="/machines/$machineId/lease"
      params={{ machineId }}
      search={{ projectId }}
      className="underline underline-offset-3"
    >
      {machineName}
    </Link>
  );
}

function ChatLink({ projectId, chat }: { projectId: string; chat: ProjectMemberRemovalChatRef }) {
  return (
    <Link
      to="/projects/$projectId/chats/$chatId"
      params={{ projectId, chatId: chat.chatId }}
      className="underline underline-offset-3"
    >
      {chat.title || chat.chatId}
    </Link>
  );
}

/** 强制移除后仍无法确认撤销的租约：保留为占用待处理，绝不显示为空闲。 */
function RetainedLease({
  lease,
  projectId,
}: {
  lease: ProjectMemberRemovalOutcome["leases"][number];
  projectId: string;
}) {
  return (
    <li
      data-testid="member-removal-lease"
      data-lease-outcome="retained"
      className="space-y-1 border-t border-border-soft py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <MachineLeaseLink
        projectId={projectId}
        machineId={lease.machineId}
        machineName={lease.machineName}
      />
      <StatusLine
        label={LEASE_STATE_LABELS.fencing.label}
        detail={reasonLabel(lease.reason)}
        tone="warning"
        testId="member-removal-lease-state"
      />
      <p className="text-muted-foreground">
        该 Machine 仍由旧操作权占用，等待 Worker
        确认后才会释放，不等于空闲；请在租约页确认后再判断它是否可用。
      </p>
    </li>
  );
}

/** 阻塞事实里有、但不在本次善后结果里的租约：本次未处理，状态保持原样。 */
function UntouchedLease({
  lease,
  projectId,
}: {
  lease: ProjectMemberRemovalLeaseRef;
  projectId: string;
}) {
  return (
    <li
      data-testid="member-removal-lease"
      data-lease-outcome="untouched"
      className="space-y-1 border-t border-border-soft py-3 first:border-t-0 first:pt-0 last:pb-0"
    >
      <MachineLeaseLink
        projectId={projectId}
        machineId={lease.key.machineId}
        machineName={lease.machineName}
      />
      <StatusLine
        label="本次未处理"
        detail={LEASE_STATE_LABELS.fencing.label}
        tone="warning"
        testId="member-removal-lease-state"
      />
      <p className="text-muted-foreground">
        {lease.relation === "handoff_target"
          ? "指向此 Agent 的待决交接不由强制移除处理；"
          : "该租约不在强制移除的处理范围内；"}
        它保持等待 Worker 确认，不等于空闲。
      </p>
    </li>
  );
}

/**
 * 强制移除的善后结果。结果集只有 id（`abortedRunIds` / `ownerTransferredChatIds` /
 * `unassignedTaskIds`），所以对象名称与链接取自产生这次操作的
 * `project_member_removal_blocked.details` 快照：两者来自同一个服务端快照，
 * 页面不推断、不补造缺失的对象。
 * 风险优先：无法确认撤销的占用排在最前，再列已经完成的转接与退回。
 */
export function MemberRemovalOutcome({
  outcome,
  blockers,
  agentName,
  onDismiss,
}: {
  outcome: ProjectMemberRemovalOutcome;
  blockers: ProjectMemberRemovalBlockers | null;
  agentName: string;
  onDismiss: () => void;
}) {
  const projectId = outcome.projectId;
  const runRefs = new Map<string, ProjectMemberRemovalRunRef>();
  const chatRefs = new Map<string, ProjectMemberRemovalChatRef>();
  const taskRefs = new Map<string, ProjectMemberRemovalTaskRef>();
  const blockerLeases: ProjectMemberRemovalLeaseRef[] = [];
  for (const blocker of blockers?.blockers ?? []) {
    if (blocker.kind === "active_runs")
      for (const item of blocker.items) {
        runRefs.set(item.runId, item);
        chatRefs.set(item.chat.chatId, item.chat);
      }
    else if (blocker.kind === "leases") blockerLeases.push(...blocker.items);
    else if (blocker.kind === "owner_duties")
      for (const item of blocker.items) chatRefs.set(item.chat.chatId, item.chat);
    else
      for (const item of blocker.items) {
        taskRefs.set(item.taskId, item);
        chatRefs.set(item.chat.chatId, item.chat);
      }
  }
  const settledMachineIds = new Set(outcome.leases.map((lease) => lease.machineId));
  const untouchedLeases = blockerLeases.filter(
    (lease) => !settledMachineIds.has(lease.key.machineId),
  );
  const retainedLeases = outcome.leases.filter((lease) => lease.outcome === "retained");
  const releasedLeases = outcome.leases.filter((lease) => lease.outcome === "released");
  const heldBack = [...retainedLeases, ...untouchedLeases];
  const handled =
    outcome.abortedRunIds.length +
    outcome.ownerTransferredChatIds.length +
    outcome.unassignedTaskIds.length;

  return (
    <section
      data-testid="member-removal-outcome"
      className="mt-5 rounded-container border border-border bg-secondary p-4 text-xs leading-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">
            {outcome.removed ? `「${agentName}」已强制移除` : `「${agentName}」已不在当前 Project`}
          </h2>
          <p className="mt-1 text-muted-foreground">
            {outcome.removed
              ? "以下是本次自动善后的结果；成员行已从 Project 移除，全局 profile 仍保留。"
              : "本次调用是幂等空操作：成员行已不存在，没有产生新的变更。"}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          data-testid="dismiss-member-outcome"
          onClick={onDismiss}
        >
          关闭
        </Button>
      </div>

      {heldBack.length > 0 && (
        <div data-testid="member-removal-retained-leases" className="mt-4">
          <h3 className="font-medium text-status-warning">占用待处理</h3>
          <p className="mt-1 text-muted-foreground">
            {retainedLeases.length > 0
              ? "下列 Machine 的旧操作权无法确认已撤销，仍是占用状态，不会显示为空闲。"
              : "下列 Machine 仍被旧操作权占用；本次没有处理它们，它们不会显示为空闲。"}
          </p>
          <ul className="mt-2">
            {retainedLeases.map((lease) => (
              <RetainedLease key={lease.machineId} lease={lease} projectId={projectId} />
            ))}
            {untouchedLeases.map((lease) => (
              <UntouchedLease key={lease.key.machineId} lease={lease} projectId={projectId} />
            ))}
          </ul>
        </div>
      )}

      <div className="mt-4 space-y-3">
        {handled === 0 && heldBack.length === 0 && (
          <p data-testid="member-removal-no-side-effects" className="text-muted-foreground">
            {outcome.removed
              ? "本次没有需要中止的运行、转接的负责人、退回的 Task 或待处理的租约。"
              : "本次没有成员变更，也没有新的运行中止、负责人转接、Task 退回或租约处置。"}
          </p>
        )}

        {outcome.abortedRunIds.length > 0 && (
          <div data-testid="member-removal-aborted-runs">
            <h3 className="font-medium">已中止的运行（{outcome.abortedRunIds.length}）</h3>
            <ul className="mt-1 space-y-2">
              {outcome.abortedRunIds.map((runId) => {
                const ref = runRefs.get(runId);
                return (
                  <li key={runId}>
                    {ref && <ChatLink projectId={projectId} chat={ref.chat} />}
                    <p className="break-all text-muted-foreground">
                      Run {runId}
                      {ref ? ` · 快照时 ${ref.status} · 分身 ${ref.instanceId}` : ""}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {outcome.ownerTransferredChatIds.length > 0 && (
          <div data-testid="member-removal-transferred-chats">
            <h3 className="font-medium">
              已转接负责人的 Chat（{outcome.ownerTransferredChatIds.length}）
            </h3>
            <p className="mt-1 text-muted-foreground">负责人已转接给执行本次操作的人。</p>
            <ul className="mt-1 space-y-2">
              {outcome.ownerTransferredChatIds.map((chatId) => {
                const ref = chatRefs.get(chatId);
                return (
                  <li key={chatId}>
                    {ref ? (
                      <ChatLink projectId={projectId} chat={ref} />
                    ) : (
                      <span className="break-all">{chatId}</span>
                    )}
                    <p className="break-all text-muted-foreground">
                      {ref ? `${ref.chatKind} · ${chatId}` : chatId}
                    </p>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {outcome.unassignedTaskIds.length > 0 && (
          <div data-testid="member-removal-unassigned-tasks">
            <h3 className="font-medium">
              已退回 proposed 的 Task（{outcome.unassignedTaskIds.length}）
            </h3>
            <ul className="mt-1 space-y-2">
              {outcome.unassignedTaskIds.map((taskId) => {
                const ref = taskRefs.get(taskId);
                return (
                  <li key={taskId}>
                    {ref ? (
                      <Link
                        to="/projects/$projectId/tasks/$taskId"
                        params={{ projectId, taskId }}
                        className="underline underline-offset-3"
                      >
                        {ref.title}
                      </Link>
                    ) : (
                      <span className="break-all">{taskId}</span>
                    )}
                    <p className="break-all text-muted-foreground">{taskId} · proposed</p>
                    {ref && (
                      <p className="text-muted-foreground">
                        仍留在原 DM：
                        <ChatLink projectId={projectId} chat={ref.chat} />
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {releasedLeases.length > 0 && (
          <div data-testid="member-removal-released-leases">
            <h3 className="font-medium">已确认撤销的租约（{releasedLeases.length}）</h3>
            <ul className="mt-1 space-y-2">
              {releasedLeases.map((lease) => (
                <li key={lease.machineId}>
                  <MachineLeaseLink
                    projectId={projectId}
                    machineId={lease.machineId}
                    machineName={lease.machineName}
                  />
                  <StatusLine label="已确认旧操作权撤销并释放" tone="success" />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </section>
  );
}
