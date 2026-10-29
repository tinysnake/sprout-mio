import { z } from "zod";
import { leaseViewSchema } from "./lease";
import { machineDetailSchema } from "./machine";
import { AGENT_RUN_STATUSES } from "./agent-run";
import { agentProfileIdSchema } from "./agent";
import { chatKindSchema, chatOwnerSchema } from "./chat";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { REPO_SOURCE_KINDS } from "./repository";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";

const projectId = z.string().regex(appIdPattern(ID_PREFIXES.project));
const chatId = z.string().regex(appIdPattern(ID_PREFIXES.chat));
const instanceId = z.string().regex(appIdPattern(ID_PREFIXES.instance));

/** 未实现的视角用显式标记表达；P3/P4 接入后该字段扩展为「不可用 | 可用视图」的联合。 */
export const unavailableFeatureSchema = z.object({
  available: z.literal(false),
  reason: z.string().min(1),
});
export type UnavailableFeature = z.infer<typeof unavailableFeatureSchema>;

export const LEASES_UNAVAILABLE_REASON = "Machine 租约尚未实现，P4b。";

const runId = z
  .string()
  .regex(/^run_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

/** 本次分析的仓库依据：来自 repo_provenance 实值，commit 必须是 git rev-parse 的完整 SHA。 */
export const infoHubRunRepoSchema = z.object({
  source: z.string().min(1),
  sourceKind: z.enum(REPO_SOURCE_KINDS),
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/, "commit 必须是 git rev-parse 的完整 SHA"),
  fresh: z.boolean(),
  recordedAt: z.iso.datetime(),
  fetchedAt: z.iso.datetime().optional(),
});
export type InfoHubRunRepo = z.infer<typeof infoHubRunRepoSchema>;

/** 最近若干 run 的运行事实；pendingInputs 只统计未投递输入。 */
export const infoHubRunSummarySchema = z.object({
  runId,
  status: z.enum(AGENT_RUN_STATUSES),
  queuedAt: z.iso.datetime(),
  startedAt: z.iso.datetime().optional(),
  settledAt: z.iso.datetime().optional(),
  requestId: z.string().min(1),
  pendingInputs: z.number().int().min(0),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  /** 本轮回报的助手消息；run 未正常完成时没有归属，字段缺省。 */
  assistantMessageId: z.string().optional(),
  repo: infoHubRunRepoSchema.optional(),
});
export type InfoHubRunSummary = z.infer<typeof infoHubRunSummarySchema>;

/** run 视角（P3 已实现）：宿主启用状态、活动 run 与最近 run，全部来自领域查询。 */
export const agentRunsViewSchema = z.object({
  available: z.literal(true),
  hostEnabled: z.boolean(),
  active: z.array(infoHubRunSummarySchema),
  recent: z.array(infoHubRunSummarySchema),
});
export type AgentRunsView = z.infer<typeof agentRunsViewSchema>;

/** Project → Agents 视角中的单个成员：profile 身份加本 Project 内已建立的 DM 与分身。 */
export const projectAgentEntrySchema = z.object({
  agentProfileId: agentProfileIdSchema,
  name: z.string(),
  personaSummary: z.string(),
  instanceId: instanceId.optional(),
  chatId: chatId.optional(),
});
export type ProjectAgentEntry = z.infer<typeof projectAgentEntrySchema>;

export const projectAgentsViewSchema = z.object({
  agents: z.array(projectAgentEntrySchema),
  runs: agentRunsViewSchema,
});
export type ProjectAgentsView = z.infer<typeof projectAgentsViewSchema>;

/**
 * 会话聚合里的 run 状态分布：只列出真实出现过的状态，顺序固定按 `AGENT_RUN_STATUSES`，
 * 便于渲染与断言，不用「缺席即 0」的稀疏对象。
 */
export const chatRunStatusCountSchema = z.object({
  status: z.enum(AGENT_RUN_STATUSES),
  count: z.number().int().min(1),
});
export type ChatRunStatusCount = z.infer<typeof chatRunStatusCountSchema>;

/**
 * 会话聚合读模型：Info Hub 的 run 列表按会话聚合。
 *
 * - `agentCount` 按 `agent_profile_id` 去重，同一 Agent 的多条 run 只计 1 个；
 * - `statusCounts` 覆盖该会话的全部 run（不只活跃与最近那几条）；
 * - `displayTitle` 用 `chatDisplayTitle` 同一条规则：频道固定文案，其余标题优先、再回落分身名；
 * - 不做分页与缓存，也不在一次读里按会话二次查库（N+1 收敛与分页归 P6，followups 已记）。
 */
