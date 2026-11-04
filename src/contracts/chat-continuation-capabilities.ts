import type { TaskAccessLevel } from "./task-capabilities";

export const CHAT_CONTINUATION_ACTIONS = [
  "project.wake_policy.read",
  "project.wake_policy.update",
  "chat.continuation.read",
  "chat.continuation.disable",
  "chat.continuation.enable",
  "chat.continuation.abort",
  "chat.continuation.retry",
  "chat.continuation.reissue",
] as const;
export type ChatContinuationAction = (typeof CHAT_CONTINUATION_ACTIONS)[number];
export type ChatContinuationAccessLevel = TaskAccessLevel;

/**
 * Levels describe the first authorization gate, not sufficient authorization:
 * Project settings update also requires its creator; Chat controls require current
 * Human Chat eligibility; retry/reissue additionally validate the same Chat subject.
 * Scheduler evaluate/enqueue/admit are internal entrypoints, never public capabilities.
 */
export const CHAT_CONTINUATION_CAPABILITIES = {
  "project.wake_policy.read": { human: "project", agent: "project" },
  "project.wake_policy.update": { human: "human", agent: "never" },
  "chat.continuation.read": { human: "member", agent: "member" },
  "chat.continuation.disable": { human: "member", agent: "never" },
  "chat.continuation.enable": { human: "member", agent: "never" },
  "chat.continuation.abort": { human: "member", agent: "never" },
  "chat.continuation.retry": { human: "member", agent: "never" },
  "chat.continuation.reissue": { human: "member", agent: "never" },
} as const satisfies Record<
  ChatContinuationAction,
  { human: ChatContinuationAccessLevel; agent: ChatContinuationAccessLevel }
>;
