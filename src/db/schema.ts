import { sql } from "drizzle-orm";
import {
  blob,
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { AGENT_RUN_STATUSES } from "../contracts/agent-run";
import type { RunConfigSnapshot } from "../contracts/agent-run";
import { DIAGNOSTIC_LEVELS } from "../contracts/diagnostics";
import type { CapabilitySnapshot } from "../contracts/machine";
import {
  EXECUTION_LOG_STATES,
  REMOTE_EXECUTION_STATES,
  EXECUTION_RECOVERY_REASONS,
  REMOTE_FAILURE_REASONS,
  REMOTE_OUTCOMES,
  CANCELLATION_FAILURE_REASONS,
  CANCELLATION_SIGNAL_OUTCOMES,
  CANCELLATION_STATES,
} from "../contracts/remote";
import type { RemoteOperation, RemoteResultPayload } from "../contracts/remote";
import { MEMBERSHIP_STATES } from "../contracts/membership";
import { RUN_RESOURCE_NOTICE_KINDS } from "../contracts/notice";
import type { RunResourceNoticePayload } from "../contracts/notice";
import type { McpConfig } from "../contracts/mcp";
import type { WorkerExchangeResponse } from "../contracts/worker";

export * from "./auth-schema";

export const project = sqliteTable(
  "project",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [uniqueIndex("project_id_owner_unique").on(table.id, table.createdBy)],
);

export const agentProfile = sqliteTable("agent_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  jobTitle: text("job_title"),
  persona: text("persona").notNull().default(""),
  harness: text("harness", { enum: ["pi"] })
    .notNull()
    .default("pi"),
  model: text("model"),
  effort: text("effort"),
  createdBy: text("created_by")
    .notNull()
    .references(() => user.id),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const projectProfile = sqliteTable("project_profile", {
  projectId: text("project_id")
    .primaryKey()
    .references(() => project.id),
  gitRemote: text("git_remote"),
  defaultBranch: text("default_branch").notNull().default("main"),
  workDirectory: text("work_directory"),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const projectMember = sqliteTable(
  "project_member",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    addedBy: text("added_by")
      .notNull()
      .references(() => user.id),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [primaryKey({ columns: [table.projectId, table.agentProfileId] })],
);

export const chat = sqliteTable(
  "chat",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    kind: text("kind", { enum: ["dm", "group", "public_channel"] }).notNull(),
    title: text("title"),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
    ownerKind: text("owner_kind", { enum: ["human", "agent"] }).notNull(),
    ownerId: text("owner_id").notNull(),
    wakePolicy: text("wake_policy", { enum: ["mention_only", "owner_led", "contextual"] })
      .notNull()
      .default("owner_led"),
    governanceRevision: integer("governance_revision").notNull().default(0),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check("chat_kind_check", sql`${table.kind} in ('dm', 'group', 'public_channel')`),
    check(
      "chat_title_check",
      sql`${table.title} is null or length(trim(${table.title})) between 1 and 80`,
    ),
    check("chat_owner_kind_check", sql`${table.ownerKind} in ('human', 'agent')`),
    check("chat_owner_id_check", sql`length(trim(${table.ownerId})) > 0`),
    check(
      "chat_wake_policy_check",
      sql`${table.wakePolicy} in ('mention_only', 'owner_led', 'contextual')`,
    ),
    check(
      "chat_governance_revision_check",
      sql`typeof(${table.governanceRevision}) = 'integer' and ${table.governanceRevision} >= 0`,
    ),
    // DM 的所有者只能是创建它的人；群与频道的所有者可以是分身，由 p5a-groups 校验参与权。
    check(
      "chat_dm_owner_check",
      sql`${table.kind} <> 'dm' or (${table.ownerKind} = 'human' and ${table.ownerId} = ${table.createdBy})`,
    ),
    check(
      "chat_public_channel_archived_check",
      sql`${table.kind} <> 'public_channel' or ${table.archivedAt} is null`,
    ),
    uniqueIndex("chat_id_project_unique").on(table.id, table.projectId),
    uniqueIndex("chat_public_channel_project_unique")
      .on(table.projectId)
      .where(sql`${table.kind} = 'public_channel'`),
    index("chat_project_updated_idx").on(table.projectId, table.updatedAt, table.id),
    index("chat_project_owner_idx").on(table.projectId, table.ownerKind, table.ownerId),
  ],
);

export const chatMember = sqliteTable(
  "chat_member",
  {
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id),
    memberKind: text("member_kind", { enum: ["human", "agent"] }).notNull(),
    memberId: text("member_id").notNull(),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.memberKind, table.memberId] }),
    check("chat_member_kind_check", sql`${table.memberKind} in ('human', 'agent')`),
    check("chat_member_id_check", sql`length(trim(${table.memberId})) > 0`),
    index("chat_member_identity_idx").on(table.memberKind, table.memberId, table.chatId),
  ],
);

/**
 * 成员唯一真值读视图：DM 与 Group 取 `chat_member`，Public Channel 从 `project_member`
 * 与 `project.created_by` 当场派生，不给成员表复制 kind/project 事实。
 * Group 的 Agent 行只在仍属本项目时存在，移出后同一读即消失；Human 行不受 project_member 限制。
 */
export const chatEffectiveMember = sqliteView("chat_effective_member", {
  chatId: text("chat_id").notNull(),
  projectId: text("project_id").notNull(),
  memberKind: text("member_kind", { enum: ["human", "agent"] }).notNull(),
  memberId: text("member_id").notNull(),
  addedAt: integer("added_at", { mode: "timestamp" }).notNull(),
  source: text("source", { enum: ["chat_member", "project_member", "project_owner"] }).notNull(),
}).as(sql`
  SELECT
    c.id AS chat_id,
    c.project_id,
    cm.member_kind,
    cm.member_id,
    cm.added_at,
    'chat_member' AS source
  FROM chat c
  JOIN chat_member cm ON cm.chat_id = c.id
  WHERE c.kind IN ('dm', 'group') AND (
    cm.member_kind = 'human' OR c.kind = 'dm' OR EXISTS (
      SELECT 1 FROM project_member pm
      WHERE pm.project_id = c.project_id AND pm.agent_profile_id = cm.member_id
    )
  )
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'agent' AS member_kind,
    pm.agent_profile_id AS member_id,
    pm.added_at,
    'project_member' AS source
  FROM chat c
  JOIN project_member pm ON pm.project_id = c.project_id
  WHERE c.kind = 'public_channel'
  UNION ALL
  SELECT
    c.id AS chat_id,
    c.project_id,
    'human' AS member_kind,
    p.created_by AS member_id,
    p.created_at AS added_at,
    'project_owner' AS source
  FROM chat c
  JOIN project p ON p.id = c.project_id
  WHERE c.kind = 'public_channel'
`);

export const agentInstance = sqliteTable(
  "agent_instance",
  {
    id: text("id").primaryKey(),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("agent_instance_profile_chat_unique").on(table.agentProfileId, table.chatId),
    uniqueIndex("agent_instance_id_project_unique").on(table.id, table.projectId),
  ],
);

export const message = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id),
    senderKind: text("sender_kind", { enum: ["human", "agent"] }).notNull(),
    senderId: text("sender_id").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check("message_sender_kind_check", sql`${table.senderKind} in ('human', 'agent')`),
    index("message_chat_created_at_idx").on(table.chatId, table.createdAt),
    uniqueIndex("message_id_chat_unique").on(table.id, table.chatId),
  ],
);