export const chatRunAggregateSchema = z.object({
  chatId,
  kind: chatKindSchema,
  displayTitle: z.string(),
  agentCount: z.number().int().min(0),
  statusCounts: z.array(chatRunStatusCountSchema),
  /** 该会话当前排队中或运行中的 run id，供页面沿会话继续看详情。 */
  activeRunIds: z.array(runId),
  /** 该会话最近一条 run 的排队时间；还没有 run 时缺省。 */
  latestRunAt: z.iso.datetime().optional(),
});
export type ChatRunAggregate = z.infer<typeof chatRunAggregateSchema>;

export const chatMemberEntrySchema = z.object({
  memberKind: z.enum(["human", "agent"]),
  memberId: z.string().min(1),
  displayName: z.string(),
});
export type ChatMemberEntry = z.infer<typeof chatMemberEntrySchema>;

export const chatInstanceViewSchema = z.object({
  instanceId,
  agentProfileId: agentProfileIdSchema,
  profileName: z.string(),
});

/** Chat → 自身与成员视角：归属、成员、分身、消息统计与真实 run 视角。 */
export const chatInfoViewSchema = z.object({
  chatId,
  projectId,
  kind: chatKindSchema,
  archived: z.boolean(),
  members: z.array(chatMemberEntrySchema),
  owner: chatOwnerSchema,
  instances: z.array(chatInstanceViewSchema),
  messages: z.object({
    count: z.number().int().min(0),
    latestAt: z.iso.datetime().optional(),
  }),
  runs: agentRunsViewSchema,
});
export type ChatInfoView = z.infer<typeof chatInfoViewSchema>;

/**
 * 轮初必要上下文的工作副本依据。
 * `run_provenance` 来自活动 run 的 repo_provenance（含该轮 fresh）；
 * `project_checkout` 来自 repo_checkout 的最近一次就绪状态（尚无该轮 fresh 事实，故省略）。
 */
export const turnWorkspaceSchema = z.object({
  basis: z.enum(["run_provenance", "project_checkout"]),
  path: z.string().min(1),
  source: z.string().min(1),
  sourceKind: z.enum(REPO_SOURCE_KINDS),
  ref: z.string().min(1),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/, "commit 必须是 git rev-parse 的完整 SHA"),
  fresh: z.boolean().optional(),
  recordedAt: z.iso.datetime().optional(),
  fetchedAt: z.iso.datetime().optional(),
});
export type TurnWorkspace = z.infer<typeof turnWorkspaceSchema>;

/**
 * 轮初必要上下文：这个分身在这一轮开始时需要知道什么。
 * `injectedIntoPrompt` 固定为 false：本 unit 不把该上下文注入模型 prompt，
 * 它只是给人与后续 P6 查询的上下文来源；注入时该字段与类型必须显式扩展并配真实模型断言。
 */
export const turnStartContextSchema = z.object({
  projectId,
  chatId,
  instanceId: instanceId.nullable(),
  agentProfileId: agentProfileIdSchema.nullable(),
  profileName: z.string().nullable(),
  hostEnabled: z.boolean(),
  workspace: turnWorkspaceSchema.nullable(),
  activeRun: z
    .object({
      runId,
      status: z.enum(AGENT_RUN_STATUSES),
      pendingInputs: z.number().int().min(0),
    })
    .nullable(),
  previousRun: z
    .object({
      runId,
      status: z.enum(AGENT_RUN_STATUSES),
      requestId: z.string().min(1),
      settledAt: z.iso.datetime().optional(),
      errorCode: z.string().optional(),
      errorMessage: z.string().optional(),
    })
    .nullable(),
  injectedIntoPrompt: z.literal(false),
});
export type TurnStartContext = z.infer<typeof turnStartContextSchema>;

export const projectInfoHubSchema = z.object({
  projectId,
  agents: projectAgentsViewSchema,
  /** run 列表按会话聚合（P5a 多 Agent 会话视角）；一个 Project 的每个会话一条。 */
  chats: z.array(chatRunAggregateSchema),
  machines: z.array(machineDetailSchema),
  leases: z.strictObject({ available: z.literal(true), items: z.array(leaseViewSchema).max(1000) }),
});
export type ProjectInfoHub = z.infer<typeof projectInfoHubSchema>;

export type InfoHubResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
