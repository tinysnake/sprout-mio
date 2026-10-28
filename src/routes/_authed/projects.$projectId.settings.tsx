import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { PageFrame } from "../../components/layout/page-frame";
import { ProjectAgentsPanel } from "../../components/info-hub/project-agents-panel";
import { holderNames } from "../../components/machine/project-lease-actions";
import { RemoteExecutionList } from "../../components/machine/remote-execution-panel";
import { listProjectExecutionsFn } from "../../server/functions/remote";
import { useEffect, useState } from "react";
import { ProjectMachinesPanel } from "../../components/info-hub/project-machines-panel";
import { ProjectBasicInfoForm } from "../../components/project/project-basic-info-form";
import { ProjectFacts } from "../../components/project/project-facts";
import { SettingsSection } from "../../components/project/settings-section";
import { ProjectConfigForm } from "../../components/project-config/project-config-form";
import { ProjectRepoPanel } from "../../components/project-config/project-repo-panel";
import { ResultError } from "../../components/project/result-error";
import { Icon } from "../../components/ui/icon";
import { getProjectProfileFn, updateProjectProfileFn } from "../../server/functions/project-config";
import { getProjectFn, updateProjectFn } from "../../server/functions/project";
import { listMachinesFn, saveProjectMachineBindingFn } from "../../server/functions/machine";
import { MachineBindingForm } from "../../components/machine/machine-binding-form";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { getProjectRepoStateFn, prepareProjectRepoFn } from "../../server/functions/repository";
import { useExecutionWiring } from "../../lib/execution-wiring";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  loader: async ({ params }) => {
    const [project, profile, repo, infoHub, machines, executions] = await Promise.all([
      getProjectFn({ data: { projectId: params.projectId } }),
      getProjectProfileFn({ data: { projectId: params.projectId } }),
      getProjectRepoStateFn({ data: { projectId: params.projectId } }),
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
      listMachinesFn({ data: {} }),
      listProjectExecutionsFn({ data: { projectId: params.projectId } }),
    ]);
    return { project, profile, repo, infoHub, machines, executions };
  },
  component: ProjectSettingsPage,
});

/**
 * 无 `project_profile` 行时领域服务返回默认分支 main，表单据此展示可编辑的当前值。
 * Project 的身份、协作配置、仓库来源与原有 Info Hub 查询都在这一页，
 * 没有独立的 Project 详情页。
 */
