/**
 * Probe 3: authority advances to N+1 while the worker still holds N.
 *
 * The host promotes its durable authority without notifying the worker. The
 * worker's next frame carries N and is refused. After the grant is delivered,
 * the worker holds N+1 and its frames are accepted again.
 */
import { createHost } from '../src/host.mjs';
import { assert, assertEqual, evidence, runProbe, spawnWorker, tempDir } from './lib.mjs';

await runProbe('03-generation-switch', async () => {
  const workerId = 'worker-3';
  const stateDir = tempDir('03');
  const host = await createHost({ workerId, stateDir });
  let worker = spawnWorker({ workerId, stateDir, port: host.port });
  const acceptedStates = [];
  const rejectedFrames = [];
  host.onEvent((event) => {
    if (event.type === 'worker-state') acceptedStates.push(event.frame);
    if (event.type === 'rejected') rejectedFrames.push(event);
  });
  try {
    await host.waitFor(() => host.connected(workerId), { label: 'worker connect' });
    const generationN = host.currentGeneration(workerId);
    await host.waitFor(() => acceptedStates.some((frame) => frame.generation === generationN), {
      label: 'baseline frame at N',
      timeoutMs: 2000,
    });

    const promoted = host.promote(workerId);
    assertEqual(promoted, generationN + 1, 'promotion advances the authority by one');
    assertEqual(host.currentGeneration(workerId), promoted, 'the authority is now N+1');
    evidence(`baseline accepted at generation=${generationN}; authority promoted to ${promoted} without notifying the worker`);

    await host.waitFor(() => rejectedFrames.some((event) => event.frame.kind === 'worker-state'), {
      label: 'stale frame refused',
      timeoutMs: 3000,
    });
    const refusal = rejectedFrames.find((event) => event.frame.kind === 'worker-state');
    assertEqual(refusal.code, 'stale-generation', 'the worker frame at N is refused as stale');
    assertEqual(refusal.frame.generation, generationN, 'the refused claim was the old generation');
    assert(
      acceptedStates.every((frame) => frame.generation === generationN),
      'no frame was accepted at the promoted generation before the grant',
    );
    evidence(`worker frame kind=worker-state claimed=${refusal.frame.generation} refused code=${refusal.code}`);

    host.notifyGrant(workerId);
    await host.waitFor(() => acceptedStates.some((frame) => frame.generation === promoted), {
      label: 'frame accepted at N+1',
      timeoutMs: 3000,
    });
    assertEqual(host.generations()[workerId], promoted, 'the durable high-water mark is N+1');
    evidence(`granted ${promoted}; next worker frame accepted at ${promoted}; durable high-water=${promoted}`);

    // The durable mark must never go backwards across a worker restart.
    await worker.stop();
    worker = spawnWorker({ workerId, stateDir, port: host.port });
    await host.waitFor(() => host.currentGeneration(workerId) > promoted, {
      label: 'reconnect above the durable high-water mark',
      timeoutMs: 4000,
    });
    evidence(`worker restart reconnect: generation=${host.currentGeneration(workerId)} > durable high-water ${promoted}`);
  } finally {
    await worker.stop();
    await host.stop();
  }
});
