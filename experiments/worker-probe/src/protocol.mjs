/**
 * Prototype worker protocol: frames, generation gate, execution state.
 *
 * This is a throwaway experiment for P0, not a production protocol. It is
 * deliberately small: one NDJSON frame shape, one authority rule, one
 * execution-state union. The point is to make the four P0 semantics observable,
 * not to define the Mio wire format.
 */

export const PROTOCOL_VERSION = 1;

export const FRAME_KINDS = [
  'hello',
  'accepted',
  'granted',
  'worker-state',
  'run',
  'query',
  'cancel',
  'execution',
  'error',
];

export const ERROR_CODES = [
  'stale-generation',
  'future-generation',
  'unknown-worker',
  'unknown-execution',
  'unknown-request',
  'duplicate-mismatch',
  'invalid-request',
  'protocol-mismatch',
];

// Direction names the SENDER. A receiver parses only the frames that side may
// send. `worker-state` and `error` are the two kinds either side may send.
const WORKER_FRAME_KINDS = new Set(['hello', 'worker-state', 'execution', 'error']);
const HOST_FRAME_KINDS = new Set(['accepted', 'granted', 'run', 'query', 'cancel', 'error']);

function isSafePositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isFingerprint(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.executable === 'string' &&
    Array.isArray(value.argv) &&
    value.argv.every((item) => typeof item === 'string') &&
    (value.cwd === undefined || typeof value.cwd === 'string')
  );
}

function isExecutionState(value) {
  if (typeof value !== 'object' || value === null) return false;
  if (value.kind === 'running') return true;
  if (value.kind === 'exited') return typeof value.code === 'number' || value.code === null;
  if (value.kind === 'unknown') return typeof value.reason === 'string';
  return false;
}

/**
 * Parse one untrusted NDJSON line into a typed frame.
 *
 * Everything crossing the socket is untyped until it lands here. A malformed
 * frame becomes a typed parse failure instead of a crash or a half-trusted
 * object. `direction` names who the caller expects to be sending, so a frame
 * from the wrong side fails closed.
 */
