import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { PageFrame } from "../../components/layout/page-frame";
import { ThemeToggle } from "../../components/layout/theme-toggle";
import { ProjectAgentsPanel } from "../../components/info-hub/project-agents-panel";
import { UnavailableNotice } from "../../components/info-hub/unavailable-notice";
import { ProjectBasicInfoForm } from "../../components/project/project-basic-info-form";
import { ProjectFacts } from "../../components/project/project-facts";
import { SettingsSection } from "../../components/project/settings-section";
import { ProjectConfigForm } from "../../components/project-config/project-config-form";
import { ProjectRepoPanel } from "../../components/project-config/project-repo-panel";
import { ResultError } from "../../components/project/result-error";
import { Icon } from "../../components/ui/icon";
import { getProjectProfileFn, updateProjectProfileFn } from "../../server/functions/project-config";
import { getProjectFn, updateProjectFn } from "../../server/functions/project";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { getProjectRepoStateFn, prepareProjectRepoFn } from "../../server/functions/repository";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  loader: async ({ params }) => {
    const [project, profile, repo, infoHub] = await Promise.all([
      getProjectFn({ data: { projectId: params.projectId } }),
      getProjectProfileFn({ data: { projectId: params.projectId } }),
      getProjectRepoStateFn({ data: { projectId: params.projectId } }),
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
    ]);
    return { project, profile, repo, infoHub };
  },
  component: ProjectSettingsPage,
});

/**
 * 无 `project_profile` 行时领域服务返回默认分支 main，表单据此展示可编辑的当前值。
 * Project 的身份、协作配置、仓库来源与原有 Info Hub 查询都在这一页，
 * 没有独立的 Project 详情页。
 */
function ProjectSettingsPage() {
  const { project, profile, repo, infoHub } = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const router = useRouter();
  const invalidate = () => void router.invalidate();

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
      actions={<ThemeToggle />}
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
            title="关联信息"
            description="原 Project 页面的 Info Hub 查询保留在这里：成员分身、活动与最近 run，以及尚未实现的 Machine 视角。"
          >
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
                  <>
                    <ProjectAgentsPanel projectId={projectId} view={infoHub.data.agents} />
                    <UnavailableNotice
                      testId="info-hub-machines-notice"
                      title="Project 的 Machine 与租约"
                      reason={infoHub.data.machines.reason}
                    />
                  </>
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
