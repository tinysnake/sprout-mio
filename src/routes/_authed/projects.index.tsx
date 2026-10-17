import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { CreateProjectDialog } from "../../components/project/create-project-dialog";
import { ResultError } from "../../components/project/result-error";
import { listProjectsFn } from "../../server/functions/project";

export const Route = createFileRoute("/_authed/projects/")({
  loader: () => listProjectsFn(),
  component: ProjectsIndexPage,
});

function ProjectsIndexPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const projects = result.ok ? result.data : [];

  return (
    <section className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">Project</h1>
        <CreateProjectDialog onCreated={() => void router.invalidate()} />
      </div>
      {!result.ok && <ResultError error={result.error} testId="projects-error" />}
      {result.ok && projects.length === 0 && (
        <p data-testid="project-empty" className="text-muted-foreground">
          还没有 Project，先创建一个。
        </p>
      )}
      <ul data-testid="project-list" className="divide-y divide-border/60 rounded-lg border">
        {projects.map((project) => (
          <li key={project.id} data-testid="project-item" data-project-id={project.id}>
            <Link
              to="/projects/$projectId"
              params={{ projectId: project.id }}
              className="block px-4 py-3 hover:bg-muted/50"
            >
              <span data-testid="project-item-name" className="font-medium">
                {project.name}
              </span>
              <span className="mt-1 block text-xs text-muted-foreground">
                创建于 {project.createdAt}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
