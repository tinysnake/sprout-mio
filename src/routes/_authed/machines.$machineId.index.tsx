import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { useMachineRefresh } from "../../components/machine/use-machine-refresh";
import { PageFrame } from "../../components/layout/page-frame";
import { MachineDetailPanel } from "../../components/machine/machine-detail";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import {
  getMachineFn,
  renewMachineEnrollmentFn,
  saveProjectMachineBindingFn,
  saveMachineRootDirectoryFn,
} from "../../server/functions/machine";
import { listProjectsFn } from "../../server/functions/project";
import { useMachineEnrollment } from "../../components/machine/machine-enrollment-context";

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
    return { detail, projects };
  },
  component: MachinePage,
});

function MachinePage() {
  const { detail, projects } = Route.useLoaderData();
  const { projectId } = Route.useSearch();
  const router = useMachineRefresh();
  const { enrollment, setEnrollment } = useMachineEnrollment();

  const back = projectId ? (
    <Link
      to="/projects/$projectId/settings"
      params={{ projectId }}
      data-testid="machine-detail-back"
    >
      返回 Project settings
    </Link>
  ) : (
    <Link to="/machines" data-testid="machine-detail-back">
      返回 Machines
    </Link>
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
      onBindingSaved={() => void router.invalidate()}
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
