import { z } from "zod";
import { agentProfileIdSchema } from "./agent";
import { appIdPattern, ID_PREFIXES } from "./ids";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const conversationId = z.string().regex(appIdPattern(ID_PREFIXES.conversation));
const instanceId = z.string().regex(appIdPattern(ID_PREFIXES.instance));

/** 未实现的视角用显式标记表达；P3/P4 接入后该字段扩展为「不可用 | 可用视图」的联合。 */
export const unavailableFeatureSchema = z.object({
  available: z.literal(false),
  reason: z.string().min(1),
});
export type UnavailableFeature = z.infer<typeof unavailableFeatureSchema>;

export const RUNS_UNAVAILABLE_REASON =
  "Agent status 与活动 run 列表依赖 P3 的 agent-run 记录；P2 没有 run，本视角未实现，不以空列表或 0 值呈现。";
export const MACHINES_UNAVAILABLE_REASON =
  "Machine 连接状态与租约视角属于 P4；P2 没有 Machine 对象，本视角未实现，不以空机器列表呈现。";

/** Project → Agents 视角中的单个成员：profile 身份加本 Project 内已建立的 DM 与分身。 */
export const projectAgentEntrySchema = z.object({
  agentProfileId: agentProfileIdSchema,
  name: z.string(),
  personaSummary: z.string(),
  instanceId: instanceId.optional(),
  conversationId: conversationId.optional(),
});
export type ProjectAgentEntry = z.infer<typeof projectAgentEntrySchema>;

export const projectAgentsViewSchema = z.object({
  agents: z.array(projectAgentEntrySchema),
  runs: unavailableFeatureSchema,
});
export type ProjectAgentsView = z.infer<typeof projectAgentsViewSchema>;

export const conversationMemberEntrySchema = z.object({
  memberKind: z.enum(["human", "agent"]),
  memberId: z.string().min(1),
  displayName: z.string(),
});
export type ConversationMemberEntry = z.infer<typeof conversationMemberEntrySchema>;

export const conversationInstanceViewSchema = z.object({
  instanceId,
  agentProfileId: agentProfileIdSchema,
  profileName: z.string(),
});

/** Conversation → 自身与成员视角：归属、成员、分身、消息统计与 run 的显式不可用标记。 */
export const conversationInfoViewSchema = z.object({
  conversationId,
  projectId,
  kind: z.literal("dm"),
  archived: z.boolean(),
  members: z.array(conversationMemberEntrySchema),
  instance: conversationInstanceViewSchema.nullable(),
  messages: z.object({
    count: z.number().int().min(0),
    latestAt: z.iso.datetime().optional(),
  }),
  runs: unavailableFeatureSchema,
});
export type ConversationInfoView = z.infer<typeof conversationInfoViewSchema>;

export const projectInfoHubSchema = z.object({
  projectId,
  agents: projectAgentsViewSchema,
  machines: unavailableFeatureSchema,
});
export type ProjectInfoHub = z.infer<typeof projectInfoHubSchema>;

export type InfoHubResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
