import { and, eq, sql } from 'drizzle-orm';
import type { Db } from './db.ts';
import { isConstraintError } from './db.ts';
import { agentInstance, agentRun, machineLease, remoteExecution, wakeRequest } from './schema.ts';

// Application-layer submission protocols. Each one leans on a database constraint
// for the invariant and adds only what SQLite cannot express (fingerprint binding,
// merge-on-conflict, atomic handoff).

export class DuplicateRequestMismatch extends Error {
  constructor(requestId: string) {
    super(`request ${requestId} was already used with a different fingerprint`);
    this.name = 'DuplicateRequestMismatch';
  }
}

export class NoActiveLease extends Error {
  constructor(projectId: string, machineId: string) {
    super(`no active lease for ${projectId} x ${machineId}`);
    this.name = 'NoActiveLease';
  }
}

export function createInstance(
  db: Db,
  row: { id: string; profileId: string; chatId: string; createdAt: number },
) {
  return db.insert(agentInstance).values(row).returning().get();
}

export function startRun(
  db: Db,
  row: { id: string; instanceId: string; startedAt: number },
) {
  return db
    .insert(agentRun)
    .values({ ...row, status: 'active', endedAt: null })
    .returning()
    .get();
}

export function endRun(
  db: Db,
  id: string,
  status: 'completed' | 'failed' | 'canceled',
  endedAt: number,
) {
  return db
    .update(agentRun)
    .set({ status, endedAt })
    .where(eq(agentRun.id, id))
    .returning()
    .get();
}

export function acquireLease(
  db: Db,
  row: {
    id: string;
    projectId: string;
    machineId: string;
    holderInstanceId: string;
    generation: number;
    acquiredAt: number;
  },
) {
  return db
    .insert(machineLease)
    .values({ ...row, state: 'active', endedAt: null })
    .returning()
    .get();
}

export function releaseLease(db: Db, id: string, endedAt: number) {
  return db
    .update(machineLease)
    .set({ state: 'released', endedAt })
    .where(eq(machineLease.id, id))
    .returning()
    .get();
}

export interface HandoffResult {
  previousId: string;
  nextId: string;
  // Count observed from inside the transaction, after release and before commit.
  activeCountInTransaction: number;
}

// Direct handoff keeps occupancy: release and re-acquire happen in one transaction,
// so no reader sees a machine with zero active leases and no second holder can slip
// into the gap.
export function handoffLease(
  db: Db,
  args: {
    projectId: string;
    machineId: string;
    nextId: string;
    nextHolderInstanceId: string;
    nextGeneration: number;
    now: number;
  },
): HandoffResult {
  return db.transaction((tx) => {
    const current = tx
      .select()
      .from(machineLease)
      .where(
        and(
          eq(machineLease.projectId, args.projectId),
          eq(machineLease.machineId, args.machineId),
          eq(machineLease.state, 'active'),
        ),
      )
      .get();
    if (!current) throw new NoActiveLease(args.projectId, args.machineId);

    tx.update(machineLease)
      .set({ state: 'released', endedAt: args.now })
      .where(eq(machineLease.id, current.id))
      .run();

    const next = tx
      .insert(machineLease)
      .values({
        id: args.nextId,
        projectId: args.projectId,
        machineId: args.machineId,
        holderInstanceId: args.nextHolderInstanceId,
        generation: args.nextGeneration,
        state: 'active',
        acquiredAt: args.now,
        endedAt: null,
      })
      .returning()
      .get();

    const activeCountInTransaction = countActiveLeases(
      tx as unknown as Db,
      args.projectId,
      args.machineId,
    );

    return { previousId: current.id, nextId: next.id, activeCountInTransaction };
  });
}

export function countActiveLeases(
  db: Db,
  projectId: string,
  machineId: string,
): number {
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(machineLease)
    .where(
      and(
        eq(machineLease.projectId, projectId),
        eq(machineLease.machineId, machineId),
        eq(machineLease.state, 'active'),
      ),
    )
    .get();
  return row?.count ?? 0;
}

export interface ExecutionRow {
  id: string;
  projectId: string;
  machineId: string;
  requestId: string;
  fingerprint: string;
  state: 'running' | 'exited' | 'unknown';
  createdAt: number;
  updatedAt: number;
}

export interface SubmitResult {
  row: ExecutionRow;
  created: boolean;
}

// One execution per (machine, request id). A repeat submit with the same
// fingerprint resolves to the existing row; a different fingerprint is refused so a
// retry cannot silently turn into a second, different command.
export function submitExecution(
  db: Db,
  row: ExecutionRow,
): SubmitResult {
  try {
    db.insert(remoteExecution).values(row).run();
    return { row, created: true };
  } catch (error) {
    if (
      !isConstraintError(error, 'SQLITE_CONSTRAINT_UNIQUE') &&
      !isConstraintError(error, 'SQLITE_CONSTRAINT_PRIMARYKEY')
    ) {
      throw error;
    }
    const existing = db
      .select()
      .from(remoteExecution)
      .where(
        and(
          eq(remoteExecution.machineId, row.machineId),
          eq(remoteExecution.requestId, row.requestId),
        ),
      )
      .get();
    if (!existing) throw error;
    if (existing.fingerprint !== row.fingerprint) {
      throw new DuplicateRequestMismatch(row.requestId);
    }
    return { row: existing as ExecutionRow, created: false };
  }
}

export interface WakeRow {
  id: string;
  targetInstanceId: string;
  source: string;
  dedupKey: string;
  payload: string;
  enqueuedAt: number;
  processedAt: number | null;
}

// One dedup key maps to one wake row for its lifetime. A repeat enqueue merges into
// the existing row and never resurrects a processed wake.
export function enqueueWake(db: Db, row: WakeRow): WakeRow {
  return db
    .insert(wakeRequest)
    .values(row)
    .onConflictDoUpdate({
      target: [wakeRequest.targetInstanceId, wakeRequest.dedupKey],
      set: { source: row.source, payload: row.payload, enqueuedAt: row.enqueuedAt },
    })
    .returning()
    .get() as WakeRow;
}

export function markWakeProcessed(db: Db, id: string, processedAt: number) {
  return db
    .update(wakeRequest)
    .set({ processedAt })
    .where(eq(wakeRequest.id, id))
    .returning()
    .get();
}
