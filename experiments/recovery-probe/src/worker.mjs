// Worker: a long-lived command host. It listens on a loopback port, spawns the
// runner for each accepted request, and answers `query` from the durable
// journal. A restarted worker reconciles its journal instead of re-running or
// guessing an outcome.

import net from 'node:net';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExecutionJournal } from './journal.mjs';
import { createFrameReader, encodeFrame } from './wire.mjs';

const args = process.argv.slice(2);
const opt = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const stateDir = opt('--dir');
if (stateDir === undefined) {
  console.error('usage: worker.mjs --dir <state-dir>');
  process.exit(2);
}
mkdirSync(stateDir, { recursive: true });

const runnerPath = join(dirname(fileURLToPath(import.meta.url)), 'runner.mjs');
const journal = new ExecutionJournal(stateDir);
journal.reconcileAll();

const liveChildren = new Set();

const server = net.createServer((socket) => {
  socket.on('error', () => {});
  socket.on('data', createFrameReader((frame) => handle(socket, frame)));
});

function handle(socket, frame) {
  const respond = (body) => socket.write(encodeFrame({ ...body, correlationId: frame.correlationId }));

  if (frame.kind === 'submit') {
    const decision = journal.accept(frame.requestId, frame.fingerprint);
    if (decision.kind === 'conflict') {
      return respond({ kind: 'error', code: 'duplicate-mismatch', requestId: frame.requestId });
    }
    if (decision.kind === 'existing') {
      const record = journal.reconcile(frame.requestId, liveChildren);
      return respond({
        kind: 'accepted',
        requestId: record.requestId,
        executionId: record.executionId,
        state: record.state,
        reused: true,
      });
    }
    const record = decision.record;
    const claimPath = journal.claimPath(record.executionId);
    const resultPath = journal.resultPath(record.executionId);
    const child = spawn(
      process.execPath,
      [
        runnerPath,
        '--effects', String(frame.effects),
        '--sleep', String(frame.sleepMs ?? 0),
        '--exit', String(frame.exitCode ?? 0),
        '--claim', claimPath,
        '--result', resultPath,
        '--token', record.token,
      ],
      { stdio: 'ignore' },
    );
    liveChildren.add(child.pid);
    journal.markRunning(frame.requestId, child.pid);
    child.on('exit', (code, signal) => {
      liveChildren.delete(child.pid);
      journal.recordResult(frame.requestId, { kind: 'exited', code, signal });
    });
    return respond({
      kind: 'accepted',
      requestId: record.requestId,
      executionId: record.executionId,
      state: journal.byRequestId(frame.requestId).state,
      reused: false,
    });
  }

  if (frame.kind === 'query') {
    const record = journal.reconcile(frame.requestId, liveChildren);
    if (record === undefined) {
      return respond({ kind: 'error', code: 'unknown-request', requestId: frame.requestId });
    }
    return respond({
      kind: 'state',
      requestId: record.requestId,
      executionId: record.executionId,
      state: record.state,
      pid: record.pid,
    });
  }

  return respond({ kind: 'error', code: 'invalid-request' });
}

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  writeFileSync(join(stateDir, 'worker.pid'), String(process.pid));
  writeFileSync(join(stateDir, 'worker.port'), String(port));
  console.log(`LISTENING ${port}`);
});
