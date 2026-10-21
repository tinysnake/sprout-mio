import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// Contract-level schema for P0 item 7. Not a business schema: it carries only the
// objects whose identity and exclusion invariants must be fixed before P1.
// Every invariant below is expressed as a database constraint so a second writer
// cannot bypass it by skipping application code.

// --- Identity -------------------------------------------------------------

export const agentProfile = sqliteTable('agent_profile', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  persona: text('persona').notNull().default(''),
  createdAt: integer('created_at').notNull(),
});

export const chat = sqliteTable('chat', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull().default(''),
});

// A 分身 is a durable identity: it outlives runs and service restarts, so its row
// has no run-scoped column and its id is the primary key.
export const agentInstance = sqliteTable(
  'agent_instance',
  {
    id: text('id').primaryKey(),
    profileId: text('profile_id')
      .notNull()
      .references(() => agentProfile.id),
    chatId: text('chat_id')
      .notNull()
      .references(() => chat.id),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('uq_agent_instance_profile_chat').on(
      t.profileId,
      t.chatId,
    ),
  ],
);

// --- Run ------------------------------------------------------------------

export const agentRun = sqliteTable(
  'agent_run',
  {
    id: text('id').primaryKey(),
    instanceId: text('instance_id')
      .notNull()
      .references(() => agentInstance.id),
    status: text('status', {
      enum: ['active', 'completed', 'failed', 'canceled'],
    }).notNull(),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [
    // Serial per 分身: at most one active run. Other 分身 run in parallel because
    // the index is per instance_id, not global.
    uniqueIndex('uq_agent_run_active_instance')
      .on(t.instanceId)
      .where(sql`${t.status} = 'active'`),
    check(
      'ck_agent_run_status',
      sql`${t.status} in ('active','completed','failed','canceled')`,
    ),
    check(
      'ck_agent_run_ended_at',
      sql`(${t.status} = 'active') = (${t.endedAt} is null)`,
    ),
  ],
);

// --- Machine lease --------------------------------------------------------

export const machineLease = sqliteTable(
  'machine_lease',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    machineId: text('machine_id').notNull(),
    holderInstanceId: text('holder_instance_id')
      .notNull()
      .references(() => agentInstance.id),
    // Persistent generation the Worker must present; advancing it fences the old
    // holder (see docs/p0/worker-lease.md).
    generation: integer('generation').notNull(),
    state: text('state', { enum: ['active', 'released', 'revoked'] }).notNull(),
    acquiredAt: integer('acquired_at').notNull(),
    endedAt: integer('ended_at'),
  },
  (t) => [
    // Mutual exclusion per Project x Machine. The partial predicate keeps lease
    // history: released rows stay for audit but do not block a new holder.
    uniqueIndex('uq_machine_lease_active_project_machine')
      .on(t.projectId, t.machineId)
      .where(sql`${t.state} = 'active'`),
    check(
      'ck_machine_lease_state',
      sql`${t.state} in ('active','released','revoked')`,
    ),
    check(
      'ck_machine_lease_ended_at',
      sql`(${t.state} = 'active') = (${t.endedAt} is null)`,
    ),
    check('ck_machine_lease_generation', sql`${t.generation} >= 1`),
    index('ix_machine_lease_holder').on(t.holderInstanceId),
  ],
);

// --- Remote execution -----------------------------------------------------

export const remoteExecution = sqliteTable(
  'remote_execution',
  {
    // Stable execution id, generated once and stable across run, host connection,
    // and lease actions (worker-probe: worker generates it, host only echoes it).
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    machineId: text('machine_id').notNull(),
    // Idempotency key as submitted by the host. Not the execution id.
    requestId: text('request_id').notNull(),
    // Command fingerprint bound to request_id; same key + different fingerprint is
    // rejected by the submission protocol, not by this table.
    fingerprint: text('fingerprint').notNull(),
    state: text('state', {
      enum: ['running', 'exited', 'unknown'],
    }).notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    // One execution per (Machine, request id). A repeat submit resolves to this row
    // instead of starting a second execution.
    uniqueIndex('uq_remote_execution_machine_request').on(
      t.machineId,
      t.requestId,
    ),
    check(
      'ck_remote_execution_state',
      sql`${t.state} in ('running','exited','unknown')`,
    ),
    index('ix_remote_execution_project').on(t.projectId),
  ],
);

// --- Wake request ---------------------------------------------------------

export const wakeRequest = sqliteTable(
  'wake_request',
  {
    id: text('id').primaryKey(),
    targetInstanceId: text('target_instance_id')
      .notNull()
      .references(() => agentInstance.id),
    source: text('source').notNull(),
    // Dedup identity of the logical event. The producer derives it; one dedup key
    // maps to one wake row for its lifetime.
    dedupKey: text('dedup_key').notNull(),
    payload: text('payload').notNull().default('{}'),
    enqueuedAt: integer('enqueued_at').notNull(),
    processedAt: integer('processed_at'),
  },
  (t) => [
    uniqueIndex('uq_wake_request_target_dedup').on(
      t.targetInstanceId,
      t.dedupKey,
    ),
    index('ix_wake_request_pending').on(t.targetInstanceId, t.processedAt),
  ],
);
