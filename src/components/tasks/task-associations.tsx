import { cn } from "cn";
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
          <div className="flex min-w-0 items-center gap-2">
            <TaskBadge status={item.status} reopened={Boolean(item.previousCompletionRef)} />
            <AppLink
              className={cn(
                "min-w-0 text-xs leading-6 underline underline-offset-4",
                compact ? "break-words" : "flex-1 truncate",
              )}
              href={`/projects/${projectId}/tasks/${item.taskId}`}
            >
              {item.title}
            </AppLink>
          </div>
          {!compact && (
            <dl className="grid grid-cols-[3rem_minmax(0,1fr)] items-start gap-x-2 gap-y-2 text-[11px]">
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
