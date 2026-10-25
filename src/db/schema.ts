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
import {
  REMOTE_EXECUTION_STATES,
  REMOTE_FAILURE_REASONS,
  REMOTE_OUTCOMES,
} from "../contracts/remote";
import type { RemoteOperation, RemoteResultPayload } from "../contracts/remote";
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
  (table) => [
    check("chat_kind_check", sql`${table.kind} in ('dm')`),
    check(
      "chat_title_check",
      sql`${table.title} is null or length(trim(${table.title})) between 1 and 80`,
    ),
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
    deadlineAt: integer("deadline_at", { mode: "timestamp_ms" }).notNull(),
    dispatchConnectionGeneration: integer("dispatch_connection_generation"),
    dispatchSeq: integer("dispatch_seq"),
    dispatchedAt: integer("dispatched_at", { mode: "timestamp_ms" }),
    drainedAt: integer("drained_at", { mode: "timestamp_ms" }),
    terminalAt: integer("terminal_at", { mode: "timestamp_ms" }),
    failureReason: text("failure_reason", { enum: REMOTE_FAILURE_REASONS }),
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
      sql`typeof(deadline_at)='integer' AND deadline_at>created_at`,
    ),
    check(
      "remote_execution_check_8",
      sql`failure_reason IN ('stale_generation','not_holder','authorization_revoked','deadline','worker_lost','executor_error','capability_unavailable','directory_unavailable')`,
    ),
    uniqueIndex("remote_execution_holder_instance_id_request_id_unique").on(
      t.holderInstanceId,
      t.requestId,
    ),
    uniqueIndex(
      "remote_execution_id_project_id_machine_id_authorization_generation_holder_instance_id_unique",
    ).on(t.id, t.projectId, t.machineId, t.authorizationGeneration, t.holderInstanceId),
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
