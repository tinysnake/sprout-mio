import { Link } from "@tanstack/react-router";
import type { MachineDetail } from "../../contracts";
import type { LeaseView } from "../../contracts/lease";
import { MachineList, StatusLine } from "../machine/machine-list";
import {
  bindingDirectory,
  formatMoment,
  observationLabel,
  type LeaseMutationHandler,
} from "../machine/machine-view";
import { LeaseOverview } from "../machine/lease-panel";

/**
 * 租约区只投影本 Project 的 machine_lease 行：谁持有、哪台 Machine、代次与状态。
 * 申请与释放由一个显式的变更处理函数注入；未注入时按既有约定标为未实现，
 * 不渲染成看似可点但没有效果的按钮。
 */
export function ProjectMachinesPanel({
  projectId,
  machines,
  leases,
  holderNames = {},
  onLeaseMutate,
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: readonly LeaseView[];
  holderNames?: Readonly<Record<string, string>>;
  onLeaseMutate?: LeaseMutationHandler;
}) {
  return (
    <section data-testid="info-hub-project-machines" className="space-y-3">
      <h3 className="text-sm font-medium">Project 的 Machines</h3>
      <MachineList
        machines={machines}
        emptyText="还没有绑定 Machine。"
        href={(id) => `/machines/${id}?projectId=${projectId}`}
        renderLink={({ href, ...props }) => <Link to={href} {...props} />}
      />
      <dl className="min-w-0 divide-y divide-border text-xs leading-6">
        {machines.flatMap((detail) =>
          detail.bindings
            .filter(({ intent }) => intent.projectId === projectId)
            .map(({ intent, observation }) => {
              const status = observationLabel(observation);
              return (
                <div
                  key={intent.machineId}
                  data-testid="info-hub-machine-binding"
                  className="min-w-0 py-3"
                >
                  <dt className="font-medium">
                    {detail.machine.name} · revision {intent.revision}
                  </dt>
                  <dd>{intent.description || "（无说明）"}</dd>
                  <dd className="break-all text-muted-foreground">
                    {bindingDirectory(detail.machine.rootDirectory, intent.projectId)}
                  </dd>
                  <dd>
                    <StatusLine {...status} />
                  </dd>
                  <dd className="text-muted-foreground">
                    {observation
                      ? `观察时间 ${formatMoment(observation.fact.checkedAt)} · 代次 ${observation.fact.generation} · revision ${observation.fact.revision}`
                      : "等待 Worker 观察"}
                  </dd>
                </div>
              );
            }),
        )}
      </dl>
      <LeaseOverview
        projectId={projectId}
        machines={machines}
        leases={leases}
        holderNames={holderNames}
        onMutate={onLeaseMutate}
        testId="info-hub-leases"
      />
    </section>
  );
}
