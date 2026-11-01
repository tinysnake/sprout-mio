// Worker-side execution journal. The worker is where a command starts, so it
// owns the durable record that makes a re-submission safe to answer instead of
// re-run. A PID being alive proves the process still runs. It never proves the
// result is recoverable, so the journal never turns a live PID into an outcome.

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

export class ExecutionJournal {
  #path;
  #execDir;
  #records;

  constructor(stateDir) {
    this.#path = join(stateDir, 'journal.json');
    this.#execDir = join(stateDir, 'exec');
    mkdirSync(this.#execDir, { recursive: true });
    this.#records = new Map();
    if (existsSync(this.#path)) {
      for (const record of JSON.parse(readFileSync(this.#path, 'utf8'))) {
        this.#records.set(record.requestId, record);
      }
    }
  }

  #flush() {
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, JSON.stringify([...this.#records.values()], null, 2));
    renameSync(temp, this.#path);
  }

  #save(record) {
    this.#records.set(record.requestId, { ...record, updatedAt: Date.now() });
    this.#flush();
  }

  byRequestId(requestId) {
    const record = this.#records.get(requestId);
    return record === undefined ? undefined : structuredClone(record);
  }

  /**
   * A request id is accepted at most once. Returns `new` for a first
   * submission, `existing` for a repeat of the same command, and `conflict`
   * when the same id names a different command. A conflict is refused, never
   * silently reused or silently re-run.
   */
  accept(requestId, fingerprint) {
    const existing = this.#records.get(requestId);
    if (existing !== undefined) {
      const same = JSON.stringify(existing.fingerprint) === JSON.stringify(fingerprint);
      return same
        ? { kind: 'existing', record: structuredClone(existing) }
        : { kind: 'conflict', record: structuredClone(existing) };
    }
    const record = {
      requestId,
      executionId: `exe-${randomUUID()}`,
      token: randomUUID(),
      fingerprint,
      pid: null,
      state: { kind: 'starting' },
      acceptedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.#save(record);
    return { kind: 'new', record: structuredClone(record) };
  }

  markRunning(requestId, pid) {
    const record = this.#records.get(requestId);
    if (record === undefined) throw new Error(`journal has no request ${requestId}`);
    this.#save({ ...record, pid, state: { kind: 'running' } });
  }

  recordResult(requestId, state) {
    const record = this.#records.get(requestId);
    if (record === undefined) throw new Error(`journal has no request ${requestId}`);
    this.#save({ ...record, pid: null, state });
  }

  claimPath(executionId) {
    return join(this.#execDir, `${executionId}.claim.json`);
  }

  resultPath(executionId) {
    return join(this.#execDir, `${executionId}.result.json`);
  }

  #reconcileOne(record, livePids) {
    const result = readJson(this.resultPath(record.executionId));
    if (result !== undefined) {
      const next = { kind: 'exited', code: result.code ?? null, signal: result.signal ?? null };
      if (record.state.kind === 'exited' && record.state.code === next.code && record.state.signal === next.signal) {
        return false;
      }
      record.state = next;
      record.pid = null;
      return true;
    }
    // A terminal state this incarnation observed directly is final.
    if (record.state.kind === 'exited') return false;
    // The owning incarnation holds the child handle. A live tracked pid keeps
    // the record running even before the runner has written its claim file.
    if (livePids !== undefined && record.pid !== null && livePids.has(record.pid)) return false;
    const claim = readJson(this.claimPath(record.executionId));
    if (claim !== undefined && claim.token === record.token && pidAlive(claim.pid)) {
      if (record.state.kind === 'running' && record.pid === claim.pid) return false;
      record.state = { kind: 'running' };
      record.pid = claim.pid;
      return true;
    }
    const reason = claim !== undefined && claim.token === record.token
      ? 'child-exited-without-result'
      : record.state.kind === 'starting'
        ? 'accepted-not-started'
        : 'no-fence-record';
    const next = { kind: 'unknown', reason };
    if (record.state.kind === 'unknown' && record.state.reason === reason && record.pid === null) return false;
    record.state = next;
    record.pid = null;
    return true;
  }

  /** Downgrade every non-terminal record the previous incarnation left behind. */
  reconcileAll() {
    let changed = 0;
    for (const record of this.#records.values()) {
      if (this.#reconcileOne(record, new Set())) changed += 1;
    }
    if (changed > 0) this.#flush();
    return changed;
  }

  reconcile(requestId, livePids) {
    const record = this.#records.get(requestId);
    if (record === undefined) return undefined;
    if (this.#reconcileOne(record, livePids)) this.#flush();
    return structuredClone(this.#records.get(requestId));
  }

  /** PIDs of any runner still holding a claim, used for teardown. */
  liveClaimPids() {
    const pids = [];
    if (!existsSync(this.#execDir)) return pids;
    for (const file of readdirSync(this.#execDir)) {
      if (!file.endsWith('.claim.json')) continue;
      const claim = readJson(join(this.#execDir, file));
      if (claim !== undefined && pidAlive(claim.pid)) pids.push(claim.pid);
    }
    return pids;
  }
}
