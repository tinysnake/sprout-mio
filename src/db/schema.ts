import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
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
import type { CapabilitySnapshot } from "../contracts/machine";

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
  (table) => [check("chat_kind_check", sql`${table.kind} in ('dm')`)],
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
  ],
);

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
    assistantMessageId: text("assistant_message_id").references(() => message.id),
  },
  (table) => [
    uniqueIndex("agent_run_one_active_instance")
      .on(table.instanceId)
      .where(sql`${table.status} in ('queued', 'running')`),
    index("agent_run_chat_queued_idx").on(table.chatId, table.queuedAt),
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
    createdBy: text("created_by")
      .notNull()
      .references(() => user.id),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => [
    uniqueIndex("machine_id_owner_unique").on(t.id, t.createdBy),
    check("machine_name_check", sql`length(trim(${t.name})) between 1 and 80`),
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
    directory: text("directory"),
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
    check(
      "project_machine_directory_check",
      sql`${t.directory} is null or (length(${t.directory}) between 1 and 4096 and substr(${t.directory}, 1, 1) = '/' and instr(${t.directory}, char(0)) = 0)`,
    ),
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
