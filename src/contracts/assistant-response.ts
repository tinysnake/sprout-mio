import { z } from "zod";
import { assistantTargetSchema } from "./assistant";

const project = z.strictObject({ id: z.string(), name: z.string() });
const agent = project.extend({ agentProfileId: z.string(), purpose: z.literal("worker") });
const chat = z.strictObject({
  id: z.string(),
  kind: z.enum(["dm", "group", "public_channel"]),
  title: z.string().nullable(),
  ownerKind: z.enum(["human", "agent"]),
  ownerId: z.string(),
});
export const assistantObserveResponseSchema = z.union([
  z.strictObject({ projects: z.array(project).max(50) }),
  z.strictObject({ agents: z.array(agent).max(50), chats: z.array(chat).max(50) }),
  z.strictObject({
    messages: z
      .array(
        z.strictObject({
          id: z.string(),
          senderKind: z.enum(["human", "agent", "automation", "assistant_work", "assistant_event"]),
          senderId: z.string(),
          body: z.string(),
          createdAt: z.iso.datetime(),
        }),
      )
      .max(50),
    runs: z
      .array(z.strictObject({ id: z.string(), instanceId: z.string(), status: z.string() }))
      .max(50),
  }),
  z.strictObject({
    run: z.strictObject({
      id: z.string(),
      status: z.string(),
      queuedAt: z.iso.datetime(),
      startedAt: z.iso.datetime().nullable(),
      settledAt: z.iso.datetime().nullable(),
      errorCode: z.string().nullable(),
      errorMessage: z.string().nullable(),
      assistantMessageId: z.string().nullable(),
    }),
    activity: z.unknown().nullable(),
    basis: z.enum(["live", "settled"]),
  }),
]);
export const assistantProposeResponseSchema = z.strictObject({
  proposalId: z.string(),
  status: z.literal("pending"),
  target: assistantTargetSchema.and(z.object({ chatId: z.string() })),
  agentProfileId: z.string(),
  body: z.string(),
});
export const assistantWatchResponseSchema = z.strictObject({
  eventId: z.string(),
  active: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(86400),
});
export type AssistantResponse =
  | z.infer<typeof assistantObserveResponseSchema>
  | z.infer<typeof assistantProposeResponseSchema>
  | z.infer<typeof assistantWatchResponseSchema>;
