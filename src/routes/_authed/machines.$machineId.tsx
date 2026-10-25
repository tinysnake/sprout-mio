import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { useEffect } from "react";
import { PageFrame } from "../../components/layout/page-frame";
import { MachineDetailPanel } from "../../components/machine/machine-detail";
import { holderNames } from "../../components/machine/project-lease-actions";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { listProjectExecutionsFn } from "../../server/functions/remote";
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

export const Route = createFileRoute("/_authed/machines/$machineId")({
  // `lease=1` 是 Machine 详情页租约区块的定位深链（Project settings 的租约入口用它进来）。
  validateSearch: z.object({ projectId: z.string().optional(), lease: z.string().optional() }),
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
    const [info, executions] = deps.projectId
      ? await Promise.all([
          getProjectInfoHubFn({ data: { projectId: deps.projectId } }),
          listProjectExecutionsFn({
            data: { projectId: deps.projectId, machineId: params.machineId },
          }),
        ])
      : [null, null];
    return { detail, projects, info, executions };
  },
  component: MachinePage,
});

function MachinePage() {
  const { detail, projects, info, executions } = Route.useLoaderData();
  const { projectId, lease } = Route.useSearch();
  const router = useRouter();
  const { enrollment, setEnrollment } = useMachineEnrollment();

  /** 滚到本页租约区块并让它里面第一个可操作控件获得真实焦点（可见焦点环）。 */
  function revealLeaseBlock() {
    const node = document.querySelector<HTMLElement>('[data-testid="machine-lease-detail"]');
    if (!node) return;
    node.scrollIntoView({ block: "start", behavior: "smooth" });
    const focusable = node.querySelector<HTMLElement>(
      'select, input, button, a[href], [tabindex]:not([tabindex="-1"])',
    );
    focusable?.focus({ preventScroll: true });
  }

  // 从 Project settings 带着 lease=1 进来：直接定位到租约区块，不需要人自己找。
  useEffect(() => {
    if (lease !== "1") return;
    const timer = window.setTimeout(revealLeaseBlock, 0);
    return () => window.clearTimeout(timer);
  }, [lease, projectId, detail]);
  useEffect(() => {
    let stopped = false;
    let refreshing = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function schedule() {
      clearTimeout(timer);
      if (stopped || refreshing || document.visibilityState !== "visible") return;
      timer = setTimeout(async () => {
        if (stopped || document.visibilityState !== "visible") return;
        refreshing = true;
        try {
          await router.invalidate();
        } catch {
          // Retry quietly on the next visible cycle; manual refresh stays available.
        } finally {
          refreshing = false;
          schedule();
        }
      }, 5000);
    }
    document.addEventListener("visibilitychange", schedule);
    schedule();
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, [router]);
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
      leaseInfo={info?.ok ? info.data : undefined}
      leaseError={info && !info.ok ? info.error : undefined}
      executionError={executions && !executions.ok ? executions.error : undefined}
      leases={info?.ok ? info.data.leases.items : []}
      holderNames={info?.ok ? holderNames(info.data) : {}}
      executions={executions?.ok ? executions.data : []}
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
          {projectId ? (
            <Button variant="secondary" data-testid="machine-lease-jump" onClick={revealLeaseBlock}>
              租约详情
            </Button>
          ) : (
            detail.data.bindings.map((binding) => (
              <Link
                key={binding.intent.projectId}
                to="/machines/$machineId"
                params={{ machineId: detail.data.machine.id }}
                search={{ projectId: binding.intent.projectId, lease: "1" }}
                data-testid="machine-lease-link"
                className="inline-flex min-h-8.5 items-center rounded-control border border-border bg-background px-2.75 text-xs font-medium text-foreground hover:border-foreground"
              >
                {availableProjects.find((p) => p.id === binding.intent.projectId)?.name ??
                  binding.intent.projectId}{" "}
                的租约
              </Link>
            ))
          )}
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
