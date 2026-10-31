import type { TaskAccessLevel } from "./task-capabilities";

export const CHAT_AUTOMATION_ACTIONS = [
  "project.wake_policy.read",
  "project.wake_policy.update",
  "chat.automation.read",
  "chat.automation.disable",
  "chat.automation.enable",
  "chat.automation.abort",
  "chat.automation.retry",
  "chat.automation.reissue",
] as const;
export type ChatAutomationAction = (typeof CHAT_AUTOMATION_ACTIONS)[number];
export type ChatAutomationAccessLevel = TaskAccessLevel;

/**
 * Levels describe the first authorization gate, not sufficient authorization:
 * Project settings update also requires its creator; Chat controls require current
 * Human Chat eligibility; retry/reissue additionally validate the same Chat subject.
 * Scheduler evaluate/enqueue/admit are internal entrypoints, never public capabilities.
 */
export const CHAT_AUTOMATION_CAPABILITIES = {
  "project.wake_policy.read": { human: "project", agent: "project" },
  "project.wake_policy.update": { human: "human", agent: "never" },
  "chat.automation.read": { human: "member", agent: "member" },
  "chat.automation.disable": { human: "member", agent: "never" },
  "chat.automation.enable": { human: "member", agent: "never" },
  "chat.automation.abort": { human: "member", agent: "never" },
  "chat.automation.retry": { human: "member", agent: "never" },
  "chat.automation.reissue": { human: "member", agent: "never" },
} as const satisfies Record<
  ChatAutomationAction,
  { human: ChatAutomationAccessLevel; agent: ChatAutomationAccessLevel }
>;
