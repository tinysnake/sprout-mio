import type { InfoHubTaskSummary } from "../../contracts/info-hub";
import { TaskBadge } from "./task-badge";
import { responsibilityLabel } from "./task-view";

export function TaskAssociations({ projectId, items, compact = false }: { projectId: string; items: readonly InfoHubTaskSummary[]; compact?: boolean }) {
  return <div data-testid="task-associations" className="min-w-0 space-y-3">
    {items.length === 0 && <p className="text-xs text-muted-foreground">暂无关联 Task</p>}
    {items.map(item => <div key={item.taskId} className="min-w-0 space-y-2 border-b border-border pb-3 last:border-0">
      <div className="flex flex-wrap items-center gap-2"><TaskBadge status={item.status} reopened={Boolean(item.previousCompletionRef)} /><a className="min-w-0 text-xs leading-6 break-words underline underline-offset-4" href={`/projects/${projectId}/tasks/${item.taskId}`}>{item.title}</a></div>
      {!compact && <><p className="text-[11px] break-words">{responsibilityLabel(item.responsibility)}</p><p className="text-[11px] text-muted-foreground">清单 {item.checklistChecked}/{item.checklistTotal} · 记录 {item.recordCount}</p></>}
    </div>)}
  </div>;
}
