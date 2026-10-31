import { z } from "zod";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { agentProfileIdSchema } from "./agent";
import { machineIdSchema } from "./machine";
import {
  INFO_HUB_LIMITS,
  agentRunsViewSchema,
  chatMemberEntrySchema,
  chatRunAggregateSchema,
  infoHubChatSummarySchema,
  infoHubLeaseSummarySchema,
  infoHubMachineSummarySchema,
  infoHubRunSummarySchema,
  infoHubTaskSummarySchema,
  infoHubUniqueArray,
  projectAgentEntrySchema,
} from "./info-hub";

const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const instanceId = z.string().regex(appIdPattern(ID_PREFIXES.instance));
export const infoHubRevisionSchema = z.string().min(1).max(256);
export const infoHubCursorSchema = z.string().min(1).max(4096);
const pagination = {
  cursor: infoHubCursorSchema.optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(INFO_HUB_LIMITS.maxPageSize)
    .default(INFO_HUB_LIMITS.defaultPageSize),
};

export const infoHubQuerySchema = z.discriminatedUnion("view", [
  z.strictObject({
    view: z.literal("project"),
    section: z.enum(["agents", "chats", "tasks", "machines"]),
    ...pagination,
  }),
  z.strictObject({
    view: z.literal("chat"),
    chatId,
    section: z.enum(["summary", "members", "runs", "tasks", "machines"]),
    ...pagination,
  }),
  z.strictObject({
    view: z.literal("agent"),
    agentProfileId: agentProfileIdSchema,
    section: z.enum(["summary", "runs", "instances", "machines"]),
    ...pagination,
  }),
  z.strictObject({ view: z.literal("machine"), machineId: machineIdSchema }),
]);
export type InfoHubQuery = z.infer<typeof infoHubQuerySchema>;

/** Target profile IDs select an object; actor identity always comes from a live grant. */
export const infoHubGetInputSchema = z.union(
  infoHubQuerySchema.options.map((schema) => schema.extend({ projectId })),
);
export type InfoHubGetInput = z.infer<typeof infoHubGetInputSchema>;
export const infoHubToolInputSchemas = { sprout_info_hub_get: infoHubQuerySchema } as const;

export const infoHubAgentInstanceSchema = z
  .strictObject({
    instanceId,
    agentProfileId: agentProfileIdSchema,
    chatId,
    chatDisplayTitle: z.string(),
    chatKind: chatRunAggregateSchema.shape.kind,
    leases: infoHubUniqueArray(infoHubLeaseSummarySchema, (lease) => lease.machineId),
  })
  .refine(
    (value) =>
      value.leases.every(
        (lease) =>
          lease.holderInstanceId === value.instanceId &&
          (lease.holder === null ||
            (lease.holder.agentProfileId === value.agentProfileId &&
              lease.holder.chatId === value.chatId)),
      ),
    "Instance lease facts must refer to the same holder",
  );
export type InfoHubAgentInstance = z.infer<typeof infoHubAgentInstanceSchema>;

export const infoHubAgentSummarySchema = projectAgentEntrySchema;
export type InfoHubAgentSummary = z.infer<typeof infoHubAgentSummarySchema>;

export const agentInfoViewSchema = z
  .strictObject({
    projectId,
    agent: infoHubAgentSummarySchema,
    runs: agentRunsViewSchema,
    instances: infoHubUniqueArray(infoHubAgentInstanceSchema, (instance) => instance.instanceId),
  })
  .refine(
    (value) =>
      [...value.runs.active, ...value.runs.recent].every(
        (run) => run.agentProfileId === value.agent.agentProfileId,
      ) &&
      value.instances.every(
        (instance) =>
          instance.agentProfileId === value.agent.agentProfileId &&
          instance.leases.every((lease) => lease.projectId === value.projectId),
      ),
    "Agent facts must match this Project and profile",
  );
export type AgentInfoView = z.infer<typeof agentInfoViewSchema>;
export const machineInfoViewSchema = infoHubMachineSummarySchema;
export type MachineInfoView = z.infer<typeof machineInfoViewSchema>;

/** Parsed cursor data is checked after transport verification, before issuing a query. */
const cursorPayloadBaseSchema = z.strictObject({
  version: z.literal(1),
  projectId,
  actorScope: z.string().min(1).max(256),
  query: infoHubQuerySchema,
  revision: infoHubRevisionSchema,
  sort: z.literal("stable_id_asc"),
  after: z.string().min(1).max(256),
});
export const infoHubCursorPayloadSchema = cursorPayloadBaseSchema.refine(
  (value) => value.query.view !== "machine" && value.query.cursor === undefined,
  "Cursor payload holds its original range without recursive cursors",
);
export type InfoHubCursorPayload = z.infer<typeof infoHubCursorPayloadSchema>;
export const infoHubCursorValidationSchema = z
  .strictObject({
    cursor: infoHubCursorPayloadSchema,
    expected: cursorPayloadBaseSchema.omit({ after: true }),
  })
  .refine((value) => {
    const { cursor, expected } = value;
    return (
      cursor.projectId === expected.projectId &&
      cursor.actorScope === expected.actorScope &&
      cursor.revision === expected.revision &&
      cursor.sort === expected.sort &&
      JSON.stringify(cursor.query) === JSON.stringify(expected.query)
    );
  }, "Cursor must match the actor, Project, range, sort and revision");

