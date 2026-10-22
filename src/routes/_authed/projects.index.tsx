import { Link, createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { FolderKanban } from "lucide-react";
import { PageFrame } from "../../components/layout/page-frame";
import { CreateProjectDialog } from "../../components/project/create-project-dialog";
import { ResultError } from "../../components/project/result-error";
import { Icon } from "../../components/ui/icon";
import { listProjectsFn } from "../../server/functions/project";

export const Route = createFileRoute("/_authed/projects/")({
  loader: async () => {
    const result = await listProjectsFn();
    if (result.ok && result.data.length === 1)
      throw redirect({
        to: "/projects/$projectId/chats",
        params: { projectId: result.data[0].id },
      });
    return result;
  },
  component: ProjectsIndexPage,
});

function ProjectsIndexPage() {
  const result = Route.useLoaderData();
  const router = useRouter();
  const projects = result.ok ? result.data : [];
  return (
    <PageFrame
      title="Projects"
      description="选择一个 Project，或创建新的协作空间。"
      testId="projects-page"
    >
      {!result.ok && <ResultError error={result.error} testId="projects-error" />}
      {result.ok && projects.length === 0 && (
        <div className="flex min-h-72 flex-col items-center justify-center gap-4 text-center">
          <Icon as={FolderKanban} size={28} className="text-muted-foreground" />
          <h2 className="text-lg font-medium">创建你的第一个 Project</h2>
          <p data-testid="project-empty" className="text-sm text-muted-foreground">
            还没有 Project，先创建一个。
          </p>
          <CreateProjectDialog
            onCreated={async (project) => {
              await router.invalidate();
              await router.navigate({
                to: "/projects/$projectId/chats",
                params: { projectId: project.id },
              });
            }}
          />
        </div>
      )}
      {projects.length > 0 && (
        <ul data-testid="project-list" className="divide-y divide-border">
          {projects.map((project) => (
            <li key={project.id} data-testid="project-item" data-project-id={project.id}>
              <Link
                to="/projects/$projectId/chats"
                params={{ projectId: project.id }}
                className="flex items-center gap-4 rounded-control px-3 py-5 hover:bg-hover"
              >
                <Icon as={FolderKanban} size={20} />
                <span className="min-w-0 flex-1">
                  <span
                    data-testid="project-item-name"
                    className="block truncate text-sm font-medium"
                  >
                    {project.name}
                  </span>
                  <span className="mt-1 block text-xs text-muted-foreground">
                    {project.description ?? "打开 Project 的 Chats"}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(project.createdAt).toLocaleDateString("zh-CN")}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageFrame>
  );
}
