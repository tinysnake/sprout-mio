import { PageFrame } from "../../../components/layout/page-frame";
import { LeaseOverview, RunHoldingNote } from "../../../components/machine/lease-panel";
import {
  ExecutionTargetTable,
  RemoteExecutionList,
} from "../../../components/machine/remote-execution-panel";
import type { LeaseView } from "../../../contracts/lease";
import { demoProject, secondProject, demoMachineDetails } from "./fixtures";
import {
  demoExecutions,
  demoFreeLease,
  demoHolderNames,
  demoLeases,
  demoRunFacts,
} from "./lease-fixtures";

/**
 * 租约与远端操作的只读演示场景：租约事实来自固定 fixture，不连接业务服务。
 * 正式模块不导入本目录。
 */
const leases: readonly LeaseView[] = [...demoLeases, demoFreeLease];

export function LeasesScene({ go }: { go: (to: string) => void }) {
  return (
    <PageFrame
      title="租约与远端操作"
      description="演示场景：租约事实来自固定 fixture，不连接业务服务。"
      back={
        <a
          href="/machines"
          data-testid="lease-scene-back"
          onClick={(event) => {
            event.preventDefault();
            go("/machines");
          }}
        >
          返回 Machines
        </a>
      }
      testId="lease-scene"
    >
      <div className="space-y-8">
        <section data-testid="lease-scene-project-a" className="space-y-3">
          <h2 className="text-sm font-medium">当前 Project：{demoProject.name}</h2>
          <LeaseOverview
            projectId={demoProject.id}
            machines={demoMachineList()}
            leases={leases}
            holderNames={demoHolderNames}
            fencingSnapshot={{ executions: demoExecutions, mutation: null }}
            testId="lease-scene-overview"
          />
          <RunHoldingNote
            leases={leases.filter((lease) => lease.projectId === demoProject.id)}
            machines={demoMachineDetails}
            runs={demoRunFacts}
            testId="lease-scene-run-relation"
          />
        </section>

        <section data-testid="lease-scene-project-b" className="space-y-3">
          <h2 className="text-sm font-medium">
            另一个 Project：{secondProject.name}
            <span className="ml-2 text-xs text-muted-foreground">
              同一台物理 Machine 的租约在此 Project 中单独成立
            </span>
          </h2>
          <LeaseOverview
            projectId={secondProject.id}
            machines={demoMachineList()}
            leases={leases}
            holderNames={demoHolderNames}
            testId="lease-scene-other-project"
          />
        </section>

        <section data-testid="lease-scene-executions" className="space-y-4">
          <h2 className="text-sm font-medium">远端操作：目标与结果</h2>
          <ExecutionTargetTable executions={demoExecutions} machines={demoMachineList()} />
          <RemoteExecutionList
            executions={demoExecutions}
            machines={demoMachineList()}
            holderNames={demoHolderNames}
          />
        </section>
      </div>
    </PageFrame>
  );
}

function demoMachineList() {
  // 演示只需要 machine.id 与 name；完整 detail 由 fixtures 提供。
  return demoMachineDetails;
}
