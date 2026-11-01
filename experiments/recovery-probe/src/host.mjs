// Host-side client and intent journal. The client is deliberately stateless
// across connections: everything a restarted host needs is written to the
// journal before the command is submitted.

import net from 'node:net';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createFrameReader, encodeFrame } from './wire.mjs';

export class WorkerClient {
  #socket = null;
  #waiters = new Map();
  #seq = 0;

  connect(port) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host: '127.0.0.1', port });
      socket.on('data', createFrameReader((frame) => {
        const waiter = this.#waiters.get(frame.correlationId);
        if (waiter === undefined) return;
        this.#waiters.delete(frame.correlationId);
        if (frame.kind === 'error') waiter.reject(new Error(frame.code));
        else waiter.resolve(frame);
      }));
      socket.on('error', (error) => {
        for (const [id, waiter] of this.#waiters) {
          this.#waiters.delete(id);
          waiter.reject(error);
        }
        reject(error);
      });
      socket.on('connect', () => {
        this.#socket = socket;
        resolve();
      });
    });
  }

  request(frame) {
    const correlationId = `c-${++this.#seq}-${Date.now()}`;
    return new Promise((resolve, reject) => {
      if (this.#socket === null) {
        reject(new Error('not connected'));
        return;
      }
      this.#waiters.set(correlationId, { resolve, reject });
      this.#socket.write(encodeFrame({ ...frame, correlationId }));
    });
  }

  close() {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

export class HostJournal {
  #path;
  #state;

  constructor(path) {
    this.#path = path;
    this.#state = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { requests: [] };
  }

  #flush() {
    const temp = `${this.#path}.tmp`;
    writeFileSync(temp, JSON.stringify(this.#state, null, 2));
    renameSync(temp, this.#path);
  }

  #upsert(requestId, change) {
    const index = this.#state.requests.findIndex((request) => request.requestId === requestId);
    const current = index >= 0 ? this.#state.requests[index] : { requestId, executionId: null, state: 'intent' };
    const next = change(current);
    if (index >= 0) this.#state.requests[index] = next;
    else this.#state.requests.push(next);
    this.#flush();
  }

  intent(requestId, fingerprint) {
    this.#upsert(requestId, (request) => ({ ...request, fingerprint, state: 'intent' }));
  }

  linked(requestId, executionId) {
    this.#upsert(requestId, (request) => ({ ...request, executionId, state: 'linked' }));
  }

  settled(requestId) {
    this.#upsert(requestId, (request) => ({ ...request, state: 'settled' }));
  }

  /** Requests whose result was never retrieved. */
  pending() {
    return this.#state.requests.filter((request) => request.state !== 'settled');
  }
}
