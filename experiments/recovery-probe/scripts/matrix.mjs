// Fault matrix: four faults crossed with three command states. Every cell runs
// a real worker process, a real runner process, real kills, and a real
// reconnect. Each cell asserts its promised outcome and the harness exits
// non-zero on the first promise that does not hold.

import { spawn } from 'node:child_process';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostJournal, WorkerClient } from '../src/host.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRATCH = join(ROOT, '.matrix');
const WORKER = join(ROOT, 'src', 'worker.mjs');
const HOST_CHILD = join(ROOT, 'src', 'host-child.mjs');

const PHASES = {
  'short-running': { sleepMs: 3000, label: 'in-progress short command' },
  'long-running': { sleepMs: 8000, label: 'in-progress long command' },
  'completed-unretrieved': { sleepMs: 300, label: 'completed, result not retrieved' },
};
const FAULTS = ['host-disconnect', 'host-restart', 'worker-restart', 'machine-restart'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function waitForDeath(pid, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid) && Date.now() < deadline) await sleep(20);
  return !pidAlive(pid);
}

async function waitForFile(path, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) {
      const value = readFileSync(path, 'utf8').trim();
      if (value !== '') return value;
    }
    await sleep(25);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function waitForLine(stream, pattern, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${pattern}`)), timeoutMs);
    stream.on('data', (chunk) => {
      buffer += chunk;
      const match = buffer.match(pattern);
      if (match !== null) {
        clearTimeout(timer);
        resolve(match);
      }
    });
  });
}

async function startWorker(cellDir) {
  const stateDir = join(cellDir, 'worker-state');
  mkdirSync(stateDir, { recursive: true });
  rmSync(join(stateDir, 'worker.port'), { force: true });
  rmSync(join(stateDir, 'worker.pid'), { force: true });
  const logPath = join(cellDir, `worker-${Date.now()}.log`);
  const out = openSync(logPath, 'a');
  const child = spawn(process.execPath, [WORKER, '--dir', stateDir], {
    detached: true,
    stdio: ['ignore', out, out],
  });
  closeSync(out);
  const port = Number(await waitForFile(join(stateDir, 'worker.port')));
  return { child, stateDir, port, logPath };
}

async function waitForEffects(effects, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countLines(effects) >= 1) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for the runner to start (${effects})`);
}

function countLines(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '').length;
}

function describe(state) {
  if (state === undefined) return 'missing';
  if (state.kind === 'exited') return `exited:${state.code ?? 'null'}/${state.signal ?? 'null'}`;
  if (state.kind === 'unknown') return `unknown:${state.reason}`;
  return state.kind;
}

function submit(client, { requestId, effects, sleepMs }) {
  return client.request({
    kind: 'submit',
    requestId,
    fingerprint: { executable: 'recovery-runner', effects, sleepMs, exitCode: 0 },
    effects,
    sleepMs,
    exitCode: 0,
  });
}

function query(client, requestId) {
  return client.request({ kind: 'query', requestId });
}

