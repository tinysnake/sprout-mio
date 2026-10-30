import type { TaskStatus } from "../../contracts/task";
import { taskStatusLabels } from "./task-view";

const tones: Record<TaskStatus, string> = {
  proposed: "bg-muted text-muted-foreground",
  assigned: "bg-secondary text-secondary-foreground",
  finished: "bg-muted text-status-success",
  canceled: "bg-muted text-muted-foreground",
};

export function TaskBadge({
  status,
  reopened = false,
}: {
  status: TaskStatus;
  reopened?: boolean;
}) {
  return (
    <span
      data-testid="task-badge"
      className={`inline-flex shrink-0 rounded-control px-2 py-1 text-[10px] ${tones[status]}`}
    >
      {taskStatusLabels[status]}
      {status === "assigned" && reopened ? " · 重开" : ""}
    </span>
  );
}
