import { useState } from "react";
import type { ProjectTasksView, TaskStatus } from "../../contracts/task";
import { TASK_STATUSES } from "../../contracts/task";
import { Button } from "../ui/button";
import { TaskBadge } from "./task-badge";
import { responsibilityLabel, taskStatusLabels } from "./task-view";

export function TaskBoard({ view }: { view: ProjectTasksView }) {
  const [selected, setSelected] = useState<TaskStatus>("proposed");
  return (
    <div className="min-w-0" data-testid="task-board">
      <div
        role="tablist"
        aria-label="Task 四态"
        className="mb-4 grid grid-cols-4 gap-1 desktop:hidden"
      >
        {TASK_STATUSES.map((status) => (
          <Button
            key={status}
            role="tab"
            aria-selected={selected === status}
            variant={selected === status ? "secondary" : "ghost"}
            onClick={() => setSelected(status)}
            className="min-w-0 px-1 text-xs"
          >
            {taskStatusLabels[status]} {view.items.filter((item) => item.status === status).length}
          </Button>
        ))}
      </div>
      <div className="grid min-w-0 gap-4 desktop:grid-cols-4">
        {TASK_STATUSES.map((status) => {
          const items = view.items.filter((item) => item.status === status);
          return (
            <section
              key={status}
              aria-label={taskStatusLabels[status]}
              data-testid={`task-column-${status}`}
              className={`min-w-0 ${selected === status ? "" : "hidden desktop:block"}`}
            >
              <h2 className="mb-3 flex justify-between border-b border-border pb-3 text-xs font-medium">
                <span>{taskStatusLabels[status]}</span>
                <span className="text-muted-foreground">{items.length}</span>
              </h2>
              <div className="space-y-3">
                {items.map((item) => (
                  <a
                    key={item.id}
                    href={`/projects/${view.projectId}/tasks/${item.id}`}
                    data-testid={`task-card-${item.id}`}
                    className="block min-w-0 space-y-3 rounded-container border border-border bg-card p-4 text-card-foreground hover:border-ring focus-visible:outline-2 focus-visible:outline-ring"
                  >
                    <TaskBadge
                      status={item.status}
                      reopened={Boolean(item.previousCompletionRef)}
                    />
                    <h3 className="text-sm leading-6 font-medium break-words [overflow-wrap:anywhere]">
                      {item.title}
                    </h3>
                    <p className="text-xs break-words text-muted-foreground">
                      {item.chatDisplayTitle ?? "尚未分配承接 Chat"}
                    </p>
                    <p className="text-xs break-words">
                      {responsibilityLabel(item.responsibility)}
                    </p>
                    <p className="text-[11px] text-muted-foreground">
                      清单 {item.checklist.checked}/{item.checklist.total} · 记录 {item.recordCount}
                    </p>
                    {item.status === "assigned" && item.recordCount === 0 && (
                      <p className="text-xs text-muted-foreground">尚无施工记录</p>
                    )}
                    {item.status === "finished" && item.lastRecordRef && (
                      <p className="text-xs text-status-success">
                        完成结果 · 记录 #{item.lastRecordRef.seq}
                      </p>
                    )}
                    {item.status === "assigned" && item.previousCompletionRef && (
                      <p className="text-xs text-muted-foreground">
                        历史结果 #{item.previousCompletionRef.seq} 保留
                      </p>
                    )}
                    <p className="text-[10px] text-muted-foreground">
                      更新于{" "}
                      <time dateTime={item.updatedAt}>
                        {new Date(item.updatedAt).toLocaleString("zh-CN")}
                      </time>
                    </p>
                  </a>
                ))}
              </div>
              {items.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">
                  暂无{taskStatusLabels[status]} Task
                </p>
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}
