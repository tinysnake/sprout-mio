import type { AgentInfoView } from "../../contracts/info-hub-query";
import { AgentStatusFact, LeaseSummaryFact } from "./basic-facts";
import { RunFactsBlock } from "./run-facts";

/** Project-scoped profile view. Instance inventory comes from the Agent query. */
export function AgentInfoPanel({ view }: { view: AgentInfoView }) {
  return (
    <section data-testid="info-hub-agent" className="min-w-0 space-y-3 text-[11px]">
      <h3 className="text-xs font-medium">{view.agent.name} · 本 Project</h3>
      <AgentStatusFact status={view.agent.status} error={view.agent.error} />
      <RunFactsBlock runs={view.runs} testId="info-agent-runs" />
      <h4 className="font-medium">分身及租约</h4>
      {view.instances.length === 0 ? (
        <p data-testid="info-agent-instances-empty" className="text-muted-foreground">
          本 Project 还没有此 Agent 的分身，无分身租约。
        </p>
      ) : (
        view.instances.map((instance) => (
          <div
            key={instance.instanceId}
            data-testid="info-agent-instance"
            className="min-w-0 space-y-1 border-t border-border py-2"
          >
            <p className="break-all">分身 {instance.instanceId}</p>
            <p className="text-muted-foreground">
              Chat：{instance.chatDisplayTitle || instance.chatKind}
            </p>
            {instance.leases.length === 0 ? (
              <p data-testid="info-lease-empty" className="text-muted-foreground">
                此分身未持有 Machine 租约。
              </p>
            ) : (
              instance.leases.map((lease) => (
                <LeaseSummaryFact key={lease.machineId} lease={lease} />
              ))
            )}
          </div>
        ))
      )}
    </section>
  );
}
