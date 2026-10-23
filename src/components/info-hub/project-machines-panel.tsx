import { Link } from "@tanstack/react-router";
import type { MachineDetail, UnavailableFeature } from "../../contracts";
import { MachineList, StatusLine } from "../machine/machine-list";
import { bindingDirectory, formatMoment, observationLabel } from "../machine/machine-view";
import { UnavailableNotice } from "./unavailable-notice";

export function ProjectMachinesPanel({
  projectId,
  machines,
  leases,
}: {
  projectId: string;
  machines: MachineDetail[];
  leases: UnavailableFeature;
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
      <dl className="divide-y divide-border text-xs leading-6">
        {machines.flatMap((detail) =>
          detail.bindings
            .filter(({ intent }) => intent.projectId === projectId)
            .map(({ intent, observation }) => {
              const status = observationLabel(observation);
              return (
                <div key={intent.machineId} data-testid="info-hub-machine-binding" className="py-3">
                  <dt className="font-medium">
                    {detail.machine.name} · revision {intent.revision}
                  </dt>
                  <dd>{intent.description || "（无说明）"}</dd>
                  <dd className="break-all text-muted-foreground">{bindingDirectory(intent)}</dd>
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
      <UnavailableNotice
        testId="info-hub-leases-notice"
        title="Machine 租约"
        reason={leases.reason}
      />
    </section>
  );
}
