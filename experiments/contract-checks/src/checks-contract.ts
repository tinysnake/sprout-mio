import { eq, sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openMigrated, sqliteErrorCode, type Db } from './db.ts';
import { check, expect } from './harness.ts';
import {
  acquireLease,
  createInstance,
  DuplicateRequestMismatch,
  endRun,
  enqueueWake,
  handoffLease,
  markWakeProcessed,
  releaseLease,
  startRun,
  submitExecution,
  countActiveLeases,
} from './operations.ts';
import {
  agentInstance,
  agentProfile,
  agentRun,
  conversation,
  machineLease,
  remoteExecution,
  wakeRequest,
} from './schema.ts';

const NOW = 1_700_000_000_000;

function caught(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return sqliteErrorCode(error);
  }
}

function countRows(db: Db, table: SQLiteTable): number {
  const row = db.select({ count: sql<number>`count(*)` }).from(table).get();
  return row?.count ?? 0;
}

function seedTwoIdentities(db: Db) {
  db.insert(agentProfile)
    .values([
      { id: 'prof-1', name: 'P1', persona: '', createdAt: NOW },
      { id: 'prof-2', name: 'P2', persona: '', createdAt: NOW },
    ])
    .run();
  db.insert(conversation)
    .values([
      { id: 'conv-1', projectId: 'proj-1', title: 'C1' },
      { id: 'conv-2', projectId: 'proj-1', title: 'C2' },
    ])
    .run();
  createInstance(db, { id: 'inst-1', profileId: 'prof-1', conversationId: 'conv-1', createdAt: NOW });
  createInstance(db, { id: 'inst-2', profileId: 'prof-2', conversationId: 'conv-2', createdAt: NOW });
}