function ProjectSettingsPage() {
  const { project, profile, repo, infoHub, machines, executions } = Route.useLoaderData();
  const [selectedMachine, setSelectedMachine] = useState("");
  const { projectId } = Route.useParams();
  // 执行列表已在 loader 里查询；读取日志、取消与连接状态都接真实服务端入口。
  const executionRows = executions.ok ? executions.data : [];
  const executionWiring = useExecutionWiring({
    projectId,
    executions: executionRows,
    listError: executions.ok ? null : executions.error,
  });
  const router = useRouter();
  const invalidate = () => void router.invalidate();
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void router.invalidate();
    }, 5000);
    return () => clearInterval(timer);
  }, [router]);

  return (
    <PageFrame
      title="Project settings"
      description="管理当前 Project 的基本信息与协作配置，查看 Chat 使用的仓库来源。"
      back={
        <Link to="/projects/$projectId/chats" params={{ projectId }}>
          <Icon as={ArrowLeft} />
          返回 Chats
        </Link>
      }
      testId="project-settings-page"
    >
      {!project.ok && <ResultError error={project.error} testId="settings-project-error" />}
      {project.ok && (
        <>
          <ProjectBasicInfoForm
            key={project.data.id}
            project={project.data}
            submit={(draft) =>
              updateProjectFn({
                data: {
                  projectId,
                  name: draft.name,
                  description: draft.description ? draft.description : null,
                },
              })
            }
            onSaved={invalidate}
          />
          <SettingsSection
            title="基本事实"
            description="Project 的身份与本次查询的诊断标识；排查问题时可以引用 requestId。"
          >
            <ProjectFacts project={project.data} requestId={project.requestId} />
          </SettingsSection>
          {!profile.ok && <ResultError error={profile.error} testId="settings-error" />}
          {profile.ok && (
            <>
              <ProjectConfigForm
                key={`profile-${profile.data.projectId}`}
                profile={profile.data}
                submit={(draft) =>
                  updateProjectProfileFn({
                    data: {
                      projectId,
                      gitRemote: draft.gitRemote.trim() || null,
                      defaultBranch: draft.defaultBranch,
                      workDirectory: draft.workDirectory.trim() || null,
                    },
                  })
                }
                onSaved={invalidate}
              />
              {repo.ok ? (
                <ProjectRepoPanel
                  key={`repo-${projectId}`}
                  state={repo.data}
                  prepare={() => prepareProjectRepoFn({ data: { projectId } })}
                  onRefresh={invalidate}
                />
              ) : (
                <ResultError error={repo.error} testId="settings-repo-error" />
              )}
            </>
          )}
          <SettingsSection
            title="Machines"
            description="选择本账号的 Machine，在当前 Project 中加入或编辑说明。工作路径由 Machine root 与 Project ID 派生。"
          >
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <label className="flex flex-col gap-2 text-xs">
                Machine
                <select
                  data-testid="project-machine-select"
                  value={selectedMachine}
                  onChange={(event) => setSelectedMachine(event.target.value)}
                  className="h-9 rounded-control border border-input bg-background px-3"
                >
                  <option value="">选择 Machine</option>
                  {machines.ok &&
                    machines.data.map((m) => (
                      <option key={m.machine.id} value={m.machine.id}>
                        {m.machine.name}
                      </option>
                    ))}
                </select>
              </label>
              <Link to="/machines" className="text-xs underline">
                管理 Machines
              </Link>
              <button type="button" onClick={invalidate} className="text-xs underline">
                刷新 Machine 事实
              </button>
            </div>
            {selectedMachine && machines.ok && (
              <div className="mb-6">
                <MachineBindingForm
                  key={`${selectedMachine}:${projectId}`}
                  machineId={selectedMachine}
                  project={project.data}
                  binding={
                    machines.data
                      .find((item) => item.machine.id === selectedMachine)
                      ?.bindings.find((item) => item.intent.projectId === projectId) ?? null
                  }
                  submit={(input) => saveProjectMachineBindingFn({ data: input })}
                  onSaved={invalidate}
                />
              </div>
            )}
            {!machines.ok && <ResultError error={machines.error} />}
            {infoHub.ok && (
              <ProjectMachinesPanel
                projectId={projectId}
                machines={infoHub.data.machines}
                leases={infoHub.data.leases.items}
                holderNames={holderNames(infoHub.data)}
              />
            )}
          </SettingsSection>
          <SettingsSection title="远端操作" description="本 Project 的最近操作与执行结果。">
            {executions.ok ? (
              <RemoteExecutionList
                executions={executions.data}
                machines={infoHub.ok ? infoHub.data.machines : []}
                holderNames={infoHub.ok ? holderNames(infoHub.data) : {}}
                leases={infoHub.ok ? infoHub.data.leases.items : []}
                logReader={executionWiring.logReader}
                canceller={executionWiring.canceller}
                connection={executionWiring.connection}
                cancellations={executionWiring.cancellations}
                onCancelled={executionWiring.onCancelled}
                testId="settings-executions"
              />
            ) : (
              <ResultError error={executions.error} />
            )}
          </SettingsSection>
          <SettingsSection title="关联信息" description="成员分身、活动与最近 run。">
            <details data-testid="settings-info-hub" className="group">
              <summary
                data-testid="project-info-hub-toggle"
                className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-foreground underline decoration-input underline-offset-3 hover:decoration-foreground"
              >
                <Icon
                  as={ChevronRight}
                  size={12}
                  className="transition-transform group-open:rotate-90"
                />
                展开 Project 的关联信息
              </summary>
              <div className="mt-4 flex flex-col gap-3">
                {infoHub.ok ? (
                  <ProjectAgentsPanel projectId={projectId} view={infoHub.data.agents} />
                ) : (
                  <ResultError error={infoHub.error} testId="info-hub-error" />
                )}
              </div>
            </details>
          </SettingsSection>
        </>
      )}
    </PageFrame>
  );
}
