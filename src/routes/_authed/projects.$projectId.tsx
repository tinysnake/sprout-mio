import { Outlet, createFileRoute } from "@tanstack/react-router";
import { PageFrame } from "../../components/layout/page-frame";
import { ResultError } from "../../components/project/result-error";
import { getProjectFn } from "../../server/functions/project";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  loader: ({ params }) => getProjectFn({ data: { projectId: params.projectId } }),
  component: ProjectLayout,
});

function ProjectLayout() {
  const result = Route.useLoaderData();
  if (!result.ok)
    return (
      <PageFrame title="Project">
        <ResultError error={result.error} testId="project-error" />
      </PageFrame>
    );
  return <Outlet />;
}
