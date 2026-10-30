import { useState } from "react";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { TaskDetailView } from "../../components/tasks/task-detail";
import type { TaskPageCommand } from "../../components/tasks/task-detail";
import { PageFrame } from "../../components/layout/page-frame";
import { ResultError } from "../../components/project/result-error";
import { Button } from "../../components/ui/button";
import { RunFactsBlock } from "../../components/info-hub/run-facts";
import { LeaseOverview } from "../../components/machine/lease-panel";
import { holderNames } from "../../components/machine/project-lease-actions";
import type { AppError } from "../../contracts/result";
import { getChatInfoFn, getProjectInfoHubFn } from "../../server/functions/info-hub";
import {
  getTaskDetailFn,
  updateTaskFn,
  assignTaskFn,
  reassignTaskFn,
  unassignTaskFn,
  startTaskFn,
  completeTaskFn,
  cancelTaskFn,
  correctTaskFn,
  reopenTaskFn,
  addTaskChecklistItemFn,
  updateTaskChecklistItemFn,
  removeTaskChecklistItemFn,
  appendTaskRecordFn,
} from "../../server/functions/task";

const commands = {
  update: updateTaskFn,
  assign: assignTaskFn,
  reassign: reassignTaskFn,
  unassign: unassignTaskFn,
  start: startTaskFn,
  complete: completeTaskFn,
  cancel: cancelTaskFn,
  correct: correctTaskFn,
  reopen: reopenTaskFn,
  checklist_add: addTaskChecklistItemFn,
  checklist_update: updateTaskChecklistItemFn,
  checklist_remove: removeTaskChecklistItemFn,
  record_append: appendTaskRecordFn,
};

export const Route = createFileRoute("/_authed/projects/$projectId/tasks/$taskId")({
  loader: async ({ params }) => {
    const detail = await getTaskDetailFn({ data: { taskId: params.taskId } });
    if (!detail.ok) return { detail, chatInfo: null, infoHub: null };
    if (detail.data.task.projectId !== params.projectId)
      return {
        detail: {
          ok: false as const,
          error: { code: "not_found" as const, message: "对象不存在", requestId: detail.requestId },
          requestId: detail.requestId,
        },
        chatInfo: null,
        infoHub: null,
      };
    const [chatInfo, infoHub] = await Promise.all([
      detail.data.chat ? getChatInfoFn({ data: { chatId: detail.data.chat.id } }) : null,
      getProjectInfoHubFn({ data: { projectId: params.projectId } }),
    ]);
    return { detail, chatInfo, infoHub };
  },
  component: ProjectTaskDetailPage,
});

function ProjectTaskDetailPage() {
  const loader = Route.useLoaderData();
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [transportError, setTransportError] = useState(false);
  async function submit(command: TaskPageCommand) {
    if (pending) return;
    setPending(true);
    setError(null);
    setTransportError(false);
    try {
      const saved = await commands[command.action]({ data: command.input });
      if (!saved.ok) {
        setError(saved.error);
        return false;
      }
      await router.invalidate();
      return true;
    } catch {
      setTransportError(true);
      return false;
    } finally {
      setPending(false);
    }
  }
  return (
    <PageFrame
      testId="task-detail-page"
      title="Task"
      actions={
        <Button variant="ghost" disabled={pending} onClick={() => void router.invalidate()}>
          刷新事实
        </Button>
      }
    >
      {(error || transportError) && (
        <div role="alert" className="mb-4 space-y-3 border-b border-border pb-4">
          {error ? (
            <ResultError error={error} testId="task-write-error" />
          ) : (
            <p className="text-xs">请求未完成，请重新加载后确认保存结果。</p>
          )}
          {error?.code === "conflict" && (
            <p className="text-xs">内容已发生变化。重新加载后再操作。</p>
          )}
          <Button
            data-testid="task-reload"
            variant="secondary"
            onClick={() => {
              setError(null);
              setTransportError(false);
              void router.invalidate();
            }}
          >
            重新加载
          </Button>
        </div>
      )}
      {loader.detail.ok ? (
        <TaskDetailView
          key={`${loader.detail.data.task.id}-${loader.detail.data.task.revision}`}
          detail={loader.detail.data}
          pending={pending}
          onCommand={submit}
          chatFacts={
            loader.detail.data.chat && (
              <div className="space-y-6">
                <div data-testid="task-chat-runs" className="space-y-3">
                  <h3 className="text-xs font-medium">Chat 活动 run</h3>
                  {loader.chatInfo?.ok ? (
                    <RunFactsBlock runs={loader.chatInfo.data.runs} testId="task-chat-run-facts" />
                  ) : loader.chatInfo && !loader.chatInfo.ok ? (
                    <ResultError error={loader.chatInfo.error} />
                  ) : (
                    <p className="text-xs text-muted-foreground">运行事实暂不可用</p>
                  )}
                </div>
                <div data-testid="task-project-leases">
                  {loader.infoHub?.ok ? (
                    <LeaseOverview
                      projectId={loader.detail.data.task.projectId}
                      machines={loader.infoHub.data.machines}
                      leases={loader.infoHub.data.leases.items}
                      holderNames={holderNames(loader.infoHub.data)}
                      dense
                      testId="task-lease-facts"
                    />
                  ) : loader.infoHub && !loader.infoHub.ok ? (
                    <ResultError error={loader.infoHub.error} />
                  ) : (
                    <p className="text-xs text-muted-foreground">租约事实暂不可用</p>
                  )}
                </div>
              </div>
            )
          }
        />
      ) : (
        <ResultError error={loader.detail.error} testId="task-load-error" />
      )}
    </PageFrame>
  );
}
