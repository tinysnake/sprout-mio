import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import type { MachineDetail } from "../../contracts";
import type { LeaseView } from "../../contracts/lease";
import { MachineList, StatusLine } from "../machine/machine-list";
import { bindingDirectory, observationLabel } from "../machine/machine-view";
import { LeaseOverview } from "../machine/lease-panel";

/**
 * Project 侧的 Machine 归属：这个 Project 关联了哪些 Machine、各自的租约摘要。
 *
 * 租约的数据归属仍是 Project × Machine（`machine_lease` 唯一键）；这里只给摘要与入口，
 * 申请、释放、交接、收回的界面在对应 Machine 详情的租约区块。
 * `onLeaseMutate` 仍被接受，供已有演示接线继续编译；正式页面不再在这一页渲染管理表单。
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
  onLeaseMutate?: unknown;
}) {
  void onLeaseMutate;
  const bound = machines.filter((detail) =>
    detail.bindings.some(({ intent }) => intent.projectId === projectId),
  );
  // 每台机器只出现一个管理入口：有租约行的机器在租约摘要里跳转，其余在绑定行里跳转。
  const leaseMachines = new Set(leases.map((lease) => lease.machineId));
  return (
    <section data-testid="info-hub-project-machines" className="space-y-3">
      <h3 className="text-sm font-medium">Project 的 Machines</h3>
      <MachineList
        machines={machines}
        emptyText="还没有绑定 Machine。"
        href={(id) => `/machines/${id}/lease?projectId=${projectId}`}
        renderLink={({ href, ...props }) => <Link to={href} {...props} />}
      />
      <dl className="min-w-0 divide-y divide-border text-xs leading-6">
        {bound.flatMap((detail) =>
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
                  <dt className="font-medium">{detail.machine.name}</dt>
                  <dd>{intent.description || "（无说明）"}</dd>
                  {/* 派生工作目录只出现这一次；可达性单独一行，不重复同一路径。 */}
                  <dd className="break-all text-muted-foreground">
                    {bindingDirectory(detail.machine.rootDirectory, intent.projectId)}
                  </dd>
                  <dd className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    {/* 原因只出现一次：StatusLine 只拿标签与 tone，detail 单独一行。 */}
                    <StatusLine label={status.label} tone={status.tone} />
                    {status.detail && (
                      <span className="text-muted-foreground">{status.detail}</span>
                    )}
                  </dd>
                  {!leaseMachines.has(detail.machine.id) && (
                    <dd>
                      <LeaseManageLink
                        projectId={projectId}
                        machineId={detail.machine.id}
                        machineName={detail.machine.name}
                      />
                    </dd>
                  )}
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
        dense
        manageLink={(lease) => (
          <LeaseManageLink
            projectId={projectId}
            machineId={lease.machineId}
            machineName={machines.find((item) => item.machine.id === lease.machineId)?.machine.name}
          />
        )}
        testId="info-hub-leases"
      />
    </section>
  );
}

/**
 * 深链到 Machine 详情页的租约区块：租约现在排在详情页的第一段，带着既有
 * `?projectId=` 进来就在那里；页头还有一个按钮做页内定位。不新增路由参数。
 */
export function LeaseManageLink({
  projectId,
  machineId,
  machineName,
}: {
  projectId: string;
  machineId: string;
  machineName?: string;
}): ReactNode {
  return (
    <Link
      to="/machines/$machineId/lease"
      params={{ machineId }}
      search={{ projectId }}
      data-testid="lease-manage-link"
      className="inline-flex min-h-6 items-center gap-1 text-[0.6875rem] text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
    >
      管理{machineName ? ` ${machineName} 的` : ""}租约
    </Link>
  );
}
