import { useState } from "react";
import { createFileRoute, Outlet, useMatch, useNavigate, useRouter } from "@tanstack/react-router";
import { TaskBoard } from "../../components/tasks/task-board";
import { TaskCreateForm } from "../../components/tasks/task-forms";
import { PageFrame } from "../../components/layout/page-frame";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import type { CreateTaskInput } from "../../contracts/task";
import type { AppError } from "../../contracts/result";
import { createTaskFn, getProjectTasksFn } from "../../server/functions/task";

export const Route = createFileRoute("/_authed/projects/$projectId/tasks")({
  loader: ({ params }) => getProjectTasksFn({ data: { projectId: params.projectId } }),
  component: ProjectTasksPage,
});

function ProjectTasksPage() {
  const result = Route.useLoaderData();
  const { projectId } = Route.useParams();
  const detail = useMatch({
    from: "/_authed/projects/$projectId/tasks/$taskId",
    shouldThrow: false,
  });
  const navigate = useNavigate();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [transportError, setTransportError] = useState(false);
  async function create(input: CreateTaskInput) {
    if (pending) return;
    setPending(true);
    setError(null);
    setTransportError(false);
    try {
      const saved = await createTaskFn({ data: input });
      if (!saved.ok) {
        setError(saved.error);
        return;
      }
      setCreating(false);
      await router.invalidate();
      await navigate({
        to: "/projects/$projectId/tasks/$taskId",
        params: { projectId, taskId: saved.data.detail.task.id },
      });
    } catch {
      setTransportError(true);
    } finally {
      setPending(false);
    }
  }
  if (detail) return <Outlet />;
  return (
    <PageFrame
      title="Tasks"
      description="目标、承接与施工记录"
      testId="tasks-page"
      actions={
        <Button onClick={() => setCreating((value) => !value)} disabled={pending}>
          {creating ? "收起创建" : "创建 Task"}
        </Button>
      }
    >
      {(error || transportError) && (
        <div className="mb-4">
          {error ? (
            <ResultError error={error} testId="task-write-error" />
          ) : (
            <p role="alert" className="text-xs">
              请求未完成，请重新加载后确认保存结果。
            </p>
          )}
          <Button variant="ghost" onClick={() => void router.invalidate()}>
            重新加载
          </Button>
        </div>
      )}
      {creating && (
        <div className="mb-8 max-w-2xl border-b border-border pb-6">
          <TaskCreateForm projectId={projectId} pending={pending} onSubmit={create} />
        </div>
      )}
      {result.ok ? (
        <TaskBoard view={result.data} />
      ) : (
        <ResultError error={result.error} testId="tasks-load-error" />
      )}
    </PageFrame>
  );
}
