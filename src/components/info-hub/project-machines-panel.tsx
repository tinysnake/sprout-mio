import { Link } from "@tanstack/react-router";
import type { MachineDetail, ProjectInfoHub } from "../../contracts";
import { MachineList, StatusLine } from "../machine/machine-list";
import { bindingDirectory, formatMoment, observationLabel } from "../machine/machine-view";
import { UnavailableNotice } from "./unavailable-notice";

/**
 * 租约区只投影本 Project 的 machine_lease 行：谁持有、哪台 Machine、代次与状态。
 * 租约的申请与释放属于后续单元，按既有约定显式标为未实现。
 */
const LEASE_STATE_LABELS = { free: "空闲", held: "持有中", fencing: "回收中" } as const;

export function ProjectMachinesPanel({
  projectId,
  machines,
  leases,
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: ProjectInfoHub["leases"];
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
      <div data-testid="info-hub-leases" className="space-y-1">
        <h4 className="text-sm font-medium">Machine 租约</h4>
        {leases.items.length === 0 ? (
          <p data-testid="info-hub-leases-empty" className="text-xs text-muted-foreground">
            本 Project 还没有租约记录。
          </p>
        ) : (
          <dl className="min-w-0 divide-y divide-border text-xs leading-6">
            {leases.items.map((lease) => {
              const machine = machines.find((item) => item.machine.id === lease.machineId);
              return (
                <div
                  key={`${lease.projectId}:${lease.machineId}`}
                  data-testid="info-hub-lease"
                  className="min-w-0 py-3"
                >
                  <dt className="font-medium">
                    {machine?.machine.name ?? lease.machineId} · {LEASE_STATE_LABELS[lease.state]}
                  </dt>
                  <dd className="text-muted-foreground">
                    代次 {lease.generation} · 更新 {formatMoment(lease.changedAt)}
                  </dd>
                  <dd className="break-all text-muted-foreground">
                    {lease.holderInstanceId ?? "无持有者"}
                  </dd>
                </div>
              );
            })}
          </dl>
        )}
      </div>
      <UnavailableNotice
        testId="info-hub-leases-notice"
        title="租约申请与释放"
        reason="租约申请、释放与交接尚未接入，P4b 后续单元接入后可操作。"
      />
    </section>
  );
}
