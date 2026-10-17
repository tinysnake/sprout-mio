/**
 * Probe 2: the host loses the result and forgets everything. A fresh host over
 * the same durable generation store reconnects, recovers the execution by
 * request id, and does not cause a second spawn.
 *
 * Host A is stopped and discarded, so host B starts with an empty in-memory
 * ledger. Only the worker's durable record can answer. The side-effect file is
 * the proof the command ran once.
 */
import { join } from 'node:path';
import { createHost } from '../src/host.mjs';
import {
  assert,
  assertEqual,
  countLines,
  evidence,
  runProbe,
  spawnWorker,
  tempDir,
  tickCommand,
  waitForCount,
} from './lib.mjs';

await runProbe('02-lost-response-recovery', async () => {
  const workerId = 'worker-2';
  const stateDir = tempDir('02');
  const sideEffect = join(stateDir, 'side-effect.txt');

  const hostA = await createHost({ workerId, stateDir });
  const port = hostA.port;
  const worker = spawnWorker({ workerId, stateDir, port });
  let hostB;
  try {
    await hostA.waitFor(() => hostA.connected(workerId), { label: 'worker connect to host A' });
    const generationA = hostA.currentGeneration(workerId);

    const fingerprint = tickCommand(sideEffect, 1200);
    const lost = await hostA.submit({ requestId: 'req-lost', fingerprint });
    assertEqual(lost.state.kind, 'running', 'host A saw the command start');
    await waitForCount(sideEffect, 1);
    const executionId = lost.executionId;
    evidence(`host A: generation=${lost.generation} executionId=${executionId} state=running lines=1`);

    // Amnesia. Host A is stopped and thrown away before the exit result exists.
    await hostA.stop();

    hostB = await createHost({ workerId, stateDir, port });
    assertEqual(hostB.lastExecution(executionId), undefined, 'host B starts with no memory of the execution');
    await hostB.waitFor(() => hostB.connected(workerId), { label: 'worker reconnect to host B', timeoutMs: 4000 });
    const generationB = hostB.currentGeneration(workerId);
    assert(generationB > generationA, `reconnect must get a higher generation (${generationA} -> ${generationB})`);
    evidence(`host A stopped and discarded; host B has no execution memory; worker reconnected at generation=${generationB} (was ${generationA})`);

    const recovered = await hostB.query({ requestId: 'req-lost' });
    assertEqual(recovered.executionId, executionId, 'host B recovers the original execution id by request id');
    assert(
      recovered.state.kind === 'running' || recovered.state.kind === 'exited',
      `recovered state must be known, got ${recovered.state.kind}`,
    );
    evidence(`recovered by requestId: executionId=${recovered.executionId} (same) state=${recovered.state.kind}`);

    await hostB.waitFor(() => hostB.lastExecution(executionId)?.state.kind === 'exited', {
      label: 'command exit after recovery',
      timeoutMs: 4000,
    });

    // Re-submitting the same request after the recovery must also dedup, not run.
    const resubmitted = await hostB.submit({ requestId: 'req-lost', fingerprint });
    assertEqual(resubmitted.executionId, executionId, 're-submit returns the same execution id');
    assertEqual(resubmitted.state.kind, 'exited', 're-submit reports the settled state');
    assertEqual(countLines(sideEffect), 1, 'the command never ran a second time');
    evidence(`re-submit after recovery: executionId=${resubmitted.executionId} (same) state=exited lines=1`);
  } finally {
    await worker.stop();
    if (hostB !== undefined) await hostB.stop();
    else await hostA.stop().catch(() => {});
  }
});