export async function runContractChecks(): Promise<void> {
  // --- 分身唯一性 ---------------------------------------------------------
  await check('instance_unique_rejects_second', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    const code = caught(() =>
      createInstance(db, { id: 'inst-1-dup', profileId: 'prof-1', conversationId: 'conv-1', createdAt: NOW }),
    );
    const rows = countRows(db, agentInstance);
    expect(code === 'SQLITE_CONSTRAINT_UNIQUE', `expected SQLITE_CONSTRAINT_UNIQUE, got ${code}`);
    expect(rows === 2, `expected 2 instances, got ${rows}`);
    return `code=${code} instances=${rows}`;
  });

  await check('instance_unique_allows_same_profile_other_conversation', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    const created = createInstance(db, { id: 'inst-3', profileId: 'prof-1', conversationId: 'conv-2', createdAt: NOW });
    const rows = countRows(db, agentInstance);
    expect(rows === 3, `expected 3 instances, got ${rows}`);
    return `created=${created.id} instances=${rows}`;
  });

  await check('instance_fk_rejects_unknown_profile', () => {
    const { db, sqlite } = openMigrated(':memory:');
    seedTwoIdentities(db);
    const code = caught(() =>
      createInstance(db, { id: 'inst-ghost', profileId: 'prof-missing', conversationId: 'conv-1', createdAt: NOW }),
    );
    expect(code === 'SQLITE_CONSTRAINT_FOREIGNKEY', `expected SQLITE_CONSTRAINT_FOREIGNKEY, got ${code}`);
    const pragma = sqlite.pragma('foreign_keys') as Array<{ foreign_keys: number }>;
    return `code=${code} pragma_foreign_keys=${pragma[0]?.foreign_keys}`;
  });

  // --- Project x Machine 租约互斥 -----------------------------------------
  await check('lease_exclusive_rejects_second_active', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    acquireLease(db, { id: 'lease-a', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 1, acquiredAt: NOW });
    const code = caught(() =>
      acquireLease(db, { id: 'lease-b', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-2', generation: 2, acquiredAt: NOW }),
    );
    const active = countActiveLeases(db, 'proj-1', 'mach-1');
    expect(code === 'SQLITE_CONSTRAINT_UNIQUE', `expected SQLITE_CONSTRAINT_UNIQUE, got ${code}`);
    expect(active === 1, `expected 1 active lease, got ${active}`);
    return `code=${code} active=${active}`;
  });

  await check('lease_released_allows_new_holder', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    acquireLease(db, { id: 'lease-a', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 1, acquiredAt: NOW });
    releaseLease(db, 'lease-a', NOW + 10);
    const next = acquireLease(db, { id: 'lease-b', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-2', generation: 2, acquiredAt: NOW + 10 });
    const active = countActiveLeases(db, 'proj-1', 'mach-1');
    const total = countRows(db, machineLease);
    expect(active === 1 && total === 2, `expected active=1 total=2, got active=${active} total=${total}`);
    return `holder=${next.holderInstanceId} active=${active} history_rows=${total}`;
  });

  await check('lease_handoff_single_transaction_no_gap', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    acquireLease(db, { id: 'lease-a', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 1, acquiredAt: NOW });
    const result = handoffLease(db, { projectId: 'proj-1', machineId: 'mach-1', nextId: 'lease-b', nextHolderInstanceId: 'inst-2', nextGeneration: 2, now: NOW + 10 });
    const active = countActiveLeases(db, 'proj-1', 'mach-1');
    const total = countRows(db, machineLease);
    const holder = db.select().from(machineLease).where(eq(machineLease.id, 'lease-b')).get();
    expect(result.activeCountInTransaction === 1, `inside tx active=${result.activeCountInTransaction}`);
    expect(active === 1, `after commit active=${active}`);
    expect(holder?.holderInstanceId === 'inst-2' && holder.generation === 2, `holder=${holder?.holderInstanceId} gen=${holder?.generation}`);
    return `previous=${result.previousId} next=${result.nextId} active_in_tx=${result.activeCountInTransaction} active_after=${active} history_rows=${total}`;
  });

  await check('lease_handoff_two_transactions_has_gap_negative_control', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    acquireLease(db, { id: 'lease-a', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 1, acquiredAt: NOW });
    releaseLease(db, 'lease-a', NOW + 10);
    const activeAfterRelease = countActiveLeases(db, 'proj-1', 'mach-1');
    // The intruder is not the intended next holder: the window is open to anyone.
    acquireLease(db, { id: 'lease-intruder', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 3, acquiredAt: NOW + 11 });
    const code = caught(() =>
      acquireLease(db, { id: 'lease-intended', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-2', generation: 2, acquiredAt: NOW + 12 }),
    );
    expect(activeAfterRelease === 0, `expected a zero-lease window, observed active=${activeAfterRelease}`);
    expect(code === 'SQLITE_CONSTRAINT_UNIQUE', `expected intended holder refused, got ${code}`);
    return `release-then-acquire window: active=${activeAfterRelease}; intruder_won=true; intended refused code=${code}`;
  });

  // --- run 串行 -----------------------------------------------------------
  await check('run_serial_rejects_second_active', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    startRun(db, { id: 'run-1', instanceId: 'inst-1', startedAt: NOW });
    const code = caught(() => startRun(db, { id: 'run-2', instanceId: 'inst-1', startedAt: NOW + 1 }));
    const active = db
      .select({ count: sql<number>`count(*)` })
      .from(agentRun)
      .where(eq(agentRun.status, 'active'))
      .get();
    expect(code === 'SQLITE_CONSTRAINT_UNIQUE', `expected SQLITE_CONSTRAINT_UNIQUE, got ${code}`);
    expect(active?.count === 1, `expected 1 active run, got ${active?.count}`);
    return `code=${code} active_runs=${active?.count}`;
  });

  await check('run_parallel_across_instances_allowed', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    startRun(db, { id: 'run-1', instanceId: 'inst-1', startedAt: NOW });
    startRun(db, { id: 'run-2', instanceId: 'inst-2', startedAt: NOW });
    const active = db
      .select({ count: sql<number>`count(*)` })
      .from(agentRun)
      .where(eq(agentRun.status, 'active'))
      .get();
    expect(active?.count === 2, `expected 2 active runs, got ${active?.count}`);
    return `active_runs=${active?.count} (one per 分身)`;
  });

  await check('run_after_end_allows_next', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    startRun(db, { id: 'run-1', instanceId: 'inst-1', startedAt: NOW });
    endRun(db, 'run-1', 'completed', NOW + 5);
    const next = startRun(db, { id: 'run-2', instanceId: 'inst-1', startedAt: NOW + 6 });
    const active = countRows(db, agentRun);
    const activeOnly = db
      .select({ count: sql<number>`count(*)` })
      .from(agentRun)
      .where(eq(agentRun.status, 'active'))
      .get();
    expect(next.status === 'active' && activeOnly?.count === 1, `next=${next.status} active=${activeOnly?.count}`);
    return `next=${next.id} active=${activeOnly?.count} total=${active}`;
  });

  await check('run_check_rejects_contradictory_ended_at', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    const activeWithEnd = caught(() =>
      db.insert(agentRun).values({ id: 'run-bad-1', instanceId: 'inst-1', status: 'active', startedAt: NOW, endedAt: NOW }).run(),
    );
    const endedWithoutEnd = caught(() =>
      db.insert(agentRun).values({ id: 'run-bad-2', instanceId: 'inst-1', status: 'completed', startedAt: NOW, endedAt: null }).run(),
    );
    const badStatus = caught(() =>
      db.insert(agentRun).values({ id: 'run-bad-3', instanceId: 'inst-1', status: 'paused' as 'active', startedAt: NOW, endedAt: null }).run(),
    );
    expect(
      activeWithEnd === 'SQLITE_CONSTRAINT_CHECK' && endedWithoutEnd === 'SQLITE_CONSTRAINT_CHECK' && badStatus === 'SQLITE_CONSTRAINT_CHECK',
      `codes=${activeWithEnd},${endedWithoutEnd},${badStatus}`,
    );
    return `active_with_ended_at=${activeWithEnd} ended_without_ended_at=${endedWithoutEnd} unknown_status=${badStatus}`;
  });

  // --- 执行 ID 幂等 -------------------------------------------------------
  await check('execution_same_request_returns_same_row', () => {
    const { db } = openMigrated(':memory:');
    const base = { id: 'exe-1', projectId: 'proj-1', machineId: 'mach-1', requestId: 'req-1', fingerprint: 'fp-X', state: 'running' as const, createdAt: NOW, updatedAt: NOW };
    const first = submitExecution(db, base);
    const second = submitExecution(db, { ...base, id: 'exe-2' });
    const rows = countRows(db, remoteExecution);
    expect(first.created === true && second.created === false, `created=${first.created},${second.created}`);
    expect(second.row.id === 'exe-1', `second submit resolved to ${second.row.id}`);
    expect(rows === 1, `expected 1 execution row, got ${rows}`);
    return `first=${first.row.id}(created=${first.created}) second=${second.row.id}(created=${second.created}) rows=${rows}`;
  });

  await check('execution_fingerprint_mismatch_rejected', () => {
    const { db } = openMigrated(':memory:');
    const base = { id: 'exe-1', projectId: 'proj-1', machineId: 'mach-1', requestId: 'req-1', fingerprint: 'fp-X', state: 'running' as const, createdAt: NOW, updatedAt: NOW };
    submitExecution(db, base);
    let thrown: unknown;
    try {
      submitExecution(db, { ...base, id: 'exe-2', fingerprint: 'fp-Y' });
    } catch (error) {
      thrown = error;
    }
    const rows = countRows(db, remoteExecution);
    const stored = db.select().from(remoteExecution).where(eq(remoteExecution.requestId, 'req-1')).get();
    expect(thrown instanceof DuplicateRequestMismatch, `expected DuplicateRequestMismatch, got ${String(thrown)}`);
    expect(rows === 1 && stored?.fingerprint === 'fp-X', `rows=${rows} fingerprint=${stored?.fingerprint}`);
    return `error=${(thrown as Error).name} rows=${rows} stored_fingerprint=${stored?.fingerprint}`;
  });

  await check('execution_request_key_scoped_per_machine', () => {
    const { db } = openMigrated(':memory:');
    const base = { projectId: 'proj-1', requestId: 'req-1', fingerprint: 'fp-X', state: 'running' as const, createdAt: NOW, updatedAt: NOW };
    submitExecution(db, { ...base, id: 'exe-m1', machineId: 'mach-1' });
    const other = submitExecution(db, { ...base, id: 'exe-m2', machineId: 'mach-2' });
    const rows = countRows(db, remoteExecution);
    expect(other.created === true && rows === 2, `created=${other.created} rows=${rows}`);
    return `machine-2 submit created=${other.created} rows=${rows}`;
  });

  // --- 唤醒去重 -----------------------------------------------------------
  await check('wake_dedup_merges_second_enqueue', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    const first = enqueueWake(db, { id: 'wake-1', targetInstanceId: 'inst-1', source: 'task', dedupKey: 'task-9', payload: '{"n":1}', enqueuedAt: NOW, processedAt: null });
    const second = enqueueWake(db, { id: 'wake-2', targetInstanceId: 'inst-1', source: 'task', dedupKey: 'task-9', payload: '{"n":2}', enqueuedAt: NOW + 1, processedAt: null });
    const rows = countRows(db, wakeRequest);
    expect(first.id === 'wake-1' && second.id === 'wake-1', `ids=${first.id},${second.id}`);
    expect(rows === 1 && second.payload === '{"n":2}', `rows=${rows} payload=${second.payload}`);
    return `id=${second.id} rows=${rows} payload=${second.payload}`;
  });

  await check('wake_merge_does_not_resurrect_processed', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    enqueueWake(db, { id: 'wake-1', targetInstanceId: 'inst-1', source: 'task', dedupKey: 'task-9', payload: '{"n":1}', enqueuedAt: NOW, processedAt: null });
    markWakeProcessed(db, 'wake-1', NOW + 2);
    const again = enqueueWake(db, { id: 'wake-2', targetInstanceId: 'inst-1', source: 'task', dedupKey: 'task-9', payload: '{"n":2}', enqueuedAt: NOW + 3, processedAt: null });
    const rows = countRows(db, wakeRequest);
    expect(again.id === 'wake-1' && again.processedAt === NOW + 2, `id=${again.id} processed_at=${again.processedAt}`);
    expect(rows === 1, `rows=${rows}`);
    return `id=${again.id} rows=${rows} processed_at=${again.processedAt}`;
  });

  await check('wake_dedup_scoped_per_target', () => {
    const { db } = openMigrated(':memory:');
    seedTwoIdentities(db);
    enqueueWake(db, { id: 'wake-1', targetInstanceId: 'inst-1', source: 'task', dedupKey: 'task-9', payload: '{}', enqueuedAt: NOW, processedAt: null });
    const other = enqueueWake(db, { id: 'wake-2', targetInstanceId: 'inst-2', source: 'task', dedupKey: 'task-9', payload: '{}', enqueuedAt: NOW, processedAt: null });
    const rows = countRows(db, wakeRequest);
    expect(other.id === 'wake-2' && rows === 2, `id=${other.id} rows=${rows}`);
    return `second target id=${other.id} rows=${rows}`;
  });

  // --- 约束落在数据库，而不是只在 schema 定义 -----------------------------
  await check('partial_unique_indexes_present_in_sqlite_master', () => {
    const { sqlite } = openMigrated(':memory:');
    const rows = sqlite
      .prepare(`select name, sql from sqlite_master where type = 'index' and name in (?, ?, ?)`)
      .all('uq_agent_instance_profile_conversation', 'uq_machine_lease_active_project_machine', 'uq_agent_run_active_instance') as Array<{ name: string; sql: string }>;
    const find = (name: string) => rows.find((r) => r.name === name)?.sql ?? '';
    const lease = find('uq_machine_lease_active_project_machine');
    const run = find('uq_agent_run_active_instance');
    expect(rows.length === 3, `found ${rows.length} indexes`);
    expect(lease.includes('machine_lease') && lease.includes("'active'"), `lease index sql=${lease}`);
    expect(run.includes('agent_run') && run.includes("'active'"), `run index sql=${run}`);
    return `3 indexes present; lease="${lease}"; run="${run}"`;
  });
}
