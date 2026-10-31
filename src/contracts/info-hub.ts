import { z } from "zod";
import { chatAutomationModeSchema } from "./chat-automation";
import { wakeEvaluationErrorCodeSchema } from "./wake-evaluation";
import { leaseViewSchema } from "./lease";
import { machineConnectionViewSchema, machineIdSchema } from "./machine";
import { AGENT_RUN_STATUSES, runIdSchema } from "./agent-run";
import { agentProfileIdSchema } from "./agent";
import { chatKindSchema, chatOwnerSchema } from "./chat";
import { appIdPattern, ID_PREFIXES } from "./ids";
import { REPO_SOURCE_KINDS } from "./repository";
import type { FieldErrors } from "./project";
import type { AppResult } from "./result";
import {
  taskContextSchema,
  taskIdSchema,
  taskRecordRefSchema,
  taskResponsibilitySchema,
  taskStatusSchema,
} from "./task";

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

const runId = runIdSchema;

export const INFO_HUB_LIMITS = {
  defaultPageSize: 25,
  maxPageSize: 100,
  maxResponseBytes: 65_536,
  maxTurnContextBytes: 8_192,
  maxHintBytes: 1_024,
  hintMergeWindowMs: 2_000,
  hintMinimumIntervalMs: 5_000,
} as const;

/** A visible page owns one request; visibility restoration discards its cursor. */
export const INFO_HUB_POLLING = {
  intervalMs: 3_000,
  maxBackoffMs: 30_000,
  maxInFlight: 1,
  pauseWhenHidden: true,
  refreshImmediatelyOnVisible: true,
  fullRefreshOnResume: true,
  backoffMultiplier: 2,
  jitterRatio: 0.1,
  requestTimeoutMs: 10_000,
  pauseWhenOffline: true,
  abortOnScopeChange: true,
} as const;

export const infoHubAgentStatusSchema = z.enum(["idle", "queued", "running", "error"]);
export type InfoHubAgentStatus = z.infer<typeof infoHubAgentStatusSchema>;
export const infoHubAgentErrorSchema = z.strictObject({
  runId,
  chatId,
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2000),
});
export type InfoHubAgentError = z.infer<typeof infoHubAgentErrorSchema>;
const agentStateFields = {
  status: infoHubAgentStatusSchema,
  error: infoHubAgentErrorSchema.nullable(),
};

export function infoHubUniqueArray<T extends z.ZodType>(
  item: T,
  key: (value: z.infer<T>) => string,
) {
  return z.array(item).refine((items) => new Set(items.map(key)).size === items.length, {
    message: "Info Hub fact keys must be unique",
  });
}

/** machine_lease joined to agent_instance/profile/chat; never an operation grant. */
export const infoHubLeaseSummarySchema = leaseViewSchema
  .safeExtend({
    holderResolution: z.enum(["none", "resolved", "unknown"]),
    holder: z
      .strictObject({
        instanceId,
        agentProfileId: agentProfileIdSchema,
        displayName: z.string().min(1),
        chatId,
        chatDisplayTitle: z.string(),
        chatKind: chatKindSchema,
      })
      .nullable(),
  })
  .superRefine((value, ctx) => {
    if (
      (value.holderInstanceId === null) !== (value.holderResolution === "none") ||
      (value.holder !== null) !== (value.holderResolution === "resolved") ||
      (value.holder !== null && value.holder.instanceId !== value.holderInstanceId)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Lease holder resolution must preserve its stored identity",
      });
    }
  });
export type InfoHubLeaseSummary = z.infer<typeof infoHubLeaseSummarySchema>;

const leaseSummaries = infoHubUniqueArray(
  infoHubLeaseSummarySchema,
  (lease) => `${lease.projectId}:${lease.machineId}`,
);

