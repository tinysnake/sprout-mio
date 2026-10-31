import { z } from "zod";
import type { TaskAccessLevel } from "./task-capabilities";

export const INFO_HUB_ACTIONS = [
  "basic.read",
  "turn_snapshot.read",
  "turn_snapshot.capture",
  "hint.deliver",
] as const;
export type InfoHubAction = (typeof INFO_HUB_ACTIONS)[number];

/** capture/deliver are host-only operations, with no synthetic system Agent. */
export const INFO_HUB_CAPABILITIES = {
  "basic.read": { human: "project", agent: "project" },
  "turn_snapshot.read": { human: "project", agent: "never" },
  "turn_snapshot.capture": { human: "never", agent: "never" },
  "hint.deliver": { human: "never", agent: "never" },
} as const satisfies Record<InfoHubAction, { human: TaskAccessLevel; agent: TaskAccessLevel }>;

export const INFO_HUB_ERROR_CODES = [
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_failed",
  "too_many_requests",
  "info_hub_cursor_stale",
  "turn_context_unavailable",
  "internal",
] as const;
export const infoHubErrorCodeSchema = z.enum(INFO_HUB_ERROR_CODES);
export type InfoHubErrorCode = z.infer<typeof infoHubErrorCodeSchema>;
