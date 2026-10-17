import { Link, Outlet, createFileRoute } from "@tanstack/react-router";
import { ProjectAgentsPanel } from "../../components/info-hub/project-agents-panel";
import { UnavailableNotice } from "../../components/info-hub/unavailable-notice";
import { ResultError } from "../../components/project/result-error";
import { getProjectInfoHubFn } from "../../server/functions/info-hub";
import { getProjectFn } from "../../server/functions/project";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  loader: async ({ params }) => {
    const [project, infoHub] = await Promise.all([
      getProjectFn({ data: { projectId: params.projectId } }),
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
    ]);
    return { project, infoHub };
  },
  component: ProjectHubPage,
});

/** hub 与子页共用布局：`/projects/<id>` 本身可直接刷新，子页 URL 在其下继续定位。 */
function ProjectHubPage() {
  const { project: result, infoHub } = Route.useLoaderData();

  return (
    <section className="space-y-6">
      <Link to="/projects" className="text-sm underline">
        返回列表
      </Link>
      {!result.ok && <ResultError error={result.error} testId="project-error" />}
      {result.ok && (
        <>
          <article className="space-y-4 rounded-lg border p-6">
            <h1 data-testid="project-detail-name" className="text-2xl font-semibold">
              {result.data.name}
            </h1>
            <p data-testid="project-detail-description" className="text-muted-foreground">
              {result.data.description ?? "（无描述）"}
            </p>
            <dl className="grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">Project ID</dt>
              <dd className="font-mono text-xs break-all">{result.data.id}</dd>
              <dt className="text-muted-foreground">创建时间</dt>
              <dd data-testid="project-detail-created-at">{result.data.createdAt}</dd>
              <dt className="text-muted-foreground">requestId</dt>
              <dd data-testid="project-detail-request-id" className="font-mono text-xs break-all">
                {result.requestId}
              </dd>
            </dl>
          </article>
          <nav className="flex gap-4 border-b border-border/60 pb-2 text-sm">
            <Link
              to="/projects/$projectId/settings"
              params={{ projectId: result.data.id }}
              data-testid="tab-settings"
              activeProps={{ className: "underline" }}
              className="pb-2"
            >
              配置
            </Link>
            <Link
              to="/projects/$projectId/conversations"
              params={{ projectId: result.data.id }}
              data-testid="tab-conversations"
              activeProps={{ className: "underline" }}
              className="pb-2"
            >
              对话
            </Link>
            <Link
              to="/projects/$projectId/agents"
              params={{ projectId: result.data.id }}
              data-testid="tab-agents"
              activeProps={{ className: "underline" }}
              className="pb-2"
            >
              Agent 成员
            </Link>
          </nav>
          {infoHub.ok ? (
            <>
              <ProjectAgentsPanel projectId={result.data.id} view={infoHub.data.agents} />
              <UnavailableNotice
                testId="info-hub-machines-notice"
                title="Project 的 Machine 与租约"
                reason={infoHub.data.machines.reason}
              />
            </>
          ) : (
            <ResultError error={infoHub.error} testId="info-hub-error" />
          )}
          <Outlet />
        </>
      )}
    </section>
  );
}