export const agentRun = sqliteTable(
  "agent_run",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => agentInstance.id),
    chatId: text("chat_id")
      .notNull()
      .references(() => chat.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    requestId: text("request_id").notNull(),
    status: text("status", { enum: AGENT_RUN_STATUSES }).notNull(),
    queuedAt: integer("queued_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    startedAt: integer("started_at", { mode: "timestamp" }),
    settledAt: integer("settled_at", { mode: "timestamp" }),
    stopReason: text("stop_reason"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    sessionId: text("session_id").notNull(),
    configSnapshot: text("config_snapshot", { mode: "json" }).$type<RunConfigSnapshot>(),
    // 回复消息必须与 run 同属一个 chat（裁定 d9）。单列 message(id) 外键被这条复合外键覆盖，
    // 不再重复声明；目标由 message 上的 uniqueIndex("message_id_chat_unique") 提供。
    assistantMessageId: text("assistant_message_id"),
  },
  (table) => [
    foreignKey({
      columns: [table.assistantMessageId, table.chatId],
      foreignColumns: [message.id, message.chatId],
    }),
    uniqueIndex("agent_run_one_active_instance")
      .on(table.instanceId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("agent_run_chat_queued_idx").on(table.chatId, table.queuedAt),
    uniqueIndex("agent_run_assistant_message_unique")
      .on(table.assistantMessageId)
      .where(sql`${table.assistantMessageId} is not null`),
    uniqueIndex("agent_run_bound_identity_unique").on(
      table.id,
      table.instanceId,
      table.projectId,
      table.chatId,
    ),
    check(
      "agent_run_status_check",
      sql`${table.status} in ('queued', 'running', 'completed', 'failed', 'aborted', 'interrupted')`,
    ),
    check(
      "agent_run_timestamps_check",
      sql`(
      (${table.status} = 'queued' and ${table.startedAt} is null and ${table.settledAt} is null)
      or (${table.status} = 'running' and ${table.startedAt} is not null and ${table.settledAt} is null)
      or (${table.status} in ('completed', 'failed', 'aborted', 'interrupted') and ${table.settledAt} is not null)
    )`,
    ),
    check(
      "agent_run_completed_check",
      sql`${table.status} != 'completed' or (
      ${table.assistantMessageId} is not null and ${table.configSnapshot} is not null
      and ${table.startedAt} is not null and ${table.stopReason} is not null and ${table.stopReason} = 'stop'
      and ${table.errorCode} is null and ${table.errorMessage} is null
    )`,
    ),
    check(
      "agent_run_failed_check",
      sql`${table.status} != 'failed' or (
      ${table.errorCode} is not null and ${table.errorMessage} is not null and ${table.errorMessage} != ''
    )`,
    ),
  ],
);

export const agentRunInput = sqliteTable(
  "agent_run_input",
  {
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.id),
    messageId: text("message_id")
      .notNull()
      .references(() => message.id),
    disposition: text("disposition", { enum: ["pending", "delivered", "cancelled"] })
      .notNull()
      .default("pending"),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
    cancelledAt: integer("cancelled_at", { mode: "timestamp" }),
    cancelReason: text("cancel_reason", {
      enum: ["membership_revoked", "human_stop", "group_dissolved"],
    }),
  },
  (table) => [
    // 联合主键让同一条消息可以扇出给多条 run；run_id 作为最左列继续服务按 run 的读取。
    primaryKey({ columns: [table.runId, table.messageId] }),
    index("agent_run_input_message_idx").on(table.messageId),
    index("agent_run_input_run_disposition_idx").on(table.runId, table.disposition),
    check(
      "agent_run_input_disposition_check",
      sql`(
      (${table.disposition} = 'pending' and ${table.deliveredAt} is null and ${table.cancelledAt} is null and ${table.cancelReason} is null)
      or (${table.disposition} = 'delivered' and ${table.deliveredAt} is not null and ${table.cancelledAt} is null and ${table.cancelReason} is null)
      or (${table.disposition} = 'cancelled' and ${table.deliveredAt} is null and ${table.cancelledAt} is not null and ${table.cancelReason} is not null)
    )`,
    ),
    check(
      "agent_run_input_cancel_reason_check",
      sql`${table.cancelReason} is null or ${table.cancelReason} in ('membership_revoked', 'human_stop', 'group_dissolved')`,
    ),
  ],
);

export const diagnosticEvent = sqliteTable(
  "diagnostic_event",
  {
    id: text("id").primaryKey(),
    at: integer("at", { mode: "timestamp" }).notNull(),
    level: text("level", { enum: DIAGNOSTIC_LEVELS }).notNull(),
    event: text("event").notNull(),
    requestId: text("request_id").notNull(),
    projectId: text("project_id").references(() => project.id),
    chatId: text("chat_id"),
    instanceId: text("instance_id"),
    runId: text("run_id"),
    executionId: text("execution_id"),
    message: text("message").notNull(),
    data: text("data"),
  },
  (table) => [
    check(
      "diagnostic_event_level_check",
      sql`${table.level} in (${sql.join(
        DIAGNOSTIC_LEVELS.map((level) => sql.raw(`'${level}'`)),
        sql`, `,
      )})`,
    ),
    index("diagnostic_event_at_idx").on(table.at),
    index("diagnostic_event_request_id_idx").on(table.requestId),
    index("diagnostic_event_project_id_idx").on(table.projectId),
  ],
);

export const runtimeBoot = sqliteTable(
  "runtime_boot",
  {
    id: text("id").primaryKey(),
    startedAt: integer("started_at", { mode: "timestamp" }).notNull(),
    stoppedAt: integer("stopped_at", { mode: "timestamp" }),
    phase: text("phase", {
      enum: ["starting", "ready", "stopping", "stopped", "interrupted"],
    }).notNull(),
    pid: integer("pid").notNull(),
    appVersion: text("app_version").notNull(),
  },
  (table) => [
    check(
      "runtime_boot_phase_check",
      sql`${table.phase} in ('starting', 'ready', 'stopping', 'stopped', 'interrupted')`,
    ),
  ],
);

export const repoCheckout = sqliteTable(
  "repo_checkout",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    path: text("path").notNull(),
    sourceKind: text("source_kind", { enum: ["managed_clone", "bound_copy"] }).notNull(),
    source: text("source").notNull(),
    ref: text("ref").notNull(),
    commit: text("commit").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" }),
    resolvedAt: integer("resolved_at", { mode: "timestamp" }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    status: text("status", { enum: ["preparing", "ready"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    uniqueIndex("repo_checkout_project_unique").on(table.projectId),
    check("repo_checkout_status_check", sql`${table.status} in ('preparing', 'ready')`),
    check(
      "repo_checkout_ready_check",
      sql`${table.status} != 'ready' or (
      ${table.path} != '' and ${table.commit} != '' and ${table.ref} != '' and ${table.source} != ''
    )`,
    ),
  ],
);

export const repoProvenance = sqliteTable(
  "repo_provenance",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .unique()
      .references(() => agentRun.id),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    checkoutId: text("checkout_id")
      .notNull()
      .references(() => repoCheckout.id),
    path: text("path").notNull(),
    source: text("source").notNull(),
    sourceKind: text("source_kind", { enum: ["managed_clone", "bound_copy"] }).notNull(),
    ref: text("ref").notNull(),
    commit: text("commit").notNull(),
    fresh: integer("fresh", { mode: "boolean" }).notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp" }).notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" }),
  },
  (table) => [
    index("repo_provenance_project_idx").on(table.projectId),
    check("repo_provenance_fresh_check", sql`${table.fresh} in (0, 1)`),
    check("repo_provenance_commit_check", sql`${table.commit} != ''`),
  ],
);

export const machine = sqliteTable(
  "machine",
  {
    id: text("id").primaryKey().notNull(),
    name: text("name").notNull(),
    rootDirectory: text("root_directory"),
    rootRevision: integer("root_revision").notNull().default(1),
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("machine_id_owner_unique").on(t.id, t.createdBy),
    check("machine_name_check", sql`length(trim(${t.name})) between 1 and 80`),
    check(
      "machine_root_directory_check",
      sql`${t.rootDirectory} is null or (length(${t.rootDirectory}) between 1 and 4096 and substr(${t.rootDirectory}, 1, 1) = '/' and instr(${t.rootDirectory}, char(0)) = 0)`,
    ),
    check(
      "machine_root_revision_check",
      sql`typeof(${t.rootRevision}) = 'integer' and ${t.rootRevision} between 1 and 9007199254740991`,
    ),
  ],
);

export const machineCredential = sqliteTable(
  "machine_credential",
  {
    machineId: text("machine_id")
      .primaryKey()
      .notNull()
      .references(() => machine.id),
    ticketHash: text("ticket_hash").notNull(),
    ticketExpiresAt: integer("ticket_expires_at", { mode: "timestamp_ms" }).notNull(),
    secretHash: text("secret_hash"),
    activatedAt: integer("activated_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("machine_ticket_hash_unique").on(t.ticketHash),
    uniqueIndex("machine_secret_hash_unique").on(t.secretHash),
    check(
      "machine_ticket_hash_check",
      sql`length(${t.ticketHash}) = 64 and ${t.ticketHash} not glob '*[^0-9a-f]*'`,
    ),
    check(
      "machine_secret_hash_check",
      sql`${t.secretHash} is null or (length(${t.secretHash}) = 64 and ${t.secretHash} not glob '*[^0-9a-f]*')`,
    ),
    check(
      "machine_activation_check",
      sql`(${t.secretHash} is null and ${t.activatedAt} is null) or (${t.secretHash} is not null and ${t.activatedAt} is not null)`,
    ),
  ],
);

export const machineConnectionCounter = sqliteTable(
  "machine_connection_counter",
  {
    machineId: text("machine_id")
      .primaryKey()
      .notNull()
      .references(() => machine.id),
    highWater: integer("high_water").notNull().default(0),
  },
  (t) => [
    check(
      "machine_high_water_check",
      sql`typeof(${t.highWater}) = 'integer' and ${t.highWater} between 0 and 9007199254740991`,
    ),
  ],
);

export const machineConnection = sqliteTable(
  "machine_connection",
  {
    machineId: text("machine_id")
      .notNull()
      .references(() => machine.id),
    generation: integer("generation").notNull(),
    attemptId: text("attempt_id").notNull(),
    bootId: text("boot_id")
      .notNull()
      .references(() => runtimeBoot.id),
    status: text("status", { enum: ["open", "closed"] }).notNull(),
    openedAt: integer("opened_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
    closedAt: integer("closed_at", { mode: "timestamp_ms" }),
    seq: integer("seq").notNull().default(0),
    capability: text("capability", { mode: "json" }).$type<CapabilitySnapshot>(),
    lastPayloadHash: text("last_payload_hash"),
  },
  (t) => [
    primaryKey({ columns: [t.machineId, t.generation] }),
    uniqueIndex("machine_connection_attempt_unique").on(t.machineId, t.attemptId),
    uniqueIndex("machine_connection_mcp_session_unique").on(
      t.machineId,
      t.generation,
      t.bootId,
      t.attemptId,
    ),
    check(
      "machine_generation_check",
      sql`typeof(${t.generation}) = 'integer' and ${t.generation} between 1 and 9007199254740991`,
    ),
    check(
      "machine_seq_check",
      sql`typeof(${t.seq}) = 'integer' and ${t.seq} between 0 and 9007199254740991`,
    ),
    check("machine_attempt_check", sql`length(${t.attemptId}) > 0`),
    check(
      "machine_connection_status_check",
      sql`(${t.status} = 'open' and ${t.closedAt} is null) or (${t.status} = 'closed' and ${t.closedAt} is not null)`,
    ),
    check(
      "machine_connection_payload_check",
      sql`(${t.seq} = 0 and ${t.capability} is null and ${t.lastPayloadHash} is null) or (${t.seq} > 0 and ${t.capability} is not null and ${t.lastPayloadHash} is not null and length(${t.lastPayloadHash}) = 64 and ${t.lastPayloadHash} not glob '*[^0-9a-f]*')`,
    ),
    check(
      "machine_capability_json_check",
      sql`case when ${t.capability} is null then 1 when json_valid(${t.capability}) then json_type(${t.capability}) = 'object' else 0 end`,
    ),
  ],
);

export const projectMachine = sqliteTable(
  "project_machine",
  {
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    createdBy: text("created_by").notNull(),
    description: text("description").notNull().default(""),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.machineId] }),
    foreignKey({
      columns: [t.projectId, t.createdBy],
      foreignColumns: [project.id, project.createdBy],
    }),
    foreignKey({
      columns: [t.machineId, t.createdBy],
      foreignColumns: [machine.id, machine.createdBy],
    }),
    check(
      "project_machine_revision_check",
      sql`typeof(${t.revision}) = 'integer' and ${t.revision} between 1 and 9007199254740991`,
    ),
    check("project_machine_description_check", sql`length(${t.description}) <= 500`),
  ],
);