const pageSchema = z.strictObject({
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  nextCursor: infoHubCursorSchema.nullable(),
});
const responseBase = { projectId, revision: infoHubRevisionSchema, asOf: z.iso.datetime() };
function listSection<V extends string, S extends string, T extends z.ZodType>(
  view: V,
  section: S,
  item: T,
  key: (value: z.infer<T>) => string,
) {
  return z.strictObject({
    ...responseBase,
    view: z.literal(view),
    section: z.literal(section),
    data: infoHubUniqueArray(item, key).max(INFO_HUB_LIMITS.maxPageSize),
    page: pageSchema,
  });
}

const chatScope = { chatId };
const agentScope = { agentProfileId: agentProfileIdSchema };
export const infoHubViewSchema = z
  .union([
    listSection("project", "agents", projectAgentEntrySchema, (agent) => agent.agentProfileId),
    listSection("project", "chats", infoHubChatSummarySchema, (chat) => chat.chatId),
    listSection("project", "tasks", infoHubTaskSummarySchema, (task) => task.taskId),
    listSection("project", "machines", infoHubMachineSummarySchema, (machine) => machine.machineId),
    z.strictObject({
      ...responseBase,
      ...chatScope,
      view: z.literal("chat"),
      section: z.literal("summary"),
      data: infoHubChatSummarySchema,
    }),
    listSection(
      "chat",
      "members",
      chatMemberEntrySchema,
      (member) => `${member.memberKind}:${member.memberId}`,
    ).extend(chatScope),
    listSection("chat", "runs", infoHubRunSummarySchema, (run) => run.runId).extend(chatScope),
    listSection("chat", "tasks", infoHubTaskSummarySchema, (task) => task.taskId).extend(chatScope),
    listSection(
      "chat",
      "machines",
      infoHubMachineSummarySchema,
      (machine) => machine.machineId,
    ).extend(chatScope),
    z.strictObject({
      ...responseBase,
      ...agentScope,
      view: z.literal("agent"),
      section: z.literal("summary"),
      data: infoHubAgentSummarySchema,
    }),
    listSection("agent", "runs", infoHubRunSummarySchema, (run) => run.runId).extend(agentScope),
    listSection(
      "agent",
      "instances",
      infoHubAgentInstanceSchema,
      (instance) => instance.instanceId,
    ).extend(agentScope),
    listSection(
      "agent",
      "machines",
      infoHubMachineSummarySchema,
      (machine) => machine.machineId,
    ).extend(agentScope),
    z.strictObject({
      ...responseBase,
      view: z.literal("machine"),
      machineId: machineIdSchema,
      data: machineInfoViewSchema,
    }),
  ])
  .superRefine((value, ctx) => {
    if (
      "page" in value &&
      (value.page.total < value.data.length ||
        (value.page.nextCursor !== null && value.data.length === 0))
    ) {
      ctx.addIssue({ code: "custom", message: "Page metadata must describe the returned facts" });
    }
    if (
      value.view === "chat" &&
      value.section === "summary" &&
      value.data.chatId !== value.chatId
    ) {
      ctx.addIssue({ code: "custom", message: "Chat summary identity mismatch" });
    }
    if (
      value.view === "agent" &&
      value.section === "summary" &&
      value.data.agentProfileId !== value.agentProfileId
    ) {
      ctx.addIssue({ code: "custom", message: "Agent summary identity mismatch" });
    }
    if (
      value.view === "machine" &&
      (value.data.projectId !== value.projectId || value.data.machineId !== value.machineId)
    ) {
      ctx.addIssue({ code: "custom", message: "Machine summary identity mismatch" });
    }
    if (Array.isArray(value.data)) {
      for (const item of value.data) {
        if ("leases" in item && item.leases.some((lease) => lease.projectId !== value.projectId)) {
          ctx.addIssue({
            code: "custom",
            message: "Instance leases must stay in the response Project",
          });
        }
        if (
          "lease" in item &&
          item.lease.holder !== null &&
          ((value.view === "chat" && item.lease.holder.chatId !== value.chatId) ||
            (value.view === "agent" && item.lease.holder.agentProfileId !== value.agentProfileId))
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Machine holder must match the requested Chat or Agent",
          });
        }
        if (
          ("projectId" in item && item.projectId !== value.projectId) ||
          (value.view === "chat" &&
            value.section !== "machines" &&
            "chatId" in item &&
            item.chatId !== value.chatId) ||
          (value.view === "agent" &&
            "agentProfileId" in item &&
            item.agentProfileId !== value.agentProfileId)
        ) {
          ctx.addIssue({
            code: "custom",
            message: "Response facts must match their requested range",
          });
        }
      }
    }
    if (
      new TextEncoder().encode(JSON.stringify(value)).byteLength > INFO_HUB_LIMITS.maxResponseBytes
    ) {
      ctx.addIssue({ code: "custom", message: "Info Hub response exceeds its UTF-8 budget" });
    }
  });
export type InfoHubView = z.infer<typeof infoHubViewSchema>;

export const infoHubRefreshInputSchema = z.strictObject({
  projectId,
  query: infoHubQuerySchema,
  knownRevision: infoHubRevisionSchema.optional(),
});
export const infoHubRefreshResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("changed"), view: infoHubViewSchema }),
  z.strictObject({ kind: z.literal("unchanged"), ...responseBase, query: infoHubQuerySchema }),
]);
export type InfoHubRefreshInput = z.infer<typeof infoHubRefreshInputSchema>;
export type InfoHubRefreshResult = z.infer<typeof infoHubRefreshResultSchema>;
