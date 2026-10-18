import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { user } from "./auth-schema";
import { AGENT_RUN_STATUSES } from "../contracts/agent-run";
import type { RunConfigSnapshot } from "../contracts/agent-run";
import { DIAGNOSTIC_LEVELS } from "../contracts/diagnostics";

export * from "./auth-schema";

export const project = sqliteTable("project", {
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
});

export const agentProfile = sqliteTable("agent_profile", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
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

export const conversation = sqliteTable(
  "conversation",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => project.id),
    kind: text("kind", { enum: ["dm"] }).notNull(),
    title: text("title"),
    archivedAt: integer("archived_at", { mode: "timestamp" }),
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
  (table) => [check("conversation_kind_check", sql`${table.kind} in ('dm')`)],
);

export const conversationMember = sqliteTable(
  "conversation_member",
  {
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    memberKind: text("member_kind", { enum: ["human", "agent"] }).notNull(),
    memberId: text("member_id").notNull(),
    addedAt: integer("added_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    primaryKey({ columns: [table.conversationId, table.memberKind, table.memberId] }),
    check("conversation_member_kind_check", sql`${table.memberKind} in ('human', 'agent')`),
  ],
);

export const agentInstance = sqliteTable(
  "agent_instance",
  {
    id: text("id").primaryKey(),
    agentProfileId: text("agent_profile_id")
      .notNull()
      .references(() => agentProfile.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
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
    uniqueIndex("agent_instance_profile_conversation_unique").on(
      table.agentProfileId,
      table.conversationId,
    ),
  ],
);

export const message = sqliteTable(
  "message",
  {
    id: text("id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
    senderKind: text("sender_kind", { enum: ["human", "agent"] }).notNull(),
    senderId: text("sender_id").notNull(),
    body: text("body").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (table) => [
    check("message_sender_kind_check", sql`${table.senderKind} in ('human', 'agent')`),
    index("message_conversation_created_at_idx").on(table.conversationId, table.createdAt),
  ],
);

export const agentRun = sqliteTable(
  "agent_run",
  {
    id: text("id").primaryKey(),
    instanceId: text("instance_id")
      .notNull()
      .references(() => agentInstance.id),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversation.id),
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
    assistantMessageId: text("assistant_message_id").references(() => message.id),
  },
  (table) => [
    uniqueIndex("agent_run_one_active_instance")
      .on(table.instanceId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("agent_run_conversation_queued_idx").on(table.conversationId, table.queuedAt),
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
    messageId: text("message_id")
      .primaryKey()
      .references(() => message.id),
    runId: text("run_id")
      .notNull()
      .references(() => agentRun.id),
    disposition: text("disposition", { enum: ["pending", "delivered"] })
      .notNull()
      .default("pending"),
    deliveredAt: integer("delivered_at", { mode: "timestamp" }),
  },
  (table) => [
    index("agent_run_input_run_idx").on(table.runId),
    check(
      "agent_run_input_disposition_check",
      sql`(
      (${table.disposition} = 'pending' and ${table.deliveredAt} is null)
      or (${table.disposition} = 'delivered' and ${table.deliveredAt} is not null)
    )`,
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
    conversationId: text("conversation_id"),
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