export const directoryObservation = sqliteTable(
  "directory_observation",
  {
    machineId: text("machine_id").notNull(),
    generation: integer("generation").notNull(),
    projectId: text("project_id").notNull(),
    revision: integer("revision").notNull(),
    seq: integer("seq").notNull(),
    checkedAt: integer("checked_at", { mode: "timestamp_ms" }).notNull(),
    kind: text("kind", { enum: ["accessible", "unavailable"] }).notNull(),
    realPath: text("real_path"),
    reason: text("reason", { enum: ["missing", "not_directory", "denied", "io_error"] }),
  },
  (t) => [
    primaryKey({ columns: [t.machineId, t.generation, t.projectId, t.revision] }),
    foreignKey({
      columns: [t.machineId, t.generation],
      foreignColumns: [machineConnection.machineId, machineConnection.generation],
    }),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [projectMachine.projectId, projectMachine.machineId],
    }),
    check(
      "directory_observation_revision_check",
      sql`typeof(${t.revision}) = 'integer' and ${t.revision} between 1 and 9007199254740991`,
    ),
    check(
      "directory_observation_seq_check",
      sql`typeof(${t.seq}) = 'integer' and ${t.seq} between 1 and 9007199254740991`,
    ),
    check(
      "directory_observation_result_check",
      sql`(${t.kind} = 'accessible' and ${t.realPath} is not null and ${t.reason} is null and length(${t.realPath}) between 1 and 4096 and substr(${t.realPath}, 1, 1) = '/' and instr(${t.realPath}, char(0)) = 0) or (${t.kind} = 'unavailable' and ${t.realPath} is null and ${t.reason} is not null and ${t.reason} in ('missing', 'not_directory', 'denied', 'io_error'))`,
    ),
  ],
);

export const machineLease = sqliteTable(
  "machine_lease",
  {
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    generation: integer("generation").notNull(),
    state: text("state", { enum: ["free", "held", "fencing"] }).notNull(),
    holderInstanceId: text("holder_instance_id"),
    changedAt: integer("changed_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check(
      "machine_lease_check_1",
      sql`typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991`,
    ),
    check("machine_lease_check_2", sql`state IN ('free','held','fencing')`),
    check("machine_lease_check_3", sql`typeof(changed_at)='integer' AND changed_at>=0`),
    primaryKey({ columns: [t.projectId, t.machineId] }),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [projectMachine.projectId, projectMachine.machineId],
    }),
    foreignKey({
      columns: [t.holderInstanceId, t.projectId],
      foreignColumns: [agentInstance.id, agentInstance.projectId],
    }),
    check(
      "machine_lease_check_7",
      sql`(state='free' AND holder_instance_id IS NULL) OR
        (state IN ('held','fencing') AND holder_instance_id IS NOT NULL)`,
    ),
    check("machine_lease_check_8", sql`state='free' OR generation>0`),
  ],
);

export const leaseAuthorization = sqliteTable(
  "lease_authorization",
  {
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    generation: integer("generation").notNull(),
    holderInstanceId: text("holder_instance_id"),
    state: text("state", { enum: ["free", "active", "draining", "revoked"] }).notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
    reason: text("reason", {
      enum: ["initial", "acquire", "release", "handoff", "reclaim"],
    }).notNull(),
  },
  (t) => [
    check(
      "lease_authorization_check_1",
      sql`typeof(generation)='integer' AND generation BETWEEN 0 AND 9007199254740991`,
    ),
    check("lease_authorization_check_2", sql`state IN ('free','active','draining','revoked')`),
    check("lease_authorization_check_3", sql`typeof(issued_at)='integer' AND issued_at>=0`),
    check(
      "lease_authorization_check_4",
      sql`reason IN ('initial','acquire','release','handoff','reclaim')`,
    ),
    primaryKey({ columns: [t.projectId, t.machineId, t.generation] }),
    uniqueIndex(
      "lease_authorization_project_id_machine_id_generation_holder_instance_id_unique",
    ).on(t.projectId, t.machineId, t.generation, t.holderInstanceId),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [machineLease.projectId, machineLease.machineId],
    }),
    foreignKey({
      columns: [t.holderInstanceId, t.projectId],
      foreignColumns: [agentInstance.id, agentInstance.projectId],
    }),
    check(
      "lease_authorization_check_9",
      sql`(state='free' AND holder_instance_id IS NULL AND revoked_at IS NULL) OR
        (state IN ('active','draining') AND holder_instance_id IS NOT NULL AND revoked_at IS NULL) OR
        (state='revoked' AND revoked_at IS NOT NULL AND typeof(revoked_at)='integer' AND revoked_at>=issued_at)`,
    ),
    check("lease_authorization_check_10", sql`generation>0 OR holder_instance_id IS NULL`),
    uniqueIndex("lease_one_live_authorization")
      .on(t.projectId, t.machineId)
      .where(sql`state IN ('free','active','draining')`),
  ],
);

