import { leaseStateLabel } from "../machine/lease-view";
import { Link } from "@tanstack/react-router";
import type {
  InfoHubAgentError,
  InfoHubAgentStatus,
  InfoHubLeaseSummary,
  InfoHubMachineSummary,
} from "../../contracts/info-hub";

const AGENT_STATUS_LABELS: Record<InfoHubAgentStatus, string> = {
  idle: "待机中",
  queued: "排队中",
  running: "运行中",
  error: "出错",
};

export function AgentStatusFact({
  status,
  error,
}: {
  status: InfoHubAgentStatus;
  error: InfoHubAgentError | null;
}) {
  return (
    <div
      data-testid="info-agent-status"
      data-status={status}
      className="min-w-0 space-y-1 text-[11px]"
    >
      <p>Agent status：{AGENT_STATUS_LABELS[status]}</p>
      {error && (
        <p className="break-words text-destructive">
          {error.code}：{error.message}
        </p>
      )}
    </div>
  );
}

export function LeaseSummaryFact({ lease }: { lease: InfoHubLeaseSummary }) {
  return (
    <div
      data-testid="info-lease-fact"
      data-state={lease.state}
      className="min-w-0 space-y-1 text-[11px] break-words"
    >
      <p>
        本 Project 租约：
        {leaseStateLabel(lease.state).label} · 代次 {lease.generation}
      </p>
      {lease.holder ? (
        <p>
          持有者 Agent：{lease.holder.displayName} · 分身{" "}
          <span className="break-all">{lease.holder.instanceId}</span> · Chat：
          <Link
            to="/projects/$projectId/chats/$chatId"
            params={{ projectId: lease.projectId, chatId: lease.holder.chatId }}
            className="underline"
          >
            {lease.holder.chatDisplayTitle || lease.holder.chatKind}
          </Link>
        </p>
      ) : lease.holderInstanceId ? (
        <p>
          持有者未知 · 已记录分身 <span className="break-all">{lease.holderInstanceId}</span>
        </p>
      ) : (
        <p className="text-muted-foreground">无持有者</p>
      )}
    </div>
  );
}

export function MachineSummaryFact({ machine }: { machine: InfoHubMachineSummary }) {
  const connection = { online: "在线", offline: "离线", unknown: "未知", connecting: "连接中" };
  return (
    <section
      data-testid="info-machine-fact"
      className="min-w-0 space-y-2 border-b border-border py-3 last:border-0"
    >
      <p className="text-xs font-medium break-words">{machine.name}</p>
      <p data-testid="info-machine-connection" className="text-[11px] text-muted-foreground">
        连接状态：{connection[machine.connection.kind]}
        {machine.projectMembership === "removed" ? " · 已移出 Project" : ""}
      </p>
      <LeaseSummaryFact lease={machine.lease} />
    </section>
  );
}
