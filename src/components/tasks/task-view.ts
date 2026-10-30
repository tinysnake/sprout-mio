import type { TaskDetail, TaskResponsibility, TaskStatus } from "../../contracts/task";

export const taskStatusLabels: Record<TaskStatus, string> = {
  proposed: "待分配", assigned: "已分配", finished: "已完成", canceled: "已取消",
};

export function responsibilityLabel(value: TaskResponsibility | null | undefined) {
  if (!value) return "待明确责任";
  return value.kind === "human" ? `Human · ${value.userId}` : `Agent · ${value.name}`;
}

export function resultNotice(detail: TaskDetail) {
  if (detail.task.status === "finished" && detail.completionRecord) {
    return { label: `当前完成结果 · 记录 #${detail.completionRecord.seq} · 查看结果`, record: detail.completionRecord, current: true };
  }
  if (detail.previousCompletionRecord) {
    return { label: `当前没有完成结果。历史结果 #${detail.previousCompletionRecord.seq} 保留`, record: detail.previousCompletionRecord, current: false };
  }
  return { label: "当前没有完成结果", record: null, current: false };
}
