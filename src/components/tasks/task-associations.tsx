import type { InfoHubTaskSummary } from "../../contracts/info-hub";
import { AppLink } from "../ui/app-link";
import { TaskBadge } from "./task-badge";
import { responsibilityLabel } from "./task-view";

export function TaskAssociations({
  projectId,
  items,
  compact = false,
}: {
  projectId: string;
  items: readonly InfoHubTaskSummary[];
  compact?: boolean;
}) {
  return (
    <div data-testid="task-associations" className="min-w-0 space-y-3">
      {items.length === 0 && <p className="text-xs text-muted-foreground">暂无关联 Task</p>}
      {items.map((item) => (
        <div
          key={item.taskId}
          className="min-w-0 space-y-2 border-b border-border pb-3 last:border-0"
        >
          <div className="flex flex-wrap items-center gap-2">
            {compact && (
              <TaskBadge status={item.status} reopened={Boolean(item.previousCompletionRef)} />
            )}
            <AppLink
              className="min-w-0 text-xs leading-6 break-words underline underline-offset-4"
              href={`/projects/${projectId}/tasks/${item.taskId}`}
            >
              {item.title}
            </AppLink>
          </div>
          {!compact && (
            <dl className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2 gap-y-2 text-[11px]">
              <dt className="text-muted-foreground">状态</dt>
              <dd className="[&>span]:bg-transparent [&>span]:p-0">
                <TaskBadge status={item.status} reopened={Boolean(item.previousCompletionRef)} />
              </dd>
              <dt className="text-muted-foreground">负责人</dt>
              <dd className="break-words">{responsibilityLabel(item.responsibility)}</dd>
              <dt className="text-muted-foreground">进展</dt>
              <dd className="text-muted-foreground">
                清单 {item.checklistChecked}/{item.checklistTotal} · 记录 {item.recordCount}
              </dd>
            </dl>
          )}
        </div>
      ))}
    </div>
  );
}
