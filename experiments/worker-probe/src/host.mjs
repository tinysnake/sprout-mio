/**
 * Prototype host: TCP listener, durable generation authority, and the
 * host-side half of the gate. The Worker connects out to this process.
 *
 * The host is the authority that mints generations. It keeps the high-water
 * mark on disk so a restart never reissues a generation, and it refuses any
 * Worker frame that claims a generation other than the current authority.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { decideGeneration, encodeFrame, parseFrame } from './protocol.mjs';

const DEFAULT_TIMEOUT_MS = 5000;

class GenerationStore {
  #path;
  #values;

  constructor(stateDir) {
    mkdirSync(stateDir, { recursive: true });
    this.#path = join(stateDir, 'host-generations.json');
    this.#values = existsSync(this.#path) ? JSON.parse(readFileSync(this.#path, 'utf8')) : {};
  }

  #flush() {
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#values, null, 2));
    renameSync(temp, this.#path);
  }

  next(workerId) {
    const next = (this.#values[workerId] ?? 0) + 1;
    this.#values[workerId] = next;
    this.#flush();
    return next;
  }

  current(workerId) {
    return this.#values[workerId];
  }

  snapshot() {
    return { ...this.#values };
  }
}

export async function createHost({ workerId, stateDir, port = 0 }) {
  const generations = new GenerationStore(stateDir);
  const connections = new Map(); // connectionId -> { socket, workerId, generation, buffer }
  const authority = new Map(); // workerId -> current generation
  const pending = new Map(); // requestId -> { resolve, reject, timer }
  const executed = new Map(); // executionId -> last known execution frame
  const rejections = [];
  const counters = { accepted: 0, staleRejected: 0, futureRejected: 0 };

  const listeners = new Set();
  function notify(event) {
    for (const listener of listeners) listener(event);
  }
  function onEvent(listener) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function liveConnection(worker) {
    for (const connection of connections.values()) {
      if (connection.workerId === worker) return connection;
    }
    return undefined;
  }

  function send(connection, frame) {
    connection.socket.write(encodeFrame(frame));
  }

  function recordError(frame) {
    notify({ type: 'error', frame });
    const waiter = frame.correlationId === undefined ? undefined : pending.get(frame.correlationId);
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      pending.delete(frame.correlationId);
      waiter.reject(Object.assign(new Error(frame.detail || frame.code), { code: frame.code }));
    }
  }

  function handleExecution(frame) {
    executed.set(frame.executionId, frame);
    notify({ type: 'execution', frame });
    const waiter = frame.correlationId === undefined ? undefined : pending.get(frame.correlationId);
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    pending.delete(frame.correlationId);
    waiter.resolve(frame);
  }

  function handleWorkerFrame(connection, frame) {
    // The host gate. A Worker that still holds a superseded generation cannot
    // report facts or state; its frame is refused and never applied.
    const current = authority.get(frame.workerId);
    const decision = decideGeneration({ claimed: frame.generation, current });
    if (!decision.accepted) {
      counters[decision.code === 'stale-generation' ? 'staleRejected' : 'futureRejected'] += 1;
      rejections.push({ code: decision.code, kind: frame.kind, claimed: frame.generation, current, at: Date.now() });
      send(connection, {
        v: 1,
        kind: 'error',
        workerId: frame.workerId,
        generation: current,
        code: decision.code,
        detail: `${frame.kind} carried generation ${frame.generation}`,
      });
      notify({ type: 'rejected', frame, code: decision.code });
      return;
    }
    if (frame.kind === 'worker-state') {
      notify({ type: 'worker-state', frame });
      return;
    }
    if (frame.kind === 'execution') {
      handleExecution(frame);
      return;
    }
    if (frame.kind === 'error') {
      recordError(frame);
      return;
    }
  }

  const server = createServer((socket) => {
    const connectionId = `conn-${randomUUID()}`;
    const connection = { socket, workerId: undefined, generation: undefined, buffer: '' };
    connections.set(connectionId, connection);
    socket.setNoDelay(true);
    socket.on('data', (chunk) => {
      connection.buffer += chunk.toString('utf8');
      let index = connection.buffer.indexOf('\n');
      while (index >= 0) {
        const line = connection.buffer.slice(0, index);
        connection.buffer = connection.buffer.slice(index + 1);
        const parsed = parseFrame(line, 'worker');
        if (!parsed.ok) {
          connection.socket.write(
            encodeFrame({
              v: 1,
              kind: 'error',
              workerId: connection.workerId ?? workerId,
              generation: connection.generation ?? authority.get(connection.workerId ?? workerId) ?? 1,
              code: parsed.code,
              detail: parsed.detail,
            }),
          );
        } else if (parsed.frame.kind === 'hello') {
          const acceptedWorker = parsed.frame.workerId;
          const granted = generations.next(acceptedWorker);
          authority.set(acceptedWorker, granted);
          connection.workerId = acceptedWorker;
          connection.generation = granted;
          counters.accepted += 1;
          send(connection, {
            v: 1,
            kind: 'accepted',
            workerId: acceptedWorker,
            generation: granted,
            connectionId,
          });
          notify({ type: 'accepted', workerId: acceptedWorker, generation: granted, connectionId });
        } else {
          handleWorkerFrame(connection, parsed.frame);
        }
        index = connection.buffer.indexOf('\n');
      }
    });
    socket.on('close', () => {
      connections.delete(connectionId);
      notify({ type: 'disconnected', connectionId, workerId: connection.workerId });
    });
    socket.on('error', () => {});
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address();

  function requireConnection(worker) {
    const connection = liveConnection(worker);
    if (connection === undefined) throw new Error(`worker ${worker} is not connected`);
    return connection;
  }

  function request(kind, fields, worker) {
    const connection = requireConnection(worker);
    const { timeoutMs, generation: override, ...rest } = fields;
    const generation = override ?? authority.get(worker);
    if (generation === undefined) throw new Error(`no authority for ${worker}`);
    const correlationId = `cor-${randomUUID()}`;
    const frame = { v: 1, kind, workerId: worker, generation, correlationId, ...rest };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(correlationId);
        reject(new Error(`${kind} ${correlationId} timed out`));
      }, timeoutMs ?? DEFAULT_TIMEOUT_MS);
      pending.set(correlationId, { resolve, reject, timer });
      send(connection, frame);
    });
  }

  return {
    port: address.port,
    onEvent,
    rejections,
    counters,
    generations: () => generations.snapshot(),

    currentGeneration(worker) {
      return authority.get(worker);
    },

    connected(worker) {
      return liveConnection(worker) !== undefined;
    },

    /** Advance durable authority without telling the Worker. */
    promote(worker) {
      const next = generations.next(worker);
      authority.set(worker, next);
      notify({ type: 'promoted', workerId: worker, generation: next });
      return next;
    },

    /** Push the current authority to the live connection, if any. */
    notifyGrant(worker) {
      const connection = liveConnection(worker);
      if (connection === undefined) return;
      connection.generation = authority.get(worker);
      send(connection, {
        v: 1,
        kind: 'granted',
        workerId: worker,
        generation: authority.get(worker),
      });
    },

    submit({ requestId, fingerprint, generation, timeoutMs }) {
      return request('run', { requestId, fingerprint, generation, timeoutMs }, workerId);
    },

    query({ requestId, executionId, generation }) {
      return request('query', { requestId, executionId, generation }, workerId);
    },

    cancel({ executionId, generation }) {
      return request('cancel', { executionId, generation }, workerId);
    },

    lastExecution(executionId) {
      return executed.get(executionId);
    },

    async waitFor(predicate, { timeoutMs = DEFAULT_TIMEOUT_MS, label = 'condition' } = {}) {
      if (predicate()) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new Error(`timed out waiting for ${label}`));
        }, timeoutMs);
        const unsubscribe = onEvent(() => {
          if (!predicate()) return;
          clearTimeout(timer);
          unsubscribe();
          resolve();
        });
      });
    },

    async stop() {
      for (const waiter of pending.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error('host stopped'));
      }
      pending.clear();
      for (const connection of connections.values()) connection.socket.destroy();
      connections.clear();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