/** machine + connection generation, scoped by project_machine; no root/capability. */
export const infoHubMachineSummarySchema = z
  .strictObject({
    projectId,
    machineId: machineIdSchema,
    name: z.string().min(1),
    description: z.string().max(500),
    projectMembership: z.enum(["current", "removed"]),
    connection: z.union([
      machineConnectionViewSchema,
      z.strictObject({ kind: z.literal("unknown") }),
    ]),
    lease: infoHubLeaseSummarySchema,
  })
  .refine(
    (value) =>
      value.projectId === value.lease.projectId && value.machineId === value.lease.machineId,
    "Machine and lease must share their Project and Machine key",
  );
export type InfoHubMachineSummary = z.infer<typeof infoHubMachineSummarySchema>;

/** 本次分析的仓库依据：来自 repo_provenance 实值，commit 必须是 git rev-parse 的完整 SHA。 */
export const infoHubRunRepoSchema = z.strictObject({
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
export const infoHubRunSummarySchema = z.strictObject({
  runId,
  chatId,
  instanceId,
  agentProfileId: agentProfileIdSchema,
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
export const agentRunsViewSchema = z.strictObject({
  available: z.literal(true),
  hostEnabled: z.boolean(),
  active: infoHubUniqueArray(
    infoHubRunSummarySchema.refine((run) => run.status === "queued" || run.status === "running"),
    (run) => run.runId,
  ),
  recent: infoHubUniqueArray(infoHubRunSummarySchema, (run) => run.runId),
});
export type AgentRunsView = z.infer<typeof agentRunsViewSchema>;

/** Project → Agents 视角中的单个成员：profile 身份加本 Project 内已建立的 DM 与分身。 */
export const projectAgentEntrySchema = z
  .strictObject({
    ...agentStateFields,
    agentProfileId: agentProfileIdSchema,
    name: z.string().min(1),
    jobTitle: z.string().max(40).optional(),
    instanceId: instanceId.optional(),
    chatId: chatId.optional(),
  })
  .refine(
    (value) => (value.status === "error") === (value.error !== null),
    "Error status must name its source run error",
  );
export type ProjectAgentEntry = z.infer<typeof projectAgentEntrySchema>;

export const projectAgentsViewSchema = z.strictObject({
  agents: infoHubUniqueArray(projectAgentEntrySchema, (agent) => agent.agentProfileId),
  runs: agentRunsViewSchema,
});
export type ProjectAgentsView = z.infer<typeof projectAgentsViewSchema>;

/**
 * 会话聚合里的 run 状态分布：只列出真实出现过的状态，顺序固定按 `AGENT_RUN_STATUSES`，
 * 便于渲染与断言，不用「缺席即 0」的稀疏对象。
 */
export const chatRunStatusCountSchema = z.strictObject({
  status: z.enum(AGENT_RUN_STATUSES),
  count: z.number().int().min(1),
});
export type ChatRunStatusCount = z.infer<typeof chatRunStatusCountSchema>;

export const taskCountsSchema = z.strictObject({
  proposed: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  assigned: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  finished: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  canceled: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});
export type TaskCounts = z.infer<typeof taskCountsSchema>;

export const infoHubTaskSummarySchema = z.strictObject({
  taskId: taskIdSchema,
  title: z.string().trim().min(1).max(120),
  status: taskStatusSchema,
  revision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  chatId: chatId.optional(),
  chatKind: chatKindSchema.optional(),
  chatDisplayTitle: z.string().optional(),
  responsibility: taskResponsibilitySchema.optional(),
  checklistTotal: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  checklistChecked: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  recordCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  lastRecordRef: taskRecordRefSchema.optional(),
  previousCompletionRef: taskRecordRefSchema.optional(),
  updatedAt: z.iso.datetime(),
  context: taskContextSchema,
});
export type InfoHubTaskSummary = z.infer<typeof infoHubTaskSummarySchema>;

export const chatTasksViewSchema = z.strictObject({
  available: z.literal(true),
  items: infoHubUniqueArray(infoHubTaskSummarySchema, (task) => task.taskId),
});
export type ChatTasksView = z.infer<typeof chatTasksViewSchema>;
export const projectTasksInfoHubViewSchema = chatTasksViewSchema.extend({
  counts: taskCountsSchema,
});
export type ProjectTasksInfoHubView = z.infer<typeof projectTasksInfoHubViewSchema>;

/** P6a summary only; the full automation read view is a separate authorized query. */
export const chatAutomationSummarySchema = z
  .strictObject({
    mode: chatAutomationModeSchema,
    epoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    nextDueAt: z.iso.datetime().nullable(),
    lastDecision: z.enum(["continue", "do_not_continue", "indeterminate"]).nullable(),
    attentionCode: wakeEvaluationErrorCodeSchema.nullable(),
    remindedHuman: z.boolean(),
  })
  .refine(
    (value) => value.mode === "enabled" || value.nextDueAt === null,
    "Disabled automation has no executable schedule",
  );
export type ChatAutomationSummary = z.infer<typeof chatAutomationSummarySchema>;

/**
 * 会话聚合读模型：Info Hub 的 run 列表按会话聚合。
 *
 * - `agentCount` 按 `agent_profile_id` 去重，同一 Agent 的多条 run 只计 1 个；
 * - `statusCounts` 覆盖该会话的全部 run（不只活跃与最近那几条）；
 * - `displayTitle` 用 `chatDisplayTitle` 同一条规则：频道固定文案，其余标题优先、再回落分身名；
 * - 不做分页与缓存，也不在一次读里按会话二次查库（N+1 收敛与分页归 P6，followups 已记）。
 */
export const chatRunAggregateSchema = z.object({
  automation: chatAutomationSummarySchema.optional(),
  taskCounts: taskCountsSchema,
  assignedTaskIds: infoHubUniqueArray(taskIdSchema, (id) => id),
  chatId,
  kind: chatKindSchema,
  displayTitle: z.string(),
  agentCount: z.number().int().min(0),
  statusCounts: infoHubUniqueArray(chatRunStatusCountSchema, (count) => count.status),
  /** 该会话当前排队中或运行中的 run id，供页面沿会话继续看详情。 */
  activeRunIds: infoHubUniqueArray(runId, (id) => id),
  /** 该会话最近一条 run 的排队时间；还没有 run 时缺省。 */
  latestRunAt: z.iso.datetime().optional(),
});
export type ChatRunAggregate = z.infer<typeof chatRunAggregateSchema>;

export const chatMemberEntrySchema = z.discriminatedUnion("memberKind", [
  z.strictObject({
    memberKind: z.literal("human"),
    memberId: z.string().min(1),
    displayName: z.string(),
  }),
  z
    .strictObject({
      memberKind: z.literal("agent"),
      memberId: agentProfileIdSchema,
      displayName: z.string(),
      ...agentStateFields,
    })
    .refine(
      (value) => (value.status === "error") === (value.error !== null),
      "Error status must name its source run error",
    ),
]);
export type ChatMemberEntry = z.infer<typeof chatMemberEntrySchema>;

export const chatInstanceViewSchema = z
  .strictObject({
    instanceId,
    agentProfileId: agentProfileIdSchema,
    profileName: z.string(),
    leases: leaseSummaries,
  })
  .refine(
    (value) =>
      value.leases.every(
        (lease) =>
          lease.holderInstanceId === value.instanceId &&
          (lease.holder === null || lease.holder.agentProfileId === value.agentProfileId),
      ),
    "Instance leases must identify their actual holder",
  );

/** Chat → 自身与成员视角：归属、成员、分身、消息统计与真实 run 视角。 */
export const chatInfoViewSchema = z
  .strictObject({
    automation: chatAutomationSummarySchema.optional(),
    chatId,
    projectId,
    kind: chatKindSchema,
    archived: z.boolean(),
    members: infoHubUniqueArray(
      chatMemberEntrySchema,
      (member) => `${member.memberKind}:${member.memberId}`,
    ),
    owner: chatOwnerSchema.strict(),
    instances: infoHubUniqueArray(chatInstanceViewSchema, (instance) => instance.instanceId),
    messages: z.strictObject({
      count: z.number().int().min(0),
      latestAt: z.iso.datetime().optional(),
    }),
    runs: agentRunsViewSchema,
    tasks: chatTasksViewSchema,
  })
  .refine(
    (value) =>
      value.instances.every((instance) =>
        instance.leases.every(
          (lease) =>
            lease.projectId === value.projectId &&
            (lease.holder === null || lease.holder.chatId === value.chatId),
        ),
      ) && [...value.runs.active, ...value.runs.recent].every((run) => run.chatId === value.chatId),
    "Chat facts must remain in this Chat and Project",
  );
export type ChatInfoView = z.infer<typeof chatInfoViewSchema>;

/**
 * 轮初必要上下文的工作副本依据。
 * `run_provenance` 来自活动 run 的 repo_provenance（含该轮 fresh）；
 * `project_checkout` 来自 repo_checkout 的最近一次就绪状态（尚无该轮 fresh 事实，故省略）。
 */
export const turnWorkspaceSchema = z.strictObject({
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

export const infoHubTurnTaskSummarySchema = infoHubTaskSummarySchema.pick({
  taskId: true,
  title: true,
  status: true,
  revision: true,
  responsibility: true,
});
export type InfoHubTurnTaskSummary = z.infer<typeof infoHubTurnTaskSummarySchema>;

export const infoHubPendingLeaseRequestSchema = z.strictObject({
  projectId,
  machineId: machineIdSchema,
  mutationId: z.string().regex(appIdPattern(ID_PREFIXES.leaseMutation)),
  action: z.enum(["release", "handoff", "reclaim"]),
  state: z.literal("pending"),
  createdAt: z.iso.datetime(),
});
export type InfoHubPendingLeaseRequest = z.infer<typeof infoHubPendingLeaseRequestSchema>;

/** runId is the snapshot key; submission confirms only the SDK boundary. */
export const turnStartContextSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    runId,
    capturedAt: z.iso.datetime(),
    basisRevision: z.string().min(1).max(256),
    serializedText: z
      .string()
      .min(1)
      .refine(
        (text) => new TextEncoder().encode(text).byteLength <= INFO_HUB_LIMITS.maxTurnContextBytes,
        "Turn context exceeds its UTF-8 budget",
      ),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    deliveryState: z.enum(["prepared", "submitted", "failed"]),
    submittedAt: z.iso.datetime().nullable(),
    failureCode: z
      .enum(["serialization_failed", "persistence_failed", "submission_failed"])
      .nullable(),
    truncated: z.boolean(),
    omittedCounts: z.strictObject({
      members: z.number().int().nonnegative(),
      runs: z.number().int().nonnegative(),
      tasks: z.number().int().nonnegative(),
      leases: z.number().int().nonnegative(),
      pendingLeaseRequests: z.number().int().nonnegative(),
    }),
    projectId,
    chatId,
    instanceId,
    agentProfileId: agentProfileIdSchema,
    profileName: z.string().min(1),
    projectName: z.string().min(1),
    chatTitle: z.string(),
    chatKind: chatKindSchema,
    chatArchived: z.boolean(),
    automation: chatAutomationSummarySchema.optional(),
    owner: chatOwnerSchema.strict(),
    members: infoHubUniqueArray(
      chatMemberEntrySchema,
      (member) => `${member.memberKind}:${member.memberId}`,
    ),
    status: infoHubAgentStatusSchema,
    heldMachines: infoHubUniqueArray(infoHubMachineSummarySchema, (machine) => machine.machineId),
    pendingLeaseRequests: infoHubUniqueArray(
      infoHubPendingLeaseRequestSchema,
      (request) => request.mutationId,
    ),
    taskCounts: taskCountsSchema,
    projectSummary: z.strictObject({
      agentCount: z.number().int().nonnegative(),
      chatCount: z.number().int().nonnegative(),
      machineCount: z.number().int().nonnegative(),
    }),
    chatRuns: infoHubUniqueArray(
      infoHubRunSummarySchema
        .pick({ runId: true, chatId: true, instanceId: true, agentProfileId: true, status: true })
        .extend({ isSelf: z.boolean(), status: z.enum(["queued", "running"]) }),
      (run) => run.runId,
    ),
    tasks: infoHubUniqueArray(infoHubTurnTaskSummarySchema, (task) => task.taskId),
    hostEnabled: z.boolean(),
    workspace: turnWorkspaceSchema.nullable(),
    activeRun: z.strictObject({
      runId,
      status: z.enum(["queued", "running"]),
      pendingInputs: z.number().int().min(0),
    }),

    injectedIntoPrompt: z.boolean(),
  })
  .superRefine((value, ctx) => {
    const submitted = value.deliveryState === "submitted";
    if (
      value.injectedIntoPrompt !== submitted ||
      (value.submittedAt !== null) !== submitted ||
      (value.failureCode !== null) !== (value.deliveryState === "failed")
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Injection must have a submitted receipt; prepared/failed is not injected",
      });
    }
    if (
      value.chatRuns.some(
        (run) =>
          run.chatId !== value.chatId ||
          run.isSelf !==
            (run.runId === value.runId &&
              run.instanceId === value.instanceId &&
              run.agentProfileId === value.agentProfileId),
      ) ||
      value.chatRuns.filter((run) => run.isSelf).length !== 1
    ) {
      ctx.addIssue({
        code: "custom",
        message: "The current run must be explicitly identified among this Chat's active runs",
      });
    }
    if (
      value.runId !== value.activeRun.runId ||
      value.pendingLeaseRequests.some((request) => request.projectId !== value.projectId) ||
      value.heldMachines.some(
        (machine) =>
          machine.projectId !== value.projectId ||
          machine.lease.holderInstanceId !== value.instanceId ||
          (machine.lease.holder !== null &&
            (machine.lease.holder.agentProfileId !== value.agentProfileId ||
              machine.lease.holder.chatId !== value.chatId)),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Snapshot identity must come from its run and its held leases",
      });
    }
    if (
      Object.values(value.omittedCounts).some((count) => count > 0) !== value.truncated ||
      (value.submittedAt !== null && Date.parse(value.submittedAt) < Date.parse(value.capturedAt))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Snapshot truncation or submission time is inconsistent",
      });
    }
  });
