import { createServerFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { z } from "zod";
import type { TaskAction } from "../../contracts/task-capabilities";
import type {
  ProjectTasksView,
  TaskCommandResult,
  TaskDetail,
  TaskResult,
} from "../../contracts/task";
import { taskIdSchema } from "../../contracts/task";
import { fieldErrorsFrom, projectIdInput } from "../../contracts/project";
import { fail, ok, toAppError } from "../../contracts/result";
import type { ProjectContext } from "../../domain/access";
import { getRequestContext } from "../request-context";
import { toDomainAppError } from "./domain-errors";

async function serverDeps() {
  const [session, domain] = await Promise.all([import("../session"), import("../../domain/task")]);
  return { requireSession: session.requireSession, ...domain };
}
type Deps = Awaited<ReturnType<typeof serverDeps>>;
async function taskBoundary<T>(
  headers: Headers,
  requestId: string,
  operation: (deps: Deps, ctx: ProjectContext) => T,
): Promise<TaskResult<T>> {
  try {
    const deps = await serverDeps();
    const session = await deps.requireSession(headers, requestId);
    if (!session.ok) return session;
    return ok(operation(deps, { userId: session.data.userId, requestId }), requestId);
  } catch (error) {
    if (error instanceof z.ZodError)
      return { ...fail(toAppError(error, requestId)), fieldErrors: fieldErrorsFrom(error) };
    const mapped = await toDomainAppError(error, requestId);
    if (mapped) return fail(mapped);
    console.error("[task] 请求失败", { requestId, error });
    return fail({ code: "internal", message: "内部错误", requestId });
  }
}
export function getProjectTasksBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<TaskResult<ProjectTasksView>> {
  return taskBoundary(headers, requestId, (deps, ctx) =>
    deps.getProjectTasks(projectIdInput.parse(raw).projectId, ctx),
  );
}
export function getTaskDetailBoundary(
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<TaskResult<TaskDetail>> {
  return taskBoundary(headers, requestId, (deps, ctx) =>
    deps.getTaskDetail(z.strictObject({ taskId: taskIdSchema }).parse(raw).taskId, ctx),
  );
}
export function taskCommandBoundary(
  action: TaskAction,
  raw: unknown,
  headers: Headers,
  requestId: string,
): Promise<TaskResult<TaskCommandResult>> {
  return taskBoundary(headers, requestId, (deps, ctx) => deps.mutateTask(action, raw, ctx));
}
export const createTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("create", raw, headers, requestId);
export const updateTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("update", raw, headers, requestId);
export const assignTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("assign", raw, headers, requestId);
export const reassignTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("reassign", raw, headers, requestId);
export const unassignTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("unassign", raw, headers, requestId);
export const startTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("start", raw, headers, requestId);
export const completeTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("complete", raw, headers, requestId);
export const cancelTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("cancel", raw, headers, requestId);
export const correctTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("correct", raw, headers, requestId);
export const reopenTaskBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("reopen", raw, headers, requestId);
export const addTaskChecklistItemBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("checklist_add", raw, headers, requestId);
export const updateTaskChecklistItemBoundary = (
  raw: unknown,
  headers: Headers,
  requestId: string,
) => taskCommandBoundary("checklist_update", raw, headers, requestId);
export const removeTaskChecklistItemBoundary = (
  raw: unknown,
  headers: Headers,
  requestId: string,
) => taskCommandBoundary("checklist_remove", raw, headers, requestId);
export const appendTaskRecordBoundary = (raw: unknown, headers: Headers, requestId: string) =>
  taskCommandBoundary("record_append", raw, headers, requestId);

export const getProjectTasksFn = createServerFn({ method: "GET" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    const request = getRequestContext();
    return getProjectTasksBoundary(data, getRequestHeaders(), request.requestId);
  });
export const getTaskDetailFn = createServerFn({ method: "GET" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    const request = getRequestContext();
    return getTaskDetailBoundary(data, getRequestHeaders(), request.requestId);
  });
export const createTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return createTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const updateTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return updateTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const assignTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return assignTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const reassignTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return reassignTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const unassignTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return unassignTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const startTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return startTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const completeTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return completeTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const cancelTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return cancelTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const correctTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return correctTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const reopenTaskFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return reopenTaskBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const addTaskChecklistItemFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return addTaskChecklistItemBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
export const updateTaskChecklistItemFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return updateTaskChecklistItemBoundary(
      data,
      getRequestHeaders(),
      getRequestContext().requestId,
    );
  });
export const removeTaskChecklistItemFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return removeTaskChecklistItemBoundary(
      data,
      getRequestHeaders(),
      getRequestContext().requestId,
    );
  });
export const appendTaskRecordFn = createServerFn({ method: "POST" })
  .validator((raw: unknown) => raw)
  .handler(async ({ data }) => {
    return appendTaskRecordBoundary(data, getRequestHeaders(), getRequestContext().requestId);
  });
