import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProjectBasicInfoForm } from "../../components/project/project-basic-info-form";
import { ProjectConfigForm } from "../../components/project-config/project-config-form";
import { ProjectRepoPanel } from "../../components/project-config/project-repo-panel";
import { ResultError } from "../../components/project/result-error";
import { getProjectProfileFn } from "../../server/functions/project-config";
import { getProjectFn } from "../../server/functions/project";
import { getProjectRepoStateFn } from "../../server/functions/repository";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  loader: async ({ params }) => {
    const [project, profile, repo] = await Promise.all([
      getProjectFn({ data: { projectId: params.projectId } }),
      getProjectProfileFn({ data: { projectId: params.projectId } }),
      getProjectRepoStateFn({ data: { projectId: params.projectId } }),
    ]);
    return { project, profile, repo };
  },
  component: ProjectSettingsPage,
});

/** 无 `project_profile` 行时领域服务返回默认分支 main，表单据此展示可编辑的当前值。 */
function ProjectSettingsPage() {
  const { project, profile, repo } = Route.useLoaderData();
  const router = useRouter();
  const invalidate = () => void router.invalidate();

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">Project 配置</h2>
      {!project.ok && <ResultError error={project.error} testId="settings-project-error" />}
      {project.ok && <ProjectBasicInfoForm project={project.data} onSaved={invalidate} />}
      {!profile.ok && <ResultError error={profile.error} testId="settings-error" />}
      {profile.ok && (
        <>
          <ProjectConfigForm profile={profile.data} onSaved={invalidate} />
          {repo.ok ? (
            <ProjectRepoPanel state={repo.data} onRefresh={invalidate} />
          ) : (
            <ResultError error={repo.error} testId="settings-repo-error" />
          )}
        </>
      )}
    </section>
  );
}
