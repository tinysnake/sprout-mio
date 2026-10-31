import { z } from "zod";
import { runIdSchema } from "./agent-run";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { machineIdSchema } from "./machine";
import { INFO_HUB_LIMITS, infoHubUniqueArray } from "./info-hub";
import { infoHubRevisionSchema } from "./info-hub-query";

export const INFO_HUB_HINT_KINDS = [
  "chat_members",
  "chat_owner",
  "chat_archived",
  "task_summary",
  "agent_status",
  "machine_connection",
  "machine_lease",
] as const;
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
export const infoHubHintChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.enum(["chat_members", "chat_owner", "chat_archived", "task_summary", "agent_status"]),
    chatId,
  }),
  z.strictObject({
    kind: z.enum(["machine_connection", "machine_lease"]),
    machineId: machineIdSchema,
  }),
]);

/** Run-local ephemeral steering, with no message, admission, retry or resource-notice fields. */
export const infoHubHintSchema = z
  .strictObject({
    runId: runIdSchema,
    projectId: z.string().regex(appIdPattern(ID_PREFIXES.project)),
    chatId,
    instanceId: z.string().regex(appIdPattern(ID_PREFIXES.instance)),
    asOf: z.iso.datetime(),
    revision: infoHubRevisionSchema,
    heldMachineIds: infoHubUniqueArray(machineIdSchema, (id) => id),
    changes: infoHubUniqueArray(
      infoHubHintChangeSchema,
      (change) => `${change.kind}:${"chatId" in change ? change.chatId : change.machineId}`,
    ).min(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.changes.some((change) =>
        "chatId" in change
          ? change.chatId !== value.chatId
          : !value.heldMachineIds.includes(change.machineId),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Hint scope is the current Chat and the run instance's held Machines",
      });
    }
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > INFO_HUB_LIMITS.maxHintBytes) {
      ctx.addIssue({ code: "custom", message: "Hint exceeds its UTF-8 budget" });
    }
  });
export type InfoHubHint = z.infer<typeof infoHubHintSchema>;

/** This key must live only in the current run's memory and be discarded on settlement. */
export const infoHubHintDedupeKeySchema = z.strictObject({
  runId: runIdSchema,
  kind: z.enum(INFO_HUB_HINT_KINDS),
  targetId: z.string().min(1).max(128),
  revision: infoHubRevisionSchema,
});
export type InfoHubHintDedupeKey = z.infer<typeof infoHubHintDedupeKeySchema>;
