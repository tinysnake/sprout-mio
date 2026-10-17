/**
 * Probe 4: a query or cancel carrying a superseded generation is refused, and
 * the execution record stays reachable under the current generation.
 *
 * The stale caller is the probe deliberately stamping the old generation, which
 * models a holder that kept the entry point after the authority moved on.
 */
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import {
  assertEqual,
  assertGenerationError,
  countLines,
  evidence,
  runProbe,
  spawnWorker,
  tempDir,
  tickCommand,
  waitForCount,
} from './lib.mjs';

await runProbe('04-stale-execution-request', async () => {
  const workerId = 'worker-4';
  const stateDir = tempDir('04');
  const sideEffect = join(stateDir, 'side-effect.txt');
  const host = await createHost({ workerId, stateDir });
  const worker = spawnWorker({ workerId, stateDir, port: host.port });
  try {
    await host.waitFor(() => host.connected(workerId), { label: 'worker connect' });
    const generationN = host.currentGeneration(workerId);

    const fingerprint = tickCommand(sideEffect, 6000);
    const started = await host.submit({ requestId: 'req-E', fingerprint });
    assertEqual(started.state.kind, 'running', 'the command started');
    const executionId = started.executionId;
    await waitForCount(sideEffect, 1);

    const withCurrent = await host.query({ requestId: 'req-E' });
    assertEqual(withCurrent.state.kind, 'running', 'the current generation can query the execution');
    evidence(`generation=${generationN}: executionId=${executionId} state=running lines=1`);

    host.promote(workerId);
    host.notifyGrant(workerId);

    let staleQuery;
    try {
      await host.query({ requestId: 'req-E', generation: generationN });
    } catch (error) {
      staleQuery = error;
    }
    assertGenerationError(staleQuery, 'stale-generation', 'a stale query is refused');

    let staleCancel;
    try {
      await host.cancel({ executionId, generation: generationN });
    } catch (error) {
      staleCancel = error;
    }
    assertGenerationError(staleCancel, 'stale-generation', 'a stale cancel is refused');
    evidence(`stale query and stale cancel both refused code=stale-generation (claimed=${generationN})`);

    const stillRunning = await host.query({ executionId });
    assertEqual(stillRunning.state.kind, 'running', 'the refused cancel did not stop the command');
    assertEqual(countLines(sideEffect), 1, 'the refused requests did not run anything');
    evidence('refused cancel did not stop the command: still running, lines=1');

    await host.cancel({ executionId });
    await host.waitFor(() => host.lastExecution(executionId)?.state.kind === 'exited', {
      label: 'cancel terminates the command',
      timeoutMs: 3000,
    });
    const settled = host.lastExecution(executionId);
    assertEqual(settled.state.signal, 'SIGTERM', 'the current generation can cancel the execution');
    evidence('current generation cancel accepted: state=exited signal=SIGTERM');
  } finally {
    await worker.stop();
    await host.stop();
  }
});
