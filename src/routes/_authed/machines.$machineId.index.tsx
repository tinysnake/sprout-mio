import { createFileRoute } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { z } from "zod";
import { useMachineActivity } from "../../components/machine/use-machine-activity";
import { useMachineRefresh } from "../../components/machine/use-machine-refresh";
import { PageBackLink } from "../../components/layout/page-back";
import { PageFrame } from "../../components/layout/page-frame";
import { MachineDetailPanel } from "../../components/machine/machine-detail";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import { Icon } from "../../components/ui/icon";
import {
  getMachineFn,
  renewMachineEnrollmentFn,
  saveProjectMachineBindingFn,
  saveMachineRootDirectoryFn,
} from "../../server/functions/machine";
import { listProjectsFn } from "../../server/functions/project";
import { useMachineEnrollment } from "../../components/machine/machine-enrollment-context";
import { useMachineRelations } from "../../components/machine/use-machine-relations";
import { listProjectLeasesFn } from "../../server/functions/lease";
import { listProjectExecutionsFn } from "../../server/functions/remote";

export const Route = createFileRoute("/_authed/machines/$machineId/")({
  // Project 上下文只用于绑定编辑；租约由独立路由承载。
  validateSearch: z.object({ projectId: z.string().optional() }),
  loaderDeps: ({ search }) => ({ projectId: search.projectId }),
  loader: async ({ params, deps }) => {
    const [detail, projects] = await Promise.all([
      getMachineFn({
        data: {
          machineId: params.machineId,
          ...(deps.projectId ? { projectId: deps.projectId } : {}),
        },
      }),
      listProjectsFn(),
    ]);
    const projectIds = detail.ok
      ? [...new Set(detail.data.bindings.map((item) => item.intent.projectId))]
      : [];
    const [leaseResults, executionResults] = await Promise.all([
      Promise.all(projectIds.map((projectId) => listProjectLeasesFn({ data: { projectId } }))),
      Promise.all(
        projectIds.map((projectId) =>
          listProjectExecutionsFn({ data: { projectId, machineId: params.machineId } }),
        ),
      ),
    ]);
    return {
      detail,
      projects,
      leases: leaseResults.flatMap((result) => (result.ok ? result.data : [])),
      executions: executionResults.flatMap((result) => (result.ok ? result.data : [])),
    };
  },
  component: MachinePage,
});

function MachinePage() {
  const { detail, projects, leases, executions } = Route.useLoaderData();
  const { projectId } = Route.useSearch();
  const { machineId } = Route.useParams();
  // 页面事实的活性来源是一条很小的 revision 读取；只有它变了才整页重取。
  const activity = useMachineActivity({ machineId, ...(projectId ? { projectId } : {}) });
  const router = useMachineRefresh({ revision: activity.revision });
  const relationState = useMachineRelations({ machineId });
  const { enrollment, setEnrollment } = useMachineEnrollment();

  const back = projectId ? (
    <PageBackLink
      to="/projects/$projectId/settings"
      params={{ projectId }}
      data-testid="machine-detail-back"
    >
      <Icon as={ArrowLeft} />
      返回 Project settings
    </PageBackLink>
  ) : (
    <PageBackLink to="/machines" data-testid="machine-detail-back">
      <Icon as={ArrowLeft} />
      返回 Machines
    </PageBackLink>
  );
  if (!detail.ok)
    return (
      <PageFrame title="Machine 不可用" back={back}>
        <ResultError error={detail.error} />
      </PageFrame>
    );
  const availableProjects = projects.ok ? projects.data : [];
  return (
    <MachineDetailPanel
      detail={detail.data}
      back={back}
      enrollment={enrollment?.detail.machine.id === detail.data.machine.id ? enrollment : null}
      projectNames={Object.fromEntries(availableProjects.map((p) => [p.id, p.name]))}
      bindingProject={availableProjects.find((p) => p.id === projectId) ?? null}
      installOrigin={typeof window === "undefined" ? undefined : window.location.origin}
      onRenewEnrollment={(machineId) => renewMachineEnrollmentFn({ data: { machineId } })}
      onEnrollmentCreated={setEnrollment}
      onEnrollmentRevoked={(machineId) => {
        // 父级只有一个槽位，只有它属于被放弃请求的 target 时才撤销。
        if (enrollment?.detail.machine.id === machineId) setEnrollment(null);
      }}
      onSaveRoot={(input) => saveMachineRootDirectoryFn({ data: input })}
      onRootRefresh={async () => {
        await router.invalidate();
      }}
      onSaveBinding={(input) => saveProjectMachineBindingFn({ data: input })}
      onBindingSaved={() => {
        void router.invalidate();
        relationState.refresh();
      }}
      relations={relationState.relations}
      relationsLoading={relationState.loading}
      relationsError={relationState.error}
      relationsLastSuccessAt={relationState.lastSuccessAt}
      onRelationsChanged={() => {
        relationState.refresh();
        void router.invalidate();
      }}
      leases={leases}
      executions={executions}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            data-testid="machine-refresh"
            onClick={() => void router.invalidate()}
          >
            刷新连接与观察
          </Button>
        </div>
      }
    />
  );
}
