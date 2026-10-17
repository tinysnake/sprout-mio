/**
 * Probe 1: the same request id submitted twice must not start the command twice.
 *
 * Evidence is the side-effect file: one line per spawn. The host also observes
 * the execution id the worker returns.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import {
  assert,
  assertEqual,
  assertGenerationError,
  countLines,
  evidence,
  runProbe,
  sleep,
  spawnWorker,
  tempDir,
  tickCommand,
  waitForCount,
} from './lib.mjs';

await runProbe('01-duplicate-request-id', async () => {
  const workerId = 'worker-1';
  const stateDir = tempDir('01');
  const sideEffect = join(stateDir, 'side-effect.txt');
  const host = await createHost({ workerId, stateDir });
  const worker = spawnWorker({ workerId, stateDir, port: host.port });
  try {
    await host.waitFor(() => host.connected(workerId), { label: 'worker connect' });

    const fingerprint = tickCommand(sideEffect, 500);
    const first = await host.submit({ requestId: 'req-A', fingerprint });
    assertEqual(first.state.kind, 'running', 'first submission starts the command');
    await waitForCount(sideEffect, 1);
    evidence(`first submit: requestId=req-A executionId=${first.executionId} state=running lines=1`);

    const second = await host.submit({ requestId: 'req-A', fingerprint });
    assertEqual(second.executionId, first.executionId, 'repeat returns the same execution id');
    await sleep(150);
    assertEqual(countLines(sideEffect), 1, 'repeat did not spawn a second command');
    evidence(`repeat submit: executionId=${second.executionId} (same) lines=1`);

    await host.waitFor(() => host.lastExecution(first.executionId)?.state.kind === 'exited', {
      label: 'command exit',
      timeoutMs: 3000,
    });

    const afterExit = await host.submit({ requestId: 'req-A', fingerprint });
    assertEqual(afterExit.executionId, first.executionId, 'repeat after completion returns the same execution id');
    assertEqual(afterExit.state.kind, 'exited', 'repeat after completion reports the settled state');
    assertEqual(countLines(sideEffect), 1, 'repeat after completion did not spawn a second command');
    evidence(`repeat after exit: executionId=${afterExit.executionId} (same) state=exited lines=1`);

    await sleep(50);
    let conflict;
    try {
      await host.submit({ requestId: 'req-A', fingerprint: tickCommand(sideEffect, 0) });
    } catch (error) {
      conflict = error;
    }
    assertGenerationError(conflict, 'duplicate-mismatch', 'a request id naming a different command is refused');
    assertEqual(countLines(sideEffect), 1, 'the refused conflict did not spawn a command');
    evidence(`same requestId, different fingerprint: refused code=${conflict.code} lines=1`);

    const ledger = JSON.parse(readFileSync(join(stateDir, 'worker-ledger.json'), 'utf8'));
    assertEqual(ledger.length, 1, 'the worker persisted exactly one execution record');
  } finally {
    await worker.stop();
    await host.stop();
  }
});