export type TurnStartContext = z.infer<typeof turnStartContextSchema>;

export const infoHubChatSummarySchema = chatRunAggregateSchema.strict().extend({
  archived: z.boolean(),
  owner: chatOwnerSchema.strict(),
  memberCount: z.number().int().nonnegative(),
});
export type InfoHubChatSummary = z.infer<typeof infoHubChatSummarySchema>;

export const projectInfoHubSchema = z
  .strictObject({
    projectId,
    projectName: z.string().min(1),
    tasks: projectTasksInfoHubViewSchema,
    agents: projectAgentsViewSchema,
    /** run 列表按会话聚合（P5a 多 Agent 会话视角）；一个 Project 的每个会话一条。 */
    chats: infoHubUniqueArray(infoHubChatSummarySchema, (chat) => chat.chatId),
    machines: infoHubUniqueArray(infoHubMachineSummarySchema, (machine) => machine.machineId),
    leases: z.strictObject({ available: z.literal(true), items: leaseSummaries.max(1000) }),
  })
  .refine(
    (value) =>
      value.machines.every((machine) => machine.projectId === value.projectId) &&
      value.leases.items.every((lease) => lease.projectId === value.projectId),
    "Project facts cannot include another Project's Machines or leases",
  );
export type ProjectInfoHub = z.infer<typeof projectInfoHubSchema>;

export type InfoHubResult<T> = AppResult<T> & { fieldErrors?: FieldErrors };
