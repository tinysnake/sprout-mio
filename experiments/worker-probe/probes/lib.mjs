import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WORKER_ENTRY = join(ROOT, 'src', 'worker.mjs');
export const TICK_ENTRY = join(ROOT, 'fixtures', 'append-tick.mjs');

export function tempDir(label) {
  return mkdtempSync(join(tmpdir(), `worker-probe-${label}-`));
}

export function countLines(path) {
  if (!existsSync(path)) return 0;
  const text = readFileSync(path, 'utf8');
  return text.split('\n').filter((line) => line.length > 0).length;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Wait for a side-effect file to reach an exact line count. */
export async function waitForCount(path, expected, { timeoutMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countLines(path) === expected) return;
    await sleep(20);
  }
  throw new Error(`expected ${expected} lines in ${path}, found ${countLines(path)}`);
}

/** A command fingerprint that appends exactly one line, then sleeps. */
export function tickCommand(sideEffectPath, sleepMs) {
  return { executable: process.execPath, argv: [TICK_ENTRY, sideEffectPath, String(sleepMs)] };
}

export function spawnWorker({ workerId, stateDir, port }) {
  const child = spawn(
    process.execPath,
    [WORKER_ENTRY, '--worker-id', workerId, '--state-dir', stateDir, '--port', String(port)],
    { stdio: ['ignore', 'inherit', 'inherit'] },
  );
  return {
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const ended = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGTERM');
      await ended;
    },
  };
}

export async function runProbe(name, body) {
  const started = Date.now();
  try {
    await body();
    console.log(`PASS ${name} (${Date.now() - started}ms)`);
    process.exit(0);
  } catch (error) {
    console.log(`FAIL ${name}: ${error.message}`);
    console.error(error);
    process.exit(1);
  }
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function evidence(message) {
  console.log(`  evidence: ${message}`);
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message} (expected ${expected}, got ${actual})`);
}

export function assertGenerationError(error, code, message) {
  if (error?.code !== code) throw new Error(`${message} (expected code ${code}, got ${error?.code}: ${error?.message})`);
}
