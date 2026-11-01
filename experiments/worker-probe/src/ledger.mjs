/**
 * Worker-side execution ledger: the dedup key and the recovery record.
 *
 * The worker owns this because the worker is where a command starts. The host
 * may lose its own view at any time (crash, lease handover, reconnect); the
 * worker's record is what makes a re-submitted request safe to answer instead
 * of re-run.
 *
 * Two invariants:
 * - A request id is accepted at most once. The record is persisted before the
 *   child is spawned, so a crash cannot leave an accepted id with no record.
 * - A record that says `running` when the worker loads means the worker died
 *   mid-command. It cannot prove the child is gone, so it becomes `unknown`
 *   and is never auto-rerun.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sameFingerprint, unknown } from './protocol.mjs';

export class ExecutionLedger {
  #path;
  #records;

  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, 'worker-ledger.json');
    this.#records = new Map();
    if (existsSync(this.#path)) {
      const parsed = JSON.parse(readFileSync(this.#path, 'utf8'));
      for (const record of parsed) this.#records.set(record.requestId, record);
    }
    // A dead worker cannot fence the child it left behind. Downgrade every
    // record that was running when it died instead of claiming an outcome.
    let changed = false;
    for (const [requestId, record] of this.#records) {
      if (record.state.kind === 'running') {
        this.#records.set(requestId, { ...record, state: unknown('worker-restarted'), pid: null });
        changed = true;
      }
    }
    if (changed) this.#flush();
  }

  #flush() {
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.#records.values()], null, 2));
    renameSync(temp, this.#path);
  }

  byRequestId(requestId) {
    const record = this.#records.get(requestId);
    return record === undefined ? undefined : structuredClone(record);
  }

  byExecutionId(executionId) {
    for (const record of this.#records.values()) {
      if (record.executionId === executionId) return structuredClone(record);
    }
    return undefined;
  }

  /**
   * Decide what a `run` frame means.
   *
   * Returns `new` for a first submission, `existing` for a repeat of the same
   * command, and `conflict` when the same request id names a different command.
   * A conflict must never silently run or silently reuse; the caller refuses it.
   */
  accept(requestId, fingerprint) {
    const record = this.#records.get(requestId);
    if (record !== undefined) {
      return sameFingerprint(record.fingerprint, fingerprint)
        ? { kind: 'existing', record: structuredClone(record) }
        : { kind: 'conflict', record: structuredClone(record) };
    }
    const created = {
      requestId,
      executionId: `exe-${randomUUID()}`,
      fingerprint,
      state: unknown('accepted-not-started'),
      pid: null,
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#records.set(requestId, created);
    this.#flush();
    return { kind: 'new', record: structuredClone(created) };
  }

  markRunning(requestId, pid) {
    this.#update(requestId, (record) => ({ ...record, state: { kind: 'running' }, pid }));
  }

  settle(requestId, state) {
    this.#update(requestId, (record) => ({ ...record, state, pid: null }));
  }

  #update(requestId, change) {
    const record = this.#records.get(requestId);
    if (record === undefined) throw new Error(`ledger has no request ${requestId}`);
    this.#records.set(requestId, { ...change(record), updatedAt: Date.now() });
    this.#flush();
  }

  size() {
    return this.#records.size;
  }
}