export function parseFrame(line, direction) {
  const trimmed = line.trim();
  if (trimmed === '') return { ok: false, code: 'invalid-request', detail: 'empty frame' };
  let raw;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, code: 'invalid-request', detail: 'not JSON' };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'invalid-request', detail: 'not an object' };
  }
  if (raw.v !== PROTOCOL_VERSION) {
    return { ok: false, code: 'protocol-mismatch', detail: `v=${String(raw.v)}` };
  }
  if (!FRAME_KINDS.includes(raw.kind)) {
    return { ok: false, code: 'invalid-request', detail: `kind=${String(raw.kind)}` };
  }
  const allowed = direction === 'worker' ? WORKER_FRAME_KINDS : HOST_FRAME_KINDS;
  if (!allowed.has(raw.kind)) {
    return { ok: false, code: 'invalid-request', detail: `kind ${raw.kind} not valid from ${direction}` };
  }
  if (raw.kind === 'hello') {
    if (typeof raw.workerId !== 'string' || raw.workerId === '') {
      return { ok: false, code: 'invalid-request', detail: 'hello needs workerId' };
    }
    return { ok: true, frame: { v: PROTOCOL_VERSION, kind: 'hello', workerId: raw.workerId } };
  }
  if (typeof raw.workerId !== 'string' || raw.workerId === '') {
    return { ok: false, code: 'invalid-request', detail: `${raw.kind} needs workerId` };
  }
  // Every frame after hello carries the sender's claimed authority generation.
  if (!isSafePositiveInt(raw.generation)) {
    return { ok: false, code: 'invalid-request', detail: `${raw.kind} needs a positive integer generation` };
  }
  // Request identity and execution identity are different things. A query or
  // cancel has no request id of its own, so every host request carries a
  // correlation id that the worker echoes; the host matches the answer on it.
  const base = {
    v: PROTOCOL_VERSION,
    kind: raw.kind,
    workerId: raw.workerId,
    generation: raw.generation,
    ...(typeof raw.correlationId === 'string' ? { correlationId: raw.correlationId } : {}),
  };
  switch (raw.kind) {
    case 'accepted':
      if (typeof raw.connectionId !== 'string' || raw.connectionId === '') {
        return { ok: false, code: 'invalid-request', detail: 'accepted needs connectionId' };
      }
      return { ok: true, frame: { ...base, connectionId: raw.connectionId } };
    case 'granted':
      return { ok: true, frame: base };
    case 'worker-state':
      return { ok: true, frame: base };
    case 'run':
      if (typeof raw.requestId !== 'string' || raw.requestId === '') {
        return { ok: false, code: 'invalid-request', detail: 'run needs requestId' };
      }
      if (!isFingerprint(raw.fingerprint)) {
        return { ok: false, code: 'invalid-request', detail: 'run needs fingerprint' };
      }
      return { ok: true, frame: { ...base, requestId: raw.requestId, fingerprint: raw.fingerprint } };
    case 'query': {
      const hasRequest = typeof raw.requestId === 'string' && raw.requestId !== '';
      const hasExecution = typeof raw.executionId === 'string' && raw.executionId !== '';
      if (hasRequest === hasExecution) {
        return { ok: false, code: 'invalid-request', detail: 'query needs exactly one of requestId or executionId' };
      }
      return {
        ok: true,
        frame: { ...base, ...(hasRequest ? { requestId: raw.requestId } : { executionId: raw.executionId }) },
      };
    }
    case 'cancel':
      if (typeof raw.executionId !== 'string' || raw.executionId === '') {
        return { ok: false, code: 'invalid-request', detail: 'cancel needs executionId' };
      }
      return { ok: true, frame: { ...base, executionId: raw.executionId } };
    case 'execution':
      if (typeof raw.requestId !== 'string' || typeof raw.executionId !== 'string' || !isExecutionState(raw.state)) {
        return { ok: false, code: 'invalid-request', detail: 'execution needs requestId, executionId, state' };
      }
      return { ok: true, frame: { ...base, requestId: raw.requestId, executionId: raw.executionId, state: raw.state } };
    case 'error':
      if (!ERROR_CODES.includes(raw.code)) {
        return { ok: false, code: 'invalid-request', detail: `unknown error code ${String(raw.code)}` };
      }
      return {
        ok: true,
        frame: {
          ...base,
          code: raw.code,
          detail: typeof raw.detail === 'string' ? raw.detail : '',
          ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId } : {}),
          ...(typeof raw.executionId === 'string' ? { executionId: raw.executionId } : {}),
        },
      };
    default:
      return { ok: false, code: 'invalid-request', detail: `unhandled kind ${raw.kind}` };
  }
}

export function encodeFrame(frame) {
  return `${JSON.stringify(frame)}\n`;
}

/**
 * The one authority rule, shared by both receivers.
 *
 * Authority is a monotonic generation. A claimed generation below the
 * receiver's current one is stale. Above it is future authority the sender was
 * never granted. Both are refused, so a receiver never acts on a generation it
 * does not currently own.
 */
export function decideGeneration({ claimed, current }) {
  if (claimed === current) return { accepted: true, generation: claimed };
  if (claimed < current) return { accepted: false, code: 'stale-generation' };
  return { accepted: false, code: 'future-generation' };
}

export const running = () => ({ kind: 'running' });
export const exited = (code, signal) => ({ kind: 'exited', code, signal });
export const unknown = (reason) => ({ kind: 'unknown', reason });

/** Dedup compares the whole command, not just its id. */
export function sameFingerprint(a, b) {
  if (a.executable !== b.executable) return false;
  if ((a.cwd ?? null) !== (b.cwd ?? null)) return false;
  if (a.argv.length !== b.argv.length) return false;
  return a.argv.every((value, index) => value === b.argv[index]);
}
