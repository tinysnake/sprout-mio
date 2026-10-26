import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PageFrame } from "../../components/layout/page-frame";
import { MachineLeasePanel } from "../../components/machine/machine-lease";
import { holderNames } from "../../components/machine/project-lease-actions";
import { useMachineEnrollment } from "../../components/machine/machine-enrollment-context";
import { useMachineRefresh } from "../../components/machine/use-machine-refresh";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import { getMachineFn, renewMachineEnrollmentFn } from "../../server/functions/machine";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import { listProjectsFn } from "../../server/functions/project";

export const Route = createFileRoute("/_authed/machines/$machineId/lease")({
  validateSearch: z.object({ projectId: z.string().min(1).optional() }),
  loaderDeps: ({ search }) => ({ projectId: search.projectId }),
  loader: async ({ params, deps }) => {
    if (!deps.projectId) return null;
    const [detail, info, executions, projects] = await Promise.all([
      getMachineFn({ data: { machineId: params.machineId, projectId: deps.projectId } }),
      getProjectInfoHubFn({ data: { projectId: deps.projectId } }),
      listProjectExecutionsFn({ data: { projectId: deps.projectId, machineId: params.machineId } }),
      listProjectsFn(),
    ]);
    return { detail, info, executions, projects };
  },
  component: MachineLeasePage,
});

function MachineLeasePage() {
  const data = Route.useLoaderData();
  const { machineId } = Route.useParams();
  const { projectId } = Route.useSearch();
  const navigate = useNavigate();
  const router = useMachineRefresh();
  const { enrollment, setEnrollment } = useMachineEnrollment();
  const back = (
    <button
      type="button"
      data-testid="machine-detail-back"
      className="text-sm text-foreground underline-offset-4 hover:underline"
      onClick={() => {
        if (typeof window !== "undefined" && Number(window.history.state?.idx) > 0) {
          window.history.back();
        } else {
          void navigate({
            to: projectId ? "/projects/$projectId/settings" : "/machines/$machineId",
            params: projectId ? { projectId } : { machineId },
          });
        }
      }}
    >
      返回
    </button>
  );
  if (!data || !projectId)
    return (
      <PageFrame
        title="租约需要 Project 上下文"
        back={back}
        testId="machine-lease-context-required"
      >
        <p className="text-sm text-muted-foreground">
          租约以 Project × Machine 为单位。请从 Project settings 的 Machines 入口打开租约。
        </p>
      </PageFrame>
    );
  if (!data.detail.ok)
    return (
      <PageFrame title="Machine 不可用" back={back}>
        <ResultError error={data.detail.error} />
      </PageFrame>
    );
  if (!data.info.ok)
    return (
      <PageFrame title="Project 租约不可用" back={back}>
        <ResultError error={data.info.error} />
      </PageFrame>
    );
  const detail = data.detail.data;
  const project = data.projects.ok
    ? data.projects.data.find((item) => item.id === projectId)
    : undefined;
  return (
    <MachineLeasePanel
      detail={detail}
      project={{ id: projectId, name: project?.name ?? projectId }}
      back={back}
      leaseInfo={data.info.data}
      leases={data.info.data.leases.items}
      holderNames={holderNames(data.info.data)}
      executions={data.executions.ok ? data.executions.data : []}
      executionError={data.executions.ok ? undefined : data.executions.error}
      enrollment={enrollment?.detail.machine.id === machineId ? enrollment : null}
      installOrigin={typeof window === "undefined" ? undefined : window.location.origin}
      onRenewEnrollment={(id) => renewMachineEnrollmentFn({ data: { machineId: id } })}
      onEnrollmentCreated={setEnrollment}
      onEnrollmentRevoked={(id) => {
        if (enrollment?.detail.machine.id === id) setEnrollment(null);
      }}
      actions={
        <Button
          variant="outline"
          data-testid="machine-refresh"
          onClick={() => void router.invalidate()}
        >
          刷新租约与操作
        </Button>
      }
    />
  );
}