export const leaseMutation = sqliteTable(
  "lease_mutation",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    actorKind: text("actor_kind", { enum: ["agent", "human"] }).notNull(),
    actorId: text("actor_id").notNull(),
    requestId: text("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    action: text("action", { enum: ["acquire", "release", "handoff", "reclaim"] }).notNull(),
    expectedGeneration: integer("expected_generation").notNull(),
    targetInstanceId: text("target_instance_id"),
    state: text("state", { enum: ["pending", "completed"] }).notNull(),
    completedGeneration: integer("completed_generation"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check("lease_mutation_check_1", sql`actor_kind IN ('agent','human')`),
    check(
      "lease_mutation_check_2",
      sql`length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("lease_mutation_check_3", sql`action IN ('acquire','release','handoff','reclaim')`),
    check(
      "lease_mutation_check_4",
      sql`typeof(expected_generation)='integer' AND expected_generation BETWEEN 0 AND 9007199254740991`,
    ),
    check("lease_mutation_check_5", sql`state IN ('pending','completed')`),
    check("lease_mutation_check_6", sql`typeof(created_at)='integer' AND created_at>=0`),
    uniqueIndex("lease_mutation_actor_kind_actor_id_request_id_unique").on(
      t.actorKind,
      t.actorId,
      t.requestId,
    ),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [machineLease.projectId, machineLease.machineId],
    }),
    foreignKey({
      columns: [t.projectId, t.machineId, t.expectedGeneration],
      foreignColumns: [
        leaseAuthorization.projectId,
        leaseAuthorization.machineId,
        leaseAuthorization.generation,
      ],
    }),
    foreignKey({
      columns: [t.targetInstanceId, t.projectId],
      foreignColumns: [agentInstance.id, agentInstance.projectId],
    }),
    foreignKey({
      columns: [t.projectId, t.machineId, t.completedGeneration],
      foreignColumns: [
        leaseAuthorization.projectId,
        leaseAuthorization.machineId,
        leaseAuthorization.generation,
      ],
    }),
    check(
      "lease_mutation_check_12",
      sql`(action='handoff' AND target_instance_id IS NOT NULL) OR (action!='handoff' AND target_instance_id IS NULL)`,
    ),
    check(
      "lease_mutation_check_13",
      sql`(actor_kind='agent' AND action IN ('acquire','release','handoff')) OR (actor_kind='human' AND action='reclaim')`,
    ),
    check(
      "lease_mutation_check_14",
      sql`(state='pending' AND action!='acquire' AND completed_at IS NULL AND completed_generation IS NULL) OR
        (state='completed' AND completed_at IS NOT NULL AND typeof(completed_at)='integer' AND completed_at>=created_at
          AND completed_generation IS NOT NULL AND typeof(completed_generation)='integer'
          AND completed_generation BETWEEN expected_generation AND 9007199254740991)`,
    ),
    check(
      "lease_mutation_check_15",
      sql`state='pending' OR completed_generation=expected_generation+1 OR
        (action='acquire' AND completed_generation=expected_generation)`,
    ),
    uniqueIndex("lease_one_pending_mutation")
      .on(t.projectId, t.machineId)
      .where(sql`state='pending'`),
  ],
);

export const projectMachineMembership = sqliteTable(
  "project_machine_membership",
  {
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    /** 一段加入生命周期一行；rejoin 只新建 epoch+1，不删除历史行。 */
    epoch: integer("epoch").notNull(),
    state: text("state", { enum: MEMBERSHIP_STATES }).notNull(),
    joinedAt: integer("joined_at", { mode: "timestamp_ms" }).notNull(),
    requestedBy: text("requested_by"),
    requestId: text("request_id"),
    payloadHash: text("payload_hash"),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }),
    removalMutationId: text("removal_mutation_id"),
    removedAt: integer("removed_at", { mode: "timestamp_ms" }),
    revokedGeneration: integer("revoked_generation"),
  },
  (t) => [
    primaryKey({ columns: [t.projectId, t.machineId, t.epoch] }),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [projectMachine.projectId, projectMachine.machineId],
    }),
    foreignKey({ columns: [t.removalMutationId], foreignColumns: [leaseMutation.id] }),
    check(
      "project_machine_membership_check_1",
      sql`typeof(${t.epoch})='integer' AND ${t.epoch} BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "project_machine_membership_check_2",
      sql`${t.state} IN ('active','detaching','removed')`,
    ),
    check(
      "project_machine_membership_check_3",
      sql`typeof(${t.joinedAt})='integer' AND ${t.joinedAt}>=0`,
    ),
    check(
      "project_machine_membership_check_4",
      sql`${t.requestedAt} IS NULL OR (typeof(${t.requestedAt})='integer' AND ${t.requestedAt}>=${t.joinedAt})`,
    ),
    check(
      "project_machine_membership_check_5",
      sql`${t.removedAt} IS NULL OR (typeof(${t.removedAt})='integer' AND ${t.removedAt}>=0 AND ${t.requestedAt} IS NOT NULL AND ${t.removedAt}>=${t.requestedAt})`,
    ),
    check(
      "project_machine_membership_check_6",
      sql`${t.payloadHash} IS NULL OR (length(${t.payloadHash})=64 AND ${t.payloadHash} NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "project_machine_membership_check_7",
      sql`${t.revokedGeneration} IS NULL OR (typeof(${t.revokedGeneration})='integer' AND ${t.revokedGeneration} BETWEEN 0 AND 9007199254740991)`,
    ),
    // 可空参与项逐个显式判定，不让 NULL 让整条 CHECK 恒真。
    check(
      "project_machine_membership_check_8",
      sql`(${t.state}='active' AND ${t.requestedBy} IS NULL AND ${t.requestId} IS NULL AND ${t.payloadHash} IS NULL AND ${t.requestedAt} IS NULL AND ${t.removalMutationId} IS NULL AND ${t.removedAt} IS NULL AND ${t.revokedGeneration} IS NULL) OR
        (${t.state}='detaching' AND ${t.requestedBy} IS NOT NULL AND ${t.requestId} IS NOT NULL AND ${t.payloadHash} IS NOT NULL AND ${t.requestedAt} IS NOT NULL AND ${t.removalMutationId} IS NOT NULL AND ${t.removedAt} IS NULL AND ${t.revokedGeneration} IS NULL) OR
        (${t.state}='removed' AND ${t.requestedBy} IS NOT NULL AND ${t.requestId} IS NOT NULL AND ${t.payloadHash} IS NOT NULL AND ${t.requestedAt} IS NOT NULL AND ${t.removedAt} IS NOT NULL AND ${t.revokedGeneration} IS NOT NULL)`,
    ),
    uniqueIndex("project_machine_membership_one_live_epoch")
      .on(t.projectId, t.machineId)
      .where(sql`state IN ('active','detaching')`),
    uniqueIndex("project_machine_membership_actor_request_unique")
      .on(t.requestedBy, t.requestId)
      .where(sql`request_id IS NOT NULL`),
  ],
);

export const runResourceNotice = sqliteTable(
  "run_resource_notice",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    runId: text("run_id").notNull(),
    instanceId: text("instance_id").notNull(),
    chatId: text("chat_id").notNull(),
    kind: text("kind", { enum: RUN_RESOURCE_NOTICE_KINDS }).notNull(),
    /** 前三者用原 lease mutation id；machine_removed 用 membership:<project>:<machine>:<epoch>。 */
    causeId: text("cause_id").notNull(),
    payloadJson: text("payload_json", { mode: "json" }).$type<RunResourceNoticePayload>().notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [projectMachine.projectId, projectMachine.machineId],
    }),
    foreignKey({
      columns: [t.runId, t.instanceId, t.projectId, t.chatId],
      foreignColumns: [agentRun.id, agentRun.instanceId, agentRun.projectId, agentRun.chatId],
    }),
    check(
      "run_resource_notice_check_1",
      sql`${t.kind} IN ('lease_handed_off','lease_released','lease_reclaimed','machine_removed')`,
    ),
    check(
      "run_resource_notice_check_2",
      sql`CASE WHEN json_valid(${t.payloadJson}) THEN json_type(${t.payloadJson})='object' ELSE 0 END`,
    ),
    check(
      "run_resource_notice_check_3",
      sql`typeof(${t.createdAt})='integer' AND ${t.createdAt}>=0`,
    ),
    check(
      "run_resource_notice_check_4",
      sql`${t.deliveredAt} IS NULL OR (typeof(${t.deliveredAt})='integer' AND ${t.deliveredAt}>=${t.createdAt})`,
    ),
    uniqueIndex("run_resource_notice_kind_cause_id_run_id_unique").on(t.kind, t.causeId, t.runId),
    index("run_resource_notice_undelivered_idx")
      .on(t.runId, t.createdAt, t.id)
      .where(sql`delivered_at IS NULL`),
  ],
);

export const workerExchangeFrame = sqliteTable(
  "worker_exchange_frame",
  {
    machineId: text("machine_id").notNull(),
    connectionGeneration: integer("connection_generation").notNull(),
    seq: integer("seq").notNull(),
    payloadHash: text("payload_hash").notNull(),
    responseJson: text("response_json", { mode: "json" })
      .$type<Extract<WorkerExchangeResponse, { ok: true }>["data"]>()
      .notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check(
      "worker_exchange_frame_check_1",
      sql`typeof(connection_generation)='integer' AND connection_generation BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "worker_exchange_frame_check_2",
      sql`typeof(seq)='integer' AND seq BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "worker_exchange_frame_check_3",
      sql`length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "worker_exchange_frame_check_4",
      sql`CASE WHEN json_valid(response_json) THEN json_type(response_json)='object' ELSE 0 END`,
    ),
    check("worker_exchange_frame_check_5", sql`typeof(created_at)='integer' AND created_at>=0`),
    primaryKey({ columns: [t.machineId, t.connectionGeneration, t.seq] }),
    foreignKey({
      columns: [t.machineId, t.connectionGeneration],
      foreignColumns: [machineConnection.machineId, machineConnection.generation],
    }),
  ],
);

export const remoteExecution = sqliteTable(
  "remote_execution",
  {
    id: text("id").primaryKey().notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    runId: text("run_id").notNull(),
    chatId: text("chat_id").notNull(),
    requestId: text("request_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    operationJson: text("operation_json", { mode: "json" }).$type<RemoteOperation>().notNull(),
    directoryRevision: integer("directory_revision"),
    state: text("state", { enum: REMOTE_EXECUTION_STATES }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    dispatchDeadlineAt: integer("dispatch_deadline_at", { mode: "timestamp_ms" }).notNull(),
    runtimeDeadlineAt: integer("runtime_deadline_at", { mode: "timestamp_ms" }),
    maxRuntimeMs: integer("max_runtime_ms"),
    runnerToken: text("runner_token"),
    logState: text("log_state", { enum: EXECUTION_LOG_STATES }).notNull().default("none"),
    /** Worker 已声明该执行不会再产出新帧；没有这个事实就不能判 `full`。 */
    logSealed: integer("log_sealed", { mode: "boolean" }).notNull().default(false),
    producedThroughSeq: integer("produced_through_seq"),
    acknowledgedThroughSeq: integer("acknowledged_through_seq"),
    availableFromSeq: integer("available_from_seq"),
    dispatchConnectionGeneration: integer("dispatch_connection_generation"),
    dispatchSeq: integer("dispatch_seq"),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    drainedAt: integer("drained_at", { mode: "timestamp_ms" }),
    terminalAt: integer("terminal_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason", { enum: REMOTE_FAILURE_REASONS }),
    // 恢复归约给出的 unknown 原因。取值由 contracts/remote 的枚举约束，不在这里再写 CHECK：
    // SQLite 加检查约束要重建整张表，而它已被结果、日志、取消三张表按复合键引用。
    recoveryReason: text("recovery_reason", { enum: EXECUTION_RECOVERY_REASONS }),
    // 最近一次被接受、且来自当前或更新连接代次的归约报告时间。过期判定只认这个事实，
    // 不把「没收到任何报告」和「报告说 running」混为一谈。
    recoveryReportedAt: integer("recovery_reported_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    check(
      "remote_execution_check_1",
      sql`typeof(authorization_generation)='integer' AND authorization_generation BETWEEN 1 AND 9007199254740991`,
    ),
    check(
      "remote_execution_check_2",
      sql`length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "remote_execution_check_3",
      sql`CASE WHEN json_valid(operation_json) THEN json_type(operation_json)='object' ELSE 0 END`,
    ),
    check(
      "remote_execution_check_4",
      sql`directory_revision IS NULL OR (typeof(directory_revision)='integer' AND directory_revision BETWEEN 1 AND 9007199254740991)`,
    ),
    check(
      "remote_execution_check_5",
      sql`state IN ('queued','dispatched','running','draining','succeeded','failed','rejected','timed_out','unknown')`,
    ),
    check("remote_execution_check_6", sql`typeof(created_at)='integer' AND created_at>=0`),
    check(
      "remote_execution_check_7",
      sql`typeof(dispatch_deadline_at)='integer' AND dispatch_deadline_at>created_at`,
    ),
    check(
      "remote_execution_check_8",
      sql`failure_reason IS NULL OR failure_reason IN ('stale_generation','not_holder','authorization_revoked','cancelled','deadline','worker_lost','executor_error','capability_unavailable','directory_unavailable')`,
    ),
    uniqueIndex("remote_execution_holder_instance_id_request_id_unique").on(
      t.holderInstanceId,
      t.requestId,
    ),
    uniqueIndex(
      "remote_execution_id_project_id_machine_id_authorization_generation_holder_instance_id_unique",
    ).on(t.id, t.projectId, t.machineId, t.authorizationGeneration, t.holderInstanceId),
    // 本阶段对 remote_execution 的唯一 DDL：按 scope 的稳定分页索引，不重建表。
    index("remote_execution_scope_idx").on(t.projectId, t.machineId, t.createdAt, t.id),
    foreignKey({
      columns: [t.projectId, t.machineId, t.authorizationGeneration, t.holderInstanceId],
      foreignColumns: [
        leaseAuthorization.projectId,
        leaseAuthorization.machineId,
        leaseAuthorization.generation,
        leaseAuthorization.holderInstanceId,
      ],
    }),
    foreignKey({
      columns: [t.runId, t.holderInstanceId, t.projectId, t.chatId],
      foreignColumns: [agentRun.id, agentRun.instanceId, agentRun.projectId, agentRun.chatId],
    }),
    // 投递帧在同一 immediate 事务里后写，因此 0013 把这条外键写成
    // DEFERRABLE INITIALLY DEFERRED；drizzle 的 schema DSL 不表达该修饰，SQL 才是权威。
    // 任何重建 remote_execution 的迁移（如 0019）都必须手写保留该修饰，否卿首次下发
    // 会在帧写入之前撞上外键检查，命令永远发不出去。
    foreignKey({
      columns: [t.machineId, t.dispatchConnectionGeneration, t.dispatchSeq],
      foreignColumns: [
        workerExchangeFrame.machineId,
        workerExchangeFrame.connectionGeneration,
        workerExchangeFrame.seq,
      ],
    }),
    check(
      "remote_execution_check_14",
      sql`(dispatch_connection_generation IS NULL AND dispatch_seq IS NULL AND dispatched_at IS NULL AND drained_at IS NULL) OR
        (dispatch_connection_generation IS NOT NULL AND typeof(dispatch_connection_generation)='integer' AND dispatch_connection_generation>=1
          AND dispatch_seq IS NOT NULL AND typeof(dispatch_seq)='integer' AND dispatch_seq>=1
          AND dispatched_at IS NOT NULL AND typeof(dispatched_at)='integer' AND dispatched_at>=created_at)`,
    ),
    check(
      "remote_execution_check_15",
      sql`drained_at IS NULL OR (typeof(drained_at)='integer' AND dispatched_at IS NOT NULL AND drained_at>=dispatched_at)`,
    ),
    check(
      "remote_execution_check_16",
      sql`state NOT IN ('dispatched','running','draining') OR dispatch_connection_generation IS NOT NULL`,
    ),
    check(
      "remote_execution_check_17",
      sql`state!='queued' OR dispatch_connection_generation IS NULL`,
    ),
    check(
      "remote_execution_check_18",
      sql`state!='succeeded' OR (dispatch_connection_generation IS NOT NULL AND drained_at IS NOT NULL)`,
    ),
    check(
      "remote_execution_check_19",
      sql`(state IN ('queued','dispatched','running','draining') AND terminal_at IS NULL AND failure_reason IS NULL) OR
        (state='succeeded' AND terminal_at IS NOT NULL AND typeof(terminal_at)='integer' AND terminal_at>=created_at AND failure_reason IS NULL) OR
        (state IN ('failed','rejected','timed_out','unknown') AND terminal_at IS NOT NULL AND typeof(terminal_at)='integer' AND terminal_at>=created_at AND failure_reason IS NOT NULL)`,
    ),
    check(
      "remote_execution_check_20",
      sql`runner_token IS NULL OR (length(runner_token)=32 AND runner_token NOT GLOB '*[^0-9a-f]*')`,
    ),
    check(
      "remote_execution_check_21",
      sql`log_state IN ('none','partial','full','gap','truncated')`,
    ),
    check(
      "remote_execution_check_22",
      sql`(max_runtime_ms IS NULL AND runtime_deadline_at IS NULL) OR
        (max_runtime_ms IS NOT NULL AND typeof(max_runtime_ms)='integer' AND max_runtime_ms BETWEEN 1 AND 9007199254740991
          AND runtime_deadline_at IS NOT NULL AND typeof(runtime_deadline_at)='integer'
          AND dispatched_at IS NOT NULL AND runtime_deadline_at>=dispatched_at)`,
    ),
    check(
      "remote_execution_check_23",
      sql`(produced_through_seq IS NULL OR (typeof(produced_through_seq)='integer' AND produced_through_seq>=1))
        AND (acknowledged_through_seq IS NULL OR (typeof(acknowledged_through_seq)='integer' AND acknowledged_through_seq>=1))
        AND (available_from_seq IS NULL OR (typeof(available_from_seq)='integer' AND available_from_seq>=1))
        AND (acknowledged_through_seq IS NULL OR produced_through_seq IS NOT NULL)
        AND (acknowledged_through_seq IS NULL OR produced_through_seq IS NULL OR acknowledged_through_seq<=produced_through_seq)
        AND (available_from_seq IS NULL OR produced_through_seq IS NULL OR available_from_seq<=produced_through_seq+1)`,
    ),
    check("remote_execution_check_24", sql`log_state='none' OR produced_through_seq IS NOT NULL`),
    check(
      "remote_execution_check_25",
      sql`log_state!='full' OR acknowledged_through_seq IS NOT NULL`,
    ),
  ],
);

/** 追加流：一行一个有序帧，或者一行只表达 gap。裁剪不新建表，靠 `available_from_seq` + gap 行。 */
export const executionLogFrame = sqliteTable(
  "execution_log_frame",
  {
    executionId: text("execution_id").notNull(),
    sequence: integer("sequence").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    stream: text("stream", { enum: ["stdout", "stderr"] }).notNull(),
    byteStart: integer("byte_start").notNull(),
    byteEnd: integer("byte_end").notNull(),
    payloadBytes: blob("payload_bytes", { mode: "buffer" }),
    checksum: text("checksum").notNull(),
    gapFromSeq: integer("gap_from_seq"),
    gapToSeq: integer("gap_to_seq"),
    durableAt: integer("durable_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check(
      "execution_log_frame_check_1",
      sql`typeof(sequence)='integer' AND sequence BETWEEN 1 AND 9007199254740991`,
    ),
    check("execution_log_frame_check_2", sql`stream IN ('stdout','stderr')`),
    check(
      "execution_log_frame_check_3",
      sql`typeof(byte_start)='integer' AND byte_start>=0 AND typeof(byte_end)='integer' AND byte_end>=byte_start`,
    ),
    check(
      "execution_log_frame_check_4",
      sql`payload_bytes IS NULL OR length(payload_bytes)<=16384`,
    ),
    check(
      "execution_log_frame_check_5",
      sql`length(checksum)=64 AND checksum NOT GLOB '*[^0-9a-f]*'`,
    ),
    check("execution_log_frame_check_6", sql`typeof(durable_at)='integer' AND durable_at>=0`),
    check(
      "execution_log_frame_check_7",
      sql`(payload_bytes IS NOT NULL AND gap_from_seq IS NULL AND gap_to_seq IS NULL) OR
        (payload_bytes IS NULL AND gap_from_seq IS NOT NULL AND gap_to_seq IS NOT NULL
          AND typeof(gap_from_seq)='integer' AND typeof(gap_to_seq)='integer'
          AND gap_from_seq>=1 AND gap_to_seq>=gap_from_seq)`,
    ),
    primaryKey({ columns: [t.executionId, t.sequence] }),
    foreignKey({
      columns: [
        t.executionId,
        t.projectId,
        t.machineId,
        t.authorizationGeneration,
        t.holderInstanceId,
      ],
      foreignColumns: [
        remoteExecution.id,
        remoteExecution.projectId,
        remoteExecution.machineId,
        remoteExecution.authorizationGeneration,
        remoteExecution.holderInstanceId,
      ],
    }),
  ],
);

/** 取消是独立于执行与租约的事实：`delivered` 只证明意图送达，不证明进程已停。 */
export const executionCancellation = sqliteTable(
  "execution_cancellation",
  {
    id: text("id").primaryKey().notNull(),
    executionId: text("execution_id").notNull(),
    requestId: text("request_id").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    // 取消是人类或分身的显式动作：两种 actor 共用一列形状，不用可空外键冒充。
    actorKind: text("actor_kind", { enum: ["agent", "human"] }).notNull(),
    actorId: text("actor_id").notNull(),
    state: text("state", { enum: CANCELLATION_STATES }).notNull(),
    signalOutcome: text("signal_outcome", { enum: CANCELLATION_SIGNAL_OUTCOMES })
      .notNull()
      .default("none"),
    // 取消策略是入参事实，不是下发时的常量：请求留下什么，Worker 就收到什么。
    policy: text("policy", { enum: ["term_then_kill", "kill"] })
      .notNull()
      .default("term_then_kill"),
    termWaitMs: integer("term_wait_ms").notNull().default(2000),
    requestedAt: integer("requested_at", { mode: "timestamp_ms" }).notNull(),
    deliveredAt: integer("delivered_at", { mode: "timestamp_ms" }),
    exitedAt: integer("exited_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason", { enum: CANCELLATION_FAILURE_REASONS }),
  },
  (t) => [
    check(
      "execution_cancellation_check_1",
      sql`state IN ('requested','delivered','exited_observed','already_exited','failed','unknown')`,
    ),
    check(
      "execution_cancellation_check_2",
      sql`signal_outcome IN ('none','term_delivered','kill_delivered')`,
    ),
    check(
      "execution_cancellation_check_3",
      sql`typeof(requested_at)='integer' AND requested_at>=0`,
    ),
    check(
      "execution_cancellation_check_4",
      sql`delivered_at IS NULL OR (typeof(delivered_at)='integer' AND delivered_at>=requested_at)`,
    ),
    check(
      "execution_cancellation_check_5",
      sql`exited_at IS NULL OR (typeof(exited_at)='integer' AND delivered_at IS NOT NULL AND exited_at>=delivered_at)`,
    ),
    check(
      "execution_cancellation_check_6",
      sql`failure_reason IS NULL OR failure_reason IN ('signal_failed','delivery_unconfirmed','exit_not_observed')`,
    ),
    check(
      "execution_cancellation_check_7",
      sql`(state='requested' AND delivered_at IS NULL AND exited_at IS NULL AND failure_reason IS NULL AND signal_outcome='none') OR
        (state='delivered' AND delivered_at IS NOT NULL AND exited_at IS NULL AND failure_reason IS NULL) OR
        (state IN ('exited_observed','already_exited') AND delivered_at IS NOT NULL AND exited_at IS NOT NULL AND failure_reason IS NULL) OR
        (state='failed' AND delivered_at IS NOT NULL AND exited_at IS NULL AND failure_reason IS NOT NULL) OR
        (state='unknown' AND exited_at IS NULL AND failure_reason IS NOT NULL)`,
    ),
    check(
      "execution_cancellation_check_8",
      sql`length(request_id)>7 AND substr(request_id,1,7)='cancel:'`,
    ),
    check("execution_cancellation_check_9", sql`policy IN ('term_then_kill','kill')`),
    check("execution_cancellation_check_10", sql`term_wait_ms BETWEEN 1 AND 10000`),
    check("execution_cancellation_check_11", sql`actor_kind IN ('agent','human')`),
    check("execution_cancellation_check_12", sql`length(actor_id)>0`),
    uniqueIndex("execution_cancellation_holder_instance_id_request_id_unique").on(
      t.holderInstanceId,
      t.requestId,
    ),
    uniqueIndex(
      "execution_cancellation_id_project_id_machine_id_authorization_generation_holder_instance_id_unique",
    ).on(t.id, t.projectId, t.machineId, t.authorizationGeneration, t.holderInstanceId),
    foreignKey({
      columns: [t.executionId],
      foreignColumns: [remoteExecution.id],
    }),
    foreignKey({
      columns: [t.projectId, t.machineId, t.authorizationGeneration, t.holderInstanceId],
      foreignColumns: [
        leaseAuthorization.projectId,
        leaseAuthorization.machineId,
        leaseAuthorization.generation,
        leaseAuthorization.holderInstanceId,
      ],
    }),
  ],
);

export const executionResult = sqliteTable(
  "execution_result",
  {
    executionId: text("execution_id").primaryKey().notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    payloadHash: text("payload_hash").notNull(),
    outcome: text("outcome", { enum: REMOTE_OUTCOMES }).notNull(),
    payloadJson: text("payload_json", { mode: "json" }).$type<RemoteResultPayload>().notNull(),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    check(
      "execution_result_check_1",
      sql`length(payload_hash)=64 AND payload_hash NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "execution_result_check_2",
      sql`outcome IN ('succeeded','failed','rejected','timed_out','unknown')`,
    ),
    check(
      "execution_result_check_3",
      sql`CASE WHEN json_valid(payload_json) THEN json_type(payload_json)='object' ELSE 0 END`,
    ),
    check("execution_result_check_4", sql`typeof(recorded_at)='integer' AND recorded_at>=0`),
    foreignKey({
      columns: [
        t.executionId,
        t.projectId,
        t.machineId,
        t.authorizationGeneration,
        t.holderInstanceId,
      ],
      foreignColumns: [
        remoteExecution.id,
        remoteExecution.projectId,
        remoteExecution.machineId,
        remoteExecution.authorizationGeneration,
        remoteExecution.holderInstanceId,
      ],
    }),
  ],
);

export const remoteToolGrant = sqliteTable(
  "remote_tool_grant",
  {
    id: text("id").primaryKey().notNull(),
    secretHash: text("secret_hash").notNull(),
    userId: text("user_id").notNull(),
    projectId: text("project_id").notNull(),
    chatId: text("chat_id").notNull(),
    instanceId: text("instance_id").notNull(),
    runId: text("run_id").notNull(),
    issuedAt: integer("issued_at", { mode: "timestamp_ms" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
    revokedAt: integer("revoked_at", { mode: "timestamp_ms" }),
  },
  (t) => [
    uniqueIndex("remote_tool_grant_secret_hash_unique").on(t.secretHash),
    uniqueIndex("remote_tool_grant_mcp_session_unique").on(
      t.id,
      t.runId,
      t.instanceId,
      t.projectId,
      t.chatId,
    ),
    check(
      "remote_tool_grant_check_2",
      sql`length(secret_hash)=64 AND secret_hash NOT GLOB '*[^0-9a-f]*'`,
    ),
    uniqueIndex("remote_tool_grant_run_id_unique").on(t.runId),
    check("remote_tool_grant_check_4", sql`typeof(issued_at)='integer' AND issued_at>=0`),
    check("remote_tool_grant_check_5", sql`typeof(expires_at)='integer' AND expires_at>issued_at`),
    check(
      "remote_tool_grant_check_6",
      sql`revoked_at IS NULL OR (typeof(revoked_at)='integer' AND revoked_at>=issued_at)`,
    ),
    foreignKey({
      columns: [t.projectId, t.userId],
      foreignColumns: [project.id, project.createdBy],
    }),
    foreignKey({
      columns: [t.runId, t.instanceId, t.projectId, t.chatId],
      foreignColumns: [agentRun.id, agentRun.instanceId, agentRun.projectId, agentRun.chatId],
    }),
  ],
);

// The relay stores millisecond timestamps and safe integers; nullable state fields
// use explicit IS predicates because SQLite accepts a NULL CHECK result.
const mcpInteger = (name: string, minimum = 0) =>
  check(
    "mcp_" + name + "_integer",
    sql.raw(
      "typeof(" +
        name +
        ")='integer' AND " +
        name +
        " BETWEEN " +
        minimum +
        " AND 9007199254740991",
    ),
  );
const mcpHash = (name: string) =>
  check(
    "mcp_" + name + "_hash",
    sql.raw("length(" + name + ")=64 AND " + name + " NOT GLOB '*[^0-9a-f]*'"),
  );

export const mcpServerRegistration = sqliteTable(
  "mcp_server_registration",
  {
    id: text("id").notNull(),
    revision: integer("revision").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    name: text("name").notNull(),
    transport: text("transport", { enum: ["stdio", "streamableHttp"] }).notNull(),
    configRef: text("config_ref").notNull(),
    configHash: text("config_hash").notNull(),
    configJson: text("config_json", { mode: "json" }).$type<McpConfig>().notNull(),
    createdAt: integer("created_at").notNull(),
    retiredAt: integer("retired_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id, t.revision] }),
    uniqueIndex("mcp_registration_identity_unique").on(t.id, t.revision, t.projectId, t.machineId),
    uniqueIndex("mcp_registration_config_unique").on(
      t.id,
      t.revision,
      t.projectId,
      t.machineId,
      t.transport,
      t.configHash,
    ),
    uniqueIndex("mcp_server_registration_live_name")
      .on(t.projectId, t.machineId, t.name)
      .where(sql`retired_at IS NULL`),
    foreignKey({
      columns: [t.projectId, t.machineId],
      foreignColumns: [projectMachine.projectId, projectMachine.machineId],
    }),
    mcpInteger("revision", 1),
    mcpInteger("created_at"),
    mcpHash("config_hash"),
    check(
      "mcp_registration_name",
      sql`length(name) BETWEEN 1 AND 64 AND name NOT GLOB '*[^a-z0-9_-]*' AND substr(name,1,1) GLOB '[a-z]'`,
    ),
    check("mcp_registration_transport", sql`transport IN ('stdio','streamableHttp')`),
    check("mcp_registration_ref", sql`length(config_ref) BETWEEN 1 AND 128`),
    check(
      "mcp_registration_config_object",
      sql`CASE WHEN json_valid(config_json) THEN json_type(config_json)='object' ELSE 0 END`,
    ),
    check(
      "mcp_registration_config_transport",
      sql`CASE WHEN json_valid(config_json) THEN json_extract(config_json,'$.transport') IS transport ELSE 0 END`,
    ),
    check(
      "mcp_registration_retired_at",
      sql`retired_at IS NULL OR (typeof(retired_at)='integer' AND retired_at>=created_at)`,
    ),
  ],
);

export const mcpServerProcess = sqliteTable(
  "mcp_server_process",
  {
    id: text("id").primaryKey().notNull(),
    registrationId: text("registration_id").notNull(),
    registrationRevision: integer("registration_revision").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    transport: text("transport", { enum: ["stdio", "streamableHttp"] }).notNull(),
    configHash: text("config_hash").notNull(),
    workerIncarnationId: text("worker_incarnation_id").notNull(),
    launchNonce: text("launch_nonce").notNull(),
    pid: integer("pid"),
    processStartedAt: integer("process_started_at"),
    endpoint: text("endpoint"),
    state: text("state", {
      enum: ["starting", "running", "stopping", "exited", "failed", "lost"],
    }).notNull(),
    stateRevision: integer("state_revision").notNull(),
    stateHash: text("state_hash").notNull(),
    createdAt: integer("created_at").notNull(),
    lastObservedAt: integer("last_observed_at").notNull(),
    endedAt: integer("ended_at"),
    exitCode: integer("exit_code"),
    endReason: text("end_reason"),
  },
  (t) => [
    foreignKey({
      columns: [t.registrationId, t.registrationRevision, t.projectId, t.machineId],
      foreignColumns: [
        mcpServerRegistration.id,
        mcpServerRegistration.revision,
        mcpServerRegistration.projectId,
        mcpServerRegistration.machineId,
      ],
    }),
    uniqueIndex("mcp_process_session_identity_unique").on(
      t.id,
      t.registrationId,
      t.registrationRevision,
      t.projectId,
      t.machineId,
      t.transport,
      t.workerIncarnationId,
    ),
    mcpInteger("registration_revision", 1),
    mcpInteger("state_revision", 1),
    mcpInteger("created_at", 0),
    mcpInteger("last_observed_at", 0),
    mcpHash("state_hash"),
    mcpHash("config_hash"),
    check(
      "mcp_process_started_at_integer",
      sql`process_started_at IS NULL OR (typeof(process_started_at)='integer' AND process_started_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_ended_at_integer",
      sql`ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_process_pid",
      sql`pid IS NULL OR (typeof(pid)='integer' AND pid BETWEEN 1 AND 9007199254740991)`,
    ),
    check(
      "mcp_process_exit_code",
      sql`exit_code IS NULL OR (typeof(exit_code)='integer' AND exit_code BETWEEN -9007199254740991 AND 9007199254740991)`,
    ),
    check("mcp_process_transport", sql`transport IN ('stdio','streamableHttp')`),
    check(
      "mcp_process_state",
      sql`state IN ('starting','running','stopping','exited','failed','lost')`,
    ),
    check("mcp_process_endpoint", sql`transport='streamableHttp' OR endpoint IS NULL`),
    check(
      "mcp_process_running",
      sql`state<>'running' OR (pid IS NOT NULL OR (transport='streamableHttp' AND endpoint IS NOT NULL))`,
    ),
    check(
      "mcp_process_lifecycle",
      sql`(state IN ('starting','running','stopping') AND ended_at IS NULL AND end_reason IS NULL AND exit_code IS NULL) OR (state IN ('exited','failed','lost') AND ended_at IS NOT NULL AND end_reason IS NOT NULL)`,
    ),
    check(
      "mcp_process_end_reason",
      sql`end_reason IS NULL OR end_reason IN ('owner_stopped','spawn_failed','exited','crashed','unreachable','worker_lost','config_retired')`,
    ),
  ],
);

export const mcpSession = sqliteTable(
  "mcp_session",
  {
    id: text("id").primaryKey().notNull(),
    processId: text("process_id").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    registrationId: text("registration_id").notNull(),
    registrationRevision: integer("registration_revision").notNull(),
    transport: text("transport", { enum: ["stdio", "streamableHttp"] }).notNull(),
    configHash: text("config_hash").notNull(),
    workerIncarnationId: text("worker_incarnation_id").notNull(),
    runId: text("run_id").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    grantId: text("grant_id").notNull(),
    chatId: text("chat_id").notNull(),
    openRequestId: text("open_request_id").notNull(),
    openHash: text("open_hash").notNull(),
    state: text("state", {
      enum: ["connecting", "connected", "disconnected", "failed", "closed"],
    }).notNull(),
    createdAt: integer("created_at").notNull(),
    attachedAt: integer("attached_at"),
    connectedAt: integer("connected_at"),
    endedAt: integer("ended_at"),
    endReason: text("end_reason"),
    protocolVersion: text("protocol_version"),
    clientHighWater: integer("client_high_water").notNull(),
    workerAckClientSeq: integer("worker_ack_client_seq").notNull(),
    serverHighWater: integer("server_high_water").notNull(),
    hostAckServerSeq: integer("host_ack_server_seq").notNull(),
    workerStateRevision: integer("worker_state_revision").notNull(),
    workerStateHash: text("worker_state_hash"),
    workerDetachedAt: integer("worker_detached_at"),
    fenceMutationId: text("fence_mutation_id"),
    workerConnectionGeneration: integer("worker_connection_generation").notNull(),
    serverBootId: text("server_boot_id").notNull(),
    workerAttemptId: text("worker_attempt_id").notNull(),
  },
  (t) => [
    uniqueIndex("mcp_session_open_unique").on(t.grantId, t.openRequestId),
    uniqueIndex("mcp_session_process_unique")
      .on(t.processId)
      .where(sql`${t.state} IN ('connecting','connected')`),
    uniqueIndex("mcp_session_frame_identity_unique").on(
      t.id,
      t.projectId,
      t.machineId,
      t.authorizationGeneration,
      t.holderInstanceId,
      t.processId,
    ),
    foreignKey({
      columns: [
        t.processId,
        t.registrationId,
        t.registrationRevision,
        t.projectId,
        t.machineId,
        t.transport,
        t.workerIncarnationId,
      ],
      foreignColumns: [
        mcpServerProcess.id,
        mcpServerProcess.registrationId,
        mcpServerProcess.registrationRevision,
        mcpServerProcess.projectId,
        mcpServerProcess.machineId,
        mcpServerProcess.transport,
        mcpServerProcess.workerIncarnationId,
      ],
    }),
    foreignKey({
      columns: [t.projectId, t.machineId, t.authorizationGeneration],
      foreignColumns: [
        leaseAuthorization.projectId,
        leaseAuthorization.machineId,
        leaseAuthorization.generation,
      ],
    }),
    foreignKey({
      columns: [t.runId, t.holderInstanceId, t.projectId, t.chatId],
      foreignColumns: [agentRun.id, agentRun.instanceId, agentRun.projectId, agentRun.chatId],
    }),
    foreignKey({
      columns: [t.grantId, t.runId, t.holderInstanceId, t.projectId, t.chatId],
      foreignColumns: [
        remoteToolGrant.id,
        remoteToolGrant.runId,
        remoteToolGrant.instanceId,
        remoteToolGrant.projectId,
        remoteToolGrant.chatId,
      ],
    }),
    foreignKey({
      columns: [t.machineId, t.workerConnectionGeneration, t.serverBootId, t.workerAttemptId],
      foreignColumns: [
        machineConnection.machineId,
        machineConnection.generation,
        machineConnection.bootId,
        machineConnection.attemptId,
      ],
    }),
    mcpInteger("registration_revision", 1),
    mcpInteger("worker_connection_generation", 1),
    mcpInteger("authorization_generation", 0),
    mcpInteger("created_at", 0),
    mcpInteger("client_high_water", 0),
    mcpInteger("worker_ack_client_seq", 0),
    mcpInteger("server_high_water", 0),
    mcpInteger("host_ack_server_seq", 0),
    mcpInteger("worker_state_revision", 0),
    mcpHash("config_hash"),
    mcpHash("open_hash"),
    check(
      "mcp_attached_at_integer",
      sql`attached_at IS NULL OR (typeof(attached_at)='integer' AND attached_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_connected_at_integer",
      sql`connected_at IS NULL OR (typeof(connected_at)='integer' AND connected_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_ended_at_integer",
      sql`ended_at IS NULL OR (typeof(ended_at)='integer' AND ended_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_worker_detached_at_integer",
      sql`worker_detached_at IS NULL OR (typeof(worker_detached_at)='integer' AND worker_detached_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check("mcp_session_transport", sql`transport IN ('stdio','streamableHttp')`),
    check(
      "mcp_session_state",
      sql`state IN ('connecting','connected','disconnected','failed','closed')`,
    ),
    check(
      "mcp_session_cursors",
      sql`worker_ack_client_seq<=client_high_water AND host_ack_server_seq<=server_high_water`,
    ),
    check(
      "mcp_session_protocol",
      sql`protocol_version IS NULL OR length(protocol_version) BETWEEN 1 AND 64`,
    ),
    check("mcp_session_attached", sql`attached_at IS NULL OR attached_at>=created_at`),
    check(
      "mcp_session_connected",
      sql`connected_at IS NULL OR (attached_at IS NOT NULL AND connected_at>=attached_at AND protocol_version IS NOT NULL)`,
    ),
    check("mcp_session_connecting", sql`state<>'connecting' OR connected_at IS NULL`),
    check("mcp_session_connected_state", sql`state<>'connected' OR connected_at IS NOT NULL`),
    check(
      "mcp_session_lifecycle",
      sql`(state IN ('connecting','connected') AND ended_at IS NULL AND end_reason IS NULL) OR (state IN ('disconnected','failed','closed') AND ended_at IS NOT NULL AND (connected_at IS NULL OR ended_at>=connected_at) AND end_reason IS NOT NULL)`,
    ),
    check(
      "mcp_session_end_reason",
      sql`end_reason IS NULL OR end_reason IN ('client_closed','grant_expired','run_ended','authorization_revoked','target_lost','worker_lost','transport_error','overflow','timeout')`,
    ),
    check(
      "mcp_session_worker_state",
      sql`(worker_state_revision=0 AND worker_state_hash IS NULL) OR (worker_state_revision>0 AND worker_state_hash IS NOT NULL AND length(worker_state_hash)=64 AND worker_state_hash NOT GLOB '*[^0-9a-f]*')`,
    ),
  ],
);

export const mcpFrame = sqliteTable(
  "mcp_frame",
  {
    id: text("id").primaryKey().notNull(),
    sessionId: text("session_id").notNull(),
    projectId: text("project_id").notNull(),
    machineId: text("machine_id").notNull(),
    authorizationGeneration: integer("authorization_generation").notNull(),
    holderInstanceId: text("holder_instance_id").notNull(),
    processId: text("process_id").notNull(),
    direction: text("direction", { enum: ["client_to_server", "server_to_client"] }).notNull(),
    seq: integer("seq").notNull(),
    payloadBase64: text("payload_base64"),
    payloadBytes: integer("payload_bytes").notNull(),
    payloadHash: text("payload_hash").notNull(),
    state: text("state", { enum: ["queued", "sent", "acked", "dropped", "unknown"] }).notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    sentAt: integer("sent_at"),
    terminalAt: integer("terminal_at"),
    dispositionReason: text("disposition_reason"),
  },
  (t) => [
    uniqueIndex("mcp_frame_sequence_unique").on(t.sessionId, t.direction, t.seq),
    foreignKey({
      columns: [
        t.sessionId,
        t.projectId,
        t.machineId,
        t.authorizationGeneration,
        t.holderInstanceId,
        t.processId,
      ],
      foreignColumns: [
        mcpSession.id,
        mcpSession.projectId,
        mcpSession.machineId,
        mcpSession.authorizationGeneration,
        mcpSession.holderInstanceId,
        mcpSession.processId,
      ],
    }),
    mcpInteger("authorization_generation", 0),
    mcpInteger("created_at", 0),
    mcpInteger("expires_at", 0),
    mcpInteger("seq", 1),
    mcpInteger("payload_bytes", 1),
    check(
      "mcp_sent_at_integer",
      sql`sent_at IS NULL OR (typeof(sent_at)='integer' AND sent_at BETWEEN 0 AND 9007199254740991)`,
    ),
    check(
      "mcp_terminal_at_integer",
      sql`terminal_at IS NULL OR (typeof(terminal_at)='integer' AND terminal_at BETWEEN 0 AND 9007199254740991)`,
    ),
    mcpHash("payload_hash"),
    check("mcp_frame_direction", sql`direction IN ('client_to_server','server_to_client')`),
    check("mcp_frame_state", sql`state IN ('queued','sent','acked','dropped','unknown')`),
    check("mcp_frame_bytes", sql`payload_bytes BETWEEN 1 AND 131072`),
    check(
      "mcp_frame_base64",
      sql`payload_base64 IS NULL OR (length(payload_base64) BETWEEN 4 AND 174764 AND length(payload_base64)%4=0 AND payload_base64 NOT GLOB '*[^A-Za-z0-9+/=]*')`,
    ),
    check(
      "mcp_frame_payload_live",
      sql`state NOT IN ('queued','sent') OR payload_base64 IS NOT NULL`,
    ),
    check("mcp_frame_expires", sql`expires_at>created_at`),
    check("mcp_frame_sent_at", sql`sent_at IS NULL OR sent_at>=created_at`),
    check(
      "mcp_frame_lifecycle",
      sql`(state IN ('queued','sent') AND terminal_at IS NULL AND disposition_reason IS NULL) OR (state='acked' AND terminal_at IS NOT NULL AND disposition_reason IS NULL) OR (state IN ('dropped','unknown') AND terminal_at IS NOT NULL AND disposition_reason IS NOT NULL)`,
    ),
    check(
      "mcp_frame_disposition",
      sql`disposition_reason IS NULL OR disposition_reason IN ('authorization_revoked','expired','client_closed','worker_lost','overflow','transport_error')`,
    ),
    check("mcp_frame_queued", sql`state<>'queued' OR sent_at IS NULL`),
    check("mcp_frame_sent", sql`state NOT IN ('sent','acked') OR sent_at IS NOT NULL`),
  ],
);
