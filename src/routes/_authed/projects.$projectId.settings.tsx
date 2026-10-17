import { createFileRoute, useRouter } from "@tanstack/react-router";
import { ProjectConfigForm } from "../../components/project-config/project-config-form";
import { ResultError } from "../../components/project/result-error";
import { getProjectProfileFn } from "../../server/functions/project-config";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  loader: ({ params }) => getProjectProfileFn({ data: { projectId: params.projectId } }),
  component: ProjectSettingsPage,
});

/** 无 `project_profile` 行时领域服务返回默认分支 main，表单据此展示可编辑的当前值。 */
function ProjectSettingsPage() {
  const result = Route.useLoaderData();
  const router = useRouter();

  return (
    <section className="space-y-6">
      <h2 className="text-xl font-semibold">Project 配置</h2>
      {!result.ok && <ResultError error={result.error} testId="settings-error" />}
      {result.ok && (
        <ProjectConfigForm profile={result.data} onSaved={() => void router.invalidate()} />
      )}
    </section>
  );
}
