import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { sql } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { openMigrated, type Db } from './db.ts';
import { check, expect } from './harness.ts';
import { acquireLease, createInstance } from './operations.ts';
import { agentInstance, agentProfile, conversation, machineLease, remoteExecution } from './schema.ts';

const here = dirname(fileURLToPath(import.meta.url));
const workerUrl = new URL('./concurrent-worker.mjs', import.meta.url);
const outputDir = join(here, '..', '.verify', 'concurrency');
const NOW = 1_700_000_000_000;

interface Job {
  sql: string;
  params: unknown[];
}

interface WorkerResult {
  ok: boolean;
  code?: string;
  message?: string;
}

interface RaceOutcome {
  results: WorkerResult[];
  successes: number;
  constraintFailures: number;
}

async function race(dbPath: string, jobs: Job[]): Promise<RaceOutcome> {
  const startBuffer = new SharedArrayBuffer(4);
  const start = new Int32Array(startBuffer);

  const settled = jobs.map(
    (job) =>
      new Promise<WorkerResult>((resolve) => {
        const worker = new Worker(workerUrl, {
          workerData: { dbPath, sql: job.sql, params: job.params, start: startBuffer },
        });
        worker.on('message', (message: WorkerResult) => resolve(message));
        worker.on('error', (error) => resolve({ ok: false, code: 'worker-error', message: error.message }));
      }),
  );

  await new Promise((resolve) => setTimeout(resolve, 200));
  Atomics.store(start, 0, 1);
  Atomics.notify(start, 0, jobs.length);

  const results = await Promise.all(settled);
  const successes = results.filter((r) => r.ok).length;
  const constraintFailures = results.filter((r) => !r.ok && r.code?.startsWith('SQLITE_CONSTRAINT')).length;
  return { results, successes, constraintFailures };
}

function freshFileDb(name: string, journalMode: 'delete' | 'wal'): { path: string; db: Db } {
  mkdirSync(outputDir, { recursive: true });
  const path = join(outputDir, `${name}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(path + suffix, { force: true });
  const { db } = openMigrated(path, { journalMode });
  return { path, db };
}

function countRows(db: Db, table: SQLiteTable): number {
  const row = db.select({ count: sql<number>`count(*)` }).from(table).get();
  return row?.count ?? 0;
}

function seed(db: Db) {
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

const INSERT_INSTANCE = `insert into agent_instance (id, profile_id, conversation_id, created_at) values (?, ?, ?, ?)`;
const INSERT_LEASE = `insert into machine_lease (id, project_id, machine_id, holder_instance_id, generation, state, acquired_at, ended_at) values (?, ?, ?, ?, ?, 'active', ?, null)`;
const INSERT_EXECUTION = `insert into remote_execution (id, project_id, machine_id, request_id, fingerprint, state, created_at, updated_at) values (?, ?, ?, ?, ?, 'running', ?, ?)`;

async function runMode(mode: 'delete' | 'wal'): Promise<void> {
  const tag = mode === 'wal' ? 'wal' : 'delete';

  await check(`concurrent_instance_create_exactly_one_wins_${tag}`, async () => {
    const { path, db } = freshFileDb(`instance-${tag}`, mode);
    seed(db);
    // (prof-1, conv-2) is seeded as free by seed(); both workers claim that same pair.
    const outcome = await race(path, [
      { sql: INSERT_INSTANCE, params: ['inst-a', 'prof-1', 'conv-2', NOW] },
      { sql: INSERT_INSTANCE, params: ['inst-b', 'prof-1', 'conv-2', NOW] },
    ]);
    const rows = countRows(db, agentInstance);
    expect(outcome.successes === 1, `successes=${outcome.successes} results=${JSON.stringify(outcome.results)}`);
    expect(outcome.constraintFailures === 1, `constraintFailures=${outcome.constraintFailures}`);
    expect(rows === 3, `expected 3 instances total (2 seeded + 1), got ${rows}`);
    return `journal=${mode} successes=${outcome.successes} constraint_failures=${outcome.constraintFailures} rows=${rows}`;
  });

  await check(`concurrent_lease_acquire_exactly_one_wins_${tag}`, async () => {
    const { path, db } = freshFileDb(`lease-${tag}`, mode);
    seed(db);
    const outcome = await race(path, [
      { sql: INSERT_LEASE, params: ['lease-a', 'proj-1', 'mach-1', 'inst-1', 1, NOW] },
      { sql: INSERT_LEASE, params: ['lease-b', 'proj-1', 'mach-1', 'inst-2', 2, NOW] },
    ]);
    const rows = countRows(db, machineLease);
    const active = db.select().from(machineLease).where(sql`${machineLease.state} = 'active'`).all();
    expect(outcome.successes === 1, `successes=${outcome.successes} results=${JSON.stringify(outcome.results)}`);
    expect(outcome.constraintFailures === 1, `constraintFailures=${outcome.constraintFailures}`);
    expect(rows === 1 && active.length === 1, `rows=${rows} active=${active.length}`);
    return `journal=${mode} successes=${outcome.successes} constraint_failures=${outcome.constraintFailures} winner=${active[0]?.id} active=${active.length}`;
  });

  await check(`concurrent_execution_same_request_single_row_${tag}`, async () => {
    const { path, db } = freshFileDb(`execution-${tag}`, mode);
    const outcome = await race(path, [
      { sql: INSERT_EXECUTION, params: ['exe-a', 'proj-1', 'mach-1', 'req-1', 'fp-X', NOW, NOW] },
      { sql: INSERT_EXECUTION, params: ['exe-b', 'proj-1', 'mach-1', 'req-1', 'fp-X', NOW, NOW] },
    ]);
    const rows = countRows(db, remoteExecution);
    expect(outcome.successes === 1, `successes=${outcome.successes} results=${JSON.stringify(outcome.results)}`);
    expect(rows === 1, `expected 1 execution row, got ${rows}`);
    return `journal=${mode} successes=${outcome.successes} constraint_failures=${outcome.constraintFailures} rows=${rows}`;
  });
}

export async function runConcurrencyChecks(): Promise<void> {
  // Prove the race is real first: the same insert attempted sequentially is not a race.
  await check('sequential_insert_is_not_a_race_negative_control', () => {
    const { path: _path, db } = freshFileDb('sequential-control', 'delete');
    seed(db);
    acquireLease(db, { id: 'lease-a', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-1', generation: 1, acquiredAt: NOW });
    let secondCode = 'INSERTED';
    try {
      acquireLease(db, { id: 'lease-b', projectId: 'proj-1', machineId: 'mach-1', holderInstanceId: 'inst-2', generation: 2, acquiredAt: NOW });
    } catch (error) {
      secondCode = (error as { code?: string }).code ?? String(error);
    }
    expect(secondCode === 'SQLITE_CONSTRAINT_UNIQUE', `got ${secondCode}`);
    return `sequential second acquire code=${secondCode}; concurrency checks below use separate connections`;
  });

  await runMode('delete');
  await runMode('wal');
}
