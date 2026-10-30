export const TASK_ACTIONS = [
  "create",
  "update",
  "assign",
  "reassign",
  "unassign",
  "start",
  "checklist_add",
  "checklist_update",
  "checklist_remove",
  "record_append",
  "complete",
  "cancel",
  "correct",
  "reopen",
] as const;

export type TaskAction = (typeof TASK_ACTIONS)[number];
export type TaskAccessLevel = "never" | "project" | "member" | "responsible" | "human";

export const TASK_CAPABILITIES = {
  create: { human: "project", agent: "never" },
  update: { human: "member", agent: "responsible" },
  assign: { human: "member", agent: "never" },
  reassign: { human: "member", agent: "never" },
  unassign: { human: "member", agent: "never" },
  start: { human: "member", agent: "never" },
  checklist_add: { human: "member", agent: "member" },
  checklist_update: { human: "member", agent: "member" },
  checklist_remove: { human: "member", agent: "member" },
  record_append: { human: "member", agent: "member" },
  complete: { human: "member", agent: "responsible" },
  cancel: { human: "member", agent: "responsible" },
  correct: { human: "human", agent: "never" },
  reopen: { human: "human", agent: "never" },
} as const satisfies Record<TaskAction, { human: TaskAccessLevel; agent: TaskAccessLevel }>;
