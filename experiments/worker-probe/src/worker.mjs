/**
 * Prototype worker process. Connects out to the host, executes the commands the
 * host sends, and owns the execution ledger that makes repeats safe.
 *
 * The worker refuses any host frame whose generation is not the one it was
 * granted, so an operation authorized under a superseded generation cannot act
 * even if the caller kept the entry point.
 */

import { spawn } from 'node:child_process';
import { connect } from 'node:net';
import { ExecutionLedger } from './ledger.mjs';
import { PROTOCOL_VERSION, decideGeneration, encodeFrame, exited, parseFrame } from './protocol.mjs';

const HEARTBEAT_MS = 120;
const RECONNECT_MS = 40;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index].replace(/^--/, '');
    args[key] = argv[index + 1];
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const workerId = args['worker-id'];
const stateDir = args['state-dir'];
const port = Number(args.port);
if (!workerId || !stateDir || !Number.isSafeInteger(port)) {
  console.error('usage: worker.mjs --worker-id <id> --state-dir <dir> --port <port>');
  process.exit(2);
}

const ledger = new ExecutionLedger(stateDir);
const children = new Map(); // executionId -> ChildProcess
let socket;
let heldGeneration;
let stopped = false;
let heartbeat;
let reconnectTimer;

function send(frame) {
  if (socket === undefined) return;
  socket.write(encodeFrame({ v: PROTOCOL_VERSION, workerId, ...frame }));
}

function sendExecution(record, correlationId) {
  send({
    kind: 'execution',
    generation: heldGeneration,
    requestId: record.requestId,
    executionId: record.executionId,
    state: record.state,
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

function refuse(code, detail, requestId, correlationId) {
  send({
    kind: 'error',
    generation: heldGeneration,
    code,
    detail,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

function startCommand(record) {
  const child = spawn(record.fingerprint.executable, record.fingerprint.argv, {
    cwd: record.fingerprint.cwd,
    stdio: 'ignore',
  });
  children.set(record.executionId, child);
  ledger.markRunning(record.requestId, child.pid);
  child.on('close', (code, signal) => {
    children.delete(record.executionId);
    ledger.settle(record.requestId, exited(code, signal));
    sendExecution(ledger.byRequestId(record.requestId));
  });
  child.on('error', () => {
    children.delete(record.executionId);
    ledger.settle(record.requestId, exited(null, 'spawn-error'));
    sendExecution(ledger.byRequestId(record.requestId));
  });
}

function onRun(frame) {
  const decision = ledger.accept(frame.requestId, frame.fingerprint);
  if (decision.kind === 'conflict') {
    refuse('duplicate-mismatch', `request ${frame.requestId} already names a different command`, frame.requestId, frame.correlationId);
    return;
  }
  if (decision.kind === 'existing') {
    // The dedup answer. Same id, same command: return the record, never spawn.
    sendExecution(decision.record, frame.correlationId);
    return;
  }
  startCommand(decision.record);
  sendExecution(ledger.byRequestId(frame.requestId), frame.correlationId);
}

function onQuery(frame) {
  const record = frame.requestId !== undefined ? ledger.byRequestId(frame.requestId) : ledger.byExecutionId(frame.executionId);
  if (record === undefined) {
    refuse('unknown-execution', `no execution for ${frame.requestId ?? frame.executionId}`, frame.requestId, frame.correlationId);
    return;
  }
  sendExecution(record, frame.correlationId);
}

function onCancel(frame) {
  const record = ledger.byExecutionId(frame.executionId);
  if (record === undefined) {
    refuse('unknown-execution', `no execution ${frame.executionId}`, undefined, frame.correlationId);
    return;
  }
  const child = children.get(frame.executionId);
  if (child !== undefined) child.kill('SIGTERM');
  sendExecution(record, frame.correlationId);
}

function handleFrame(frame) {
  // The worker gate. Only the generation this process currently holds may act.
  if (frame.kind === 'granted') {
    if (heldGeneration === undefined || frame.generation >= heldGeneration) heldGeneration = frame.generation;
    return;
  }
  const decision = decideGeneration({ claimed: frame.generation, current: heldGeneration });
  if (!decision.accepted) {
    refuse(decision.code, `${frame.kind} carried generation ${frame.generation}`, undefined, frame.correlationId);
    return;
  }
  if (frame.kind === 'run') onRun(frame);
  else if (frame.kind === 'query') onQuery(frame);
  else if (frame.kind === 'cancel') onCancel(frame);
}

function connectOnce() {
  if (stopped) return;
  socket = connect({ host: '127.0.0.1', port }, () => {
    send({ kind: 'hello' });
  });
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      const parsed = parseFrame(line, 'host');
      if (parsed.frame.kind === 'accepted') {
        heldGeneration = parsed.frame.generation;
      } else {
        handleFrame(parsed.frame);
      }
      index = buffer.indexOf('\n');
    }
  });
  socket.on('error', () => {});
  socket.on('close', () => {
    socket = undefined;
    if (stopped) return;
    reconnectTimer = setTimeout(connectOnce, RECONNECT_MS);
  });
}

connectOnce();
heartbeat = setInterval(() => {
  if (heldGeneration !== undefined) send({ kind: 'worker-state', generation: heldGeneration });
}, HEARTBEAT_MS);

function shutdown() {
  stopped = true;
  clearInterval(heartbeat);
  clearTimeout(reconnectTimer);
  for (const child of children.values()) child.kill('SIGKILL');
  if (socket !== undefined) socket.destroy();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