async function waitForState(client, requestId, kinds, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await query(client, requestId);
    if (kinds.includes(last.state.kind)) return last;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${requestId} to reach ${kinds}, last=${describe(last?.state)}`);
}

async function openClient(port) {
  const client = new WorkerClient();
  await client.connect(port);
  return client;
}

/** Kill every worker pid and runner pid a cell may have left behind. */
function teardown(cellDir) {
  const stateDir = join(cellDir, 'worker-state');
  const workerPidFile = join(stateDir, 'worker.pid');
  if (existsSync(workerPidFile)) {
    const pid = Number(readFileSync(workerPidFile, 'utf8').trim());
    try { process.kill(-pid, 'SIGKILL'); } catch { /* group may already be gone */ }
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  const execDir = join(stateDir, 'exec');
  if (!existsSync(execDir)) return;
  for (const file of readdirSync(execDir)) {
    if (!file.endsWith('.claim.json')) continue;
    try {
      const claim = JSON.parse(readFileSync(join(execDir, file), 'utf8'));
      process.kill(claim.pid, 'SIGKILL');
    } catch { /* not alive or unreadable */ }
  }
}

async function afterReconnectQuery(cellDir, worker, requestId) {
  const client = await openClient(worker.port);
  const first = await query(client, requestId);
  return { client, first };
}

// --- Fault 1: host disconnect. The host process stays alive; the socket drops.
async function runHostDisconnect(cell, cellDir) {
  const { phase } = cell;
  const worker = await startWorker(cellDir);
  const effects = join(cellDir, 'effects.log');
  const client = await openClient(worker.port);
  const pending = new Map();
  const accepted = await submit(client, { requestId: 'req-1', effects, sleepMs: PHASES[phase].sleepMs });
  pending.set('req-1', { executionId: accepted.executionId });

  if (phase === 'completed-unretrieved') await sleep(1200);

  client.close(); // fault: the connection is lost, the command is not.
  await sleep(500);

  const { client: reconnected, first } = await afterReconnectQuery(cellDir, worker, 'req-1');
  const observations = {
    executionIdStable: first.executionId === pending.get('req-1').executionId,
    afterReconnect: describe(first.state),
  };
  if (phase === 'short-running') {
    const terminal = await waitForState(reconnected, 'req-1', ['exited'], 6000);
    observations.final = describe(terminal.state);
  }
  if (phase === 'long-running') await waitForEffects(effects);
  observations.effectsLines = countLines(effects);
  reconnected.close();
  return observations;
}

// --- Fault 2: host restart. The host process is killed; the new host rebuilds
// from the durable intent journal, not from memory.
async function runHostRestart(cell, cellDir) {
  const { phase } = cell;
  const worker = await startWorker(cellDir);
  const effects = join(cellDir, 'effects.log');
  const journalPath = join(cellDir, 'host-journal.json');
  const host = spawn(
    process.execPath,
    [
      HOST_CHILD,
      '--port', String(worker.port),
      '--journal', journalPath,
      '--request', 'req-1',
      '--effects', effects,
      '--sleep', String(PHASES[phase].sleepMs),
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const match = await waitForLine(host.stdout, /SUBMITTED (exe-\S+)/);
  const submittedExecutionId = match[1];

  if (phase === 'completed-unretrieved') await sleep(1200);
  else await waitForEffects(effects);

  process.kill(host.pid, 'SIGKILL'); // fault: host process death
  await waitForDeath(host.pid);

  const journal = new HostJournal(journalPath);
  const pending = journal.pending();
  const { client, first } = await afterReconnectQuery(cellDir, worker, 'req-1');
  const observations = {
    pendingRecoveredFromJournal: pending.length === 1 && pending[0].executionId === submittedExecutionId,
    executionIdStable: first.executionId === submittedExecutionId,
    afterReconnect: describe(first.state),
  };
  if (phase === 'short-running') {
    const terminal = await waitForState(client, 'req-1', ['exited'], 6000);
    observations.final = describe(terminal.state);
  }
  observations.effectsLines = countLines(effects);
  client.close();
  return observations;
}

// --- Fault 3: worker restart. Only the worker process dies; its runner is
// orphaned and keeps running.
async function runWorkerRestart(cell, cellDir) {
  const { phase } = cell;
  let worker = await startWorker(cellDir);
  const effects = join(cellDir, 'effects.log');
  let client = await openClient(worker.port);
  await submit(client, { requestId: 'req-1', effects, sleepMs: PHASES[phase].sleepMs });

  if (phase === 'completed-unretrieved') {
    await sleep(1200);
  } else {
    await waitForEffects(effects);
    await waitForState(client, 'req-1', ['running'], 6000);
  }

  process.kill(worker.child.pid, 'SIGKILL'); // fault: worker death, runner orphaned
  await waitForDeath(worker.child.pid);
  client.close();

  worker = await startWorker(cellDir);
  const reconnected = await openClient(worker.port);
  const first = await query(reconnected, 'req-1');
  const observations = { afterRestart: describe(first.state), orphanPidClaimed: Number.isInteger(first.pid) };

  if (phase === 'short-running') {
    const terminal = await waitForState(reconnected, 'req-1', ['exited'], 8000);
    observations.final = describe(terminal.state);
    observations.effectsLines = countLines(effects);
  } else if (phase === 'long-running') {
    // Prove the "child killed without a durable result" path is unknown.
    process.kill(first.pid, 'SIGKILL');
    await waitForDeath(first.pid);
    const after = await query(reconnected, 'req-1');
    observations.afterOrphanKilled = describe(after.state);
    observations.effectsLines = countLines(effects);
    const resign = await submit(reconnected, { requestId: 'req-1', effects, sleepMs: PHASES[phase].sleepMs });
    observations.resubmit = { reused: resign.reused, executionIdStable: resign.executionId === first.executionId, state: describe(resign.state) };
    observations.effectsLinesAfterResubmit = countLines(effects);
  } else {
    observations.effectsLines = countLines(effects);
  }
  reconnected.close();
  return observations;
}

// --- Fault 4: machine restart. The worker process group is killed, so the
// worker and every runner die together.
async function runMachineRestart(cell, cellDir) {
  const { phase } = cell;
  let worker = await startWorker(cellDir);
  const effects = join(cellDir, 'effects.log');
  const client = await openClient(worker.port);
  await submit(client, { requestId: 'req-1', effects, sleepMs: PHASES[phase].sleepMs });

  if (phase === 'completed-unretrieved') {
    await sleep(1200);
  } else {
    await waitForEffects(effects);
    await waitForState(client, 'req-1', ['running'], 6000);
  }

  process.kill(-worker.child.pid, 'SIGKILL'); // fault: whole process group dies
  await waitForDeath(worker.child.pid);
  client.close();

  worker = await startWorker(cellDir);
  const reconnected = await openClient(worker.port);
  const first = await query(reconnected, 'req-1');
  const observations = { afterRestart: describe(first.state), effectsLines: countLines(effects) };

  if (phase !== 'completed-unretrieved') {
    const resign = await submit(reconnected, { requestId: 'req-1', effects, sleepMs: PHASES[phase].sleepMs });
    observations.resubmit = { reused: resign.reused, executionIdStable: resign.executionId === first.executionId, state: describe(resign.state) };
    observations.effectsLinesAfterResubmit = countLines(effects);
  }
  reconnected.close();
  return observations;
}

const RUNNERS = {
  'host-disconnect': runHostDisconnect,
  'host-restart': runHostRestart,
  'worker-restart': runWorkerRestart,
  'machine-restart': runMachineRestart,
};

function expectation(cell) {
  const { fault, phase } = cell;
  if (fault === 'host-disconnect' || fault === 'host-restart') {
    if (phase === 'short-running') return { afterReconnect: 'running', final: 'exited:0/null', effectsLines: 1 };
    if (phase === 'long-running') return { afterReconnect: 'running', effectsLines: 1 };
    return { afterReconnect: 'exited:0/null', effectsLines: 1 };
  }
  if (fault === 'worker-restart') {
    if (phase === 'short-running') return { afterRestart: 'running', final: 'exited:0/null', effectsLines: 1 };
    if (phase === 'long-running') return { afterRestart: 'running', afterOrphanKilled: 'unknown:', effectsLines: 1 };
    return { afterRestart: 'exited:0/null', effectsLines: 1 };
  }
  if (phase === 'completed-unretrieved') return { afterRestart: 'exited:0/null', effectsLines: 1 };
  return { afterRestart: 'unknown:', effectsLines: 1 };
}

function check(cell, observations) {
  const wanted = expectation(cell);
  const failures = [];
  for (const [key, value] of Object.entries(wanted)) {
    const actual = observations[key];
    const pass = value === 'unknown:' ? String(actual).startsWith('unknown:') : actual === value;
    if (!pass) failures.push(`${key}: wanted ${value}, got ${actual}`);
  }
  // An unknown outcome must never become a silent re-run.
  const unknown = String(observations.afterRestart ?? observations.afterOrphanKilled ?? '').startsWith('unknown');
  if (unknown && observations.resubmit !== undefined) {
    if (observations.resubmit.reused !== true) failures.push(`resubmit.reused: wanted true, got ${observations.resubmit.reused}`);
    if (observations.resubmit.executionIdStable !== true) failures.push('resubmit changed execution id');
    if (!String(observations.resubmit.state).startsWith('unknown:')) failures.push(`resubmit.state: wanted unknown, got ${observations.resubmit.state}`);
    if (observations.effectsLinesAfterResubmit !== 1) failures.push(`resubmit re-ran the command: effectsLines=${observations.effectsLinesAfterResubmit}`);
  }
  return failures;
}

async function runCell(cell) {
  const cellDir = join(SCRATCH, cell.id);
  rmSync(cellDir, { recursive: true, force: true });
  mkdirSync(cellDir, { recursive: true });
  console.log(`=== ${cell.id} (${FAULTS.includes(cell.fault) ? cell.fault : '?'}, ${PHASES[cell.phase].label}) ===`);
  console.log(`  command: node scripts/matrix.mjs --cell ${cell.id}`);
  let observations;
  try {
    observations = await RUNNERS[cell.fault](cell, cellDir);
  } finally {
    teardown(cellDir);
  }
  for (const [key, value] of Object.entries(observations)) {
    console.log(`  observed ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value}`);
  }
  const failures = check(cell, observations);
  if (failures.length === 0) {
    console.log(`PASS ${cell.id}`);
    return true;
  }
  console.log(`FAIL ${cell.id}`);
  for (const failure of failures) console.log(`  ! ${failure}`);
  return false;
}

const only = process.argv.includes('--cell')
  ? process.argv[process.argv.indexOf('--cell') + 1]
  : undefined;

const cells = [];
for (const fault of FAULTS) {
  for (const phase of Object.keys(PHASES)) cells.push({ id: `${fault}__${phase}`, fault, phase });
}
const selected = only === undefined ? cells : cells.filter((cell) => cell.id === only);
if (selected.length === 0) {
  console.log(`no cell matches --cell ${only}`);
  process.exit(2);
}

mkdirSync(SCRATCH, { recursive: true });
let failed = 0;
for (const cell of selected) {
  const ok = await runCell(cell);
  if (!ok) failed += 1;
}
console.log('---');
if (failed === 0) console.log(`ALL PASS (${selected.length} cells)`);
else console.log(`${failed} FAILED of ${selected.length}`);
process.exit(failed === 0 ? 0 : 1);
